/**
 * 队名 / 联赛名的中文化。
 *
 * ## 数据从哪来
 *
 * 三层，优先级从高到低：
 *   1. localStorage 覆盖层 —— 管理页面改的东西，只在本机生效
 *   2. 仓库 JSON（src/data/*.zh.json）—— 基准词典，跟代码一起提交和部署
 *   3. 查不到就原样返回英文
 *
 * 第 3 层是刻意的：译名是**渐进增强**，不是必需品。新球队每周都会出现，
 * 查不到时显示 "Once Caldas" 远好过显示空白或 "未知球队"。
 *
 * ## 为什么不存「球队 → 联赛」的映射
 *
 * 升降级每年都在变，存一份映射就等于承诺每年维护它，而且必然过期。
 * 每个赛事自己带联赛信息，读的时候现取即可，零维护。
 *
 * ## 联赛名为什么从图片 URL 反解
 *
 * Gamma 的 tag 里几乎拿不到联赛：实测 857 场里 soccer-* tag 命中 0 次，
 * 而 event.image 的路径 soccer-leagues/<code>.png 命中 184 次。
 * 图片路径比 tag 可靠，所以联赛代码从它反解。
 */
import teamsJson from '@/data/teams.zh.json'
import leaguesJson from '@/data/leagues.zh.json'
import leaguesEnJson from '@/data/leagues.en.json'
import { getLang } from './i18n'

/** JSON 里的说明字段，不是词条 */
/**
 * 以下划线开头的键是说明 / 分节注释，不是词条。
 * 除了顶部的 `_comment`，批量导入时也会插入 `_imported_from_trader` 这类分节标记
 * （见 teams.zh.json 后半段）；统一按前缀剥离，免得假词条混进 BASE_TEAMS 污染计数和导出。
 */
const isMetaKey = (k: string): boolean => k.startsWith('_')

function stripMeta(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!isMetaKey(k)) out[k] = v
  }
  return out
}

export const BASE_TEAMS = stripMeta(teamsJson as Record<string, string>)
export const BASE_LEAGUES = stripMeta(leaguesJson as Record<string, string>)
const LEAGUES_EN = stripMeta(leaguesEnJson as Record<string, string>)

const LS_TEAMS = 'dict.teams.zh'
const LS_LEAGUES = 'dict.leagues.zh'
const LS_ICONS = 'dict.teams.icon'
const LS_LEAGUE_ICONS = 'dict.leagues.icon'

function readLS(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
  } catch {
    // localStorage 可能被禁用（隐私模式），或存了坏数据。
    // 覆盖层丢失只影响未提交的编辑，不该让整个页面挂掉。
    return {}
  }
}

function writeLS(key: string, v: Record<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* 配额满或被禁用，忽略 */
  }
}

/** 覆盖层。读一次缓存在内存里，管理页面改动后调 reloadOverrides() */
let ovTeams = readLS(LS_TEAMS)
let ovLeagues = readLS(LS_LEAGUES)
let ovIcons = readLS(LS_ICONS)
let ovLeagueIcons = readLS(LS_LEAGUE_ICONS)

export function reloadOverrides(): void {
  ovTeams = readLS(LS_TEAMS)
  ovLeagues = readLS(LS_LEAGUES)
  ovIcons = readLS(LS_ICONS)
  ovLeagueIcons = readLS(LS_LEAGUE_ICONS)
}

export function getOverrides(): {
  teams: Record<string, string>
  leagues: Record<string, string>
  icons: Record<string, string>
  leagueIcons: Record<string, string>
} {
  return {
    teams: { ...ovTeams },
    leagues: { ...ovLeagues },
    icons: { ...ovIcons },
    leagueIcons: { ...ovLeagueIcons },
  }
}

export function setTeamOverride(en: string, zh: string | null): void {
  if (zh == null || zh.trim() === '') delete ovTeams[en]
  else ovTeams[en] = zh.trim()
  writeLS(LS_TEAMS, ovTeams)
}

export function setLeagueOverride(code: string, zh: string | null): void {
  if (zh == null || zh.trim() === '') delete ovLeagues[code]
  else ovLeagues[code] = zh.trim()
  writeLS(LS_LEAGUES, ovLeagues)
}

export function setTeamIcon(en: string, url: string | null): void {
  if (url == null || url.trim() === '') delete ovIcons[en]
  else ovIcons[en] = url.trim()
  writeLS(LS_ICONS, ovIcons)
}

/**
 * 联赛图标覆盖。
 *
 * 常规情况下不需要 —— Gamma 的 event.image 就是联赛徽标，直接用。
 * 这里只处理两种例外：某场赛事没带图（实测 857 场里只有 184 场带），
 * 或者官方那张图不好看/不清楚，想换一张。
 */
export function setLeagueIcon(code: string, url: string | null): void {
  if (url == null || url.trim() === '') delete ovLeagueIcons[code]
  else ovLeagueIcons[code] = url.trim()
  writeLS(LS_LEAGUE_ICONS, ovLeagueIcons)
}

/**
 * 查表用的规范化键：小写、去掉常见俱乐部后缀/前缀噪音。
 *
 * Gamma 的队名带各种后缀（Everton FC / Manchester United FC / AS Monaco FC），
 * 而人手写词典时往往只写主名。归一化让两边能对上，少写一堆重复词条。
 */
export function normalizeTeamKey(en: string): string {
  return en
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(fc|afc|sc|ac|as|ss|rc|cd|ca|cf|club|fk|pfk|nk|sk|us|sv|vfl|tsg)\s+/, '')
    .replace(/\s+(fc|afc|sc|ac|cf|cd|ca|fk|sk|bk|if|jk|kv|sad)$/, '')
    .trim()
}

/** 查表：覆盖层 → 基准 → 精确 → 归一化 → 查不到返回 null */
function lookupTeam(en: string): string | null {
  if (ovTeams[en]) return ovTeams[en]
  if (BASE_TEAMS[en]) return BASE_TEAMS[en]

  const norm = normalizeTeamKey(en)
  // 归一化匹配：把两边都归一化后再比，这样 "Everton FC" 能命中词条 "Everton"
  for (const src of [ovTeams, BASE_TEAMS]) {
    for (const [k, v] of Object.entries(src)) {
      if (normalizeTeamKey(k) === norm) return v
    }
  }
  return null
}

/**
 * 缺译名收集。
 *
 * 不报错、不打日志 —— 收集起来给管理页面显示「这些队还没译名」，
 * 这样补词典有依据，不用靠肉眼在图上找英文。
 */
const missingTeams = new Set<string>()
const missingLeagues = new Set<string>()

export function missing(): { teams: string[]; leagues: string[] } {
  return {
    teams: [...missingTeams].sort(),
    leagues: [...missingLeagues].sort(),
  }
}

export function clearMissing(): void {
  missingTeams.clear()
  missingLeagues.clear()
}

/** 队名中文化。查不到原样返回英文，并记进缺失表 */
export function translateTeam(en: string | null | undefined): string {
  if (!en) return ''
  const hit = lookupTeam(en)
  if (hit) return hit
  missingTeams.add(en)
  return en
}

/** 球队图标 URL。Gamma 不提供球队级图标，只有管理页面手工填的 */
export function teamIcon(en: string | null | undefined): string | null {
  if (!en) return null
  return ovIcons[en] ?? null
}

/**
 * 联赛图标 URL。覆盖优先，其次用 Gamma 给的那张。
 *
 * 参数带 fallback 是因为 Gamma 的图挂在**赛事**上而不是联赛上，
 * 这个模块拿不到赛事，只能由调用方把 event.image 传进来。
 */
export function leagueIcon(
  code: string | null | undefined,
  fallback?: string | null,
): string | null {
  if (code && ovLeagueIcons[code]) return ovLeagueIcons[code]
  return fallback ?? null
}

/**
 * 从 Gamma 的图片 URL 反解联赛代码。
 *
 * 路径形如 .../soccer-leagues/col1.png。不是这个形状就返回 null ——
 * 很多赛事的 image 是赛事海报而不是联赛徽标（例如金球奖那种非对阵盘）。
 */
export function leagueCodeFromImage(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/soccer-leagues\/([a-z0-9_-]+)\.(png|jpg|jpeg|svg|webp)/i)
  return m ? m[1].toLowerCase() : null
}

/** 联赛代码 → 中文名。查不到返回 null（不显示代码本身，那对用户没有意义） */
export function translateLeague(code: string | null | undefined): string | null {
  if (!code) return null
  const hit = ovLeagues[code] ?? BASE_LEAGUES[code]
  if (hit) return hit
  missingLeagues.add(code)
  return null
}

/**
 * 按界面语言显示的队名 / 联赛名。
 *
 * 与 translateTeam / translateLeague 分开：那两个的语义是「中文译名」，词典管理页
 * 和搜索都靠它（缺失表也是它记的），不能跟着界面语言变。界面上显示的走这两个。
 */
export function displayTeam(en: string | null | undefined): string {
  return getLang() === 'en' ? (en ?? '') : translateTeam(en)
}

export function displayLeague(code: string | null | undefined): string | null {
  return getLang() === 'en' ? leagueEn(code) : translateLeague(code)
}

/** 联赛英文名。查不到返回 null，口径同 translateLeague */
export function leagueEn(code: string | null | undefined): string | null {
  return code ? (LEAGUES_EN[code] ?? null) : null
}

/**
 * 盘口问句的中文化。
 *
 * 先换队名（长的先换，否则短名会先命中长名的一部分），再套术语表。
 * 这是**替换**而不是翻译：Polymarket 的问句是模板生成的，句式有限，
 * 正则替换就够；上真正的机器翻译反而会把队名和线值搞乱。
 *
 * ## 术语表按实测句式写，不是照原项目搬
 *
 * 原项目那份术语表（Halftime Result / Over\/Under / First Team to Score）
 * 对不上 Gamma 的实际问句 —— 实测 944 个足球问句归并成 29 个模板，
 * 里面根本没有 "Halftime Result"，用的是 "{T} leading at halftime?"；
 * 也没有 "Over/Under"，用的是 "O/U {N}"。照搬只能命中零星几条。
 *
 * 实测模板（出现次数从多到少，{T}=队名 {N}=数字 {D}=日期）：
 *   240  Exact Score: {T} {N} - {N} {T}?
 *    80  {T} vs. {T}: {T} O/U {N} Corners
 *    70  {T} vs. {T}: O/U {N} Total Corners
 *    48  {T} vs. {T}: O/U {N}
 *    48  {T} vs. {T}: {T} O/U {N}
 *    34  Will {T} win on {D}?
 *    32  {T} leading at halftime?
 *    32  {T} to win the second half?
 *    32  Spread: {T} (-{N})
 *    32  {T} vs. {T}: {T} {N}st/nd Half O/U {N}
 *    30  {T} to score first vs. {T}?
 *    17  Will {T} vs. {T} end in a draw?
 *    16  {T} vs. {T}: Draw at halftime?
 *    16  {T} vs. {T}: Second half draw?
 *    15  Exact Score: Any Other Score?
 *    15  {T} vs. {T}: Neither team to score first?
 *    10  {T} vs. {T}: Total Corners Odd or Even?
 *    10  {T} vs. {T}: Team to Take First Corner
 *     8  {T} vs. {T}: Both Teams to Score [in First/Second Half]
 *
 * ## 顺序是正确性的一部分
 *
 * 具体的必须排在笼统的前面，否则会被先拆碎：
 *   "Total Corners Odd or Even" 若晚于 "Total Corners"，会变成「总角球 Odd or Even」
 *   "O/U 2.5 Total Corners"     若晚于裸 "O/U"，会变成「大小球 2.5 总角球」
 *   "Both Teams to Score in First Half" 若晚于 "Both Teams to Score"，后半截留英文
 */
const TERMS: Array<[RegExp, string]> = [
  // ---- 准确比分。整句型「Any Other Score」必须排在前缀替换之前 ----
  [/Exact\s+Score:\s*Any\s+Other\s+Score/gi, '准确比分：其他'],
  [/Exact\s+Score:\s*/gi, '准确比分 '],

  // ---- 角球。三条 O/U 变体各自带单位，必须先于裸 O/U ----
  [/Total\s+Corners\s+Odd\s+or\s+Even/gi, '总角球单双'],
  [/Team\s+to\s+Take\s+First\s+Corner/gi, '率先获得角球'],
  [/O\/U\s+([\d.]+)\s+Total\s+Corners/gi, '总角球 $1'],
  [/O\/U\s+([\d.]+)\s+Corners/gi, '角球 $1'],
  [/Total\s+Corners/gi, '总角球'],

  // ---- 半场。要在 O/U 之前，让「1st Half O/U 1.5」先变成「上半场 O/U 1.5」----
  [/\b1st\s+Half\b/gi, '上半场'],
  [/\b2nd\s+Half\b/gi, '下半场'],
  [/\bin\s+First\s+Half\b/gi, '（上半场）'],
  [/\bin\s+Second\s+Half\b/gi, '（下半场）'],

  // ---- 大小球：剩下的裸 O/U ----
  [/O\/U\s+([\d.]+)/gi, '大小球 $1'],
  [/Over\/Under/gi, '大小球'],

  [/\bSpread:\s*/gi, '让球 '],

  // ---- 胜负与平局 ----
  // Will 是英文疑问句的引导词，中文不需要，去掉后句子反而更短更清楚
  [/^Will\s+/i, ''],
  // 日期一并吃掉：盘口本来就属于某场比赛，问句里重复日期是噪音
  [/\s+win\s+on\s+\d{4}-\d{2}-\d{2}/gi, ' 获胜'],
  [/\s+win\s+the\s+match/gi, ' 赢得比赛'],
  [/\s+end\s+in\s+a\s+(draw|tie)/gi, ' 打平'],
  [/\bleading\s+at\s+halftime/gi, '半场领先'],
  [/\bDraw\s+at\s+halftime/gi, '半场平局'],
  [/\bSecond\s+half\s+draw/gi, '下半场平局'],
  [/\bto\s+win\s+the\s+second\s+half/gi, '赢下下半场'],

  // 「谁都没先进球」要先于「率先进球」，否则剩个孤零零的 Neither team
  [/\bNeither\s+team\s+to\s+score\s+first/gi, '双方均未率先进球'],
  [/\bto\s+score\s+first/gi, '率先进球'],
  [/\bFirst\s+Team\s+to\s+Score/gi, '率先进球'],
  [/\bBoth\s+Teams\s+to\s+Score/gi, '双方均进球'],

  [/\bHalftime\s+Result/gi, '半场结果'],
  [/\bSecond\s+Half\s+Result/gi, '下半场结果'],
  [/\bTotal\s+Goals/gi, '总进球'],
  [/\bHandicap/gi, '让球'],
  [/\bDraw\b/gi, '平局'],

  // ---- 标点归一。中英标点混排（"狼队 打平?"）看着像没翻完 ----
  [/\s*vs\.\s*/gi, ' vs '],
  [/\s*:\s*/g, '：'],
  [/\?/g, '？'],
]

export function translateQuestion(
  en: string | null | undefined,
  homeEn?: string | null,
  awayEn?: string | null,
): string {
  if (!en) return ''
  let text = en

  // 队名先换长的：Manchester United 若先换成 "曼联"，"Manchester City" 里的
  // "Manchester" 就不会被误伤；反过来则会。
  const pairs = [
    { en: homeEn ?? '', zh: translateTeam(homeEn) },
    { en: awayEn ?? '', zh: translateTeam(awayEn) },
  ]
    .filter((p) => p.en && p.zh && p.en !== p.zh)
    .sort((a, b) => b.en.length - a.en.length)

  for (const { en: e, zh } of pairs) {
    text = text.replace(new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), zh)
  }

  return applyTerms(text)
}

/** 术语表替换 + 空白归一。从 translateQuestion 抽出来，好让 localizeMarketTitle 复用。 */
function applyTerms(text: string): string {
  for (const [re, to] of TERMS) text = text.replace(re, to)
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 队名匹配表：一份**精确**（大小写不敏感的原文）、一份**归一化**（strip 掉 CF/FC 等前后缀）。
 *
 * 两级匹配，和 lookupTeam 一个口径：先精确、后归一化。这很重要 ——
 *  - 归一化是「Real Madrid」对上词典键「Real Madrid CF」的关键（否则常见球队永远译不出）；
 *  - 但归一化会把「FC Barcelona」和「Barcelona SC（厄瓜多尔）」都压成 barcelona 撞车，
 *    所以标题里写全的「FC Barcelona」要先走精确匹配拿到对的那支，撞车只在没有精确写法时才发生。
 *
 * 都用 **first-wins**，且覆盖层（ovTeams）先加、基准后加 —— 覆盖优先，同 lookupTeam。
 * 覆盖层条目数变了就重建（生产环境没有覆盖层）。
 */
let teamMapCache: { size: number; exact: Map<string, string>; norm: Map<string, string> } | null = null
function teamMaps() {
  const size = Object.keys(ovTeams).length
  if (teamMapCache && teamMapCache.size === size) return teamMapCache
  const exact = new Map<string, string>()
  const norm = new Map<string, string>()
  const add = (en: string, zh: string) => {
    if (!en || !zh || en === zh) return
    const lc = en.toLowerCase()
    if (!exact.has(lc)) exact.set(lc, zh)
    const nk = normalizeTeamKey(en)
    if (!norm.has(nk)) norm.set(nk, zh)
  }
  for (const [en, zh] of Object.entries(ovTeams)) add(en, zh)
  for (const [en, zh] of Object.entries(BASE_TEAMS)) add(en, zh)
  teamMapCache = { size, exact, norm }
  return teamMapCache
}

/** 一个候选串是不是已知队名，是则给中文（先精确后归一化），否则 null */
function tryTeam(cand: string): string | null {
  const c = cand.trim()
  if (!c) return null
  const { exact, norm } = teamMaps()
  return exact.get(c.toLowerCase()) ?? norm.get(normalizeTeamKey(c)) ?? null
}

/** 一段（不含分隔符）里最长的球队词组换成中文，其余原样 */
function translateFragmentTeams(frag: string): string {
  const lead = frag.match(/^\s*/)?.[0] ?? ''
  const trail = frag.match(/\s*$/)?.[0] ?? ''
  const core = frag.trim()
  if (!core) return frag
  const words = core.split(/\s+/)
  // 词组从长到短、从左到右试：优先命中「Real Madrid」而不是先啃到某个单词
  for (let len = words.length; len >= 1; len--) {
    for (let start = 0; start + len <= words.length; start++) {
      const zh = tryTeam(words.slice(start, start + len).join(' '))
      if (!zh) continue
      const before = words.slice(0, start).join(' ')
      const after = words.slice(start + len).join(' ')
      return lead + [before, zh, after].filter(Boolean).join(' ') + trail
    }
  }
  return frag
}

/**
 * 把标题里的球队名换成中文（不依赖「主队 vs 客队」的固定结构）。
 *
 * 先按 vs / 冒号 / 破折号 / 斜杠 / 括号切成小段（这些位置不会横跨一个队名），每段再做
 * 归一化的最长词组匹配 —— 「联赛：主队 vs 客队 - 盘口」里的两个队名都能单独认出来。
 */
function scanTeams(text: string): string {
  const DELIM = /(\s+vs\.?\s+|[:：/()]|\s[-–—]\s)/gi
  return text
    .split(DELIM)
    .map((part) => (/^(\s+vs\.?\s+|[:：/()]|\s[-–—]\s)$/i.test(part) ? part : translateFragmentTeams(part)))
    .join('')
}

/**
 * 盘口标题的展示化，给「我的订单」列表和导出用（data-api 的 `title` 只有英文）。
 *
 * **只处理含「vs」的对阵盘**：足球盘口标题都是「主队 vs 客队 [- 盘口]」的形状，vs 是可靠的
 * 足球信号。含 vs 时按 vs / 冒号 / 破折号切段、每段做归一化的最长队名匹配（scanTeams），再套
 * 术语表与标点归一（applyTerms）。
 *
 * 不含 vs 的（政治、选举这类「Will X win …」）**原样返回**：那些没有对阵结构，硬扫队名会把
 * 「Seoul」这种词误当球队译掉、还被术语表切掉引导词 Will，读成半截残句 —— 宁可不译，不能译错。
 */
export function localizeMarketTitle(title: string | null | undefined): string {
  const s = (title ?? '').trim()
  if (!s || getLang() === 'en') return s
  if (!/\svs\.?\s/i.test(s)) return s
  return applyTerms(scanTeams(s))
}

/**
 * 从 data-api 的盘口标题里拆出「比赛（谁对谁）」和「盘口后缀」两部分（**原文**，不翻译）。
 *
 * data-api 标题形如「[联赛：]主队 vs 客队[ - 盘口]」。以 vs 为锚：
 *  - 盘口后缀 = vs 之后第一个「 - / – / — 」（其次「: 」）之后的部分；胜平负盘没有后缀。
 *  - 比赛 = 前半段去掉 vs 之前的联赛前缀「Xxx: 」。
 *
 * 没有 vs 的（政治、是非盘等）整条当作「比赛」、盘口后缀为空 —— 由 localizeMarketType 按结果
 * 兜底成「是非 / 胜平负」。分组就按这里的 match 原文做键（与语言无关）。
 */
export function splitMatchMarket(title: string | null | undefined): { match: string; market: string } {
  const t = (title ?? '').trim()
  if (!t) return { match: '', market: '' }
  const vs = t.search(/\svs\.?\s/i)
  if (vs < 0) return { match: t, market: '' }
  let sep = -1
  const dash = t.slice(vs).search(/\s[-–—]\s/)
  if (dash >= 0) sep = vs + dash
  else {
    const colon = t.slice(vs).search(/\s*[:：]\s/)
    if (colon >= 0) sep = vs + colon
  }
  let matchPart = sep >= 0 ? t.slice(0, sep) : t
  const market = sep >= 0 ? t.slice(sep).replace(/^\s*[-–—:：]\s*/, '').trim() : ''
  // 去掉 vs 之前的联赛前缀「Xxx: 」
  const pc = matchPart.search(/[:：]\s/)
  const vm = matchPart.search(/\svs\.?\s/i)
  if (pc >= 0 && pc < vm) matchPart = matchPart.slice(pc + 1)
  return { match: matchPart.trim(), market }
}

/**
 * 盘口类型的中文化（不含「选择」那一侧，那是 localizeOutcome 的事）。
 *
 * 有后缀就翻后缀（总进球 / 让球 / 双方进球…，走术语表；后缀里带队名也一并扫），没有后缀就按
 * 结果兜底：Yes/No → 是非，其余（队名 / 平局）→ 胜平负。英文模式给英文（后缀原样 / Match Result）。
 */
export function localizeMarketType(rawMarket: string | null | undefined, outcome: string | null | undefined): string {
  const m = (rawMarket ?? '').trim()
  const en = getLang() === 'en'
  if (m) return en ? m : applyTerms(scanTeams(m))
  const o = (outcome ?? '').trim().toLowerCase()
  if (o === 'yes' || o === 'no') return en ? 'Yes / No' : '是非'
  return en ? 'Match Result' : '胜平负'
}

/** Polymarket 足球盘口玩法 → 中英名（sportsMarketType 见 gamma 返回的枚举） */
const SPORTS_MARKET: Record<string, [string, string]> = {
  moneyline: ['胜平负', 'Match Result'],
  spreads: ['让球', 'Handicap'],
  totals: ['总进球', 'Total Goals'],
  both_teams_to_score: ['双方进球', 'Both Teams to Score'],
  both_teams_to_score_first_half: ['上半场双方进球', 'BTTS · 1st Half'],
  both_teams_to_score_second_half: ['下半场双方进球', 'BTTS · 2nd Half'],
  soccer_halftime_result: ['半场胜平负', 'Halftime Result'],
  soccer_second_half_result: ['下半场胜平负', 'Second Half Result'],
  soccer_exact_score: ['准确比分', 'Exact Score'],
  soccer_first_to_score: ['首先进球', 'First to Score'],
  first_half_totals: ['上半场进球', '1st Half Goals'],
  second_half_totals: ['下半场进球', '2nd Half Goals'],
  soccer_team_totals: ['球队进球', 'Team Goals'],
  soccer_first_half_team_totals: ['上半场球队进球', '1st Half Team Goals'],
  soccer_second_half_team_totals: ['下半场球队进球', '2nd Half Team Goals'],
  total_corners: ['总角球', 'Total Corners'],
  soccer_first_half_total_corners: ['上半场角球', '1st Half Corners'],
  soccer_second_half_total_corners: ['下半场角球', '2nd Half Corners'],
  soccer_team_total_corners: ['球队角球', 'Team Corners'],
  soccer_game_corners_odd_even: ['角球单双', 'Corners Odd/Even'],
  soccer_first_corner: ['首个角球', 'First Corner'],
}

/**
 * 盘口玩法的中文化，优先用 Gamma 的 sportsMarketType（可靠），没有再退到翻译赛事标题后缀，
 * 都没有就按 moneyline 兜底（胜平负）。
 */
export function localizeSportsMarket(sportsType: string | null | undefined, suffix: string | null | undefined): string {
  const en = getLang() === 'en'
  const hit = SPORTS_MARKET[(sportsType ?? '').trim()]
  if (hit) return en ? hit[1] : hit[0]
  const s = (suffix ?? '').trim()
  if (s) return en ? s : applyTerms(scanTeams(s))
  return en ? 'Match Result' : '胜平负'
}

/** 去掉尾部括注，如 "Draw (A vs B)" → "Draw" */
function stripParen(s: string): string {
  return s.replace(/\s*[（(].*$/, '').trim()
}

/** 一个「主语」（队名 / 比分 / 平局等）的中文化：先扫队名，扫不动再按结果词表 */
function localizeSubject(s: string | null | undefined): string {
  const t = (s ?? '').trim()
  if (!t || getLang() === 'en') return t
  const z = applyTerms(scanTeams(t))
  if (z !== t) return z
  return localizeOutcome(t)
}

/** 玩法本身就是 Yes/No 命题（选是/否，主语不必再显示）的类型 */
const BINARY_PROP = new Set([
  'both_teams_to_score',
  'both_teams_to_score_first_half',
  'both_teams_to_score_second_half',
  'soccer_game_corners_odd_even',
])

/**
 * 「选择」那一侧的中文化，把 Gamma 的结果信息拼成人话。
 *
 *  - 大小球：Over/Under（+线值）→ 大/小 2.5
 *  - 让球：outcome 是队名，groupItemTitle 常带线值 "Team (-1.5)" —— 用它
 *  - Yes/No 命题（双方进球、角球单双…）→ 是/否
 *  - 其余 Yes/No（胜平负、半场、准确比分、首先进球…）→ 主语（队名/比分），持 No 的加「否：」前缀
 *  - 兜底：直接把 outcome 当结果词译
 */
export function localizePick(o: {
  outcome?: string | null
  groupItemTitle?: string | null
  line?: number | null
  sportsType?: string | null
}): string {
  const en = getLang() === 'en'
  const oc = (o.outcome ?? '').trim()
  const ocl = oc.toLowerCase()
  const lineStr = o.line != null && Number.isFinite(o.line) ? ` ${o.line}` : ''
  if (ocl === 'over') return en ? `Over${lineStr}` : `大${lineStr}`
  if (ocl === 'under') return en ? `Under${lineStr}` : `小${lineStr}`
  if ((o.sportsType ?? '') === 'spreads') {
    // 让球是两支球队各持一侧：groupItemTitle 只标了**被让方（favorite，负让球）**，如
    // "Germany (-1.5)"。持仓真正买的哪一侧看 outcome（就是队名）——买的是另一支时，让球要**反号**
    // （+1.5）。之前直接拿 groupItemTitle 当选择，买客队 +1.5 会被错标成主队 -1.5。
    const git = (o.groupItemTitle ?? '').trim()
    const favTeam = git.replace(/\s*[（(].*$/, '').trim()
    const m = git.match(/\(\s*([-+]?\d*\.?\d+)\s*\)/)
    const favLine = m ? Number(m[1]) : o.line == null ? null : Number(o.line)
    const held = oc || favTeam
    let myLine = favLine
    if (favTeam && favLine != null && Number.isFinite(favLine)) {
      const isFav = normalizeTeamKey(held) === normalizeTeamKey(favTeam)
      myLine = isFav ? favLine : -favLine
    }
    const teamZh = localizeSubject(held) || held
    const lineStr = myLine != null && Number.isFinite(myLine) ? ` ${myLine > 0 ? '+' : ''}${myLine}` : ''
    return `${teamZh}${lineStr}`
  }
  if (ocl === 'yes' || ocl === 'no') {
    if (BINARY_PROP.has(o.sportsType ?? '')) return en ? (ocl === 'yes' ? 'Yes' : 'No') : ocl === 'yes' ? '是' : '否'
    const subj = localizeSubject(stripParen(o.groupItemTitle ?? ''))
    if (!subj) return en ? (ocl === 'yes' ? 'Yes' : 'No') : ocl === 'yes' ? '是' : '否'
    if (ocl === 'no') return en ? `No: ${subj}` : `否：${subj}`
    return subj
  }
  return localizeSubject(oc) || localizeOutcome(oc)
}

/**
 * 单个结果（买/持有的那一侧）的展示化。
 *
 * data-api 的 `outcome` 是英文：胜平负盘是**队名**（走 translateTeam），大小球是
 * Over/Under（可能带比分线，如 "Over 2.5"），是非盘是 Yes/No。队名以外的几种在
 * translateQuestion 的 TERMS 里没有**独立**词条（那边只认 "O/U 2.5" 这种组合），
 * 所以在这里单独列出来。英文模式原样返回。
 */
export function localizeOutcome(outcome: string | null | undefined): string {
  const s = (outcome ?? '').trim()
  if (!s || getLang() === 'en') return s
  const lower = s.toLowerCase()
  if (lower === 'yes') return '是'
  if (lower === 'no') return '否'
  if (lower === 'draw' || lower === 'tie') return '平局'
  const over = s.match(/^over\s*([\d.]+)?$/i)
  if (over) return over[1] ? `大 ${over[1]}` : '大球'
  const under = s.match(/^under\s*([\d.]+)?$/i)
  if (under) return under[1] ? `小 ${under[1]}` : '小球'
  // 剩下的多半是队名（胜平负盘的选项就是队名本身）
  return translateTeam(s)
}

/**
 * 导出成可直接粘进仓库 JSON 的形状（基准 + 覆盖合并，按键排序）。
 *
 * 排序是刻意的：JSON 顺序稳定，git diff 才只显示真正改动的那几行，
 * 否则每次导出都是整文件重排，review 无从下手。
 */
export function exportMerged(): {
  teams: string
  leagues: string
  icons: string
  leagueIcons: string
} {
  const sortObj = (o: Record<string, string>) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))),
      null,
      2,
    )
  return {
    teams: sortObj({ ...BASE_TEAMS, ...ovTeams }),
    leagues: sortObj({ ...BASE_LEAGUES, ...ovLeagues }),
    icons: sortObj(ovIcons),
    leagueIcons: sortObj(ovLeagueIcons),
  }
}
