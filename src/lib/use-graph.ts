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
  clobTokenIdsOf,
  fetchSoccerEvents,
  mergeIntoMatches,
  tickOf,
  toGraphMarketInput,
  type SoccerMatch,
} from './gamma'
import { applyLivePrices, buildMarketGraph, type GraphEventInput } from '../graph/graph'
import { resolveTemplate, TEMPLATE_EDGES } from '../graph/template'
import { inferGoalCounts, matchMinute, type GoalCounts } from '../graph/goals'
import { translateLeague, translateQuestion, translateTeam } from './dict'
import { createClobWs, type ClobWs, type ConnState } from './clob-ws'
import { toLiveQuotes, type Quote } from './book'
import { DEFAULT_TICK, type TickSize } from './tick'
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
  /** WS 连接状态，给 UI 显示「实时 / 连接中 / 快照」 */
  wsState: ConnState
  /** 拿到真实双边报价的 token 数。0 = 图上全是快照价 */
  quotedCount: number
  /**
   * 每个 token 的完整行情（含**不可成交**的单边/交叉盘）。
   *
   * 与 quotedCount 的差别：那个数只统计可成交的，是「能不能下单」的判据；
   * 这里是原始状态，下单弹窗要拿它显示买一/卖一与量，也包括只有单边的
   * 时候——那时不该假装没数据。
   */
  book: ReadonlyMap<string, Quote>
  /** tokenId → 该盘口的 tick size。下单表单的步进与展示精度都用它 */
  tickByToken: Record<string, TickSize>
}

/**
 * 由一场比赛算出图与槽位。
 *
 * ## 快照价 vs 实时报价
 *
 * 结构（节点、边、划分组）由 Gamma 的盘口列表建，那部分不随价格变。
 * 价格分两层：
 *
 *   1. Gamma 的 outcomePrices —— **上一次成交价**，可能几小时前的，
 *      而且只有一个数（bid==ask==price）。节点上标「快照」。
 *   2. CLOB book WebSocket —— 真实双边买卖盘，能成交的价。
 *
 * 只有第 2 层能用来下单。第 1 层拿来挂单大概率不成交，因为那个价此刻
 * 可能根本没人挂。所以两者必须在 UI 上区分开（画布用 `quoted` 标记）。
 *
 * ## 为什么分成两个 useMemo
 *
 * baseGraph 只依赖 match（换比赛才重建），liveGraph 依赖报价（每 400ms 可能变）。
 * 合成一个的话，每次报价更新都要重跑 buildMarketGraph —— 那是 85 个盘口的
 * 完整拓扑推导，没必要。applyLivePrices 只重算价格相关的部分（λ、边、违约）。
 */
export function useMarketGraph(match: SoccerMatch | null): GraphState {
  const prevRef = useRef<Record<string, number>>({})

  const baseGraph = useMemo(() => {
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

  /**
   * 要订阅的 token 列表。
   *
   * 从节点的每一侧收集，而不是从 match.markets —— 一个盘口有两侧（Yes/No、
   * Over/Under），CLOB 是**按 token 订阅**的，两侧各有自己的 tokenId。
   * 只订一侧会让另一侧永远停在快照价。
   */
  const tokens = useMemo(() => {
    if (!baseGraph) return [] as string[]
    const set = new Set<string>()
    for (const n of baseGraph.nodes) {
      for (const s of n.sides) if (s.tokenId) set.add(s.tokenId)
    }
    return [...set]
  }, [baseGraph])

  const [book, setBook] = useState<ReadonlyMap<string, Quote>>(new Map())
  const [wsState, setWsState] = useState<ConnState>('idle')
  const wsRef = useRef<ClobWs | null>(null)

  // WS 实例整个 hook 生命周期只建一个：换比赛只改订阅集合，不重建连接层。
  // 卸载时必须 close，否则重连定时器会一直活着（HMR 下尤其明显）。
  useEffect(() => {
    const ws = createClobWs()
    wsRef.current = ws
    const offBook = ws.onBook((b) => setBook(new Map(b)))
    const offState = ws.onState(setWsState)
    return () => {
      offBook()
      offState()
      ws.close()
      wsRef.current = null
    }
  }, [])

  useEffect(() => {
    setBook(new Map())
    wsRef.current?.setTokens(tokens)
  }, [tokens])

  const liveQuotes = useMemo(() => toLiveQuotes(book), [book])
  const quotedCount = Object.keys(liveQuotes).length

  /**
   * tokenId → tick size。
   *
   * 来自 Gamma 的 `orderPriceMinTickSize`，**同一场比赛的不同盘口可以不同**
   * （实测 30 个足球盘口里 4 个是 0.001）。所以必须按 token 逐条取，不能
   * 拿一个默认值糊弄全图：tick=0.001 的盘口按 0.01 挂价，会白让半个 tick。
   *
   * 取不到的用 DEFAULT_TICK —— 猜粗了只是少赚，猜细了会被 CLOB 拒单。
   * 下单弹窗还会另外拉一次盘口深度，那里 SDK 给的 tickSize 更权威。
   */
  const tickByToken = useMemo(() => {
    const out: Record<string, TickSize> = {}
    if (!match) return out
    for (const m of match.markets) {
      const t = (tickOf(m) ?? DEFAULT_TICK) as TickSize
      for (const id of clobTokenIdsOf(m)) out[id] = t
    }
    return out
  }, [match])

  /**
   * 把实时报价盖到结构图上。
   *
   * applyLivePrices 会就地改 nodes 的 bid/ask/quoted，再返回一个重算过
   * λ、边、违约的新图。就地改意味着**上一次的报价会留在 baseGraph 上** ——
   * 这里是有意接受的：token 暂时没推送时，沿用最后已知报价比退回几小时前的
   * 快照价更接近真实。代价是 quoted 标记一旦为 true 就不会退回，
   * 所以要判断「现在能不能下单」得看 quotedCount 和 wsState，不能只看 quoted。
   */
  const graph = useMemo(() => {
    if (!baseGraph) return null
    if (quotedCount === 0) return baseGraph
    const minute = matchMinute(match?.endDate ?? null)
    return applyLivePrices(baseGraph, liveQuotes, {
      homeGoals: 0,
      awayGoals: 0,
      minute,
    })
  }, [baseGraph, liveQuotes, quotedCount, match?.endDate])

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

  return { graph, slots, goals, prevPrices, wsState, quotedCount, book, tickByToken }
}

export { TEMPLATE_EDGES }
