/**
 * 盘口导出的回归测试。
 *
 * 钉三处会在文件里**看不出来**的错：
 *  1. CLOB 的 bids/asks 顺序是反的 —— 不重排，读文件的人会把最差价当最优价
 *  2. 深度按 asset_id 对位，不按请求顺序 —— 错位会让价量系统性错配
 *  3. 导出覆盖**全部**盘口，而不是画布此刻显示的那些（折叠时点导出不该少盘口）
 *
 * 排版与下载没法在 node 里验（要 Blob / a.click），所以只测纯逻辑。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  buildBookExport,
  exportFileName,
  nodesToExport,
  toExportSide,
  toLevels,
  tokensOf,
  type RawBook,
} from './book-export'
import type { MarketGraph, GraphNode } from '../graph/types'

function node(id: string, label: string, tokens: string[]): GraphNode {
  return {
    id,
    marketId: `m-${id}`,
    conditionId: `0x${id}`,
    desc: {
      family: 'ou',
      period: 'ft',
      metric: 'goals',
      subject: 'match',
      line: 2.5,
      homeLine: null,
      score: null,
      player: null,
      role: null,
      label,
      goalSensitive: true,
    },
    questionEn: `Will there be over 2.5 goals in ${id}?`,
    questionZh: `${id} 全场总进球超过 2.5 吗？`,
    volume: 1234.5,
    liquidity: 678.9,
    sides: tokens.map((t, i) => ({
      name: i === 0 ? 'Over' : 'Under',
      tokenId: t,
      price: 0.5,
      bid: null,
      ask: null,
      quoted: false,
    })),
    primarySide: 'Over',
    impact: { homeGoal: 'up', awayGoal: 'up', magnitude: 0, deltaHome: null, deltaAway: null, modelled: false },
    emphasis: 'major',
    column: 'ft',
    row: 0,
  }
}

function graph(nodes: GraphNode[]): MarketGraph {
  return {
    eventId: 'ev1',
    homeTeamEn: 'Everton FC',
    awayTeamEn: 'Wolverhampton Wanderers FC',
    homeTeamZh: '埃弗顿',
    awayTeamZh: '狼队',
    title: 'Everton FC vs. Wolverhampton Wanderers FC',
    league: '英超',
    endTime: '2026-10-09T19:00:00Z',
    lambdaTotal: null,
    lambdaHome: null,
    lambdaAway: null,
    nodes,
    edges: [],
    groups: [],
    columns: [],
    stats: { markets: nodes.length, withVolume: 0, goalSensitive: 0, edges: 0, violations: 0 },
  }
}

test('toLevels：买方由高到低、卖方由低到高，第一项都是最优价', () => {
  const bids = toLevels(
    [
      { price: '0.40', size: '10' },
      { price: '0.48', size: '20' },
      { price: '0.45', size: '30' },
    ],
    'bids',
  )
  assert.deepEqual(bids.map((l) => l.price), [0.48, 0.45, 0.4])

  const asks = toLevels(
    [
      { price: '0.55', size: '10' },
      { price: '0.51', size: '20' },
    ],
    'asks',
  )
  assert.deepEqual(asks.map((l) => l.price), [0.51, 0.55])
})

test('toLevels：默认只留前 3 档，且是排序后的前 3 档', () => {
  // CLOB 原样返回的买盘顺序是**反的**（从低到高）。照原序截前 3 会拿到最差三档，
  // 而那三个数在文件里和最优三档分辨不出来 —— 必须先排序再截断。
  const raw = [
    { price: '0.10', size: '1' },
    { price: '0.20', size: '2' },
    { price: '0.30', size: '3' },
    { price: '0.40', size: '4' },
    { price: '0.50', size: '5' },
  ]
  assert.deepEqual(toLevels(raw, 'bids').map((l) => l.price), [0.5, 0.4, 0.3])
  assert.deepEqual(toLevels(raw, 'asks').map((l) => l.price), [0.1, 0.2, 0.3])
  // 档数可调
  assert.equal(toLevels(raw, 'bids', 5).length, 5)
  assert.equal(toLevels(raw, 'bids', 1).length, 1)
})

test('toLevels：notional = 价 × 量，按分收口', () => {
  // 0.55 × 120.5 = 66.275，浮点尾巴不该印进文件
  assert.deepEqual(toLevels([{ price: '0.55', size: '120.5' }], 'bids'), [
    { price: 0.55, size: 120.5, notional: 66.28 },
  ])
})

test('toLevels：丢掉 size<=0 的残留档与非法值', () => {
  const out = toLevels(
    [
      { price: '0.9', size: '0' },
      { price: '0.5', size: '5' },
      { price: 'x', size: 'y' },
      { price: '0.3' },
    ],
    'bids',
  )
  assert.deepEqual(out.map((l) => l.price), [0.5])
  assert.deepEqual(toLevels(null, 'bids'), [])
  assert.deepEqual(toLevels(undefined, 'asks'), [])
})

test('toExportSide：买一/卖一来自档位本身，并给点差、中价、合计', () => {
  const s = toExportSide('Over', 't1', {
    bids: [
      { price: '0.49', size: '100' },
      { price: '0.48', size: '50' },
    ],
    asks: [{ price: '0.52', size: '80' }],
    last_trade_price: '0.5',
  })
  assert.equal(s.bestBid, 0.49)
  assert.equal(s.bestAsk, 0.52)
  assert.equal(s.spread, 0.03)
  assert.equal(s.mid, 0.505)
  assert.equal(s.lastTradePrice, 0.5)
  assert.equal(s.totals.bidSize, 150)
  assert.equal(s.totals.bidNotional, 73) // 0.49×100 + 0.48×50
  assert.equal(s.totals.askSize, 80)
  assert.equal(s.missing, false)
})

test('toExportSide：点差与中价不留浮点尾巴', () => {
  // (0.07+0.08)/2 的浮点值是 0.07500000000000001，不收口就会这么印进文件
  const s = toExportSide('Yes', 't1', {
    bids: [{ price: '0.07', size: '138.86' }],
    asks: [{ price: '0.08', size: '100' }],
  })
  assert.equal(s.mid, 0.075)
  assert.equal(s.spread, 0.01)
  // 0.3-0.1 = 0.19999999999999998
  const t = toExportSide('Yes', 't2', {
    bids: [{ price: '0.1', size: '1' }],
    asks: [{ price: '0.3', size: '1' }],
  })
  assert.equal(t.spread, 0.2)
  assert.equal(t.mid, 0.2)
})

test('toExportSide：单边盘不拿另一侧顶替点差与中价', () => {
  const s = toExportSide('Under', 't2', { bids: [{ price: '0.3', size: '10' }] })
  assert.equal(s.bestBid, 0.3)
  assert.equal(s.bestAsk, null)
  assert.equal(s.spread, null)
  assert.equal(s.mid, null)
})

test('toExportSide：「没拉到」与「拉到了但空着」要分开', () => {
  // 赛前盘口空着是常态，不是缺口
  const empty = toExportSide('Over', 't1', { bids: [], asks: [] })
  assert.equal(empty.missing, false)
  assert.deepEqual(empty.bids, [])

  const absent = toExportSide('Over', 't1', undefined)
  assert.equal(absent.missing, true)
})

test('toExportSide：totals 只统计导出的那几档', () => {
  // 5 档买盘，默认只导前 3 档 → 合计也只能是那 3 档的量
  const s = toExportSide('Yes', 't1', {
    bids: [
      { price: '0.5', size: '10' },
      { price: '0.4', size: '10' },
      { price: '0.3', size: '10' },
      { price: '0.2', size: '10' },
      { price: '0.1', size: '10' },
    ],
    asks: [],
  })
  assert.equal(s.bids.length, 3)
  assert.equal(s.totals.bidSize, 30, '不是整本的 50')
  assert.equal(s.totals.bidNotional, 12) // (0.5+0.4+0.3)×10
})

test('tokensOf：两侧 token 都收，去重', () => {
  const nodes = [node('a', '全场 2.5', ['t1', 't2']), node('b', '全场 1.5', ['t2', 't3'])]
  assert.deepEqual(tokensOf(nodes).sort(), ['t1', 't2', 't3'])
})

test('nodesToExport：给了 id 就只留那些，没给就是全图', () => {
  const nodes = [
    node('a', '盘口 A', ['t1', 't2']),
    node('b', '盘口 B', ['t3', 't4']),
    node('c', '盘口 C', ['t5', 't6']),
  ]
  const g = graph(nodes)
  assert.deepEqual(nodesToExport(g).map((n) => n.id), ['a', 'b', 'c'])
  assert.deepEqual(nodesToExport(g, new Set(['c', 'a'])).map((n) => n.id), ['a', 'c'], '顺序按图走')
  assert.deepEqual(nodesToExport(g, new Set()).map((n) => n.id), [])
  // 图上没有的 id 不会凭空造出盘口
  assert.deepEqual(nodesToExport(g, new Set(['zzz'])).map((n) => n.id), [])
})

test('buildBookExport：三层结构齐全，深度按 asset_id 对位', () => {
  const g = graph([node('a', '全场 2.5', ['t1', 't2'])])
  // 故意把 map 的插入顺序与 sides 顺序反过来 —— 按顺序对位就会错配
  const books = new Map<string, RawBook>([
    ['t2', { asset_id: 't2', bids: [{ price: '0.45', size: '10' }], asks: [], tick_size: '0.01' }],
    ['t1', { asset_id: 't1', bids: [], asks: [{ price: '0.55', size: '20' }], tick_size: '0.01' }],
  ])
  const data = buildBookExport(g, books, { eventIds: ['ev1', 'ev2'], now: new Date('2026-10-09T12:00:00Z') })

  assert.equal(data.match.title, 'Everton FC vs. Wolverhampton Wanderers FC')
  assert.equal(data.match.homeTeam, '埃弗顿')
  assert.equal(data.match.kickoff, '2026-10-09T19:00:00Z')
  assert.deepEqual(data.match.eventIds, ['ev1', 'ev2'])
  assert.equal(data.exportedAt, '2026-10-09T12:00:00.000Z')

  const m = data.markets[0]
  assert.equal(m.label, '全场 2.5')
  assert.equal(m.question, 'a 全场总进球超过 2.5 吗？')
  assert.equal(m.conditionId, '0xa')
  assert.equal(m.tickSize, '0.01')
  assert.equal(m.kind.line, 2.5)

  const over = m.sides.find((s) => s.tokenId === 't1')!
  assert.equal(over.name, 'Over', '侧名跟着 token 走，不能被 map 顺序带偏')
  assert.equal(over.bestAsk, 0.55)
  assert.equal(over.bestBid, null)
  const under = m.sides.find((s) => s.tokenId === 't2')!
  assert.equal(under.bestBid, 0.45)
})

test('buildBookExport：只导指定的盘口，但总数仍报这场比赛的全部', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => node(`n${i}`, `盘口 ${i}`, [`a${i}`, `b${i}`]))
  const data = buildBookExport(graph(nodes), new Map(), { nodeIds: new Set(['n0', 'n1', 'n2']) })

  assert.equal(data.markets.length, 3)
  assert.equal(data.scope.markets, 3, '导了 3 个')
  assert.equal(data.scope.ofTotal, 12, '这场一共 12 个')
  // match.markets 是比赛总数，不是导出数 —— 两个数都在，才看得出这份文件只是一页
  assert.equal(data.match.markets, 12)
  assert.equal(data.stats.markets, 3)
  assert.equal(data.stats.tokens, 6, '只统计导出的那 3 个盘口的 token')
})

test('buildBookExport：不给 nodeIds 就导全图', () => {
  const nodes = Array.from({ length: 5 }, (_, i) => node(`n${i}`, `盘口 ${i}`, [`a${i}`, `b${i}`]))
  const data = buildBookExport(graph(nodes), new Map())
  assert.equal(data.scope.markets, 5)
  assert.equal(data.scope.ofTotal, 5)
})

test('buildBookExport：levelsPerSide 标明截断值', () => {
  const g = graph([node('a', '全场 2.5', ['t1', 't2'])])
  const deep: RawBook = {
    asset_id: 't1',
    bids: Array.from({ length: 9 }, (_, i) => ({ price: String(0.5 - i * 0.01), size: '10' })),
    asks: Array.from({ length: 9 }, (_, i) => ({ price: String(0.6 + i * 0.01), size: '10' })),
  }
  const books = new Map<string, RawBook>([['t1', deep]])

  const d3 = buildBookExport(g, books)
  assert.equal(d3.levelsPerSide, 3)
  const s3 = d3.markets[0].sides.find((s) => s.tokenId === 't1')!
  assert.equal(s3.bids.length, 3)
  assert.equal(s3.asks.length, 3)
  assert.equal(s3.bestBid, 0.5, '截断不影响买一')
  assert.equal(s3.bestAsk, 0.6)

  const d9 = buildBookExport(g, books, { levels: 9 })
  assert.equal(d9.levelsPerSide, 9)
  assert.equal(d9.markets[0].sides.find((s) => s.tokenId === 't1')!.bids.length, 9)
})

test('buildBookExport：统计把「没拉到」的数报出来', () => {
  const g = graph([node('a', '全场 2.5', ['t1', 't2']), node('b', '全场 1.5', ['t3', 't4'])])
  const books = new Map<string, RawBook>([
    ['t1', { asset_id: 't1', bids: [{ price: '0.4', size: '5' }], asks: [{ price: '0.6', size: '5' }] }],
    ['t2', { asset_id: 't2', bids: [], asks: [] }],
  ])
  const data = buildBookExport(g, books)
  assert.equal(data.stats.tokens, 4)
  assert.equal(data.stats.withDepth, 1, 't1 有挂单')
  assert.equal(data.stats.missing, 2, 't3/t4 整个没拉到')
  assert.equal(data.stats.levels, 2)
})

test('buildBookExport：没有盘口也能导出（空壳，不抛）', () => {
  const data = buildBookExport(graph([]), new Map())
  assert.deepEqual(data.markets, [])
  assert.equal(data.stats.tokens, 0)
})

test('exportFileName：用英文队名 + 时间戳，中英导出同名', () => {
  const data = buildBookExport(graph([]), new Map())
  const name = exportFileName(data, new Date(2026, 9, 9, 19, 30))
  // 中文界面下 match.homeTeam 是「埃弗顿」，但文件名仍走英文原名
  assert.equal(name, 'polysoccer-book-everton-fc-vs-wolverhamp-20261009-1930.json')
  assert.ok(/^[a-z0-9.-]+$/.test(name), '文件名只含 ASCII')
})
