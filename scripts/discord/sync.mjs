// Discord 播报同步：把仓库里的功能说明 / 更新记录推到 Discord 频道。
// 用法（webhook 从 .env 的 DISCORD_WEBHOOK_URL 读）：
//   npm run discord            # 同步「功能说明」+ 推送未发的「更新记录」
//   npm run discord -- overview   # 只同步功能说明（编辑同一条消息，不刷屏）
//   npm run discord -- changelog  # 只推送 changelog.md 里还没发过的新条目
//
// 设计：仓库是唯一真相，Discord 是镜像。
//  - 功能说明 = docs/discord/overview.md → 维护成固定消息，内容变了就“编辑”。
//  - 更新记录 = docs/discord/changelog.md → 追加式，每条新条目发一条新消息。
// 已发消息 id / 已发条数记在 scripts/discord/state.json，别手删。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const STATE_PATH = resolve(HERE, 'state.json');
const OVERVIEW_MD = resolve(ROOT, 'docs/discord/overview.md');
const CHANGELOG_MD = resolve(ROOT, 'docs/discord/changelog.md');

const WEBHOOK = (process.env.DISCORD_WEBHOOK_URL || '').trim();
if (!WEBHOOK) {
  console.error('缺少 DISCORD_WEBHOOK_URL（放 .env，脚本用 --env-file 读）。');
  process.exit(1);
}

const COLOR_OVERVIEW = 0x5865f2; // Discord 蓝
const COLOR_CHANGELOG = 0x57f287; // 绿
const EMBED_LIMIT = 3900; // 单个 embed description 上限 4096，留点余量

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readState() {
  if (!existsSync(STATE_PATH)) return { overviewMessageIds: [], changelogPostedCount: 0 };
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { overviewMessageIds: [], changelogPostedCount: 0 };
  }
}
function writeState(s) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
}

async function api(method, path, body) {
  const res = await fetch(WEBHOOK + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    const wait = Math.ceil((j.retry_after || 1) * 1000) + 250;
    console.warn(`  被限流，等 ${wait}ms 重试…`);
    await sleep(wait);
    return api(method, path, body);
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

const postMessage = (embed) => api('POST', '?wait=true', { embeds: [embed] }).then((m) => m.id);
const editMessage = (id, embed) => api('PATCH', `/messages/${id}`, { embeds: [embed] });
const deleteMessage = (id) => api('DELETE', `/messages/${id}`);

// 按行累积切块，尽量在行边界断开；单行超限则硬切。
function chunk(text, size) {
  const out = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (line.length > size) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size));
      continue;
    }
    if ((buf + '\n' + line).length > size) { out.push(buf); buf = line; }
    else buf = buf ? buf + '\n' + line : line;
  }
  if (buf) out.push(buf);
  return out.length ? out : [''];
}

async function syncOverview() {
  if (!existsSync(OVERVIEW_MD)) { console.log('· 没有 overview.md，跳过功能说明'); return; }
  const md = readFileSync(OVERVIEW_MD, 'utf8').trim();
  const parts = chunk(md, EMBED_LIMIT);
  const state = readState();
  const ids = Array.isArray(state.overviewMessageIds) ? [...state.overviewMessageIds] : [];

  for (let i = 0; i < parts.length; i++) {
    const embed = { description: parts[i], color: COLOR_OVERVIEW };
    if (i === 0) embed.title = '📘 功能说明';
    if (parts.length > 1) embed.footer = { text: `${i + 1} / ${parts.length}` };
    if (ids[i]) { await editMessage(ids[i], embed); console.log(`· 功能说明 #${i + 1} 已更新`); }
    else { ids[i] = await postMessage(embed); console.log(`· 功能说明 #${i + 1} 已发布`); }
    await sleep(300);
  }
  for (let i = parts.length; i < ids.length; i++) {
    await deleteMessage(ids[i]).catch(() => {});
    await sleep(300);
  }
  ids.length = parts.length;
  state.overviewMessageIds = ids;
  writeState(state);
}

// changelog.md 按 /^## / 切条目；文件头的 HTML 注释在第一个 ## 之前，自动忽略。
function parseEntries(md) {
  const blocks = md.split(/^##\s+/m).slice(1);
  return blocks.map((b) => {
    const nl = b.indexOf('\n');
    const title = (nl === -1 ? b : b.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : b.slice(nl + 1)).trim();
    return { title, body };
  });
}

async function syncChangelog() {
  if (!existsSync(CHANGELOG_MD)) { console.log('· 没有 changelog.md，跳过更新记录'); return; }
  const entries = parseEntries(readFileSync(CHANGELOG_MD, 'utf8'));
  const state = readState();
  const posted = state.changelogPostedCount || 0;
  const pending = entries.slice(posted);
  if (!pending.length) { console.log('· 更新记录：无新条目'); }
  for (const e of pending) {
    await postMessage({
      title: `🆕 ${e.title}`.slice(0, 256),
      description: (e.body || '（无正文）').slice(0, 4096),
      color: COLOR_CHANGELOG,
      timestamp: new Date().toISOString(),
    });
    console.log(`· 更新记录已推送：${e.title}`);
    await sleep(400);
  }
  state.changelogPostedCount = entries.length;
  writeState(state);
}

const cmd = process.argv[2] || 'all';
try {
  if (cmd === 'overview' || cmd === 'all') await syncOverview();
  if (cmd === 'changelog' || cmd === 'all') await syncChangelog();
  console.log('完成。');
} catch (err) {
  console.error('同步失败：', err.message);
  process.exit(1);
}
