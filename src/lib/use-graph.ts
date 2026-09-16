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
import { translateLeague, translateQuestion, translateTeam } from './dict'
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
    // 队名中文化在这里注入，而不是在 gamma.ts 里改 match.home/away：
    // 那两个字段要保持英文原名 —— 让球方向判断、盘口问句替换、词典查表
    // 都以英文名为键，翻过就对不上了。
    const homeZh = translateTeam(match.home)
    const awayZh = translateTeam(match.away)
    const event: GraphEventInput = {
      id: match.id,
      titleEn: match.title,
      titleZh: `${homeZh} vs ${awayZh}`,
      homeTeamEn: match.home,
      awayTeamEn: match.away,
      // translateTeam 查不到会原样返回英文，此时不传 zh —— parse.ts 里
      // `homeTeamZh || homeTeamEn` 的回落逻辑本来就对，传个等于英文的值
      // 只会让「有没有译名」这件事看不出来。
      homeTeamZh: homeZh === match.home ? null : homeZh,
      awayTeamZh: awayZh === match.away ? null : awayZh,
      league: translateLeague(match.leagueCode),
      endTime: match.endDate,
    }
    // 盘口问句也过一遍翻译：toGraphMarketInput 里 questionZh 写死 null，
    // 因为那个函数拿不到队名。队名只有在这一层才知道，所以在这里补。
    // 翻不动（译名缺失 + 术语没命中）就留 null，让 tooltip 回落英文原句。
    const markets = match.markets.map((m) => {
      const base = toGraphMarketInput(m)
      const zh = translateQuestion(base.questionEn, match.home, match.away)
      return { ...base, questionZh: zh && zh !== base.questionEn ? zh : null }
    })
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
