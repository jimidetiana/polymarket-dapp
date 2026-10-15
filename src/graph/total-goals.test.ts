/**
 * 总进球分布测试。
 *
 * 跑法：npx vitest run src/graph/total-goals.test.ts
 *
 * 盯的是几条「一旦搞反就会给出错误分布」的性质：相减方向、末桶、缺口处必须停、
 * 可见集合过滤、以及脏报价要能被 sumProb 暴露出来。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { totalGoalsDistribution } from './total-goals.js'
import type { GraphNode, MarketGraph } from './types.js'

/** 一档大小球。ask/quoted 决定它能不能参与相减 */
function ou(line: number, ask: number | null, opts: { volume?: number; quoted?: boolean } = {}): GraphNode {
  const quoted = opts.quoted ?? ask != null
  return {
    id: `m${line}`,
    marketId: `${line}`,
    conditionId: `0x${line}`,
    desc: {
      family: 'ou',
      period: 'ft',
      metric: 'goals',
      subject: 'match',
      line,
      homeLine: null,
      score: null,
      player: null,
      role: null,
      label: `总进球 ${line}`,
      goalSensitive: true,
    },
    questionEn: `Over ${line} goals?`,
    questionZh: `总进球超过 ${line} 吗？`,
    volume: opts.volume ?? 100 * line,
    liquidity: 0,
    sides: [
      { name: 'Over', tokenId: `t${line}`, price: ask, bid: ask, ask, quoted },
      { name: 'Under', tokenId: `u${line}`, price: null, bid: null, ask: null, quoted: false },
    ],
    primarySide: 'Over',
    impact: { homeGoal: 'up', awayGoal: 'up', magnitude: 0, deltaHome: null, deltaAway: null, modelled: false },
    emphasis: 'major',
    column: 'total',
    row: 0,
  }
}

function graph(nodes: GraphNode[]): MarketGraph {
  return {
    eventId: 'e1',
    homeTeamEn: 'Home FC',
    awayTeamEn: 'Away FC',
    homeTeamZh: null,
    awayTeamZh: null,
    title: 'Home FC vs. Away FC',
    league: null,
    endTime: null,
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

const allVisible = (nodes: GraphNode[]) => new Set(nodes.map((n) => n.id))

test('相邻两档相减得到「恰好 k 球」，且各桶之和为 1', () => {
  const nodes = [ou(0.5, 0.9), ou(1.5, 0.7), ou(2.5, 0.45), ou(3.5, 0.2)]
  const r = totalGoalsDistribution(graph(nodes), allVisible(nodes))
  assert.ok(r)
  assert.deepEqual(
    r.buckets.map((b) => b.goals),
    [0, 1, 2, 3, 4],
  )
  // 0 球 = 1 − P(Over 0.5)；1 球 = P(0.5) − P(1.5)；末桶 = P(Over 3.5)
  const prob = r.buckets.map((b) => Number(b.prob.toFixed(6)))
  assert.deepEqual(prob, [0.1, 0.2, 0.25, 0.25, 0.2])
  assert.equal(Number(r.sumProb.toFixed(6)), 1)
  assert.equal(r.maxLine, 3.5)
})

test('末桶装的是 P(Over maxLine)，不是差值', () => {
  const nodes = [ou(0.5, 0.8), ou(1.5, 0.3)]
  const r = totalGoalsDistribution(graph(nodes), allVisible(nodes))
  assert.ok(r)
  // 0 球 0.2、1 球 0.5、2 球及以上 0.3
  assert.deepEqual(r.buckets.map((b) => Number(b.prob.toFixed(6))), [0.2, 0.5, 0.3])
})

test('连续段不足 2 档时返回 null，不硬凑一个跨度桶', () => {
  // 只有 0.5 一档能连上（缺 1.5），推不出任何分布
  const nodes = [ou(0.5, 0.9), ou(2.5, 0.45), ou(3.5, 0.2)]
  assert.equal(totalGoalsDistribution(graph(nodes), allVisible(nodes)), null)
})

test('梯子不从 0.5 起步就返回 null —— 否则第一个桶会被标错', () => {
  // 最低档是 1.5 时，1 − P(Over 1.5) 是「0 或 1 球」，不是「0 球」。
  // 开赛后已结算的档会掉出报价集合（ask=1 被 toLiveQuotes 滤掉），正是这种形状。
  const nodes = [ou(1.5, 0.7), ou(2.5, 0.45), ou(3.5, 0.2)]
  assert.equal(totalGoalsDistribution(graph(nodes), allVisible(nodes)), null)
})

test('第一个缺口之后的高线全部不参与', () => {
  const nodes = [ou(0.5, 0.9), ou(1.5, 0.6), ou(3.5, 0.2)]
  const r = totalGoalsDistribution(graph(nodes), allVisible(nodes))
  assert.ok(r)
  // 只用到 0.5 / 1.5
  assert.equal(r.maxLine, 1.5)
  assert.equal(r.quotedLines, 2)
  assert.deepEqual(r.buckets.map((b) => b.goals), [0, 1, 2])
})

test('没有真实双边盘的档不参与相减，连续段在它那里断掉', () => {
  const nodes = [ou(0.5, 0.9), ou(1.5, 0.7, { quoted: false }), ou(2.5, 0.45)]
  // 1.5 无双边盘 → 断在它那里 → 连续段只剩 0.5 → 不足 2 档
  assert.equal(totalGoalsDistribution(graph(nodes), allVisible(nodes)), null)
})

test('可见集合之外的高线不参与 —— 分析范围跟着显示范围走', () => {
  const nodes = [ou(0.5, 0.9), ou(1.5, 0.7), ou(2.5, 0.45), ou(3.5, 0.2)]
  // 只显示前两档（等价于折叠态把外圈线收起来）
  const visible = new Set(['m0.5', 'm1.5'])
  const r = totalGoalsDistribution(graph(nodes), visible)
  assert.ok(r)
  assert.equal(r.maxLine, 1.5)
  assert.equal(r.totalLines, 2)
  assert.deepEqual(r.buckets.map((b) => b.goals), [0, 1, 2])
})

test('相邻倒挂时投影回单调（取前值），负桶从根上不出现', () => {
  // P(Over 1.5) > P(Over 0.5) 是脏数据：进 2 球不可能比进 1 球更可能
  const nodes = [ou(0.5, 0.4), ou(1.5, 0.7)]
  const r = totalGoalsDistribution(graph(nodes), allVisible(nodes))
  assert.ok(r)
  assert.equal(Number(r.buckets[0].prob.toFixed(6)), 0.6) // 1 − 0.4
  assert.equal(r.buckets[1].prob, 0) // 1.5 那档被投影成 0.4 → 0.4 − 0.4
  assert.equal(Number(r.buckets[2].prob.toFixed(6)), 0.4) // 末桶 = 投影后的 P(Over 1.5)
  assert.equal(r.monotoneFixups, 1)
  // 投影之后不会再有负桶，所以 sumProb 恒为 1；诊断改由 monotoneFixups 承担
  assert.equal(Number(r.sumProb.toFixed(6)), 1)
  assert.ok(r.buckets.every((b) => b.prob >= 0), '投影后不应出现负概率')
})

test('梯子自洽时不触发投影，monotoneFixups 为 0', () => {
  const nodes = [ou(0.5, 0.9), ou(1.5, 0.7), ou(2.5, 0.45), ou(3.5, 0.2)]
  const r = totalGoalsDistribution(graph(nodes), allVisible(nodes))
  assert.ok(r)
  assert.equal(r.monotoneFixups, 0)
})

test('可见档不足 2 时返回 null，不硬凑', () => {
  const nodes = [ou(0.5, 0.9)]
  assert.equal(totalGoalsDistribution(graph(nodes), allVisible(nodes)), null)
})

test('热度取两档较小者，heatRatio 给的是「钱相对概率」的比', () => {
  const nodes = [
    ou(0.5, 0.9, { volume: 1000 }),
    ou(1.5, 0.5, { volume: 600 }),
    ou(2.5, 0.2, { volume: 100 }),
  ]
  const r = totalGoalsDistribution(graph(nodes), allVisible(nodes))
  assert.ok(r)
  // 0 球热 1000、1 球热 min(1000,600)=600、2 球热 min(600,100)=100、末桶热 100
  const heat = r.buckets.map((b) => Number(b.heatShare.toFixed(6)))
  const total = 1000 + 600 + 100 + 100
  assert.deepEqual(heat, [1000 / total, 600 / total, 100 / total, 100 / total].map((v) => Number(v.toFixed(6))))
  // 每个桶的 heatRatio 都算得出来（prob 都 > 0）
  assert.ok(r.buckets.every((b) => b.heatRatio != null))
})
