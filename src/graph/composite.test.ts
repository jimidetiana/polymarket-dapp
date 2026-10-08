/**
 * 合成盘口测试。
 *   npx vitest run src/graph/composite.test.ts
 *
 * 最要紧的一条：**权重由赔率定，不由几何位置定**。
 *
 * 整数线的定义是"多进一个球走水"（净额为零），这条约束把权重钉成
 * "易腿的价格"。按 50/50 配只在赔率正好 2.0 时才等价 —— 而那种巧合
 * 不会报错，只会让你在边界上亏掉一部分本金。下面用逐档模拟把这条钉住。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { applyLivePrices, buildMarketGraph, type GraphMarketInput } from './graph.js'
import { resolveTemplate, TEMPLATE_EDGES, type ResolvedSlot } from './template.js'
import {
  ANCHOR_DS,
  anchorT,
  compositeEdges,
  easyLeg,
  hardLeg,
  isReady,
  legOf,
  lineLabel,
  lineOf,
  nearestAnchorD,
  oddsOf,
  weightsLabel,
  weightsOf,
  type CompositeEdge,
} from './composite.js'

const EVENT = {
  id: '1',
  titleZh: '切尔西 vs 布莱顿',
  homeTeamEn: 'Chelsea FC',
  awayTeamEn: 'Brighton & Hove Albion FC',
  homeTeamZh: '切尔西',
  awayTeamZh: '布莱顿',
}

const NO_GOALS = { total: null, home: null, away: null }

let seq = 0
function yesNo(questionEn: string): GraphMarketInput {
  seq += 1
  return {
    id: String(seq),
    questionEn,
    outcomes: ['Yes', 'No'],
    clobTokenIds: [`t${seq}a`, `t${seq}b`],
    volume: 1000,
  }
}
/** 让球盘：outcomes[0] 是被点名的队 */
function spread(named: 'home' | 'away', line: number): GraphMarketInput {
  seq += 1
  const H = 'Chelsea FC'
  const A = 'Brighton & Hove Albion FC'
  return {
    id: String(seq),
    questionEn: `Spread: ${named === 'home' ? H : A} (${line})`,
    line,
    outcomes: named === 'home' ? [H, A] : [A, H],
    clobTokenIds: [`t${seq}a`, `t${seq}b`],
    volume: 1000,
  }
}

/** 胜平负三腿 + 主客各两档让球（-1.5 / -2.5）。只建一次，token id 才稳定 */
const MARKETS: GraphMarketInput[] = [
  yesNo('Will Chelsea FC win on 2026-08-30?'),
  yesNo('Will Chelsea FC vs. Brighton & Hove Albion FC end in a draw?'),
  yesNo('Will Brighton & Hove Albion FC win on 2026-08-30?'),
  spread('home', -1.5),
  spread('away', -1.5),
  spread('home', -2.5),
  spread('away', -2.5),
]

/**
 * 建一场图。`asks` 按**槽位 key** 给卖价，经 applyLivePrices 真的盖上去
 * —— 走真实路径才能同时验到 quoted 标志，而不是手搓一个 slot 对象。
 */
function build(asks: Record<string, number> = {}): ResolvedSlot[] {
  const g0 = buildMarketGraph(EVENT, MARKETS)
  const first = resolveTemplate(g0, NO_GOALS)
  const quotes: Record<string, { bid: number | null; ask: number | null }> = {}
  for (const s of first) {
    if (!s.tokenId) continue
    quotes[s.tokenId] = { bid: null, ask: asks[s.key] ?? null }
  }
  return resolveTemplate(applyLivePrices(g0, quotes), NO_GOALS)
}

function edgeOf(slots: ResolvedSlot[], from: string, to: string): CompositeEdge {
  const e = compositeEdges(slots, TEMPLATE_EDGES).find((x) => x.id === `${from}~${to}`)
  assert.ok(e, `应有可合成的边 ${from}~${to}`)
  return e
}

/**
 * 逐档模拟：给定两腿的权重与价，算出某个 margin 下的**回收额**。
 *
 * `wins[i]` 是该腿在这个 margin 下赢不赢。押注总额固定为 stake，
 * 所以「回收 == stake」就是走水。
 */
function payout(stake: number, legs: Array<{ ask: number; weight: number; win: boolean }>): number {
  let out = 0
  for (const l of legs) if (l.win) out += (l.weight * stake) / l.ask
  return out
}

// ==================== 哪些边可合成 ====================

test('可合成的边：同队 + 只差一档', () => {
  const ids = compositeEdges(build(), TEMPLATE_EDGES).map((e) => e.id)

  assert.ok(ids.includes('ml_home~sp_home_-1.5'))
  assert.ok(ids.includes('ml_away~sp_away_-1.5'))
  assert.ok(ids.includes('sp_home_-1.5~sp_home_-2.5'))
  assert.ok(ids.includes('sp_away_-1.5~sp_away_-2.5'))

  // 跨两档的边**不能**合成：主胜(-0.5) 到 主队+1.5 中间隔着 +0.5 一档
  assert.ok(!ids.includes('ml_home~sp_home_+1.5'))
  assert.ok(!ids.includes('ml_away~sp_away_+1.5'))
  // 队不同（主队 -1.5 与客队 -1.5 是两条不同的梯子）
  assert.ok(!ids.includes('sp_home_-1.5~sp_away_-1.5'))
})

test('跨两档的边仍然存在于模板里，只是不可合成', () => {
  // 防回归：这条边上"没有锚点"必须是因为判据排除了它，而不是模板里没这条边
  assert.ok(TEMPLATE_EDGES.some(([a, b]) => a === 'ml_home' && b === 'sp_home_+1.5'))
})

test('没挂那一档盘口时，对应的边不出现', () => {
  const without25 = MARKETS.filter((m) => m.line !== -2.5)
  const g = buildMarketGraph(EVENT, without25)
  const ids = compositeEdges(resolveTemplate(g, NO_GOALS), TEMPLATE_EDGES).map((e) => e.id)
  assert.ok(!ids.includes('sp_home_-1.5~sp_home_-2.5'))
  assert.ok(ids.includes('ml_home~sp_home_-1.5'), '邻档仍在，不该一起消失')
})

test('折叠掉的外档不参与合成', () => {
  const slots = build().filter((s) => !['sp_home_-2.5', 'sp_away_-2.5'].includes(s.key))
  const ids = compositeEdges(slots, TEMPLATE_EDGES).map((e) => e.id)
  assert.ok(!ids.includes('sp_home_-1.5~sp_home_-2.5'))
})

test('平局不是让球腿；胜平负两腿按 -0.5 记线', () => {
  const slots = build()
  const at = (k: string) => slots.find((s) => s.key === k)
  assert.equal(legOf(at('ml_draw')), null)
  assert.equal(legOf(at('ml_home'))?.line, -0.5)
  assert.equal(legOf(at('ml_away'))?.line, -0.5)
  assert.equal(legOf(at('ml_home'))?.team, 'home')
  assert.equal(legOf(at('ml_away'))?.team, 'away')
})

test('让球腿按自己球队的口径记线', () => {
  const slots = build()
  const at = (k: string) => slots.find((s) => s.key === k)
  assert.equal(legOf(at('sp_home_-1.5'))?.line, -1.5)
  assert.equal(legOf(at('sp_home_+1.5'))?.line, 1.5)
  assert.equal(legOf(at('sp_away_-1.5'))?.line, -1.5)
  assert.equal(legOf(at('sp_away_+1.5'))?.line, 1.5)
})

test('易腿是线值较大的那一腿，与球队无关', () => {
  const slots = build()
  // 主队：-0.5 比 -1.5 易
  const a = edgeOf(slots, 'ml_home', 'sp_home_-1.5')
  assert.equal(easyLeg(a).line, -0.5)
  assert.equal(hardLeg(a).line, -1.5)
  // 客队：+2.5 比 +1.5 易（受让更多）
  const b = edgeOf(slots, 'sp_away_+1.5', 'sp_away_+2.5')
  assert.equal(easyLeg(b).line, 2.5)
  assert.equal(hardLeg(b).line, 1.5)
  assert.equal(b.easy, 'to')
})

// ==================== 线与权重 ====================

test('锚点就是三条有名字的线', () => {
  assert.deepEqual([...ANCHOR_DS], [0.25, 0.5, 0.75])
  const e = edgeOf(build(), 'ml_home', 'sp_home_-1.5')
  assert.equal(lineLabel(e, 0.5), '主队 -1')
  assert.equal(lineLabel(e, 0.25), '主队 -0.75')
  assert.equal(lineLabel(e, 0.75), '主队 -1.25')
})

test('锚点的几何位置跟着"哪端是易腿"翻', () => {
  const a = edgeOf(build(), 'ml_home', 'sp_home_-1.5') // 易腿在 from
  assert.equal(anchorT(a, 0.25), 0.25)
  assert.equal(anchorT(a, 0.75), 0.75)
  const b = edgeOf(build(), 'sp_away_+1.5', 'sp_away_+2.5') // 易腿在 to
  assert.equal(anchorT(b, 0.25), 0.75)
  assert.equal(anchorT(b, 0.75), 0.25)
  // 线值只跟 d 走，不跟几何位置走
  assert.equal(lineOf(b, 0.25), 2.25)
  assert.equal(lineOf(b, 0.5), 2)
})

test('指针落在哪就取最近的那个锚点', () => {
  const e = edgeOf(build(), 'ml_home', 'sp_home_-1.5')
  assert.equal(nearestAnchorD(e, 0.1), 0.25)
  assert.equal(nearestAnchorD(e, 0.4), 0.5)
  assert.equal(nearestAnchorD(e, 0.66), 0.75)
  assert.equal(nearestAnchorD(e, 0.99), 0.75)
})

test('整数线的权重 = 易腿的价（不是一半一半）', () => {
  const e = edgeOf(build({ ml_home: 0.6, 'sp_home_-1.5': 0.38 }), 'ml_home', 'sp_home_-1.5')
  const w = weightsOf(e, 0.5)
  assert.ok(w)
  assert.equal(Math.round(w!.easy * 1000) / 1000, 0.6)
  assert.equal(Math.round(w!.hard * 1000) / 1000, 0.4)
})

test('两条四分之一线：(1+p)/2 与 p/2', () => {
  const e = edgeOf(build({ ml_home: 0.6, 'sp_home_-1.5': 0.38 }), 'ml_home', 'sp_home_-1.5')
  assert.equal(weightsOf(e, 0.25)?.easy, 0.8)
  assert.equal(weightsOf(e, 0.75)?.easy, 0.3)
})

test('赔率正好 2.0 时退化成几何值 0.75 / 0.5 / 0.25', () => {
  const e = edgeOf(build({ ml_home: 0.5, 'sp_home_-1.5': 0.5 }), 'ml_home', 'sp_home_-1.5')
  assert.equal(weightsOf(e, 0.25)?.easy, 0.75)
  assert.equal(weightsOf(e, 0.5)?.easy, 0.5)
  assert.equal(weightsOf(e, 0.75)?.easy, 0.25)
})

test('缺易腿的卖价时，比例本身就算不出来', () => {
  const e = edgeOf(build({ 'sp_home_-1.5': 0.38 }), 'ml_home', 'sp_home_-1.5')
  assert.equal(weightsOf(e, 0.5), null)
  assert.equal(weightsLabel(e, 0.5), null)
  assert.equal(oddsOf(e, 0.5), null)
  assert.equal(isReady(e), false)
})

test('权重显示自洽：两个百分比加起来必须是 100', () => {
  const e = edgeOf(build({ ml_home: 0.615, 'sp_home_-1.5': 0.38 }), 'ml_home', 'sp_home_-1.5')
  const label = weightsLabel(e, 0.5)
  assert.ok(label)
  const m = label!.match(/(\d+)% .* \+ (\d+)%/)
  assert.ok(m)
  assert.equal(Number(m![1]) + Number(m![2]), 100)
  assert.equal(label, '62% 主胜 + 38% 主队 -1.5')
})

// ==================== 逐档模拟：位置确实像那条线 ====================

test('整数线：多进一个球正好走水，多进两个以上赢全部', () => {
  const stake = 100
  // 易腿贵、难腿便宜，这是 50/50 会露馅的地方
  for (const [pE, pH] of [[0.6, 0.38], [0.5, 0.5], [0.72, 0.55], [0.85, 0.62]]) {
    const e = edgeOf(build({ ml_home: pE, 'sp_home_-1.5': pH }), 'ml_home', 'sp_home_-1.5')
    const w = weightsOf(e, 0.5)!
    const legs = [
      { ask: pE, weight: w.easy, win: true }, // 易腿（-0.5）
      { ask: pH, weight: w.hard, win: false }, // 难腿（-1.5）
    ]
    // m = 1：易腿赢、难腿输 → 必须正好收回本金
    assert.equal(Math.round(payout(stake, legs) * 1e6) / 1e6, stake, `p=${pE}/${pH} 边界未走水`)
    // m ≥ 2：两腿都赢 → 必须高于本金
    const both = payout(stake, [legs[0], { ...legs[1], win: true }])
    assert.ok(both > stake, `p=${pE}/${pH} 全赢没有盈利`)
    // m ≤ 0：两腿都输 → 归零
    assert.equal(payout(stake, [{ ...legs[0], win: false }, legs[1]]), 0)
  }
})

test('50/50 在赔率偏离 2.0 时不是走水（这就是要按赔率配的原因）', () => {
  const stake = 100
  const e = edgeOf(build({ ml_home: 0.6, 'sp_home_-1.5': 0.38 }), 'ml_home', 'sp_home_-1.5')
  const equal = payout(stake, [
    { ask: 0.6, weight: 0.5, win: true },
    { ask: 0.38, weight: 0.5, win: false },
  ])
  // 一半一半在 m=1 只收回 83.33，亏掉 16.67% 本金
  assert.equal(Math.round(equal * 100) / 100, 83.33)
  assert.equal(Math.round((stake - equal) * 100) / 100, 16.67)
  // 按赔率配则正好走水
  const w = weightsOf(e, 0.5)!
  assert.equal(
    Math.round(payout(stake, [
      { ask: 0.6, weight: w.easy, win: true },
      { ask: 0.38, weight: w.hard, win: false },
    ]) * 1e6) / 1e6,
    stake,
  )
})

test('四分之一线：-0.75 在边界是半赢（不亏），-1.25 是半输（亏一半）', () => {
  const stake = 100
  for (const [pE, pH] of [[0.5, 0.5], [0.6, 0.38], [0.7, 0.5]]) {
    const e = edgeOf(build({ ml_home: pE, 'sp_home_-1.5': pH }), 'ml_home', 'sp_home_-1.5')

    // -0.75：m=1 时易腿赢、难腿输，但只押了 (1+p)/2 → 回收 = stake·(1+p)/(2p) > stake
    const w25 = weightsOf(e, 0.25)!
    const at25 = payout(stake, [
      { ask: pE, weight: w25.easy, win: true },
      { ask: pH, weight: w25.hard, win: false },
    ])
    assert.ok(at25 > stake, `p=${pE} -0.75 边界应不亏`)
    assert.equal(Math.round((at25 - stake) * 1e6) / 1e6, Math.round(stake * (1 - pE) / (2 * pE) * 1e6) / 1e6)

    // -1.25：只押 p/2 在易腿 → 回收正好是本金的一半（与赔率无关）
    const w75 = weightsOf(e, 0.75)!
    const at75 = payout(stake, [
      { ask: pE, weight: w75.easy, win: true },
      { ask: pH, weight: w75.hard, win: false },
    ])
    assert.equal(Math.round(at75 * 1e6) / 1e6, stake / 2, `p=${pE} -1.25 边界应亏一半`)
  }
})

test('两腿都赢的赔率与整数线的解析式一致', () => {
  const pE = 0.62
  const pH = 0.41
  const e = edgeOf(build({ ml_home: pE, 'sp_home_-1.5': pH }), 'ml_home', 'sp_home_-1.5')
  // 整数线：1/p_L = 1 + (1−p_易)/p_难
  assert.equal(Math.round(oddsOf(e, 0.5)! * 1e6) / 1e6, Math.round((1 + (1 - pE) / pH) * 1e6) / 1e6)
})
