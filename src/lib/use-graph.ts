/**
 * 拉 Gamma 数据 → 建关系图 → 解模板槽位。
 *
 * 全部在浏览器里做：Gamma 的 CORS 是全开的（access-control-allow-origin: *），
 * 所以不需要后端代理。这也是 dapp 相对原项目最大的结构差别 ——
 * 原项目把这一整套放在 Node 侧并落 MySQL，这里没有库，图每次现算。
 *
 * 现算的代价可以接受：buildMarketGraph 是纯函数，一场比赛 85 个盘口
 * 实测 53 节点 / 62 边，耗时在毫秒级。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GammaError,
  fetchSoccerEvents,
  mergeIntoMatches,
  toGraphMarketInput,
  type SoccerMatch,
} from './gamma'
import { buildMarketGraph, type GraphEventInput } from '../graph/graph'
import { resolveTemplate, TEMPLATE_EDGES } from '../graph/template'
import { inferGoalCounts, matchMinute, type GoalCounts } from '../graph/goals'
import type { MarketGraph } from '../graph/types'
import type { ResolvedSlot } from '../graph/template'

export type MatchListState = {
  matches: SoccerMatch[]
  loading: boolean
  /** 人能看懂的错误文案；null = 无错 */
  error: string | null
  /** true = 看起来是网络不通，UI 要提示代理/VPN 而不是「暂无比赛」 */
  network: boolean
  reload: () => void
}

/** 拉今天+明天的足球比赛，已合并衍生赛事并按盘口数排序 */
export function useSoccerMatches(): MatchListState {
  const [matches, setMatches] = useState<SoccerMatch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [network, setNetwork] = useState(false)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    fetchSoccerEvents()
      .then((events) => {
        if (!alive) return
        const merged = mergeIntoMatches(events)
        setMatches(merged)
        setNetwork(false)
        // 接口通但一场都没有：多半是时间窗内确实没有比赛，不是故障
        setError(merged.length === 0 ? '时间窗内没有进行中的足球比赛' : null)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setMatches([])
        setNetwork(e instanceof GammaError ? e.likelyNetwork : false)
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [nonce])

  return { matches, loading, error, network, reload }
}

export type GraphState = {
  graph: MarketGraph | null
  slots: ResolvedSlot[]
  goals: GoalCounts | null
  /** 上一轮的中价，key = slot.key。给画布画涨跌箭头 */
  prevPrices: Record<string, number>
}

/**
 * 由一场比赛算出图与槽位。
 *
 * 价格用 Gamma 的 outcomePrices 快照 —— 那是**上一次成交价**，不是买卖盘。
 * 真实双边报价要连 CLOB 的 book WebSocket，属于下一步；画布已经用 `quoted`
 * 区分了两者，快照价不会被误当成可成交价。
 */
export function useMarketGraph(match: SoccerMatch | null): GraphState {
  const prevRef = useRef<Record<string, number>>({})

  const graph = useMemo(() => {
    if (!match) return null
    const event: GraphEventInput = {
      id: match.id,
      titleEn: match.title,
      titleZh: null,
      homeTeamEn: match.home,
      awayTeamEn: match.away,
      league: match.league,
      endTime: match.endDate,
    }
    const markets = match.markets.map(toGraphMarketInput)
    const minute = matchMinute(match.endDate)
    return buildMarketGraph(event, markets, {
      minVolume: 0,
      state: { homeGoals: 0, awayGoals: 0, minute },
    })
  }, [match])

  const goals = useMemo(
    () => (graph ? inferGoalCounts(graph, matchMinute(match?.endDate ?? null)) : null),
    [graph, match?.endDate],
  )

  const slots = useMemo(
    () => (graph && goals ? resolveTemplate(graph, goals) : []),
    [graph, goals],
  )

  // 快照上一轮价格供箭头对比。切换比赛时清空，避免拿另一场的价格比。
  const prevPrices = prevRef.current
  useEffect(() => {
    const next: Record<string, number> = {}
    for (const s of slots) {
      if (s.price != null) next[s.key] = s.price
    }
    prevRef.current = next
  }, [slots])

  return { graph, slots, goals, prevPrices }
}

export { TEMPLATE_EDGES }
