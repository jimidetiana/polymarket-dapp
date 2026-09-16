/**
 * 价值投注机器人 - 类型定义
 */

/** 比赛实时状态（来自 bzzoiro） */
export interface LiveMatchState {
  bzzoiroEventId: number
  homeTeam: string
  awayTeam: string
  league?: string
  minute: number
  status: string // 'notstarted' | 'live' | 'finished' | ...
  homeGoals: number
  awayGoals: number
  startTime?: string
}

/** Polymarket 盘口信息 */
export interface PolymarketMarket {
  marketId: string
  eventId: string
  marketType: 'moneyline' | 'spread' | string
  question: string
  outcomes: string[]
  outcomePrices: number[]
  clobTokenIds: string[]
  line?: number | null // 让球线
  bestBid?: number | null
  bestAsk?: number | null
  volume?: number
}

/** 单个 outcome 的盘口价量数据 */
export interface OutcomeBook {
  outcome: string
  tokenId: string
  bestBid: number | null
  bestBidSize: number | null
  bestAsk: number | null
  bestAskSize: number | null
}

/** 计算日志 - 每次轮询每场比赛每个 outcome 一条 */
export interface CalcLogEntry {
  eventId: string
  bzzoiroEventId: number | null
  matchMinute: number
  homeScore: number
  awayScore: number
  marketId: string
  marketType: string
  question: string | null
  outcome: string
  handicap: number | null
  modelProbability: number
  bestBid: number | null
  bestBidSize: number | null
  bestAsk: number | null
  bestAskSize: number | null
  edge: number
  recommendation: string
}

/** 初盘信息（用于计算初始 λ） */
export interface InitialOdds {
  eventId: string
  homeTeam: string
  awayTeam: string
  lambdaHome: number
  lambdaAway: number
  initialHomeProb: number
  initialDrawProb: number
  initialAwayProb: number
  source: 'polymarket' | 'manual'
  createdAt: string
  /** 比赛方向：'home'=主队方向（主队让球），'away'=客队方向（客队让球），'none'=无偏向 */
  biasDirection: 'home' | 'away' | 'none'
  /** 比赛系数：根据让球线大小推导的调整幅度（如 0.05 = 5个百分点），让球越大系数越大 */
  biasCoefficient: number
}

/** 概率计算结果 */
export interface ProbabilityResult {
  outcome: string
  modelProbability: number
  marketPrice: number
  impliedProbability: number
  edge: number
  recommendation: 'BUY' | 'SELL' | 'PASS'
}

/** 价值投注记录 */
export interface ValueBetRecord {
  botId: string
  polymarketEventId: string
  bzzoiroEventId: number
  marketId: string
  marketType: string
  question: string
  outcome: string
  handicap: number | null
  modelProbability: number
  marketPrice: number
  impliedProbability: number
  edge: number
  matchMinute: number
  currentScore: string
  lambdaHome: number
  lambdaAway: number
  recommendation: string
  status: string
}

/** 机器人配置 */
export interface ValueBotConfig {
  enabled: boolean
  pollIntervalMs: number
  edgeThreshold: number // 最小 edge 才记录（如 0.03 = 3%）
  maxGoals: number // Poisson 计算的最大进球数
  timeDecayExponent: number // 时间衰减指数，默认 0.84
  totalMatchMinutes: number // 比赛总时长，默认 90
  botId: string
}

export const DEFAULT_CONFIG: ValueBotConfig = {
  enabled: false,
  pollIntervalMs: 30_000,
  edgeThreshold: 0.03,
  maxGoals: 10,
  timeDecayExponent: 0.84,
  totalMatchMinutes: 90,
  botId: 'value-bot-v1',
}

/** 概率规则接口（可扩展） */
export interface ProbabilityRule {
  marketType: string
  marketTypeName: string
  description: string
  formula: string
  calculate(
    ctx: MatchContext,
    market: PolymarketMarket,
    initial: InitialOdds,
  ): ProbabilityResult[]
}

/** 比赛上下文 */
export interface MatchContext {
  minute: number
  homeGoals: number
  awayGoals: number
  status: string
  totalMatchMinutes: number
  timeDecayExponent: number
  maxGoals: number
}
