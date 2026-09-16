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

/** JSON 里的说明字段，不是词条 */
const META_KEY = '_comment'

function stripMeta(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k !== META_KEY) out[k] = v
  }
  return out
}

export const BASE_TEAMS = stripMeta(teamsJson as Record<string, string>)
export const BASE_LEAGUES = stripMeta(leaguesJson as Record<string, string>)

const LS_TEAMS = 'dict.teams.zh'
const LS_LEAGUES = 'dict.leagues.zh'
const LS_ICONS = 'dict.teams.icon'

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

export function reloadOverrides(): void {
  ovTeams = readLS(LS_TEAMS)
  ovLeagues = readLS(LS_LEAGUES)
  ovIcons = readLS(LS_ICONS)
}

export function getOverrides(): {
  teams: Record<string, string>
  leagues: Record<string, string>
  icons: Record<string, string>
} {
  return { teams: { ...ovTeams }, leagues: { ...ovLeagues }, icons: { ...ovIcons } }
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

  for (const [re, to] of TERMS) text = text.replace(re, to)
  return text.replace(/\s+/g, ' ').trim()
}

/** 导出成可直接粘进仓库 JSON 的形状（基准 + 覆盖合并，按键排序） */
export function exportMerged(): { teams: string; leagues: string; icons: string } {
  const sortObj = (o: Record<string, string>) =>
    JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))), null, 2)
  return {
    teams: sortObj({ ...BASE_TEAMS, ...ovTeams }),
    leagues: sortObj({ ...BASE_LEAGUES, ...ovLeagues }),
    icons: sortObj(ovIcons),
  }
}
