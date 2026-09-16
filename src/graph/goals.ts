/**
 * 从盘口反推进球数。
 *
 * 关系图中心那三个节点（进球 / 主队进球 / 客队进球）**没有对应盘口**，
 * 显示的是由大小球梯子反推出来的数字。
 *
 * 从原项目 src/market-graph/service.ts 摘出来 —— 那个文件带 MySQL 与 axios
 * 依赖，浏览器里用不了，但这两个函数本身是纯逻辑。
 */
import type { MarketGraph } from './types.js'

/**
 * 「这条线已打出」的买价阈值。
 *
 * 赢家会被推到 1.0，0.99 留一档余量。与原项目 line-monitor-book.ts 的
 * SETTLED_BID 保持同一个值 —— 两边不一致会让 dapp 和采集器对同一场比赛
 * 推出不同的比分。
 */
export const SETTLED_BID = 0.99

export type GoalCounts = { total: number | null; home: number | null; away: number | null }

/**
 * 某个主体（全场/主队/客队）的进球数上下界。
 *
 * 已打出的线给下界，还在动的线给上界。只认 **Over 钉死**：
 * Under 钉在 0.99 只表示「此刻还没进」，第 89 分钟仍可能翻 —— 拿它当上界
 * 会在补时进球时给出错的比分。
 */
function goalsBounds(
  graph: MarketGraph,
  subject: 'match' | 'home' | 'away',
): { low: number; high: number | null } {
  let low = 0
  let high: number | null = null
  for (const n of graph.nodes) {
    const d = n.desc
    if (d.family !== 'ou' || d.metric !== 'goals' || d.period !== 'ft') continue
    if (d.subject !== subject || d.line == null) continue
    const side = n.sides.find((s) => s.name === n.primarySide)
    // 快照价也算证据：0.9995 就是「这条线已打出」。
    // 与判违约不同——那个必须有真实双边盘口，这个只是读结果。
    const bid = side?.bid ?? side?.price ?? null
    if (bid == null) continue
    const need = Math.round(d.line + 0.5)
    if (bid >= SETTLED_BID) low = Math.max(low, need)
    else high = high == null ? need - 1 : Math.min(high, need - 1)
  }
  return { low, high }
}

/**
 * 中心三节点要显示的进球数。
 *
 * 三个数**各自独立**：总数能确定就显示总数，主客某一方推不出来就显示未知，
 * 不因为一方缺失把另一方也抹掉。这与「给模型一个自洽比分」是不同的需求 ——
 * 后者拆分不出来时宁可退回 0-0。
 */
export function inferGoalCounts(
  graph: MarketGraph,
  minute: number | null,
  explicit?: { homeGoals: number; awayGoals: number } | null,
): GoalCounts {
  if (explicit) {
    return {
      total: explicit.homeGoals + explicit.awayGoals,
      home: explicit.homeGoals,
      away: explicit.awayGoals,
    }
  }
  if (minute == null || minute <= 0) return { total: 0, home: 0, away: 0 }

  const settled = (b: { low: number; high: number | null }): number | null =>
    b.high != null && b.high === b.low ? b.low : null

  let total = settled(goalsBounds(graph, 'match'))
  let home = settled(goalsBounds(graph, 'home'))
  let away = settled(goalsBounds(graph, 'away'))

  // 三者互补：知道两个就能推第三个
  if (total == null && home != null && away != null) total = home + away
  if (home == null && total != null && away != null) home = total - away
  if (away == null && total != null && home != null) away = total - home

  return { total, home, away }
}

/**
 * 开哨后多少分钟。赛前为负数。
 *
 * endDate 是**计划开哨**时间，有 ±30 分钟误差（原项目多处注释警告过），
 * 所以按分钟切的任何结论都得带这个误差。
 */
export function matchMinute(endDate: string | null): number | null {
  if (!endDate) return null
  const t = Date.parse(endDate)
  if (!Number.isFinite(t)) return null
  return Math.round((Date.now() - t) / 60000)
}
