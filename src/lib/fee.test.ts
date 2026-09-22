import { describe, it, expect } from 'vitest'
import {
  bpsLabel,
  feeCentsOf,
  feeBreakdown,
  formatFeeAmount,
  maxBpsOf,
  settleOf,
  BUILDER_FEE_RATES,
} from './fee'

describe('展示用费率取哪一侧', () => {
  it('maker / taker 取较高者', () => {
    // 下单那一刻不知道会以 maker 还是 taker 成交，按高的报。
    // 取反（取低）会让界面显示的总额低于真实扣款 —— 正是本模块要防的那类错。
    expect(maxBpsOf({ makerBps: 5, takerBps: 10 })).toBe(10)
    expect(maxBpsOf({ makerBps: 10, takerBps: 5 })).toBe(10)
  })

  it('同值时就取那个值', () => {
    expect(maxBpsOf({ makerBps: 5, takerBps: 5 })).toBe(5)
    expect(maxBpsOf(BUILDER_FEE_RATES)).toBe(5)
  })

  it('两个都是 0 → 0（不是 NaN）', () => {
    expect(maxBpsOf({ makerBps: 0, takerBps: 0 })).toBe(0)
  })

  it('非法值不产生 NaN，也不变成负数', () => {
    // 费率来自 API，可能是 null → Number() → NaN。NaN 传进 feeBreakdown 会
    // 让手续费整段变成 NaN，界面上显示 "$NaN"。
    expect(maxBpsOf({ makerBps: Number.NaN, takerBps: 5 })).toBe(5)
    expect(maxBpsOf({ makerBps: Number.NaN, takerBps: Number.NaN })).toBe(0)
    expect(maxBpsOf({ makerBps: -5, takerBps: -1 })).toBe(0)
  })
})

describe('费率文案', () => {
  it('bps → 百分数，0.05% 不能被显示成 0% 或 0.1%', () => {
    // 5 bps 是我们要用的值。toFixed(2) 在这条上会出错（0.05 → "0.05" 侥幸对），
    // 但 1 bps 会被削成 "0.01%"，0.5 bps 会变成 "0.01%"（真实 0.005%）。
    expect(bpsLabel(5)).toBe('0.05%')
    expect(bpsLabel(1)).toBe('0.01%')
    expect(bpsLabel(50)).toBe('0.5%')
    expect(bpsLabel(200)).toBe('2%')
    expect(bpsLabel(100)).toBe('1%')
  })

  it('零与非法值显示 0%，不显示 NaN%', () => {
    expect(bpsLabel(0)).toBe('0%')
    expect(bpsLabel(-1)).toBe('0%')
    expect(bpsLabel(Number.NaN)).toBe('0%')
  })
})

describe('手续费金额（分）', () => {
  it('$100 × 5bps = 5 分', () => {
    expect(feeCentsOf(100, 5)).toBe(5)
  })

  it('$1000 × 5bps = 50 分', () => {
    expect(feeCentsOf(1000, 5)).toBe(50)
  })

  it('向上取整：$10 × 5bps 实际 0.5 分，给 1 分', () => {
    // 这个方向是刻意的：少报的是我们自己的收入，而且用户看到的总额会低于实际扣款
    expect(feeCentsOf(10, 5)).toBe(1)
  })

  it('本该整分的值不会被浮点误差顶上去', () => {
    // $20 × 5bps = 1 分。若少了 1e-9 那个容差，0.9999999 会被 ceil 成 2 分
    expect(feeCentsOf(20, 5)).toBe(1)
    // $200 × 5bps = 10 分
    expect(feeCentsOf(200, 5)).toBe(10)
    // $10000 × 5bps = 500 分
    expect(feeCentsOf(10_000, 5)).toBe(500)
  })

  it('费率 0 或金额 0 时不收费', () => {
    expect(feeCentsOf(100, 0)).toBe(0)
    expect(feeCentsOf(0, 5)).toBe(0)
    expect(feeCentsOf(-5, 5)).toBe(0)
  })
})

describe('手续费显示', () => {
  it('小于 1 分时给 4 位小数，不能显示成 $0.00', () => {
    // 5 bps 下 $10 的单是 $0.005。显示 $0.00 等于「界面说免费，实际扣钱」
    expect(formatFeeAmount(0.005)).toBe('$0.0050')
    expect(formatFeeAmount(0.0001)).toBe('$0.0001')
  })

  it('1 分及以上按两位显示', () => {
    expect(formatFeeAmount(0.05)).toBe('$0.05')
    expect(formatFeeAmount(0.5)).toBe('$0.50')
    expect(formatFeeAmount(5)).toBe('$5.00')
  })

  it('0 显示 $0.00', () => {
    expect(formatFeeAmount(0)).toBe('$0.00')
  })
})

describe('确认面板的数', () => {
  it('小额单的手续费向上取整到分，不为 0', () => {
    // $5 × 5bps = $0.0025 = 0.25 分。ceil → 1 分。
    // 若这条变成 0，说明「向上取整」被改成了截断 —— 那会让手续费栏显示 $0.00
    const b = feeBreakdown(10, 0.5, BUILDER_FEE_RATES.takerBps)
    expect(b.notionalUsd).toBe(5)
    expect(b.feeUsd).toBe(0.01)
    expect(b.totalUsd).toBe(5.01)
  })

  it('费率乘的是名义额：$100 本金 + 5bps → 合计 $100.05', () => {
    const b = feeBreakdown(200, 0.5, BUILDER_FEE_RATES.takerBps)
    expect(b.notionalUsd).toBe(100)
    expect(b.feeUsd).toBe(0.05)
    expect(b.totalUsd).toBe(100.05)
    expect(b.rateLabel).toBe('0.05%')
  })

  it('合计永远不小于本金（费率非负时）', () => {
    for (const size of [1, 5, 17, 100, 999]) {
      for (const price of [0.01, 0.07, 0.155, 0.5, 0.99]) {
        const b = feeBreakdown(size, price, 5)
        expect(b.totalUsd).toBeGreaterThanOrEqual(b.notionalUsd)
      }
    }
  })

  it('本金算法与提交金额同源（Math.round 到分）', () => {
    // 与 clob-client 的 usdOf 一致。0.07×3 在浮点下是 0.21000000000000002
    expect(feeBreakdown(3, 0.07, 5).notionalUsd).toBe(0.21)
    expect(feeBreakdown(3, 0.155, 5).notionalUsd).toBe(0.47)
  })

  it('费率为 0 时退化成原来的行为', () => {
    const b = feeBreakdown(10, 0.5, 0)
    expect(b.feeUsd).toBe(0)
    expect(b.totalUsd).toBe(5)
    expect(b.proceedsUsd).toBe(5)
    expect(b.rateLabel).toBe('0%')
  })
})

describe('买入扣款 / 卖出到账', () => {
  it('卖出是从成交额里扣费，不能加上去', () => {
    // $100 本金、5bps。卖出的到手是 99.95，不是 100.05。
    // 这条挂了说明 settleOf 的方向被写反 —— 界面会把用户到手的钱说少、说成扣款
    const b = feeBreakdown(200, 0.5, BUILDER_FEE_RATES.takerBps)
    expect(settleOf(b, 'SELL').usd).toBe(99.95)
    expect(settleOf(b, 'BUY').usd).toBe(100.05)
  })

  it('两个方向的标题跟着数字一起变，不会张冠李戴', () => {
    const withFee = feeBreakdown(200, 0.5, 5)
    expect(settleOf(withFee, 'BUY').label).toBe('合计（实际扣款）')
    expect(settleOf(withFee, 'SELL').label).toBe('合计（扣费后到账）')

    // 费率为 0 时不该再说「扣款/到账」—— 没有这笔钱
    const noFee = feeBreakdown(200, 0.5, 0)
    expect(settleOf(noFee, 'BUY').label).toBe('预估总额')
    expect(settleOf(noFee, 'SELL').label).toBe('预估总额')
  })

  it('卖出到手永远不大于本金（费率非负时）', () => {
    for (const size of [5, 17, 100, 999]) {
      for (const price of [0.01, 0.07, 0.155, 0.5, 0.99]) {
        const b = feeBreakdown(size, price, 5)
        expect(b.proceedsUsd).toBeLessThanOrEqual(b.notionalUsd)
      }
    }
  })

  it('买入扣款与卖出到账关于本金对称，差额都是 2 倍手续费', () => {
    // 用分比较，不用美元浮点比 —— 0.05 这种数在 double 里本来就不是精确值
    const b = feeBreakdown(200, 0.5, 5)
    const gapCents = Math.round((b.totalUsd - b.proceedsUsd) * 100)
    expect(gapCents).toBe(Math.round(b.feeUsd * 2 * 100))
  })
})
