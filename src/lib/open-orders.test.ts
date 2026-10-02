import { expect, test } from 'vitest'
import { describeDiff, diffOpenOrders, hasDiff } from './open-orders'
import type { OpenOrderRow } from './clob-client'

function order(o: Partial<OpenOrderRow> & { id: string }): OpenOrderRow {
  return {
    assetId: 'tok',
    side: 'BUY',
    price: '0.5',
    originalSize: '10',
    sizeMatched: '0',
    orderType: 'GTC',
    status: 'LIVE',
    createdAt: '2026-01-01T00:00:00Z',
    ...o,
  }
}

test('列表没变就没有差异，也不报告警', () => {
  const list = [order({ id: 'a' }), order({ id: 'b', sizeMatched: '3' })]
  const d = diffOpenOrders(list, list)
  expect(d).toEqual({ gone: [], filled: [] })
  expect(hasDiff(d)).toBe(false)
  expect(describeDiff(d)).toBeNull()
})

/**
 * 这条钉的就是重复买入那个坑：页面上还显示着的挂单，交易所那边已经没了
 * （成交或被撤）。必须报出来，否则用户按一份过期列表做决定。
 */
test('挂单在交易所那边消失要报出来', () => {
  const d = diffOpenOrders([order({ id: 'a' }), order({ id: 'b' })], [order({ id: 'b' })])
  expect(d.gone.map((o) => o.id)).toEqual(['a'])
  expect(d.filled).toEqual([])
  expect(describeDiff(d)).toContain('挂单数据异常')
})

test('成交量变多了算差异，并累计新成交的份额', () => {
  const d = diffOpenOrders(
    [order({ id: 'a', sizeMatched: '0' }), order({ id: 'b', sizeMatched: '1' })],
    [order({ id: 'a', sizeMatched: '4' }), order({ id: 'b', sizeMatched: '2.5' })],
  )
  expect(d.gone).toEqual([])
  expect(d.filled.map((f) => [f.order.id, f.addedShares])).toEqual([['a', 4], ['b', 1.5]])
  // 份额去掉尾零：5.5 而不是 5.5000
  expect(describeDiff(d)).toContain('5.5 份')
})

/** 撤成功的那笔必然从列表里消失，报成「异常」就是狼来了，真异常会被淹掉 */
test('ignoreIds 里的挂单消失不算异常', () => {
  const d = diffOpenOrders([order({ id: 'a' })], [], ['a'])
  expect(hasDiff(d)).toBe(false)
})

test('ignoreIds 不影响其他挂单的判定', () => {
  const d = diffOpenOrders([order({ id: 'a' }), order({ id: 'b' })], [], ['a'])
  expect(d.gone.map((o) => o.id)).toEqual(['b'])
})

/** 新出现的挂单（别处下的单）不是异常：它不会让人误判「还没买到」 */
test('新多出来的挂单不算异常', () => {
  const d = diffOpenOrders([order({ id: 'a' })], [order({ id: 'a' }), order({ id: 'b' })])
  expect(hasDiff(d)).toBe(false)
})

/** 部分成交回退（交易所口径抖动）不该报成「又成交了」—— 只有变多才是 */
test('成交量没变多不算差异', () => {
  const d = diffOpenOrders([order({ id: 'a', sizeMatched: '4' })], [order({ id: 'a', sizeMatched: '4' })])
  expect(hasDiff(d)).toBe(false)
  const back = diffOpenOrders([order({ id: 'a', sizeMatched: '4' })], [order({ id: 'a', sizeMatched: '3' })])
  expect(hasDiff(back)).toBe(false)
})

/** 字段是字符串，解析不出来要按 0 算，不能让 NaN 把判据传染成「有差异」 */
test('成交量字段解析不出来时不误报差异', () => {
  const d = diffOpenOrders([order({ id: 'a', sizeMatched: 'x' })], [order({ id: 'a', sizeMatched: 'y' })])
  expect(hasDiff(d)).toBe(false)
})

test('告警文案同时涵盖消失与新成交，并提示去核对持仓', () => {
  const msg = describeDiff(
    diffOpenOrders(
      [order({ id: 'a' }), order({ id: 'b', sizeMatched: '0' })],
      [order({ id: 'b', sizeMatched: '2' })],
    ),
  )
  expect(msg).toContain('1 笔挂单已不在交易所')
  expect(msg).toContain('又成交了 2 份')
  expect(msg).toContain('重复买入')
})
