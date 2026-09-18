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
 * 一场比赛的总成交额：各盘口 volume 之和。
 *
 * 求和是安全的 —— mergeIntoMatches 已按 market id 去过重，同一盘口不会算两次。
 * 也不用 Gamma 的 event.volume：一场比赛是多个 event 合并来的（见 gamma.ts），
 * 而 SoccerMatch 没留着那批 event。
 *
 * **全都拿不到时返回 null 而不是 0**：盘口真的零成交，和接口没给这个字段，
 * 是两件不同的事。lib/utils 的 formatVolume 对 null 显示「—」、对 0 显示「$0」，
 * 这里把两者分开，那个区分才有意义。
 */
export function matchVolume(m: SoccerMatch): number | null {
  let total = 0
  let seen = false
  for (const mk of m.markets) {
    const raw = mk.volume
    if (raw === null || raw === undefined || raw === '') continue
    const v = Number(raw)
    if (!Number.isFinite(v)) continue
    total += v
    seen = true
  }
  return seen ? total : null
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

/** 每个状态各多少场，给标签上的计数用 */
export function countStatuses(
  matches: SoccerMatch[],
  now: number = Date.now(),
): Record<MatchStatus, number> {
  const counts: Record<MatchStatus, number> = { not_started: 0, live: 0, ended: 0 }
  for (const m of matches) counts[matchStatus(m.endDate, now)] += 1
  return counts
}
