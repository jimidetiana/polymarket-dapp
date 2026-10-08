/**
 * Polymarket 流动性奖励（挂单奖励）的预估。
 *
 * 规则来自官方文档 programs/liquidity-rewards：每个有奖励的盘口配一个日奖池
 * （rate_per_day）、最小计分份额（rewards_min_size）和距中价的最大计分点差
 * （rewards_max_spread，单位**美分**）。单张挂单的得分是
 *
 *   S = ((v − s) / v)² × 份额      v = 最大点差，s = 距「按最小份额调整后的中价」的点差
 *
 * 每分钟随机抽样一次，按各做市商 Q_min 的占比瓜分当日奖池。Q_min 对单边挂单
 * 打折（÷ c，c = 3），中价在 [0.10, 0.90] 之外时单边挂单不计分。
 *
 * ## 这里只是估算
 *
 * 别人每个人的 Q_min 拿不到（盘口只给按价位聚合的量），所以把整本盘口当成一个
 * 做市商套同一条 Q_min 公式，再假设这张单挂满一天、盘口不变。in-game 乘数 b
 * 不公开，按 1 算。数量级可信，精确值以 Polymarket 次日实发为准。
 *
 * 查询用的那个盘口的 book 已经含互补 token 的镜像挂单（实测 YES 的买盘与 NO 的
 * 卖盘逐档相同），所以只看一边的 book，不要再把互补盘加一遍。
 */

export type RewardConfig = {
  /** 当前生效的日奖池之和（美元） */
  dailyRate: number
  /** 最小计分份额 */
  minSize: number
  /** 距中价的最大计分点差，美分 */
  maxSpreadCents: number
}

export type RewardLevel = { price: number; size: number }

/** 单边挂单的折扣系数，文档写明目前所有盘口都是 3.0 */
export const SINGLE_SIDED_DIVISOR = 3

/** SDK 的 MarketReward 里我们用得上的那几项（DecimalString 就是 string） */
export type RawMarketReward = {
  rewardsMinSize?: string | number
  rewardsMaxSpread?: number
  rewardsConfig?: { ratePerDay: string | number; startDate?: string; endDate?: string }[]
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 把接口返回的配置收成一个数；没有生效中的奖池返回 null */
export function toRewardConfig(raw: RawMarketReward, now = Date.now()): RewardConfig | null {
  let dailyRate = 0
  for (const c of raw.rewardsConfig ?? []) {
    const rate = Number(c.ratePerDay)
    if (!Number.isFinite(rate) || rate <= 0) continue
    const start = c.startDate ? Date.parse(c.startDate) : NaN
    const end = c.endDate ? Date.parse(c.endDate) : NaN
    // 日期只到天（"2026-10-04"），结束日当天仍算生效
    if (Number.isFinite(start) && now < start) continue
    if (Number.isFinite(end) && now >= end + DAY_MS) continue
    dailyRate += rate
  }
  const minSize = Number(raw.rewardsMinSize ?? 0)
  const maxSpreadCents = Number(raw.rewardsMaxSpread ?? 0)
  if (dailyRate <= 0 || !Number.isFinite(maxSpreadCents) || maxSpreadCents <= 0) return null
  return { dailyRate, minSize: Number.isFinite(minSize) ? minSize : 0, maxSpreadCents }
}

/**
 * 「按最小份额调整后的中价」：忽略小于最小计分份额的档，取剩下的最优买卖价的中点。
 * 某一侧没有够大的档就退回那一侧的原始最优价。
 */
export function adjustedMid(bids: readonly RewardLevel[], asks: readonly RewardLevel[], minSize: number): number | null {
  const best = (levels: readonly RewardLevel[], pick: (a: number, b: number) => number) => {
    let out: number | null = null
    let outBig: number | null = null
    for (const l of levels) {
      out = out == null ? l.price : pick(out, l.price)
      if (l.size >= minSize) outBig = outBig == null ? l.price : pick(outBig, l.price)
    }
    return outBig ?? out
  }
  const bid = best(bids, Math.max)
  const ask = best(asks, Math.min)
  if (bid == null || ask == null) return null
  return (bid + ask) / 2
}

/** 距中价的点差（美分），抹掉浮点尾数 */
function spreadCentsOf(price: number, mid: number): number {
  return Math.round(Math.abs(price - mid) * 100 * 1e6) / 1e6
}

/** 单位份额的得分 ((v − s) / v)²，超出范围为 0 */
export function scoreOf(spreadCents: number, maxSpreadCents: number): number {
  if (spreadCents >= maxSpreadCents) return 0
  const r = (maxSpreadCents - spreadCents) / maxSpreadCents
  return r * r
}

function sideQ(levels: readonly RewardLevel[], mid: number, v: number): number {
  let q = 0
  for (const l of levels) q += scoreOf(spreadCentsOf(l.price, mid), v) * l.size
  return q
}

export type RewardEstimate =
  | {
      kind: 'ok'
      /** 预估每天能分到的奖励（美元） */
      dailyUsd: number
      /** 占当日奖池的比例 0~1 */
      share: number
      spreadCents: number
    }
  | { kind: 'crossing' }
  | { kind: 'size' }
  | { kind: 'spread'; spreadCents: number }
  | { kind: 'extreme' }
  | { kind: 'nomid' }

export function estimateReward(args: {
  config: RewardConfig
  bids: readonly RewardLevel[]
  asks: readonly RewardLevel[]
  side: 'BUY' | 'SELL'
  price: number
  size: number
}): RewardEstimate {
  const { config, bids, asks, side, price, size } = args
  const v = config.maxSpreadCents

  // 会立即吃掉对面的单 = 吃单，不是挂单
  const bestBid = bids.reduce<number | null>((m, l) => (m == null || l.price > m ? l.price : m), null)
  const bestAsk = asks.reduce<number | null>((m, l) => (m == null || l.price < m ? l.price : m), null)
  if (side === 'BUY' && bestAsk != null && price >= bestAsk) return { kind: 'crossing' }
  if (side === 'SELL' && bestBid != null && price <= bestBid) return { kind: 'crossing' }

  const mid = adjustedMid(bids, asks, config.minSize)
  if (mid == null) return { kind: 'nomid' }
  if (size < config.minSize) return { kind: 'size' }

  const spreadCents = spreadCentsOf(price, mid)
  const s = scoreOf(spreadCents, v)
  if (s <= 0) return { kind: 'spread', spreadCents }
  // 单边挂单在极端价位不计分
  if (mid < 0.1 || mid > 0.9) return { kind: 'extreme' }

  const mine = (s * size) / SINGLE_SIDED_DIVISOR
  const qb = sideQ(bids, mid, v)
  const qa = sideQ(asks, mid, v)
  const others = Math.max(Math.min(qb, qa), Math.max(qb, qa) / SINGLE_SIDED_DIVISOR)
  const share = mine / (mine + others)
  return { kind: 'ok', dailyUsd: config.dailyRate * share, share, spreadCents }
}
