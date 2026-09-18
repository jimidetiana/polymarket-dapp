/**
 * 盘口状态的回归测试。
 *
 * 重点在两处最容易错的地方：
 *  1. CLOB 的 bids/asks 顺序不保证 —— 不排序就会取到中间某一档当"最优价"
 *  2. best_bid_ask / price_change 不带 size —— 直接覆盖会把 book 带来的量冲掉
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  EMPTY_QUOTE,
  isTradable,
  mergeQuote,
  midOf,
  quoteFromBook,
  sortLevels,
  toLiveQuotes,
  type Quote,
} from './book'

test('sortLevels：买方由高到低，卖方由低到高', () => {
  const raw = {
    bids: [
      { price: '0.40', size: '10' },
      { price: '0.48', size: '20' },
      { price: '0.45', size: '30' },
    ],
    asks: [
      { price: '0.55', size: '10' },
      { price: '0.51', size: '20' },
    ],
  }
  assert.deepEqual(sortLevels(raw, 'bids', 1), [[0.48, 20]])
  assert.deepEqual(sortLevels(raw, 'asks', 1), [[0.51, 20]])
})

test('sortLevels：丢掉 size<=0 的残留档', () => {
  const raw = { bids: [{ price: '0.9', size: '0' }, { price: '0.5', size: '5' }] }
  assert.deepEqual(sortLevels(raw, 'bids'), [[0.5, 5]])
})

test('sortLevels：字段缺失或非法不抛异常', () => {
  assert.deepEqual(sortLevels(null, 'bids'), [])
  assert.deepEqual(sortLevels({}, 'asks'), [])
  assert.deepEqual(sortLevels({ bids: [{ price: 'x', size: 'y' }] }, 'bids'), [])
})

test('quoteFromBook：取最优两侧并带上 size', () => {
  const q = quoteFromBook(
    {
      asset_id: 't1',
      bids: [{ price: '0.49', size: '100' }],
      asks: [{ price: '0.52', size: '80' }],
    },
    1000,
  )
  assert.equal(q.bid, 0.49)
  assert.equal(q.ask, 0.52)
  assert.equal(q.bidSize, 100)
  assert.equal(q.askSize, 80)
  assert.equal(q.at, 1000)
})

test('mergeQuote：价位不变时继承 size（核心规则）', () => {
  const prev: Quote = { bid: 0.49, ask: 0.52, bidSize: 100, askSize: 80, at: 1 }
  // best_bid_ask 只带价格，且价格没动
  const q = mergeQuote(prev, { best_bid: '0.49', best_ask: '0.52' }, 2)
  assert.equal(q.bidSize, 100, '价位未变应继承量')
  assert.equal(q.askSize, 80)
  assert.equal(q.at, 2)
})

test('mergeQuote：价位变化时丢弃旧 size', () => {
  const prev: Quote = { bid: 0.49, ask: 0.52, bidSize: 100, askSize: 80, at: 1 }
  const q = mergeQuote(prev, { best_bid: '0.50', best_ask: '0.52' }, 2)
  assert.equal(q.bid, 0.5)
  assert.equal(q.bidSize, null, '换了一档，旧量不再适用')
  assert.equal(q.askSize, 80, '未变动的那侧仍继承')
})

test('mergeQuote：price_change 单侧按 side 归位', () => {
  const base: Quote = { bid: 0.4, ask: 0.6, bidSize: 5, askSize: 5, at: 1 }
  const buy = mergeQuote(base, { price: '0.45', side: 'BUY' }, 2)
  assert.equal(buy.bid, 0.45)
  assert.equal(buy.ask, 0.6, '另一侧不动')

  const sell = mergeQuote(base, { price: '0.58', side: 'SELL' }, 2)
  assert.equal(sell.ask, 0.58)
  assert.equal(sell.bid, 0.4)
})

test('mergeQuote：无 prev 时从空报价起算', () => {
  const q = mergeQuote(undefined, { best_bid: '0.3', best_ask: '0.7' }, 5)
  assert.equal(q.bid, 0.3)
  assert.equal(q.ask, 0.7)
  assert.equal(q.bidSize, null)
})

test('isTradable：四条排除规则', () => {
  assert.ok(isTradable({ bid: 0.49, ask: 0.52, bidSize: 1, askSize: 1, at: 1 }))
  // 缺一侧
  assert.ok(!isTradable({ bid: 0.49, ask: null, bidSize: 1, askSize: null, at: 1 }))
  // 结算：赢家被推到 1.0
  assert.ok(!isTradable({ bid: 0.99, ask: 1, bidSize: 1, askSize: 1, at: 1 }))
  // 输家被推到 0
  assert.ok(!isTradable({ bid: 0, ask: 0.02, bidSize: 1, askSize: 1, at: 1 }))
  // 交叉/锁盘
  assert.ok(!isTradable({ bid: 0.55, ask: 0.52, bidSize: 1, askSize: 1, at: 1 }))
  assert.ok(!isTradable(EMPTY_QUOTE))
  assert.ok(!isTradable(undefined))
})

test('midOf：两侧取中价，缺侧退回单侧', () => {
  assert.equal(midOf({ bid: 0.4, ask: 0.6, bidSize: null, askSize: null, at: 1 }), 0.5)
  assert.equal(midOf({ bid: null, ask: 0.6, bidSize: null, askSize: null, at: 1 }), 0.6)
  assert.equal(midOf({ bid: 0.4, ask: null, bidSize: null, askSize: null, at: 1 }), 0.4)
  assert.equal(midOf(undefined), null)
})

test('toLiveQuotes：只放行可成交的报价', () => {
  const book = new Map<string, Quote>([
    ['ok', { bid: 0.49, ask: 0.52, bidSize: 1, askSize: 1, at: 1 }],
    ['single', { bid: 0.49, ask: null, bidSize: 1, askSize: null, at: 1 }],
    ['crossed', { bid: 0.6, ask: 0.5, bidSize: 1, askSize: 1, at: 1 }],
    ['settled', { bid: 0.99, ask: 1, bidSize: 1, askSize: 1, at: 1 }],
  ])
  const out = toLiveQuotes(book)
  assert.deepEqual(Object.keys(out), ['ok'], '脏数据不能被标成可成交')
  assert.deepEqual(out.ok, { bid: 0.49, ask: 0.52 })
})
