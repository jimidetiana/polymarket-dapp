// Discord 战绩播报：从 Polymarket data-api 读钱包的交易活动，重建每场盘口的输赢/盈亏，
// 算胜率后发到「战绩」频道。就地编辑同一条消息（见 stats-state.json），不刷屏。
//
// 用法（都从 .env 读，脚本用 --env-file 加载）：
//   npm run stats            # 拉活动 → 重建战绩 → 编辑/发一条到 DISCORD_STATS_WEBHOOK_URL
//   npm run stats -- dry     # 不发 Discord，只在终端打印（含每场判定，便于核对）
//
// 需要的 .env：
//   DISCORD_STATS_WEBHOOK_URL=<战绩频道 webhook>
//   POLY_STATS_WALLET=<钱包地址；填签名 EOA 会自动解析成持仓所在的代理地址>
//   POLY_STATS_PROB_FLOOR=0.10  # 可选，建仓概率低于此的极端低赔只展示不计入，默认 0.10
//   POLY_STATS_CAPITAL=<可选，本金覆盖值；不填按现金流推「自有资金峰值投入」>
//
// ## 消息结构（三部分）
//   1. 总览：账号总盈亏 = 当前资产总金额 − 本金；ROI；胜负统计。
//      当前资产 = 代理钱包链上现金（pUSD）+ 持仓市值（data-api /value）。
//      这才是账户口径的真盈亏——只统计「计入场次」的盈亏和会漏掉赛前套利那部分。
//   2. 明细：分「计入统计 / 不计入」两组，按时间倒序。每行：
//      结果 · 时间(年月日时分) · 比赛(中文对阵) · 盘口(中文，Yes/No、大/小、让球…) · 份数 · 价格 · 总额。
//   3. 可验证公开信息：钱包地址 + Polymarket / Polygonscan 链接。
//
// ## 计入口径（按真实数据校准，2026-09-29）
// data-api 的 /positions 只看得到**还没赎回**的仓位：赢了的盘一旦赎回就从列表消失，只剩
// 输了的（curPrice=0、redeemable=true）赖在里面——单看持仓会把胜率算成 0，完全反了。
// 所以战绩从 /activity 这份账本重建，是否「计入」看**开赛时刻**（Gamma event.endDate）：
//   - 开赛前就把仓位全平掉（开赛时净持仓≈0）= 纯赛前买卖套利，**不计入**胜率。
//   - 把仓位带过开赛（开赛时仍持有）= 真押了这场，**计入**。
//   - 计入的里面再排掉「建仓概率极端低」的（PROB_FLOOR），只展示不进胜率。
// 注意：账号总盈亏（第 1 部分）是账户口径，赛前套利那部分的盈亏也已经落进现金里，一并算进去。

import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// 记住已发的那条战绩消息 id：再跑就**编辑同一条**，不往频道刷新消息。别手删。
const STATE_PATH = resolve(HERE, 'stats-state.json');
// 队名英→中词典（前端同一份）。查不到就保留英文，不阻断。
const TEAMS = (() => {
  try { return JSON.parse(readFileSync(resolve(HERE, '../../src/data/teams.zh.json'), 'utf8')); }
  catch { return {}; }
})();

const WEBHOOK = (process.env.DISCORD_STATS_WEBHOOK_URL || '').trim();
const WALLET_IN = (process.env.POLY_STATS_WALLET || '').trim();
const PROB_FLOOR = Number(process.env.POLY_STATS_PROB_FLOOR || '0.10');
// 本金：填了就用这个数；不填就用现金流推出的「自有资金峰值投入」（见 capitalStats）。
const CAPITAL_OVERRIDE = Number(process.env.POLY_STATS_CAPITAL || '0');
const DRY = (process.argv[2] || '') === 'dry';

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';
// 现金读链上：Polymarket V2 抵押代币 pUSD（6 位小数），代理钱包上的余额就是可动用现金。
const POLYGON_RPC = 'https://polygon.drpc.org';
const PUSD_POLYGON = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const EPS = 1e-6;
const COLOR = 0x57f287; // 绿

if (!WALLET_IN) { console.error('缺少 POLY_STATS_WALLET（钱包地址，放 .env）。'); process.exit(1); }
if (!DRY && !WEBHOOK) { console.error('缺少 DISCORD_STATS_WEBHOOK_URL（放 .env）。dry 模式可不填。'); process.exit(1); }

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const usd = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const sUsd = (n) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;   // 带正负号
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const sPct = (n) => `${n >= 0 ? '+' : '-'}${Math.abs(n * 100).toFixed(1)}%`;
const sPp = (n) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(1)}pp`; // 百分点（percentage points）

// 时间统一按北京时间显示，格式「年-月-日 时:分」。
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function fmtTime(sec) {
  if (!sec) return '—';
  const p = Object.fromEntries(TIME_FMT.formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const zhTeam = (name) => (name && (TEAMS[name] || TEAMS[String(name).trim()])) || name || '';

// 从赛事标题解析「谁对阵谁」并译中文。Gamma 的 more-markets 赛事标题带「 - More Markets」后缀，去掉。
function zhMatch(eventTitle, marketTitle) {
  let t = (eventTitle || '').replace(/\s*-\s*more markets\s*$/i, '').trim();
  if (!/\svs\.?\s/i.test(t) && marketTitle) {
    const mm = marketTitle.match(/^(.+?)\s+vs\.?\s+(.+?):/i);
    if (mm) t = `${mm[1]} vs. ${mm[2]}`;
  }
  const m = t.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (m) return `${zhTeam(m[1].trim())} vs ${zhTeam(m[2].trim())}`;
  return t || '—';
}

// 把盘口标题 + 所押结果译成一眼能看懂的中文，保留 Yes/No、大/小、让球线等关键信息。
function zhMarket(title, outcome) {
  const t = (title || '').trim();
  const o = (outcome || '').trim();
  let m;
  if ((m = t.match(/O\/U\s*([\d.]+)/i))) {
    const side = /^over$/i.test(o) ? '大' : /^under$/i.test(o) ? '小' : zhTeam(o);
    return `大小球 ${m[1]} · ${side}`;
  }
  if ((m = t.match(/^Spread:\s*(.+?)\s*\(([-+][\d.]+)\)/i))) {
    return `让球 ${zhTeam(m[1].trim())} ${m[2]} · 押${zhTeam(o)}`;
  }
  if (/end in a draw/i.test(t)) {
    return `平局 · ${/^yes$/i.test(o) ? '押平' : /^no$/i.test(o) ? '不平' : o}`;
  }
  if ((m = t.match(/^Will\s+(.+?)\s+win on/i))) {
    return `胜负 · ${zhTeam(m[1].trim())}${/^yes$/i.test(o) ? '胜' : /^no$/i.test(o) ? '不胜' : ''}`;
  }
  const oo = /^(yes|no|over|under)$/i.test(o) ? o : zhTeam(o);
  return `${t}${oo ? ` · ${oo}` : ''}`;
}

// 通用分页拉取（/activity、/positions 都是裸数组）。按事件指纹去重兜底翻页。
async function fetchAll(path, extra) {
  const PAGE = 100, MAX_PAGES = 20;
  const out = [], seen = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ ...extra, limit: String(PAGE), offset: String(page * PAGE) });
    const res = await fetch(`${DATA_API}${path}?${qs}`);
    if (!res.ok) throw new Error(`data-api ${path} 返回 HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) break;
    let added = 0;
    for (const r of rows) {
      const key = `${r.type || ''}:${r.transactionHash || ''}:${r.conditionId || ''}:${r.side || ''}:${r.size || ''}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push(r); added++;
    }
    if (rows.length < PAGE || added === 0) break;
  }
  return out;
}

// 传进来的可能是签名 EOA，也可能是代理地址本身。public-profile 查得到 proxyWallet 就用它。
async function resolveWallet(addr) {
  try {
    const res = await fetch(`${GAMMA}/public-profile?address=${encodeURIComponent(addr)}`);
    if (res.ok) {
      const d = await res.json().catch(() => null);
      const pw = d && d.proxyWallet;
      if (pw && /^0x[0-9a-fA-F]{40}$/.test(pw)) return pw;
    }
  } catch { /* 查不到就用原地址 */ }
  return addr;
}

// 拉各赛事的开赛时刻 + 标题。Gamma event.endDate = 封盘/开赛时刻；title 用来渲染「谁对阵谁」。
async function fetchEvents(slugs) {
  const map = new Map();
  await Promise.all([...slugs].map(async (slug) => {
    if (!slug) return;
    try {
      const res = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
      if (!res.ok) return;
      const a = await res.json();
      const ev = Array.isArray(a) ? a[0] : a;
      const kickoff = ev && ev.endDate ? Math.floor(Date.parse(ev.endDate) / 1000) : 0;
      map.set(slug, { kickoff, title: (ev && ev.title) || '' });
    } catch { /* 查不到就没有开赛时间/标题，走兜底 */ }
  }));
  return map;
}

// 现金：代理钱包链上 pUSD 余额（可动用现金）。读失败返回 null，由调用方降级估算。
async function fetchCash(wallet) {
  try {
    const data = '0x70a08231000000000000000000000000' + wallet.slice(2);
    const res = await fetch(POLYGON_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: PUSD_POLYGON, data }, 'latest'] }),
    });
    const j = await res.json();
    if (!j || !j.result || j.result === '0x') return null;
    return Number(BigInt(j.result)) / 1e6; // pUSD 6 位小数
  } catch { return null; }
}

// 持仓市值：data-api /value。多是 0（赢了的赎成现金、输了的归 0），仍加进「当前资产」以防有进行中仓位。
async function fetchPortfolioValue(wallet) {
  try {
    const res = await fetch(`${DATA_API}/value?user=${wallet}`);
    if (!res.ok) return 0;
    const a = await res.json();
    return Array.isArray(a) && a[0] ? num(a[0].value) : 0;
  } catch { return 0; }
}

// 按盘口归集带时间戳的买/卖/赎回，并记下所押结果（outcome）。
function collectMarkets(activity) {
  const mkt = new Map();
  for (const e of activity) {
    const cid = e.conditionId; if (!cid) continue;
    const m = mkt.get(cid) || { cid, title: '', eventSlug: '', outcome: '', buys: [], sells: [], redeemPayout: 0, redeemed: false };
    if (e.title) m.title = e.title; else if (e.slug && !m.title) m.title = e.slug;
    if (e.eventSlug) m.eventSlug = e.eventSlug;
    if (e.type === 'TRADE' && e.side === 'BUY' && e.outcome) m.outcome = e.outcome; // 以买入侧为准
    else if (e.outcome && !m.outcome) m.outcome = e.outcome;
    const t = num(e.timestamp), size = num(e.size), u = num(e.usdcSize);
    if (e.type === 'TRADE' && e.side === 'BUY') m.buys.push({ t, size, u });
    else if (e.type === 'TRADE' && e.side === 'SELL') m.sells.push({ t, size, u });
    else if (e.type === 'REDEEM') { m.redeemPayout += u; m.redeemed = true; }
    mkt.set(cid, m);
  }
  return mkt;
}

// 判定一场盘口。核心区分（按用户口径）：
//   - 开赛前就全部平掉（开赛时净持仓≈0）= 纯赛前买卖，不计入；
//   - 把仓位带过开赛（开赛时仍持有）= 真的押了这场，计入：
//       赢并赎回 / 输了持有到结算 → 按结果；赛中赛后平仓了结 → 按盈亏正负定胜负。
function classifyMarket(m, pos, events) {
  const buyCost = m.buys.reduce((s, b) => s + b.u, 0);
  const buyShares = m.buys.reduce((s, b) => s + b.size, 0);
  const sellProceeds = m.sells.reduce((s, x) => s + x.u, 0);
  const entryProb = buyShares > EPS ? buyCost / buyShares : 0;
  const longshot = entryProb > 0 && entryProb < PROB_FLOOR;
  const profit = m.redeemPayout + sellProceeds - buyCost;
  const hasRedeem = m.redeemPayout > EPS;
  const p = pos.get(m.cid);
  const held = p && Math.abs(num(p.size)) > EPS;
  const ev = events.get(m.eventSlug) || {};
  const kickoff = ev.kickoff || 0;
  const boughtPre = m.buys.filter((b) => !kickoff || b.t < kickoff).reduce((s, b) => s + b.size, 0);
  const soldPre = m.sells.filter((x) => !kickoff || x.t < kickoff).reduce((s, x) => s + x.size, 0);
  const exposureAtKickoff = boughtPre - soldPre;
  // 开赛后才下的单（滚球）开赛时刻敞口是 0，但同样是真押注。
  const tradedLive = kickoff > 0 && [...m.buys, ...m.sells].some((x) => x.t >= kickoff);
  const firstT = m.buys.length ? Math.min(...m.buys.map((b) => b.t))
    : m.sells.length ? Math.min(...m.sells.map((x) => x.t)) : 0;

  let status;
  if (hasRedeem) status = 'win';                                   // 持有到结算、赢并兑付
  // 输了的仓位也会被 REDEEM（回款 $0），之后从 /positions 消失——只能靠这条账本记录认出来。
  else if (m.redeemed) status = 'loss';
  else if (held && Boolean(p.redeemable)) status = num(p.curPrice) >= 0.5 ? 'win' : 'loss'; // 持有到结算
  else if (held) status = 'open';                                  // 还没结算
  else if ((kickoff > 0 && exposureAtKickoff > EPS) || tradedLive) status = profit >= 0 ? 'win' : 'loss'; // 赛中/赛后了结
  else status = 'pretrade';                                        // 赛前平掉（或无开赛信息）→ 不计入

  let bucket, reason = '';
  if (status === 'pretrade') { bucket = 'shown'; reason = 'pretrade'; }
  else if (status === 'open') bucket = 'open';
  else if (longshot) { bucket = 'shown'; reason = 'longshot'; }
  else bucket = 'counted';

  return {
    cid: m.cid, title: m.title, eventTitle: ev.title || '', outcome: m.outcome,
    entryProb, avgPrice: entryProb, buyShares, buyCost, sellProceeds, redeemPayout: m.redeemPayout,
    profit, firstT, status, bucket, reason,
  };
}

async function reconstruct(activity, positions) {
  const mkt = collectMarkets(activity);
  const events = await fetchEvents(new Set([...mkt.values()].map((m) => m.eventSlug)));
  const pos = new Map();
  for (const p of positions) {
    const prev = pos.get(p.conditionId);
    if (!prev || Math.abs(num(p.size)) > Math.abs(num(prev.size))) pos.set(p.conditionId, p);
  }
  return [...mkt.values()].map((m) => classifyMarket(m, pos, events));
}

// 资金口径：本金 ≠ 流水。买入额累加是**流水**（钱赢回来会反复押，越滚越大）；
// **本金**是自有资金真正投进去多少——按时间跑一遍现金流（买 -，卖/赎 +），
// 累计净流出的历史峰值就是「同时压上去的最多自有资金」，最接近本金。
// net = 最终净现金流 = 已实现盈亏（当持仓市值为 0 时，就是「现金 − 本金」）。
function capitalStats(activity) {
  const ev = activity
    .filter((e) => e.type === 'TRADE' || e.type === 'REDEEM')
    .map((e) => ({
      t: num(e.timestamp),
      flow: e.type === 'REDEEM' ? num(e.usdcSize) : (e.side === 'BUY' ? -num(e.usdcSize) : num(e.usdcSize)),
    }))
    .sort((a, b) => a.t - b.t);
  let cum = 0, peak = 0, turnover = 0;
  for (const e of ev) {
    cum += e.flow;
    if (-cum > peak) peak = -cum;      // 净流出的历史最高点 = 峰值自有资金投入
    if (e.flow < 0) turnover += -e.flow; // 累计买入 = 流水
  }
  return { turnover, peakDeployed: peak, net: cum };
}

function summarize(records) {
  const counted = records.filter((r) => r.bucket === 'counted');
  const shown = records.filter((r) => r.bucket === 'shown');
  const open = records.filter((r) => r.bucket === 'open');
  const wins = counted.filter((r) => r.status === 'win').length;
  const losses = counted.filter((r) => r.status === 'loss').length;
  const actualRate = counted.length ? wins / counted.length : 0;
  // 期望胜率：每个盘口按建仓价（≈市场隐含概率）「本该中」的概率，取平均。
  // Σ 建仓价 = 按定价「本该中的场数」；除以场数 = 期望胜率。与实际胜率对比才有意义。
  const expWins = counted.reduce((s, r) => s + r.entryProb, 0);
  const expectedRate = counted.length ? expWins / counted.length : 0;
  // 明细按时间倒序（最近的在上）。
  const byTimeDesc = (a, b) => b.firstT - a.firstT;
  counted.sort(byTimeDesc);
  shown.sort(byTimeDesc);
  open.sort(byTimeDesc);
  return { counted, shown, open, wins, losses, actualRate, expWins, expectedRate };
}

// ── 渲染 ────────────────────────────────────────────────
const shares = (n) => (Math.abs(n % 1) < EPS ? String(Math.round(n)) : n.toFixed(2));
const markOf = (r) => (r.status === 'win' ? '✅' : r.status === 'loss' ? '❌' : '•');

function detailRow(r, counted) {
  const mark = counted ? markOf(r) : '•';
  const cols = [
    fmtTime(r.firstT),
    zhMatch(r.eventTitle, r.title),
    zhMarket(r.title, r.outcome),
    `${shares(r.buyShares)}份 @$${r.avgPrice.toFixed(2)}`,
    usd(r.buyCost),
  ];
  let line = `${mark} ${cols.join(' · ')}`;
  if (!counted) line += `（${r.reason === 'longshot' ? `低赔${pct(r.entryProb)}` : '赛前平仓'}）`;
  return line;
}

// 三部分文本块。asset 传 { cash, posValue, principal, pnl, roi, cashOk }。
function renderBlocks(s, asset) {
  const capTag = CAPITAL_OVERRIDE ? usd(asset.principal) : `~${usd(asset.principal)}`;
  const head = [];
  head.push(`**账号总盈亏 ${sUsd(asset.pnl)} · ROI ${sPct(asset.roi)}**`);
  if (asset.cashOk) {
    head.push(`当前资产 ${usd(asset.cash + asset.posValue)}（现金 ${usd(asset.cash)} + 持仓 ${usd(asset.posValue)}）· 本金 ${capTag}`);
  } else {
    head.push(`当前资产 ~${usd(asset.principal + asset.pnl)}（现金读取失败，按现金流估算 · 持仓 ${usd(asset.posValue)}）· 本金 ${capTag}`);
  }
  head.push(`已结算并计入 ${s.counted.length} 场 · ${s.wins} 胜 ${s.losses} 负`);
  head.push(`实际胜率 ${pct(s.actualRate)}　期望胜率 ${pct(s.expectedRate)}（按建仓价该中约 ${s.expWins.toFixed(1)} 场）　较定价 ${sPp((s.actualRate - s.expectedRate) * 100)}`);
  if (s.open.length) head.push(`进行中 ${s.open.length} 笔（结算后并入战绩）`);

  // 明细按块给出标题 + 行数组，行数组后面要按 Discord 字数上限裁（见 fitBlock）。
  const counted = {
    title: `__明细 · 计入统计（${s.counted.length}）__`,
    rows: s.counted.map((r) => detailRow(r, true)),
  };
  const shown = s.shown.length
    ? {
      title: `__明细 · 不计入（赛前买卖 / 极端低赔，共 ${s.shown.length}）__`,
      rows: s.shown.map((r) => detailRow(r, false)),
    }
    : null;
  return { head: head.join('\n'), counted, shown };
}

// 场次只会越来越多，总有一天装不下：Discord 单条 embed 描述上限 4096，整条消息
// 所有 embed（含标题/字段/footer）合计上限 6000。明细是时间倒序，所以裁掉的是**最旧**的几行，
// 并在块末注明省略了多少。顺序是「先砍不计入、再砍计入」——计入的才是战绩本体。
const MSG_BUDGET = 5800; // 留点余量给标题、footer、字段
const DESC_LIMIT = 4096;

function fitBlock(block, keep) {
  if (!block) return '';
  const omitted = block.rows.length - keep;
  const rows = omitted > 0 ? block.rows.slice(0, keep) : block.rows;
  const tail = omitted > 0 ? [`…另 ${omitted} 场未列出（更早的记录）`] : [];
  return [block.title, ...rows, ...tail].join('\n');
}

const fullBlock = (block) => fitBlock(block, block ? block.rows.length : 0);

// ── Discord ────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(WEBHOOK + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    await sleep(Math.ceil((j.retry_after || 1) * 1000) + 250);
    return api(method, path, body);
  }
  if (!res.ok) throw new Error(`Discord ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function readState() { try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } }
function writeState(s) { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n'); }

// 有记录就编辑那条，没有（或那条被删了）就发一条新的并记下 id。
async function publish(embeds) {
  const st = readState();
  if (st.messageId) {
    try { await api('PATCH', `/messages/${st.messageId}`, { embeds }); return { edited: true, id: st.messageId }; }
    catch { /* 消息被删/找不到，往下走重发 */ }
  }
  const m = await api('POST', '?wait=true', { embeds });
  writeState({ messageId: m.id, updatedAt: new Date().toISOString() });
  return { edited: false, id: m.id };
}

// 把三部分打进 embeds。两条上限都要守：单条 embed 描述 4096、整条消息所有 embed 合计 6000
// （标题、字段、footer 都算进那 6000，所以 MSG_BUDGET 留了余量）。
// 装得下就一条 embed；装不下把「不计入」明细挪到第二条，并按 fitBlock 裁掉最旧的几行。
function buildEmbeds(blocks, wallet) {
  const verifyField = {
    name: '可验证钱包（链上公开，任何人可查）',
    value: `\`${wallet}\`\n[Polymarket 主页](https://polymarket.com/profile/${wallet}) · [Polygonscan](https://polygonscan.com/address/${wallet})`,
  };
  const base = { color: COLOR, footer: { text: '数据来自 Polymarket + 链上余额，随每次更新重算' }, timestamp: new Date().toISOString() };
  const TITLE = '📊 战绩';
  const overhead = TITLE.length + base.footer.text.length + verifyField.name.length + verifyField.value.length;

  // 先尽量全列，超了就一行一行砍：先砍「不计入」，砍完还超再砍「计入」（战绩本体最后动）。
  let keepShown = blocks.shown ? blocks.shown.rows.length : 0;
  let keepCounted = blocks.counted.rows.length;
  let desc1, desc2;
  for (;;) {
    desc1 = `${blocks.head}\n\n${fitBlock(blocks.counted, keepCounted)}`;
    desc2 = blocks.shown ? fitBlock(blocks.shown, keepShown) : '';
    const over = desc1.length + desc2.length + overhead > MSG_BUDGET;
    if (!over && desc1.length <= DESC_LIMIT && desc2.length <= DESC_LIMIT) break;
    if (keepShown > 0 && (over || desc2.length > DESC_LIMIT)) keepShown--;
    else if (keepCounted > 0) keepCounted--;
    else break; // 两边都砍空了还超（理论不会），交给 slice 兜底
  }

  const embeds = [];
  if (desc2 && desc1.length + desc2.length + 2 + overhead <= MSG_BUDGET && (`${desc1}\n\n${desc2}`).length <= DESC_LIMIT) {
    embeds.push({ ...base, title: TITLE, description: `${desc1}\n\n${desc2}`.slice(0, DESC_LIMIT), fields: [verifyField] });
  } else if (desc2) {
    embeds.push({ ...base, title: TITLE, description: desc1.slice(0, DESC_LIMIT) });
    embeds.push({ ...base, description: desc2.slice(0, DESC_LIMIT), fields: [verifyField] });
  } else {
    embeds.push({ ...base, title: TITLE, description: desc1.slice(0, DESC_LIMIT), fields: [verifyField] });
  }
  return embeds;
}

// ── main ────────────────────────────────────────────────
async function main() {
  const wallet = await resolveWallet(WALLET_IN);
  if (wallet.toLowerCase() !== WALLET_IN.toLowerCase()) console.log(`· 输入是 EOA，已解析出代理地址 ${wallet}`);

  const [activity, positions, cash, posValue] = await Promise.all([
    fetchAll('/activity', { user: wallet }),
    fetchAll('/positions', { user: wallet, sizeThreshold: 0 }),
    fetchCash(wallet),
    fetchPortfolioValue(wallet),
  ]);
  const records = await reconstruct(activity, positions);
  const s = summarize(records);
  const cap = capitalStats(activity);
  const principal = CAPITAL_OVERRIDE || cap.peakDeployed;
  const cashOk = cash != null;
  // 账号总盈亏 = 当前资产总金额 − 本金。现金读到就用（现金 + 持仓市值）− 本金；
  // 读不到降级用现金流已实现盈亏 + 持仓市值（与本金无关，恒等式一致）。
  const pnl = cashOk ? (cash + posValue - principal) : (cap.net + posValue);
  const roi = principal ? pnl / principal : 0;
  const asset = { cash: cash || 0, posValue, principal, pnl, roi, cashOk };
  const blocks = renderBlocks(s, asset);

  if (DRY) {
    // dry 打全量（不裁），方便逐场核对。
    console.log([blocks.head, '', fullBlock(blocks.counted), '', fullBlock(blocks.shown)].join('\n'));
    console.log(`\n(参考) 现金 ${cashOk ? usd(cash) : '读取失败'} · 持仓市值 ${usd(posValue)} · 流水(累计买入) ${usd(cap.turnover)} · 峰值自有资金投入 ${usd(cap.peakDeployed)} · 净现金流 ${sUsd(cap.net)}`);
    console.log(`(dry) 钱包 ${wallet}，未发 Discord。`);
    return;
  }

  const embeds = buildEmbeds(blocks, wallet);
  const res = await publish(embeds);
  console.log(`${res.edited ? '已更新' : '已发布'}战绩：账号总盈亏 ${sUsd(pnl)}（ROI ${sPct(roi)}）· 计入 ${s.counted.length} 场 · 实际胜率 ${pct(s.actualRate)} / 期望 ${pct(s.expectedRate)}（消息 ${res.id}）。`);
}

main().catch((e) => { console.error('出错：', e.message); process.exitCode = 1; });
