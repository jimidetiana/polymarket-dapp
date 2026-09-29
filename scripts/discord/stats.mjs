// Discord 战绩播报：从 Polymarket data-api 读钱包的交易活动，重建每场盘口的输赢/盈亏，
// 算胜率后发到「战绩」频道。
//
// 用法（都从 .env 读，脚本用 --env-file 加载）：
//   npm run stats            # 拉活动 → 重建战绩 → 发一条到 DISCORD_STATS_WEBHOOK_URL
//   npm run stats -- dry     # 不发 Discord，只在终端打印（含每场判定，便于核对）
//
// 需要的 .env：
//   DISCORD_STATS_WEBHOOK_URL=<战绩频道 webhook>
//   POLY_STATS_WALLET=<钱包地址；填签名 EOA 会自动解析成持仓所在的代理地址>
//   POLY_STATS_PROB_FLOOR=0.10  # 可选，建仓概率低于此的极端低赔只展示不计入，默认 0.10
//
// ## 口径（按真实数据校准，2026-09-29）
// data-api 的 /positions 只看得到**还没赎回**的仓位：赢了的盘一旦赎回就从列表消失，只剩
// 输了的（curPrice=0、redeemable=true）赖在里面——单看持仓会把胜率算成 0，完全反了。
// 所以战绩从 /activity 这份账本重建，是否「计入」看**开赛时刻**（Gamma event.endDate）：
//   - 开赛前就把仓位全平掉（开赛时净持仓≈0）= 纯赛前买卖套利，**不计入**。
//   - 把仓位带过开赛（开赛时仍持有）= 真押了这场，**计入**：
//       · 赢并赎回（REDEEM，usdcSize=回款，赢方每份赎 $1）→ 胜；
//       · 输了持有到结算（/positions 里 redeemable=true 且 curPrice≈0）→ 负；
//       · 赛中/赛后平仓了结（无 REDEEM、无残留仓位）→ 按盈亏正负定胜负。
//   - 还没结算的（redeemable=false 仍持有）= 进行中。
// 计入的里面再排掉「建仓概率极端低」的（PROB_FLOOR），只展示不进胜率/盈亏。

import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// 记住已发的那条战绩消息 id：再跑就**编辑同一条**，不往频道刷新消息。别手删。
const STATE_PATH = resolve(HERE, 'stats-state.json');

const WEBHOOK = (process.env.DISCORD_STATS_WEBHOOK_URL || '').trim();
const WALLET_IN = (process.env.POLY_STATS_WALLET || '').trim();
const PROB_FLOOR = Number(process.env.POLY_STATS_PROB_FLOOR || '0.10');
// 本金：填了就用这个数；不填就用现金流推出的「自有资金峰值投入」（见 capitalStats）。
const CAPITAL_OVERRIDE = Number(process.env.POLY_STATS_CAPITAL || '0');
const DRY = (process.argv[2] || '') === 'dry';

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';
const EPS = 1e-6;
const COLOR = 0x57f287; // 绿

if (!WALLET_IN) { console.error('缺少 POLY_STATS_WALLET（钱包地址，放 .env）。'); process.exit(1); }
if (!DRY && !WEBHOOK) { console.error('缺少 DISCORD_STATS_WEBHOOK_URL（放 .env）。dry 模式可不填。'); process.exit(1); }

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const usd = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;

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

// 拉各赛事的开赛时刻。Gamma event.endDate = 封盘/开赛时刻（实测：Japan vs Venezuela
// endDate=10:25Z，赛前套利的买卖都在 10:25 之前）。按 activity 里的 eventSlug 查。
async function fetchKickoffs(slugs) {
  const map = new Map();
  await Promise.all([...slugs].map(async (slug) => {
    if (!slug) return;
    try {
      const res = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
      if (!res.ok) return;
      const a = await res.json();
      const ev = Array.isArray(a) ? a[0] : a;
      const end = ev && ev.endDate ? Math.floor(Date.parse(ev.endDate) / 1000) : 0;
      if (end) map.set(slug, end);
    } catch { /* 查不到就没有开赛时间，走兜底：赛前平仓一律不计入 */ }
  }));
  return map;
}

// 按盘口归集带时间戳的买/卖/赎回。
function collectMarkets(activity) {
  const mkt = new Map();
  for (const e of activity) {
    const cid = e.conditionId; if (!cid) continue;
    const m = mkt.get(cid) || { cid, title: '', eventSlug: '', buys: [], sells: [], redeemPayout: 0 };
    if (e.title) m.title = e.title; else if (e.slug && !m.title) m.title = e.slug;
    if (e.eventSlug) m.eventSlug = e.eventSlug;
    const t = num(e.timestamp), size = num(e.size), u = num(e.usdcSize);
    if (e.type === 'TRADE' && e.side === 'BUY') m.buys.push({ t, size, u });
    else if (e.type === 'TRADE' && e.side === 'SELL') m.sells.push({ t, size, u });
    else if (e.type === 'REDEEM') m.redeemPayout += u;
    mkt.set(cid, m);
  }
  return mkt;
}

// 判定一场盘口。核心区分（按用户口径）：
//   - 开赛前就全部平掉（开赛时净持仓≈0）= 纯赛前买卖，不计入；
//   - 把仓位带过开赛（开赛时仍持有）= 真的押了这场，计入：
//       赢并赎回 / 输了持有到结算 → 按结果；赛中赛后平仓了结 → 按盈亏正负定胜负。
function classifyMarket(m, pos, kickoffs) {
  const buyCost = m.buys.reduce((s, b) => s + b.u, 0);
  const buyShares = m.buys.reduce((s, b) => s + b.size, 0);
  const sellProceeds = m.sells.reduce((s, x) => s + x.u, 0);
  const entryProb = buyShares > EPS ? buyCost / buyShares : 0;
  const longshot = entryProb > 0 && entryProb < PROB_FLOOR;
  const profit = m.redeemPayout + sellProceeds - buyCost;
  const hasRedeem = m.redeemPayout > EPS;
  const p = pos.get(m.cid);
  const held = p && Math.abs(num(p.size)) > EPS;
  const kickoff = kickoffs.get(m.eventSlug) || 0;
  const boughtPre = m.buys.filter((b) => !kickoff || b.t < kickoff).reduce((s, b) => s + b.size, 0);
  const soldPre = m.sells.filter((x) => !kickoff || x.t < kickoff).reduce((s, x) => s + x.size, 0);
  const exposureAtKickoff = boughtPre - soldPre;

  let status;
  if (hasRedeem) status = 'win';                                   // 持有到结算、赢并兑付
  else if (held && Boolean(p.redeemable)) status = num(p.curPrice) >= 0.5 ? 'win' : 'loss'; // 持有到结算
  else if (held) status = 'open';                                  // 还没结算
  else if (kickoff > 0 && exposureAtKickoff > EPS) status = profit >= 0 ? 'win' : 'loss'; // 赛中/赛后了结
  else status = 'pretrade';                                        // 赛前平掉（或无开赛信息）→ 不计入

  let bucket, reason = '';
  if (status === 'pretrade') { bucket = 'shown'; reason = 'pretrade'; }
  else if (status === 'open') bucket = 'open';
  else if (longshot) { bucket = 'shown'; reason = 'longshot'; }
  else bucket = 'counted';

  return { cid: m.cid, title: m.title, entryProb, buyCost, sellProceeds, redeemPayout: m.redeemPayout, profit, status, bucket, reason };
}

async function reconstruct(activity, positions) {
  const mkt = collectMarkets(activity);
  const kickoffs = await fetchKickoffs(new Set([...mkt.values()].map((m) => m.eventSlug)));
  const pos = new Map();
  for (const p of positions) {
    const prev = pos.get(p.conditionId);
    if (!prev || Math.abs(num(p.size)) > Math.abs(num(prev.size))) pos.set(p.conditionId, p);
  }
  return [...mkt.values()].map((m) => classifyMarket(m, pos, kickoffs));
}

// 资金口径：本金 ≠ 流水。买入额累加是**流水**（钱赢回来会反复押，越滚越大）；
// **本金**是自有资金真正投进去多少——按时间跑一遍现金流（买 -，卖/赎 +），
// 累计净流出的历史峰值就是「同时压上去的最多自有资金」，最接近本金。
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
  return { turnover, peakDeployed: peak };
}

function summarize(records) {
  const counted = records.filter((r) => r.bucket === 'counted');
  const shown = records.filter((r) => r.bucket === 'shown');
  const open = records.filter((r) => r.bucket === 'open');
  const wins = counted.filter((r) => r.status === 'win').length;
  const losses = counted.filter((r) => r.status === 'loss').length;
  const pnl = counted.reduce((s, r) => s + r.profit, 0);
  const winRate = counted.length ? wins / counted.length : 0;
  counted.sort((a, b) => b.profit - a.profit);
  shown.sort((a, b) => b.profit - a.profit);
  return { counted, shown, open, wins, losses, pnl, winRate };
}

const mark = (r) => (r.status === 'win' ? '✅' : r.status === 'loss' ? '❌' : '•');
const shownTag = (r) => (r.reason === 'longshot' ? `低赔 ${pct(r.entryProb)}` : '赛前平仓');

function render(s, capital) {
  const roi = capital ? s.pnl / capital : 0;
  const capTag = CAPITAL_OVERRIDE ? usd(capital) : `~${usd(capital)}`;
  const L = [];
  L.push(`**已结算并计入：${s.counted.length} 场 · ${s.wins} 胜 ${s.losses} 负 · 胜率 ${pct(s.winRate)}**`);
  L.push(`盈亏 ${usd(s.pnl)} · 本金 ${capTag} · ROI ${pct(roi)}`);
  if (s.counted.length) {
    L.push('', '__明细（计入统计）__');
    for (const r of s.counted) L.push(`${mark(r)} ${r.title} · 建仓 ${pct(r.entryProb)} · ${usd(r.profit)}`);
  }
  if (s.shown.length) {
    L.push('', '__展示但不计入（赛前买卖 / 极端低赔）__');
    for (const r of s.shown) L.push(`• ${r.title} · ${shownTag(r)} · ${usd(r.profit)}`);
  }
  if (s.open.length) L.push('', `__进行中：${s.open.length} 笔（结算后并入战绩）__`);
  return L.join('\n');
}

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
async function publish(embed) {
  const st = readState();
  if (st.messageId) {
    try { await api('PATCH', `/messages/${st.messageId}`, { embeds: [embed] }); return { edited: true, id: st.messageId }; }
    catch { /* 消息被删/找不到，往下走重发 */ }
  }
  const m = await api('POST', '?wait=true', { embeds: [embed] });
  writeState({ messageId: m.id, updatedAt: new Date().toISOString() });
  return { edited: false, id: m.id };
}

// ---- main ----
async function main() {
  const wallet = await resolveWallet(WALLET_IN);
  if (wallet.toLowerCase() !== WALLET_IN.toLowerCase()) console.log(`· 输入是 EOA，已解析出代理地址 ${wallet}`);

  const [activity, positions] = await Promise.all([
    fetchAll('/activity', { user: wallet }),
    fetchAll('/positions', { user: wallet, sizeThreshold: 0 }),
  ]);
  const records = await reconstruct(activity, positions);
  const s = summarize(records);
  const cap = capitalStats(activity);
  const capital = CAPITAL_OVERRIDE || cap.peakDeployed;
  const body = render(s, capital);

  if (DRY) {
    console.log(body);
    console.log(`(参考) 流水(累计买入) ${usd(cap.turnover)} · 峰值自有资金投入 ${usd(cap.peakDeployed)}`);
    console.log(`\n=== 逐盘口判定（activity ${activity.length} / positions ${positions.length}）===`);
    for (const r of [...s.counted, ...s.shown, ...s.open]) {
      console.log([
        r.status.padEnd(8), r.bucket.padEnd(7), (r.reason || '').padEnd(8),
        `建仓${pct(r.entryProb)}`.padEnd(10), `买$${r.buyCost.toFixed(2)}`.padEnd(11),
        `卖$${r.sellProceeds.toFixed(2)}`.padEnd(11), `赎$${r.redeemPayout.toFixed(2)}`.padEnd(10),
        `盈亏${usd(r.profit)}`.padEnd(12), String(r.title).slice(0, 44),
      ].join(' '));
    }
    console.log(`\n(dry) 钱包 ${wallet}，未发 Discord。`);
    return;
  }

  const embed = {
    title: '📊 战绩',
    description: body.slice(0, 4096),
    color: COLOR,
    fields: [{
      name: '可验证钱包（链上公开，任何人可查）',
      value: `\`${wallet}\`\n[Polymarket 主页](https://polymarket.com/profile/${wallet}) · [Polygonscan](https://polygonscan.com/address/${wallet})`,
    }],
    footer: { text: '数据来自 Polymarket，随每次更新重算' },
    timestamp: new Date().toISOString(),
  };
  const res = await publish(embed);
  console.log(`${res.edited ? '已更新' : '已发布'}战绩：${s.counted.length} 场，胜率 ${pct(s.winRate)}，盈亏 ${usd(s.pnl)}（消息 ${res.id}）。`);
}

main().catch((e) => { console.error('出错：', e.message); process.exitCode = 1; });
