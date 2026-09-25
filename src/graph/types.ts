/**
 * 一场比赛的盘口网：节点是盘口，边是结构约束。
 *
 * 分类标准对所有比赛同一套——不读 soccer_markets.market_type
 * （那一列把角球、单队、半场全塞进 total）。问句拆成正交维度：
 * period × metric × subject × family × line。
 *
 * 节点是**盘口**不是 token：O/U 一个节点里两侧价格；胜平负在
 * Polymarket 上是三个 Yes/No 盘，三个节点，用 partition 边连起来。
 */

export type Period = 'ft' | 'ht' | '2h'
export type Metric =
  | 'goals'
  | 'corners'
  | 'result'
  | 'exact'
  | 'scorer'
  | 'first_goal'
  | 'advance'
  | 'penalty'
  | 'odd_even'
  | 'first_corner'
export type Subject = 'match' | 'home' | 'away' | 'player'
export type Family =
  | 'ou'
  | 'moneyline'
  | 'spread'
  | 'btts'
  | 'exact'
  | 'scorer'
  | 'first_goal'
  | 'odd_even'
  | 'first_corner'
  | 'advance'
  | 'penalty'
  | 'other'

/** 进球对该侧价格的方向。kill = 该侧直接结算掉（进球后不再是这个问题） */
export type GoalDir = 'up' | 'down' | 'kill' | 'flat'

export type EdgeKind = 'ladder' | 'partition' | 'implies' | 'period'

/** 前端按这个重算违约，不必再问服务器 */
export type ConstraintOp =
  | 'monotonic_desc'
  | 'monotonic_asc'
  | 'implies_lte'
  | 'partition_sum'

export interface MarketDescriptor {
  family: Family
  period: Period
  metric: Metric
  subject: Subject
  /** O/U 线或让球线（让球为负 = 被点名的那队让球） */
  line: number | null
  /** 让球换算成主队视角，方便跨节点比较。subject=away 且 line=-1.5 → homeLine=+1.5 */
  homeLine: number | null
  score: { home: number; away: number } | null
  player: string | null
  /** moneyline 的 1X2 槽位；其它 family 为 null */
  role: 'home' | 'away' | 'draw' | null
  /** 节点上的短标签，如「全场 2.5」「主胜」「2-1」 */
  label: string
  /** 进球会明显改这个盘的价格 */
  goalSensitive: boolean
}

export interface ParseInput {
  questionEn: string
  questionZh?: string | null
  line?: number | string | null
  homeTeamEn: string
  awayTeamEn: string
  homeTeamZh?: string | null
  awayTeamZh?: string | null
}

export interface GraphSide {
  name: string
  tokenId: string | null
  /** gamma 快照价（单一价、可能过期），被真实盘口价覆盖 */
  price: number | null
  bid: number | null
  ask: number | null
  /**
   * 这一侧是否有**真实双边盘口**（来自 /books）。
   *
   * 只有 true 才能判约束违约：gamma 快照只给一个价，bid==ask==price，
   * 于是过期快照里任何一点单调性抖动都会被判成套利（实测 slack=-0.0005
   * 这种噪音），而那根本成交不了。
   */
  quoted: boolean
}

export interface GoalImpact {
  homeGoal: GoalDir
  awayGoal: GoalDir
  /** 0–1，取 |Δ_home| 与 |Δ_away| 的较大者 */
  magnitude: number
  deltaHome: number | null
  deltaAway: number | null
  /** 幅度是否来自模型。false = 方向靠结构、幅度未建模，前端别显示数字 */
  modelled: boolean
}

export interface GraphNode {
  id: string
  marketId: string
  /**
   * 盘口的 conditionId。
   *
   * 查「这张盘我有什么持仓/成交」**只能**用它 —— data-api 的 `asset=<tokenId>`
   * 参数是静默忽略的（传了返回全量），详见 lib/positions.ts 顶部。
   */
  conditionId: string | null
  desc: MarketDescriptor
  questionEn: string
  questionZh: string | null
  volume: number
  liquidity: number
  sides: GraphSide[]
  /** 主显示侧：Over / Yes / 被点名的让球队 */
  primarySide: string
  impact: GoalImpact
  emphasis: 'major' | 'minor'
  column: string
  row: number
}

export interface GraphEdge {
  id: string
  kind: EdgeKind
  from: string
  to: string
  fromSide: string
  toSide: string
  op: ConstraintOp
  constraint: string
  violated: boolean
  slack: number | null
}

export interface GraphGroup {
  id: string
  kind: '1x2'
  period: Period
  nodeIds: string[]
  sum: number | null
  violated: boolean
}

export interface GraphColumn {
  key: string
  title: string
  index: number
}

export interface MarketGraph {
  eventId: string
  homeTeamEn: string
  awayTeamEn: string
  homeTeamZh: string | null
  awayTeamZh: string | null
  title: string
  league: string | null
  endTime: string | null
  lambdaTotal: number | null
  lambdaHome: number | null
  lambdaAway: number | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  groups: GraphGroup[]
  columns: GraphColumn[]
  stats: {
    markets: number
    withVolume: number
    goalSensitive: number
    edges: number
    violations: number
  }
}

export interface GraphTick {
  eventId: string
  marketId: string
  tokenId: string
  side: string
  snapshotAt: string
  bid: number | null
  ask: number | null
  prevBid: number | null
  prevAsk: number | null
}
