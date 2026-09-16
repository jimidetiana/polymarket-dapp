import { describe, it, expect } from 'vitest'
import {
  tickDecimals,
  tickScale,
  toSteps,
  fromSteps,
  priceBounds,
  stepBounds,
  isPriceValid,
  snapToTick,
  formatTickPrice,
  formatTickPercent,
} from './tick'

describe('tick 精度', () => {
  it('0.001 档 round-trip 不丢精度', () => {
    // 这是整个模块存在的原因：0.155 * 1000 在 IEEE 754 下是 154.999...
    expect(toSteps(0.155, '0.001')).toBe(155)
    expect(fromSteps(155, '0.001')).toBe(0.155)
    expect(toSteps(fromSteps(155, '0.001'), '0.001')).toBe(155)
  })

  it('0.07 这类看似干净的数 round-trip 也不丢', () => {
    // 0.07 * 100 = 7.000000000000001
    expect(toSteps(0.07, '0.01')).toBe(7)
    expect(fromSteps(7, '0.01')).toBe(0.07)
  })

  it('合法区间随 tick 变，不是写死 1~99 分', () => {
    expect(priceBounds('0.01')).toEqual({ min: 0.01, max: 0.99 })
    expect(priceBounds('0.001')).toEqual({ min: 0.001, max: 0.999 })
    expect(stepBounds('0.001')).toEqual({ minSteps: 1, maxSteps: 999 })
  })

  it('priceValid 同时拦区间和步进', () => {
    // 区间：tick=0.01 时 0.005 太小、1.0 太大
    expect(isPriceValid(0.005, '0.01')).toBe(false)
    expect(isPriceValid(1, '0.01')).toBe(false)
    expect(isPriceValid(0.5, '0.01')).toBe(true)
    // 步进：tick=0.01 的市场挂 0.155 会被 CLOB 拒
    expect(isPriceValid(0.155, '0.01')).toBe(false)
    expect(isPriceValid(0.155, '0.001')).toBe(true)
  })

  it('snapToTick 把越界和偏网格的价格夹回合法点', () => {
    expect(snapToTick(0, '0.001')).toBe(0.001)
    expect(snapToTick(1, '0.001')).toBe(0.999)
    expect(snapToTick(0.1554, '0.001')).toBe(0.155)
    expect(snapToTick(0.1556, '0.001')).toBe(0.156)
    // tick=0.01 时 0.155 吸附到 0.16（最近网格）
    expect(snapToTick(0.155, '0.01')).toBe(0.16)
  })

  it('展示位数跟 tick 走，0.001 档绝不四舍五入到分', () => {
    expect(formatTickPrice(0.155, '0.001')).toBe('0.155')
    expect(formatTickPrice(0.155, '0.01')).toBe('0.16')
    expect(formatTickPercent(0.155, '0.001')).toBe('15.5%')
    expect(formatTickPercent(0.155, '0.01')).toBe('16%')
  })

  it('展示与算术必须给出同一个价格（守住 toFixed 分叉）', () => {
    // 这条是本模块最重要的不变量。实测 0.155：
    //   Math.round(0.155 * 100) = 16      → 算术路径 0.16
    //   (0.155).toFixed(2)      = "0.15"  → 展示路径 0.15
    // 若展示改回 toFixed，界面会显示 0.15 而下单提交 0.16。
    const probes = [0.155, 0.145, 0.945, 0.175, 0.07, 0.005, 0.995]
    for (const tick of ['0.1', '0.01', '0.001', '0.0001'] as const) {
      for (const p of probes) {
        const shown = formatTickPrice(p, tick)
        const submitted = fromSteps(toSteps(p, tick), tick)
        expect(Number(shown)).toBe(submitted)
      }
    }
  })

  it('tickDecimals / tickScale 四档都对', () => {
    expect(tickDecimals('0.1')).toBe(1)
    expect(tickDecimals('0.01')).toBe(2)
    expect(tickDecimals('0.001')).toBe(3)
    expect(tickDecimals('0.0001')).toBe(4)
    expect(tickScale('0.001')).toBe(1000)
  })
})
