/**
 * 盘口网构建测试。
 *
 * 跑法：npx tsx --test src/market-graph/graph.test.ts
 *
 * 最要紧的两条：
 *  1. 违约必须是**可成交的套利**，不能被宽价差误报（那会让告警全是噪音）。
 *  2. 让球盘两条边必须统一到主队视角，否则梯子在比两个不同的问题。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { applyLivePrices, buildMarketGraph, type GraphMarketInput } from './graph.js'

const EVENT = {
  id: '863002',
  titleEn: 'Chelsea FC vs. Brighton & Hove Albion FC',
  titleZh: '切尔西 vs 布莱顿',
  homeTeamEn: 'Chelsea FC',
  awayTeamEn: 'Brighton & Hove Albion FC',
  homeTeamZh: '切尔西',
  awayTeamZh: '布莱顿',
  league: '英超',
  endTime: '2026-08-30 14:00:00',
}

let seq = 0
function mk(over: Partial<GraphMarketInput> & { questionEn: string }): GraphMarketInput {
  seq += 1
  return {
    id: String(seq),
    outcomes: ['Over', 'Under'],
    clobTokenIds: [`t${seq}a`, `t${seq}b`],
    volume: 1000,
    liquidity: 5000,
    ...over,
  }
}

const ou = (line: number, extra: Partial<GraphMarketInput> = {}) =>
  mk({
    questionEn: `Chelsea FC vs. Brighton & Hove Albion FC: O/U ${line}`,
    line,
    ...extra,
  })

const yesNo = (questionEn: string, extra: Partial<GraphMarketInput> = {}) =>
  mk({ questionEn, outcomes: ['Yes', 'No'], ...extra })

// ==================== 节点 ====================

test('零成交的盘口也进图，认不出的问句不进图', () => {
  const g = buildMarketGraph(EVENT, [
    ou(2.5),
    ou(1.5, { volume: 0 }),
    mk({ questionEn: 'Who will referee the match?', volume: 500 }),
  ])
  assert.deepEqual(
    g.nodes.map((n) => n.desc.line),
    [2.5, 1.5],
  )
  assert.equal(g.stats.markets, 3)
  assert.equal(g.stats.withVolume, 1)
})

test('给了 minVolume 才按成交量过滤', () => {
  const g = buildMarketGraph(EVENT, [ou(2.5), ou(1.5, { volume: 0 })], { minVolume: 0 })
  assert.equal(g.nodes.length, 1)
  assert.equal(g.nodes[0].desc.line, 2.5)
})

test('零成交盘口的快照价不参与 λ 反推，收到实时报价后才算', () => {
  // 只有一条零成交的 2.5 线，快照价 0.5：没有实时报价时不该反推出 λ
  const g = buildMarketGraph(EVENT, [ou(2.5, { volume: 0, outcomePrices: ['0.5', '0.5'] })])
  assert.equal(g.lambdaTotal, null)
  const over = g.nodes[0].sides[0].tokenId as string
  const live = applyLivePrices(g, { [over]: { bid: 0.44, ask: 0.46 } })
  assert.ok(live.lambdaTotal != null && live.lambdaTotal > 0)
})

test('列分配：角球与总进球不同列，单队与全场不同列', () => {
  const g = buildMarketGraph(EVENT, [
    ou(2.5),
    mk({ questionEn: 'Chelsea FC vs. Brighton & Hove Albion FC: O/U 10.5 Total Corners', line: 10.5 }),
    mk({ questionEn: 'Chelsea FC vs. Brighton & Hove Albion FC: Chelsea FC O/U 1.5', line: 1.5 }),
    yesNo('Will Chelsea FC win on 2026-08-30?'),
  ])
  const col = (q: string) => g.nodes.find((n) => n.questionEn.includes(q))!.column
  assert.equal(col('O/U 2.5'), 'total')
  assert.equal(col('Total Corners'), 'corner')
  assert.equal(col('Chelsea FC O/U 1.5'), 'team')
  assert.equal(col('win on'), 'ml')
})

test('重点标记跟随「受进球影响」，角球盘是 minor', () => {
  const g = buildMarketGraph(EVENT, [
    ou(2.5),
    mk({ questionEn: 'Chelsea FC vs. Brighton & Hove Albion FC: O/U 10.5 Total Corners', line: 10.5 }),
  ])
  const total = g.nodes.find((n) => n.column === 'total')!
  const corner = g.nodes.find((n) => n.column === 'corner')!
  assert.equal(total.emphasis, 'major')
  assert.equal(corner.emphasis, 'minor')
})

test('同一条梯子在列内竖着相邻（行号按线递增）', () => {
  const g = buildMarketGraph(EVENT, [ou(2.5), ou(0.5), ou(1.5)])
  const rows = g.nodes
    .slice()
    .sort((a, b) => a.row - b.row)
    .map((n) => n.desc.line)
  assert.deepEqual(rows, [0.5, 1.5, 2.5])
})

// ==================== 梯子边 ====================

test('大小球梯子：相邻档之间一条边，方向低档→高档', () => {
  const g = buildMarketGraph(EVENT, [ou(0.5), ou(1.5), ou(2.5)])
  const ladders = g.edges.filter((e) => e.kind === 'ladder')
  assert.equal(ladders.length, 2)
  assert.equal(ladders.every((e) => e.op === 'monotonic_desc'), true)
})

test('梯子只连相邻档，不连 0.5→2.5（否则边数爆炸且约束更松）', () => {
  const g = buildMarketGraph(EVENT, [ou(0.5), ou(1.5), ou(2.5)])
  const n = (line: number) => g.nodes.find((x) => x.desc.line === line)!.id
  const ids = g.edges.filter((e) => e.kind === 'ladder').map((e) => `${e.from}->${e.to}`)
  assert.ok(ids.includes(`${n(0.5)}->${n(1.5)}`))
  assert.ok(ids.includes(`${n(1.5)}->${n(2.5)}`))
  assert.ok(!ids.includes(`${n(0.5)}->${n(2.5)}`))
})

test('半场档与全场档不在同一条梯子里', () => {
  const g = buildMarketGraph(EVENT, [
    ou(1.5),
    ou(2.5),
    mk({ questionEn: 'Chelsea FC vs. Brighton & Hove Albion FC: 1st Half O/U 1.5', line: 1.5 }),
  ])
  const ladders = g.edges.filter((e) => e.kind === 'ladder')
  assert.equal(ladders.length, 1, '只有全场 1.5→2.5 这一条梯子边')
})

test('让球梯子统一到主队视角：客队让球那条被翻过来排', () => {
  const g = buildMarketGraph(EVENT, [
    mk({
      questionEn: 'Spread: Chelsea FC (-1.5)',
      line: -1.5,
      outcomes: ['Chelsea FC', 'Brighton & Hove Albion FC'],
    }),
    mk({
      questionEn: 'Spread: Brighton & Hove Albion FC (-1.5)',
      line: -1.5,
      outcomes: ['Brighton & Hove Albion FC', 'Chelsea FC'],
    }),
  ])
  // 两条盘口的 homeLine 分别是 -1.5 与 +1.5
  const lines = g.nodes.map((n) => n.desc.homeLine).sort((a, b) => (a ?? 0) - (b ?? 0))
  assert.deepEqual(lines, [-1.5, 1.5])
  // 主侧一律取主队那一侧，这样两个节点的价格才在说同一件事
  for (const n of g.nodes) assert.equal(n.primarySide, 'Chelsea FC')
  const ladder = g.edges.find((e) => e.kind === 'ladder')!
  assert.equal(ladder.op, 'monotonic_asc')
})

// ==================== 蕴含边 ====================

test('单队进球 ⊂ 全场总进球（同线）', () => {
  const g = buildMarketGraph(EVENT, [
    ou(1.5),
    mk({ questionEn: 'Chelsea FC vs. Brighton & Hove Albion FC: Chelsea FC O/U 1.5', line: 1.5 }),
  ])
  const e = g.edges.find((x) => x.kind === 'implies')!
  assert.equal(e.op, 'implies_lte')
  const from = g.nodes.find((n) => n.id === e.from)!
  assert.equal(from.desc.subject, 'home')
})

test('半场 ⊂ 全场，标成 period 边', () => {
  const g = buildMarketGraph(EVENT, [
    ou(1.5),
    mk({ questionEn: 'Chelsea FC vs. Brighton & Hove Albion FC: 1st Half O/U 1.5', line: 1.5 }),
  ])
  const e = g.edges.find((x) => x.kind === 'period')!
  assert.equal(g.nodes.find((n) => n.id === e.from)!.desc.period, 'ht')
  assert.equal(g.nodes.find((n) => n.id === e.to)!.desc.period, 'ft')
})

test('双方进球 ⟹ Over 1.5，且 ⟹ 两队各自 Over 0.5', () => {
  const g = buildMarketGraph(EVENT, [
    ou(1.5),
    mk({ questionEn: 'Chelsea FC vs. Brighton & Hove Albion FC: Chelsea FC O/U 0.5', line: 0.5 }),
    mk({ questionEn: 'Chelsea FC vs. Brighton & Hove Albion FC: Brighton & Hove Albion FC O/U 0.5', line: 0.5 }),
    yesNo('Chelsea FC vs. Brighton & Hove Albion FC: Both Teams to Score'),
  ])
  const btts = g.nodes.find((n) => n.desc.family === 'btts')!
  const outgoing = g.edges.filter((e) => e.from === btts.id)
  assert.equal(outgoing.length, 3)
})

test('准确比分只连最紧那条线 + 对应胜平负腿，不连所有低档', () => {
  const g = buildMarketGraph(EVENT, [
    ou(0.5),
    ou(1.5),
    ou(2.5),
    yesNo('Will Chelsea FC win on 2026-08-30?'),
    yesNo('Exact Score: Chelsea FC 2 - 1 Brighton & Hove Albion FC?'),
  ])
  const exact = g.nodes.find((n) => n.desc.family === 'exact')!
  const outgoing = g.edges.filter((e) => e.from === exact.id)
  assert.equal(outgoing.length, 2, '一条到 Over 2.5（总 3 球的最紧线），一条到主胜')
  const targets = outgoing.map((e) => g.nodes.find((n) => n.id === e.to)!)
  assert.ok(targets.some((t) => t.desc.line === 2.5))
  assert.ok(targets.some((t) => t.desc.role === 'home'))
})

test('球员进球 ⟹ 全场有进球', () => {
  const g = buildMarketGraph(EVENT, [ou(0.5), yesNo('Cole Palmer: Anytime Goalscorer')])
  const scorer = g.nodes.find((n) => n.desc.family === 'scorer')!
  const e = g.edges.find((x) => x.from === scorer.id)!
  assert.equal(g.nodes.find((n) => n.id === e.to)!.desc.line, 0.5)
})

// ==================== 违约判定 ====================

function quotesFor(g: ReturnType<typeof buildMarketGraph>, byLabel: Record<string, [number, number]>) {
  const q: Record<string, { bid: number | null; ask: number | null }> = {}
  for (const [label, [bid, ask]] of Object.entries(byLabel)) {
    const n = g.nodes.find((x) => x.desc.label === label)
    if (!n) throw new Error(`找不到节点 ${label}`)
    const side = n.sides.find((s) => s.name === n.primarySide)!
    q[side.tokenId!] = { bid, ask }
  }
  return q
}

test('宽价差不算违约——否则告警全是噪音', () => {
  const g = buildMarketGraph(EVENT, [ou(1.5), ou(2.5)])
  const live = applyLivePrices(g, quotesFor(g, { '1.5 球': [0.50, 0.80], '2.5 球': [0.40, 0.70] }))
  const ladder = live.edges.find((e) => e.kind === 'ladder')!
  assert.equal(ladder.violated, false, '中价看着交叉，但买卖两侧都成交不了')
})

test('可成交的梯子套利判成违约：卖高档收 0.65 > 买低档付 0.60', () => {
  const g = buildMarketGraph(EVENT, [ou(1.5), ou(2.5)])
  const live = applyLivePrices(g, quotesFor(g, { '1.5 球': [0.55, 0.60], '2.5 球': [0.65, 0.70] }))
  const ladder = live.edges.find((e) => e.kind === 'ladder')!
  assert.equal(ladder.violated, true)
  assert.ok(ladder.slack != null && ladder.slack < 0, `slack ${ladder.slack} 应为负`)
  assert.equal(live.stats.violations, 1)
})

test('正常定价的梯子不违约，slack 为正', () => {
  const g = buildMarketGraph(EVENT, [ou(1.5), ou(2.5)])
  const live = applyLivePrices(g, quotesFor(g, { '1.5 球': [0.78, 0.80], '2.5 球': [0.50, 0.52] }))
  const ladder = live.edges.find((e) => e.kind === 'ladder')!
  assert.equal(ladder.violated, false)
  assert.ok(ladder.slack! > 0)
})

test('缺一侧报价时不判违约，slack 为 null', () => {
  const g = buildMarketGraph(EVENT, [ou(1.5), ou(2.5)])
  const q = quotesFor(g, { '1.5 球': [0.78, 0.80] })
  // 2.5 档显式清成无报价（gamma 快照价也不给）
  for (const n of g.nodes) for (const s of n.sides) s.price = null
  const live = applyLivePrices(g, q)
  const ladder = live.edges.find((e) => e.kind === 'ladder')!
  assert.equal(ladder.violated, false)
  assert.equal(ladder.slack, null)
})

test('胜平负三腿：买价之和 > 1 判违约（全卖掉是净收）', () => {
  const g = buildMarketGraph(EVENT, [
    yesNo('Will Chelsea FC win on 2026-08-30?'),
    yesNo('Will Chelsea FC vs. Brighton & Hove Albion FC end in a draw?'),
    yesNo('Will Brighton & Hove Albion FC win on 2026-08-30?'),
  ])
  const live = applyLivePrices(
    g,
    quotesFor(g, { 切尔西胜: [0.5, 0.52], 全场平: [0.3, 0.32], 布莱顿胜: [0.28, 0.3] }),
  )
  const group = live.groups.find((x) => x.period === 'ft')!
  assert.equal(group.violated, true, '0.5+0.3+0.28 = 1.08 > 1')
  assert.equal(group.nodeIds.length, 3)
})

test('胜平负三腿正常定价不违约，sum 约为 1', () => {
  const g = buildMarketGraph(EVENT, [
    yesNo('Will Chelsea FC win on 2026-08-30?'),
    yesNo('Will Chelsea FC vs. Brighton & Hove Albion FC end in a draw?'),
    yesNo('Will Brighton & Hove Albion FC win on 2026-08-30?'),
  ])
  const live = applyLivePrices(
    g,
    quotesFor(g, { 切尔西胜: [0.49, 0.51], 全场平: [0.24, 0.26], 布莱顿胜: [0.24, 0.26] }),
  )
  const group = live.groups.find((x) => x.period === 'ft')!
  assert.equal(group.violated, false)
  assert.ok(group.sum != null && Math.abs(group.sum - 1) < 0.05)
})

test('三腿缺一条就不成划分，不建组', () => {
  const g = buildMarketGraph(EVENT, [
    yesNo('Will Chelsea FC win on 2026-08-30?'),
    yesNo('Will Brighton & Hove Albion FC win on 2026-08-30?'),
  ])
  assert.equal(g.groups.length, 0)
})

// ==================== λ 与影响回填 ====================

test('实时价盖进来后 λ 与进球影响都重算', () => {
  const g = buildMarketGraph(EVENT, [
    ou(2.5),
    yesNo('Will Chelsea FC win on 2026-08-30?'),
    yesNo('Will Chelsea FC vs. Brighton & Hove Albion FC end in a draw?'),
    yesNo('Will Brighton & Hove Albion FC win on 2026-08-30?'),
  ])
  const live = applyLivePrices(
    g,
    quotesFor(g, {
      '2.5 球': [0.51, 0.53],
      切尔西胜: [0.49, 0.51],
      全场平: [0.24, 0.26],
      布莱顿胜: [0.24, 0.26],
    }),
  )
  assert.ok(live.lambdaTotal != null && live.lambdaTotal > 2 && live.lambdaTotal < 4)
  assert.ok(Math.abs(live.lambdaHome! + live.lambdaAway! - live.lambdaTotal!) < 1e-9)
  const over = live.nodes.find((n) => n.desc.label === '2.5 球')!
  assert.equal(over.impact.modelled, true)
  assert.equal(over.impact.homeGoal, 'up')
  assert.ok(over.impact.magnitude > 0)
})

test('实时价覆盖不重建节点身份（前端动画才不会全量重放）', () => {
  const g = buildMarketGraph(EVENT, [ou(2.5)])
  const before = g.nodes[0]
  const live = applyLivePrices(g, quotesFor(g, { '2.5 球': [0.5, 0.52] }))
  assert.equal(live.nodes[0], before, '同一个节点对象')
  assert.equal(live.nodes[0].sides[0].bid, 0.5)
})

test('比分推进后，重点排序会变——这正是动态监控的意义', () => {
  const markets = [ou(1.5), ou(2.5), ou(3.5)]
  const pre = buildMarketGraph(EVENT, markets, { state: { homeGoals: 0, awayGoals: 0, minute: null } })
  const live = buildMarketGraph(EVENT, markets, { state: { homeGoals: 1, awayGoals: 1, minute: 70 } })
  const mag = (g: typeof pre, line: number) =>
    g.nodes.find((n) => n.desc.line === line)!.impact.magnitude
  // 赛前 λ 靠 gamma 快照价（这里没给），拿不到 λ 就没有幅度
  assert.equal(pre.lambdaTotal, null)
  assert.equal(mag(pre, 2.5), 0)
  // 2-2 边缘：给了报价后 2.5 档差一个球，最剧烈
  const withPrice = buildMarketGraph(
    EVENT,
    markets.map((m) => ({ ...m, outcomePrices: [0.52, 0.48] })),
    { state: { homeGoals: 1, awayGoals: 1, minute: 70 } },
  )
  assert.ok(withPrice.lambdaTotal != null)
  assert.ok(mag(withPrice, 2.5) > mag(withPrice, 3.5))
  void live
})
