// 队名缺译名扫描 + 词典合并（给 /team-dict 技能用，见 .claude/skills/team-dict/SKILL.md）。
//
// 用法：
//   node scripts/dict/missing-teams.mjs                          # 列出窗口内没有中文译名的球队
//   node scripts/dict/missing-teams.mjs --days 7                 # 放宽窗口（默认 2 天 = 今天+明天，与 app 一致）
//   node scripts/dict/missing-teams.mjs --json tmp/missing.json  # 顺便写一份待填骨架 {"队名": ""}
//   node scripts/dict/missing-teams.mjs --merge tmp/filled.json  # 把填好的 {"队名":"译名"} 追加进词典
//
// ## 为什么扫的是 Gamma 而不是本地文件
//
// 「哪些球队缺译名」只有把**当前真在挂盘的那些比赛**摆出来才回答得了 —— 词典里没有的
// 队名有几千个，其中绝大多数这辈子不会出现在 Polymarket 上。所以这里按 app 同一个
// 时间窗（今天+明天）和同一个 tag 口径拉赛事，逐个队名查词典。窗口之外还有仓位的比赛
// 不算：那是「我参与过的」，不是「还能下注的」，补译名先补后者。
//
// ## 为什么不用 app 的 lib/dict.ts
//
// 它要跑在裸 node 上（没有打包器、没有 @/ 别名、TS 也吃不下），而 lib/dict.ts 是
// TS + 路径别名 + import JSON。所以这里的 normalizeTeamKey / 查表是**另一份实现**：
// **src/lib/dict.ts 是唯一真相**，改那边的口径时这一份必须同步（那边顶部也有注释
// 提到这里）。漂移的后果很安静 —— 脚本会把 app 明明译得出的队名报成「缺译名」，
// 于是词典里多出一堆冗余变体。改动任一侧时，两边各跑一次对同名样本即可发现。
//
// ## 合并为什么是「追加一段」而不是插进已有排序
//
// teams.zh.json 分两段：手工词条（按联赛分组）和 2026-09-25 从 trader 库批量导入的
// 1905 条（按英文名排）。把新词条插进那两段中间，git diff 会散落在几千行里，review
// 无从下手；追加成带日期标记的独立一段，diff 永远是文件末尾一块纯新增，也留得下
// 「这批是哪个技能补的」。查表靠键，不靠顺序，分段不影响正确性。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEAMS_JSON = resolve(HERE, '../../src/data/teams.zh.json')

const GAMMA = 'https://gamma-api.polymarket.com'
/** Gamma 单页上限。实测 limit=500 也只回 100 条，所以翻页不可避免（同 lib/gamma.ts） */
const PAGE = 100
const MAX_PAGES = 20

/**
 * 查表用的规范化键：小写、去掉常见俱乐部后缀/前缀噪音。
 *
 * ⚠️ 与 src/lib/dict.ts 的 normalizeTeamKey **逐字一致**，改一边必须改另一边。
 */
export function normalizeTeamKey(en) {
  return en
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(fc|afc|sc|ac|as|ss|rc|cd|ca|cf|club|fk|pfk|nk|sk|us|sv|vfl|tsg)\s+/, '')
    .replace(/\s+(fc|afc|sc|ac|cf|cd|ca|fk|sk|bk|if|jk|kv|sad)$/, '')
    .trim()
}

/**
 * 词典 → 两级查表（精确 + 归一化），口径同 lib/dict.ts 的 lookupTeam / teamMaps。
 *
 * 键以下划线开头的是说明/分节标记，不是词条（见 lib/dict.ts 的 isMetaKey）。
 */
export function buildLookup(dict) {
  const exact = new Map()
  const norm = new Map()
  for (const [k, v] of Object.entries(dict)) {
    if (!k || k.startsWith('_') || typeof v !== 'string' || !v) continue
    const lc = k.toLowerCase()
    if (!exact.has(lc)) exact.set(lc, v)
    const nk = normalizeTeamKey(k)
    if (!norm.has(nk)) norm.set(nk, v)
  }
  return { exact, norm }
}

/** 查得到就返回中文，查不到返回 null（「查不到」= 需要补译名） */
export function lookupTeam(lookup, en) {
  if (!en) return null
  return lookup.exact.get(en.toLowerCase()) ?? lookup.norm.get(normalizeTeamKey(en)) ?? null
}

/** 只保留足球（association football）。与 lib/gamma.ts 的 isSoccer 同一口径 */
function isSoccer(evt) {
  return (evt.tags ?? []).some((t) => {
    const slug = t.slug ?? ''
    return (
      slug === 'soccer' ||
      (slug.startsWith('soccer-') && !slug.includes('transfer')) ||
      slug === 'intlpt-soccer'
    )
  })
}

/**
 * 数组参数按**重复键**编码（`id=1&id=2`），不能用逗号拼 —— 同 lib/gamma.ts 的说明。
 */
async function gammaGet(path, params) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) qs.append(k, String(item))
    else qs.set(k, String(v))
  }
  const url = `${GAMMA}${path}?${qs}`
  let res
  try {
    res = await fetch(url)
  } catch (e) {
    // fetch 抛异常基本只有网络层问题（DNS / 连接被拒 / 被墙）
    throw new Error(
      `连不上 Polymarket（${e instanceof Error ? e.message : String(e)}）。某些网络需要代理或 VPN——先确认能打开 polymarket.com。`,
    )
  }
  if (!res.ok) throw new Error(`Gamma ${path} 返回 HTTP ${res.status}`)
  return res.json()
}

/** 去掉衍生赛事后缀，得到基础比赛标题（同 lib/gamma.ts 的 baseTitle） */
function baseTitle(title) {
  return (title ?? '').split(/\s+[-–—]\s+/)[0].trim()
}

/** 从标题拆主客队（同 lib/gamma.ts 的 splitTeams）。拆不出返回 null，非对阵盘就靠它筛掉 */
function splitTeams(title) {
  const m = title.match(/^(.+?)\s+vs\.?\s+(.+?)$/i)
  if (!m) return null
  const home = m[1].trim()
  const away = m[2].split(/\s+[-–—]\s+/)[0].trim()
  return home && away ? { home, away } : null
}

/** 联赛代码从 event.image 路径反解（.../soccer-leagues/<code>.png），同 lib/dict.ts */
function leagueFromImage(url) {
  const m = (url ?? '').match(/soccer-leagues\/([a-z0-9_-]+)\.(png|jpg|jpeg|svg|webp)/i)
  return m ? m[1].toLowerCase() : null
}

/**
 * 扫当前窗口，返回每个队名出现的场次与联赛。
 *
 * 时间窗与 lib/gamma.ts 的 fetchSoccerEvents 完全一致：起点是**北京时区今天 00:00**
 * （= UTC 昨天 16:00），长度 days 天。窗口对不上就会出现「脚本说缺译名、页面上却
 * 没见过这支球队」这种对不上的现象。
 */
async function scanWindow(days) {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 16, 0, 0))
  const end = new Date(start.getTime() + days * 24 * 3600 * 1000)
  const params = {
    tag_slug: 'soccer',
    active: true,
    closed: false,
    end_date_min: start.toISOString(),
    end_date_max: end.toISOString(),
    include_markets: false,
    limit: PAGE,
  }

  // 先问总数：拿不到就无法确认是否拉全，宁可报错（同 lib/gamma.ts 的理由）
  const head = await gammaGet('/events/pagination', { ...params, limit: 1 })
  const total = head?.pagination?.totalResults
  if (typeof total !== 'number' || !Number.isFinite(total)) throw new Error('Gamma 没有返回赛事总数，无法确认能否拉全')
  const pages = Math.ceil(total / PAGE)
  // 超上限就报错而不是截断：少拉几页 = 有些球队静默不出现在「缺译名」里，
  // 这种少数据的 bug 看不出来（同 lib/gamma.ts 的取舍）
  if (pages > MAX_PAGES) throw new Error(`足球赛事多达 ${total} 个，超出预期（${MAX_PAGES} 页），先不拉`)

  const batches = await Promise.all(
    Array.from({ length: pages }, (_, i) => gammaGet('/events', { ...params, offset: i * PAGE })),
  )
  const events = batches.flat().filter(isSoccer)

  // 一场比赛有多个衍生赛事（- Halftime Result 之类），按基础标题去重后再数队名，
  // 否则「出现 7 次」其实是同一场比赛的 7 个盘口族
  const matches = new Map()
  for (const e of events) {
    const base = baseTitle(e.title)
    const teams = base && splitTeams(base)
    if (!teams) continue
    const prev = matches.get(base)
    const league = leagueFromImage(e.image ?? e.icon)
    if (prev) {
      if (!prev.league && league) prev.league = league
      continue
    }
    matches.set(base, { teams, league })
  }

  const byTeam = new Map()
  for (const { teams, league } of matches.values()) {
    for (const name of [teams.home, teams.away]) {
      const hit = byTeam.get(name) ?? { count: 0, league: null }
      hit.count += 1
      hit.league = hit.league ?? league
      byTeam.set(name, hit)
    }
  }
  return { matches: matches.size, byTeam, start, end }
}

/** 扫一遍并把缺译名列出来。返回缺译名数组（按出现场次从多到少） */
async function reportMissing(days) {
  const dict = JSON.parse(readFileSync(TEAMS_JSON, 'utf8'))
  const lookup = buildLookup(dict)
  const { matches, byTeam, start, end } = await scanWindow(days)

  const missing = []
  for (const [name, info] of byTeam) {
    if (lookupTeam(lookup, name) == null) missing.push({ name, ...info })
  }
  missing.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const fmt = (d) => new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
  console.log(
    `窗口 ${fmt(start)} → ${fmt(end)}（北京）· ${matches} 场 · ${byTeam.size} 个队名 · 词典 ${Object.keys(dict).length} 条`,
  )
  if (missing.length === 0) {
    console.log('没有缺译名的球队。')
    return missing
  }
  console.log(`\n缺译名 ${missing.length} 个：`)
  for (const m of missing) {
    console.log(`  ${String(m.count).padStart(2)}×  ${m.name}${m.league ? `   (${m.league})` : ''}`)
  }
  console.log('\n翻译后用 --merge 合并，例如：')
  console.log('  node scripts/dict/missing-teams.mjs --json tmp/missing.json   # 写待填骨架')
  console.log('  node scripts/dict/missing-teams.mjs --merge tmp/filled.json  # 合并进词典')
  return missing
}

/** 把填好的 {"英文名": "中文名"} 追加进 teams.zh.json。返回 {added, skipped} */
export function mergeIntoDict(file) {
  const filled = JSON.parse(readFileSync(file, 'utf8'))
  const raw = readFileSync(TEAMS_JSON, 'utf8')
  const dict = JSON.parse(raw)
  const lookup = buildLookup(dict)

  const added = []
  const skipped = []
  for (const [key, value] of Object.entries(filled)) {
    const en = String(key ?? '').trim()
    const zh = String(value ?? '').trim()
    const existing = lookupTeam(lookup, en)
    if (!en || en.startsWith('_')) skipped.push([key, '键不合法（空或以 _ 开头）'])
    else if (!zh) skipped.push([en, '值是空的（没填）'])
    else if (existing != null) skipped.push([en, `已有译名「${existing}」`])
    else if (zh === en) skipped.push([en, '译名与英文相同'])
    // 乱码 / 没译成中文的兜底：批量导入那次踩过 mojibake，宁可不加也不写坏词典
    else if (zh.includes('�') || !/[一-鿿]/.test(zh)) skipped.push([en, `疑似乱码或没译成中文：「${zh}」`])
    else added.push([en, zh])
  }

  if (added.length === 0) {
    console.log('没有可加的词条。跳过的：')
    for (const [en, why] of skipped) console.log(`  ${en} —— ${why}`)
    return { added, skipped }
  }

  added.sort(([a], [b]) => a.localeCompare(b))
  const date = new Date().toISOString().slice(0, 10)
  // 同一天跑第二次时换个键名：重名键在 JSON.parse 里是后者覆盖前者，
  // 下面那句条数校验会因此报错，而那个报错看起来像「脚本坏了」
  let markerKey = `_added_${date}`
  for (let n = 2; markerKey in dict; n++) markerKey = `_added_${date}_${n}`
  const marker = `  ${JSON.stringify(markerKey)}: ${JSON.stringify(`—— 以下 ${added.length} 条为 ${date} 由 /team-dict 技能按缺译名扫描补充（按英文名排序）——`)}`
  const block = added.map(([en, zh]) => `  ${JSON.stringify(en)}: ${JSON.stringify(zh)}`).join(',\n')

  // 字符串拼接而不是 JSON.parse→stringify 回写：那会把原有分段、空行和排版全部重排，
  // 一个词条也变成几千行的 diff。这里只在末尾的 `}` 之前插一段。
  const tail = raw.lastIndexOf('}')
  const out = `${raw.slice(0, tail).replace(/[\s,]*$/, '')},\n\n${marker},\n${block}\n${raw.slice(tail)}`

  // 自己先验一遍：拼坏了就别写文件（JSON 坏掉会让整个 app 起不来）
  const check = JSON.parse(out)
  const expect = Object.keys(dict).length + added.length + 1
  if (Object.keys(check).length !== expect) {
    throw new Error(`合并后词条数不对：期望 ${expect}，实际 ${Object.keys(check).length} —— 没有写文件`)
  }
  for (const [en, zh] of added) {
    if (check[en] !== zh) throw new Error(`写进去的「${en}」对不上 —— 没有写文件`)
  }

  writeFileSync(TEAMS_JSON, out)
  console.log(`已加入 ${added.length} 条到 ${TEAMS_JSON}：`)
  for (const [en, zh] of added) console.log(`  ${en} → ${zh}`)
  if (skipped.length > 0) {
    console.log(`跳过 ${skipped.length} 条：`)
    for (const [en, why] of skipped) console.log(`  ${en} —— ${why}`)
  }
  console.log('\n跑 npx vitest run src/lib/dict.test.ts 确认词典没坏，然后 git diff 看一眼。')
  return { added, skipped }
}

async function main() {
  const args = process.argv.slice(2)
  const val = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : null
  }

  const mergeFile = val('--merge')
  if (mergeFile) {
    mergeIntoDict(mergeFile)
    return
  }

  const days = Number(val('--days') ?? 2) || 2
  const missing = await reportMissing(days)

  const jsonOut = val('--json')
  if (jsonOut) {
    const skeleton = Object.fromEntries(missing.map((m) => [m.name, '']).sort(([a], [b]) => a.localeCompare(b)))
    mkdirSync(dirname(resolve(jsonOut)), { recursive: true })
    writeFileSync(resolve(jsonOut), `${JSON.stringify(skeleton, null, 2)}\n`)
    console.log(`\n待填骨架已写到 ${jsonOut}（填中文名，留空的会被 --merge 跳过）`)
  }
}

// 只有直接跑这个文件时才执行 —— 这样测试/别的脚本 import 它拿 normalizeTeamKey 不会触发联网
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
