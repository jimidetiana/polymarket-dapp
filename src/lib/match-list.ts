/**
 * 比赛列表的纯逻辑：开赛状态、搜索、筛选、成交额。
 *
 * 从 App.tsx 的 `<select>` 拆出来是因为那一版有两个硬伤：**标题是英文原文**
 * （词典明明已经加载了，只是没在这条路上用它），**没有搜索** —— 三十来场
 * 比赛挤在一个原生下拉里，只能靠眼睛找。列表的形式照原项目赛事页的
 * MatchCard（`polymarket-trader/frontend/src/pages/soccer.tsx`）。
 *
 * 纯函数放这里而不是写在组件里，是跟着仓库既有做法（tick / fit / viewport /
 * book / dict 都带同名的 .test.ts）：这些判断有边界（开哨那一刻、下播那一刻、
 * 大小写、多词），值得钉住。
 */
import type { SoccerMatch } from './gamma'
import { translateLeague, translateTeam } from './dict'

/**
 * 开赛状态。
 *
 * 全用 Gamma 的 `endDate` 推 —— 它是**计划开哨时间**（见 graph/goals.ts 的
 * matchMinute），原始项目那边有 ±30 分钟误差的警告。dapp 没有后端，
 * 拿不到真实的比赛状态，所以这是**推断**而不是事实，只用来做粗筛。
 *
 * 口径照抄原项目的 computeMatchStatus（src/soccer/db.ts）：以 2 小时为
 * 进行中窗口（90 分钟 + 补时 + 中场）。两边同一个阈值，免得同一场比赛
 * 在 dapp 上显示「进行中」而在订单页显示「已结束」。
 */
export type MatchStatus = 'not_started' | 'live' | 'ended'

export const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000

export function matchStatus(endDate: string | null, now: number = Date.now()): MatchStatus {
  if (!endDate) return 'not_started'
  const kickoff = Date.parse(endDate)
  // 解析不了就当作未开始：显示成「已结束」会让它排到列表尾部再也不被点
  if (!Number.isFinite(kickoff)) return 'not_started'
  if (now < kickoff) return 'not_started'
  return now < kickoff + LIVE_WINDOW_MS ? 'live' : 'ended'
}

export const STATUS_LABEL: Record<MatchStatus, string> = {
  not_started: '未开始',
  live: '进行中',
  ended: '已结束',
}

/** 筛选标签。`all` 不是状态，是「不筛」 */
export type MatchFilter = 'all' | MatchStatus

/** 徽标配色，与原项目 StatusBadge 取同一组语义色 */
export const STATUS_CLASS: Record<MatchStatus, string> = {
  not_started: 'border-warning/30 bg-warning/15 text-warning',
  live: 'border-success/30 bg-success/15 text-success',
  ended: 'border-border bg-muted text-muted-foreground',
}

/**
 * 搜索用的一整串文本：中英文队名 + 联赛中英文名 + 英文标题。
 *
 * 中译名走 translateTeam，和 dict-admin 的表格同一条路。**副作用是想要的**：
 * translateTeam 会把查不到的队名记进缺失表，管理页面因此能看到「这批比赛里
 * 哪些队还没译名」—— 列表比单场比赛覆盖得全，缺漏更容易被发现。
 */
export function matchHaystack(m: SoccerMatch): string {
  const parts = [
    m.title,
    m.home,
    m.away,
    translateTeam(m.home),
    translateTeam(m.away),
    m.leagueCode ?? '',
    translateLeague(m.leagueCode) ?? '',
  ]
  return parts.join(' ').toLowerCase()
}

/**
 * 按关键词筛。空白分隔的多个词是 **AND** ——「everton wolves」要两个都出现在
 * 同一场比赛里。中文没有空格，整串就是一个词，等价于子串匹配。
 *
 * 空查询返回原数组（不是空数组）：输入框清空应当恢复全部，而不是清空列表。
 */
export function searchMatches(matches: SoccerMatch[], query: string): SoccerMatch[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return matches
  return matches.filter((m) => {
    const hay = matchHaystack(m)
    return tokens.every((t) => hay.includes(t))
  })
}

export function filterMatches(
  matches: SoccerMatch[],
  filter: MatchFilter,
  now: number = Date.now(),
): SoccerMatch[] {
  if (filter === 'all') return matches
  return matches.filter((m) => matchStatus(m.endDate, now) === filter)
}

/**
 * 列表的展示顺序：**没结束的按开赛时间升序在前，已结束的沉到最后**。
 *
 * mergeIntoMatches 给的顺序是**重要性**排序（子赛事多的在前，图更完整），
 * 从那个角度看没问题，但眼睛扫不出来为什么这场排在上一场后面：同一个联赛的
 * 两场比赛可能隔了十几行。按时间排，赛程的形状才是看得见的。
 *
 * 已结束的为什么沉底而不是留在时间轴原位：时间窗从「昨天 16:00 UTC」开始，
 * 纯按时间升序的话最上面全是踢完了的比赛，而这一页要找的永远是「现在能下注
 * 的」。判断走 matchStatus，与筛选标签同一个口径（结束两小时后才算已结束）。
 *
 * 两组内部都按时间升序；时间缺失或解析不了的排在**未结束**那组的最后 ——
 * 它们连什么时候开踢都不知道，插在中间只会把时间轴切断。
 *
 * 返回新数组：入参是 react-query 的缓存，就地排序会改掉它的顺序。
 */
export function sortForList(matches: SoccerMatch[], now: number = Date.now()): SoccerMatch[] {
  const ended = (m: SoccerMatch) => (matchStatus(m.endDate, now) === 'ended' ? 1 : 0)
  return [...matches].sort((a, b) => ended(a) - ended(b) || kickoffMs(a) - kickoffMs(b))
}

function kickoffMs(m: SoccerMatch): number {
  const t = m.endDate ? Date.parse(m.endDate) : Number.NaN
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
}

/** 每个状态各多少场，给标签上的计数用 */
export function countStatuses(
  matches: SoccerMatch[],
  now: number = Date.now(),
): Record<MatchStatus, number> {
  const counts: Record<MatchStatus, number> = { not_started: 0, live: 0, ended: 0 }
  for (const m of matches) counts[matchStatus(m.endDate, now)] += 1
  return counts
}

/**
 * 打开页面（或刷新）默认该看哪一场：**开赛时间离现在最近、且还没结束的那场**。
 *
 * ## 为什么不用 mergeIntoMatches 给的顺序
 *
 * 那个顺序是**重要性**排序（子赛事多的在前，图更完整），对「哪张图最完整」是对的，
 * 对「打开页面该看哪场」是错的：它和列表里看到的顺序（sortForList，按开赛时间）
 * 不是一回事。后果实测踩过 —— **刷新后默认打开的那场和列表第一行不是同一场**，
 * 于是在一个不是自己刚下过单的比赛上找持仓，结论成了「我的持仓不见了」，
 * 其实只是看错了比赛。
 *
 * 现在的口径与列表一致：默认就是**列表的第一行**。
 *
 * 全部已结束时取**刚踢完的那场**（kickoff 最大的）：那时「最近」的答案同样是时间上
 * 最靠后的那一场，而不是随便挑一场。
 *
 * 时间缺失或解析不了的比赛不参与挑选：一场连什么时候开踢都不知道的比赛，
 * 不该被当成默认（kickoffMs 给的是 +Infinity，会赢下「取最大」那一支，那是错的）。
 */
export function defaultMatchId(
  matches: readonly SoccerMatch[],
  now: number = Date.now(),
): string | null {
  if (matches.length === 0) return null
  const upcoming = matches.filter((m) => matchStatus(m.endDate, now) !== 'ended')
  const pool = upcoming.length > 0 ? upcoming : matches
  // 未结束时取**最早**开赛的（pick=-1：(t - best) * -1 > 0 即 t < best），
  // 全都结束时取**最晚**开赛的（pick=1）。符号反过来会取到最远的那场，
  // 而它在界面上和「最近」长得一模一样 —— 有测试钉着这一条。
  const pick = upcoming.length > 0 ? -1 : 1
  let best: SoccerMatch | null = null
  for (const m of pool) {
    const t = kickoffMs(m)
    if (!Number.isFinite(t)) continue
    if (best == null || (t - kickoffMs(best)) * pick > 0) best = m
  }
  return (best ?? matches[0]).id
}

/**
 * 把「窗口外但有仓位」的比赛并进列表。
 *
 * ## 为什么需要它
 *
 * 列表的时间窗（今天+明天）是给**能下注的比赛**定的，而「我参与过哪些比赛」跟窗口
 * 无关：一场比赛踢完之后，它的赛事就从 Gamma 的窗口查询里掉出去了，列表里没有这一行，
 * 也就**没有地方挂「持仓」徽标** —— 界面上看起来就是「我有持仓的比赛在列表里找不到」。
 * 所以有仓位的那几场要按 id 单独捞回来（见 lib/gamma.ts 的 fetchMatchesByIds）。
 *
 * ## 按基础标题去重
 *
 * 同一场比赛可能**一部分子赛事在窗口内、一部分在窗口外**（各子赛事 endDate 不同），
 * 那种情况下两边的 eventIds 必须并起来，否则徽标只会在窗口内那几条子赛事上命中 ——
 * 而仓位常常落在「- More Markets」那一族里（大小球就在那）。
 *
 * 窗口内那份的顺序与对象原样保留，追加的排在后面：展示顺序由 sortForList 在渲染时
 * 决定，这里不替它排。
 */
export function mergeMatchLists(base: SoccerMatch[], extra: readonly SoccerMatch[]): SoccerMatch[] {
  if (extra.length === 0) return base
  const out = [...base]
  const at = new Map<string, number>()
  out.forEach((m, i) => at.set(m.title, i))
  for (const m of extra) {
    const i = at.get(m.title)
    if (i == null) {
      at.set(m.title, out.length)
      out.push(m)
      continue
    }
    const prev = out[i]
    const ids = new Set(prev.eventIds)
    let grew = false
    for (const id of m.eventIds) {
      if (ids.has(id)) continue
      ids.add(id)
      grew = true
    }
    if (!grew) continue
    out[i] = {
      ...prev,
      eventIds: [...ids],
      sources: [...new Set([...prev.sources, ...m.sources])],
      // volume 取两边**较大**的那个：同一场比赛两边各统计过一次，相加会翻倍；
      // 而两个数都是「这场比赛的成交额」的估计，取大的那个更接近全貌
      volume: maxOrNull(prev.volume, m.volume),
    }
  }
  return out
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.max(a, b)
}
