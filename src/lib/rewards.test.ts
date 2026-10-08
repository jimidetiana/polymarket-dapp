import { describe, expect, it } from 'vitest'
import { adjustedMid, estimateReward, scoreOf, toRewardConfig, type RewardConfig } from './rewards'

const config: RewardConfig = { dailyRate: 100, minSize: 50, maxSpreadCents: 3 }

describe('奖励配置', () => {
  it('只累加已生效的奖池，结束日当天仍算', () => {
    const now = Date.parse('2026-10-05T12:00:00Z')
    const c = toRewardConfig(
      {
        rewardsMinSize: '50',
        rewardsMaxSpread: 4.5,
        rewardsConfig: [
          { ratePerDay: '3', startDate: '2026-10-03', endDate: '2500-12-31' },
          { ratePerDay: 2, startDate: '2026-10-01', endDate: '2026-10-05' },
          { ratePerDay: 9, startDate: '2026-10-06' },
          { ratePerDay: 7, startDate: '2026-09-01', endDate: '2026-10-04' },
        ],
      },
      now,
    )
    expect(c).toEqual({ dailyRate: 5, minSize: 50, maxSpreadCents: 4.5 })
  })

  it('没有奖池或没有点差上限返回 null', () => {
    expect(toRewardConfig({ rewardsMaxSpread: 4.5, rewardsConfig: [] })).toBeNull()
    expect(toRewardConfig({ rewardsConfig: [{ ratePerDay: 3 }] })).toBeNull()
  })
})

describe('得分', () => {
  it('与文档示例一致：v=3、s=1 → (2/3)²', () => {
    expect(scoreOf(1, 3)).toBeCloseTo(4 / 9)
    expect(scoreOf(3, 3)).toBe(0)
    expect(scoreOf(4, 3)).toBe(0)
  })

  it('调整后的中价忽略小于最小份额的档', () => {
    const mid = adjustedMid(
      [{ price: 0.49, size: 10 }, { price: 0.48, size: 100 }],
      [{ price: 0.51, size: 100 }],
      50,
    )
    expect(mid).toBeCloseTo(0.495)
  })
})

describe('预估奖励', () => {
  const bids = [{ price: 0.49, size: 100 }]
  const asks = [{ price: 0.51, size: 100 }]

  it('按单边折扣与盘口占比瓜分奖池', () => {
    // 中价 0.50；盘口两侧各 100 份在 1¢ → Q = 400/9；我方 100 份 @0.49 → (400/9)/3
    const est = estimateReward({ config, bids, asks, side: 'BUY', price: 0.49, size: 100 })
    expect(est.kind).toBe('ok')
    if (est.kind !== 'ok') return
    expect(est.share).toBeCloseTo(0.25)
    expect(est.dailyUsd).toBeCloseTo(25)
    expect(est.spreadCents).toBeCloseTo(1)
  })

  it('会立即成交的价不算挂单', () => {
    expect(estimateReward({ config, bids, asks, side: 'BUY', price: 0.51, size: 100 }).kind).toBe('crossing')
    expect(estimateReward({ config, bids, asks, side: 'SELL', price: 0.49, size: 100 }).kind).toBe('crossing')
  })

  it('份额不够、超出点差、极端价位各自给出原因', () => {
    expect(estimateReward({ config, bids, asks, side: 'BUY', price: 0.49, size: 10 }).kind).toBe('size')
    expect(estimateReward({ config, bids, asks, side: 'BUY', price: 0.46, size: 100 }).kind).toBe('spread')
    const lowBids = [{ price: 0.04, size: 100 }]
    const lowAsks = [{ price: 0.06, size: 100 }]
    expect(
      estimateReward({ config, bids: lowBids, asks: lowAsks, side: 'BUY', price: 0.04, size: 100 }).kind,
    ).toBe('extreme')
  })

  it('盘口缺一侧时算不出中价', () => {
    expect(estimateReward({ config, bids, asks: [], side: 'BUY', price: 0.49, size: 100 }).kind).toBe('nomid')
  })
})
