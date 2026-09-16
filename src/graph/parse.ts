/**
 * 问句 → 规范盘口描述（纯函数，不碰库、不发请求）。
 *
 * ## 为什么不复用 soccer_markets.market_type
 *
 * 那一列是「关键词先命中先返回」，实测把三类完全不同的盘口都归成 total：
 * 角球（"O/U 10.5 Total Corners"）、单队（"{H} O/U 2.5"）、
 * 半场（"1st Half O/U 1.5"）。全库 72,519 行 total 里混着这三类，
 * 拿它当分类标准，网状图的第一层就是错的——角球盘会和总进球盘连成
 * 同一条梯子，而进球根本不影响角球盘。
 *
 * ## 分类标准（所有比赛同一套）
 *
 * 问句拆成正交维度 period × metric × subject × family × line。
 * 拆法：先把队名替换成占位符得到「问句骨架」，再按骨架匹配。
 * 实测全库有交易量的 60,020 行只落在约 30 种骨架上（scripts 探查所得），
 * 是个封闭集合，不是启发式猜测。
 *
 * 骨架示例：
 *   {H} vs. {A}: O/U 2.5                 全场总进球
 *   {H} vs. {A}: 1st Half O/U 1.5        半场总进球
 *   {H} vs. {A}: {A} O/U 2.5             客队单队进球
 *   {H} vs. {A}: O/U 10.5 Total Corners  角球（与进球无关）
 *   Spread: {H} (-1.5)                   让球
 *   Will {H} win on 2026-08-30?          胜平负的主胜腿
 */
import type {
  Family,
  MarketDescriptor,
  Metric,
  ParseInput,
  Period,
  Subject,
} from './types.js'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 队名的候选写法：库里带 FC 后缀而问句里不带（或反之）都见过 */
function nameVariants(name: string): string[] {
  const trimmed = String(name || '').trim()
  if (!trimmed) return []
  const stripped = trimmed.replace(/\s+(FC|CF|SC|AFC)$/i, '').trim()
  const out = [trimmed]
  if (stripped && stripped !== trimmed) out.push(stripped)
  return out
}

/**
 * 把队名替换成 {H}/{A}、日期替换成 {DATE}，得到问句骨架。
 *
 * 数字**不动**：线（2.5 / -1.5）和比分（2 - 3）都要从骨架里读回来。
 *
 * 长名先替换：主客队名可能互为子串（"Chelsea FC" 与 "Chelsea"），
 * 短名先替换会把长名切成 "{H} FC"，骨架就对不上了。
 */
export function skeletonOf(input: ParseInput): string {
  let q = String(input.questionEn || '').trim()
  const pairs: Array<[string, string]> = []
  for (const v of nameVariants(input.homeTeamEn)) pairs.push([v, '{H}'])
  for (const v of nameVariants(input.awayTeamEn)) pairs.push([v, '{A}'])
  pairs.sort((a, b) => b[0].length - a[0].length)
  for (const [name, tag] of pairs) {
    q = q.replace(new RegExp(escapeRe(name), 'gi'), tag)
  }
  // 日期先抽掉，否则 "on 2026-08-30" 里的数字会被 {N} 切碎
  q = q.replace(/\d{4}-\d{2}-\d{2}/g, '{DATE}')
  return q.replace(/\s+/g, ' ').trim()
}

/** 骨架里第一个出现的队名占位符（让球/单队盘用它定 subject） */
function firstTeamTag(skeleton: string, after: number = 0): 'home' | 'away' | null {
  const h = skeleton.indexOf('{H}', after)
  const a = skeleton.indexOf('{A}', after)
  if (h < 0 && a < 0) return null
  if (h < 0) return 'away'
  if (a < 0) return 'home'
  return h < a ? 'home' : 'away'
}

/** 半场/下半场/全场。"1st Half"、"2nd Half"、"halftime" 三种写法都见过 */
function periodOf(skeleton: string): Period {
  const s = skeleton.toLowerCase()
  if (/\b1st half\b|\bfirst half\b|\bat halftime\b|\bhalftime\b/.test(s)) return 'ht'
  if (/\b2nd half\b|\bsecond half\b/.test(s)) return '2h'
  return 'ft'
}

/** 取骨架里的第一个小数线（O/U 与让球都是半整数） */
function lineOf(skeleton: string, fallback: number | string | null | undefined): number | null {
  const m = skeleton.match(/(-?\d+\.\d+)/)
  if (m) return Number(m[1])
  const n = Number(fallback)
  return Number.isFinite(n) ? n : null
}

/** 进球会不会明显推动这个盘。角球/奇偶与进球无关 */
const GOAL_SENSITIVE_METRICS = new Set<Metric>([
  'goals',
  'result',
  'exact',
  'scorer',
  'first_goal',
  'advance',
  'penalty',
])

function teamName(input: ParseInput, side: 'home' | 'away'): string {
  if (side === 'home') return input.homeTeamZh || input.homeTeamEn || '主队'
  return input.awayTeamZh || input.awayTeamEn || '客队'
}

const PERIOD_LABEL: Record<Period, string> = { ft: '全场', ht: '半场', '2h': '下半场' }

/** 组装节点上的短标签。长问句在图上放不下，节点只放这一段 */
function labelOf(
  input: ParseInput,
  d: Omit<MarketDescriptor, 'label' | 'goalSensitive'>,
): string {
  const per = d.period === 'ft' ? '' : PERIOD_LABEL[d.period]
  const who =
    d.subject === 'home' ? teamName(input, 'home')
    : d.subject === 'away' ? teamName(input, 'away')
    : ''

  switch (d.family) {
    case 'ou': {
      const what = d.metric === 'corners' ? '角球' : '球'
      const scope = who ? `${who} ` : ''
      return `${per}${scope}${d.line ?? '?'} ${what}`
    }
    case 'spread':
      return `${per}让球 ${who} ${d.line != null && d.line > 0 ? '+' : ''}${d.line ?? '?'}`
    case 'moneyline':
      return d.role === 'draw' ? `${per || '全场'}平` : `${per}${who}胜`
    case 'btts':
      return `${per}双方进球`
    case 'exact':
      return d.score ? `${per}${d.score.home}-${d.score.away}` : `${per}其他比分`
    case 'first_goal':
      return who ? `${per}${who}先进球` : `${per}无人先进球`
    case 'scorer':
      return `${d.player ?? '球员'} 进球`
    case 'advance':
      return '晋级'
    case 'penalty':
      return '点球大战'
    case 'odd_even':
      return '角球奇偶'
    case 'first_corner':
      return '首个角球'
    default:
      return '其他'
  }
}

/** 冒号后的部分。单队盘与让球盘的 subject 都写在这里 */
function tailAfterColon(skeleton: string): string {
  const i = skeleton.lastIndexOf(':')
  return i < 0 ? skeleton : skeleton.slice(i + 1).trim()
}

/** 单队盘：冒号后紧跟队名占位符（"{H} vs. {A}: {A} O/U 2.5"） */
function subjectFromTail(tail: string): Subject {
  if (/^\{H\}/.test(tail)) return 'home'
  if (/^\{A\}/.test(tail)) return 'away'
  return 'match'
}

/**
 * 让球线换算成主队视角。
 *
 * "Spread: {H} (-1.5)" = 主队让 1.5 球 → 主队视角 -1.5
 * "Spread: {A} (-1.5)" = 客队让 1.5 球 → 主队视角 +1.5
 * 换算过才能把两条让球盘放进同一条梯子比较。
 */
function spreadHomeLine(subject: Subject, line: number | null): number | null {
  if (line == null) return null
  return subject === 'away' ? -line : line
}

/**
 * 解析一条盘口。识别不出返回 null——宁可漏一个节点，
 * 也不要把认不出的问句塞进 'other' 再连出错误的约束边。
 */
export function parseMarket(input: ParseInput): MarketDescriptor | null {
  const sk = skeletonOf(input)
  const s = sk.toLowerCase()
  const period = periodOf(sk)
  const tail = tailAfterColon(sk)

  let family: Family | null = null
  let metric: Metric = 'goals'
  let subject: Subject = 'match'
  let line: number | null = null
  let score: { home: number; away: number } | null = null
  let player: string | null = null
  let role: 'home' | 'away' | 'draw' | null = null

  // ---- 准确比分（含「其他比分」）----
  if (/exact score/.test(s)) {
    family = 'exact'
    metric = 'exact'
    const m = sk.match(/\{[HA]\}\s*(\d+)\s*-\s*(\d+)\s*\{[HA]\}/)
    if (m) score = { home: Number(m[1]), away: Number(m[2]) }
  }
  // ---- O/U：角球必须排在总进球之前（两者都含 o/u）----
  else if (/\bo\/u\b|over\/under/.test(s)) {
    family = 'ou'
    metric = /corner/.test(s) ? 'corners' : 'goals'
    subject = subjectFromTail(tail)
    line = lineOf(tail, input.line)
  }
  // ---- 让球 ----
  else if (/\bspread\b|\bhandicap\b/.test(s)) {
    family = 'spread'
    metric = 'goals'
    subject = subjectFromTail(tail) === 'match' ? (firstTeamTag(tail) ?? 'home') : subjectFromTail(tail)
    line = lineOf(tail, input.line)
  }
  // ---- 双方进球 ----
  else if (/both teams to score|\bbtts\b/.test(s)) {
    family = 'btts'
    metric = 'goals'
  }
  // ---- 角球衍生：奇偶、首个角球 ----
  else if (/odd or even/.test(s)) {
    family = 'odd_even'
    metric = 'odd_even'
  } else if (/first corner/.test(s)) {
    family = 'first_corner'
    metric = 'first_corner'
  }
  // ---- 先进球（含「无人先进球」）----
  else if (/to score first|score first/.test(s)) {
    family = 'first_goal'
    metric = 'first_goal'
    if (/neither team/.test(s)) subject = 'match'
    else subject = firstTeamTag(sk) ?? 'match'
  }
  // ---- 球员进球 ----
  else if (/anytime goalscorer/.test(s)) {
    family = 'scorer'
    metric = 'scorer'
    subject = 'player'
    player = sk.split(':')[0].trim() || null
  }
  // ---- 晋级 / 点球大战 ----
  else if (/team to advance/.test(s)) {
    family = 'advance'
    metric = 'advance'
  } else if (/penalty shootout/.test(s)) {
    family = 'penalty'
    metric = 'penalty'
  }
  // ---- 胜平负：主胜/客胜/平，全场与半场/下半场同形 ----
  else if (/\bdraw\b|\btie\b/.test(s)) {
    family = 'moneyline'
    metric = 'result'
    role = 'draw'
  } else if (/\bwin\b|\bleading\b|\bwinner\b/.test(s)) {
    family = 'moneyline'
    metric = 'result'
    // "Will {H} win on ..."、"{H} leading at halftime?"、"{H} to win the second half?"
    const who = firstTeamTag(sk)
    if (who == null) return null
    role = who
    subject = who
  }

  if (family == null) return null

  const base = {
    family,
    period,
    metric,
    subject,
    line,
    homeLine: family === 'spread' ? spreadHomeLine(subject, line) : null,
    score,
    player,
    role,
  }
  return {
    ...base,
    label: labelOf(input, base),
    goalSensitive: GOAL_SENSITIVE_METRICS.has(metric),
  }
}

