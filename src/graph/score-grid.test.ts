/**
 * 比分网格测试。
 *
 * 跑法：npx vitest run src/graph/score-grid.test.ts
 *
 * 盯的是几条「一旦错了就整条链废掉」的性质：
 * 让球盘取哪一侧、胜平负必须填上让球盘中间那个洞、缺口处必须停、缺锚就返回 null。
 * 夹具刻意照着真实数据的形状做 —— **让球盘只有 ±1.5 及以外，没有 ±0.5**。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { scoreGrid, tiltByHeat, tiltExponent } from './score-grid.js'
import type { GraphNode, MarketGraph, MarketDescriptor } from './types.js'

const HOME = 'Home FC'
const AWAY = 'Away FC'

function node(
  id: string,
  desc: Partial<MarketDescriptor>,
  sides: [string, number | null][],
  primaryIndex = 0,
): GraphNode {
  return {
    id,
    marketId: id,
    conditionId: `0x${id}`,
    desc: {
      family: 'ou',
      period: 'ft',
      metric: 'goals',
      subject: 'match',
      line: null,
      homeLine: null,
      score: null,
      player: null,
      role: null,
      label: id,
      goalSensitive: true,
      ...desc,
    },
    questionEn: id,
    questionZh: null,
    volume: 100,
    liquidity: 0,
    sides: sides.map(([name, p]) => ({
      name,
      tokenId: `${id}:${name}`,
      price: p,
      bid: p,
      ask: p,
      quoted: p != null,
    })),
    primarySide: sides[primaryIndex][0],
    impact: { homeGoal: 'up', awayGoal: 'up', magnitude: 0, deltaHome: null, deltaAway: null, modelled: false },
    emphasis: 'major',
    column: 'total',
    row: 0,
  }
}

/** 大小球一档。primarySide 是 Over */
const ou = (line: number, ask: number) =>
  node(`ou${line}`, { family: 'ou', subject: 'match', line }, [['Over', ask], ['Under', 1 - ask]])

/**
 * 让球一档。`cover` = 「主队在这一档的胜率」= P(净胜 ≥ −L+0.5)。
 *
 * 刻意照真实数据的形状做两件事：
 *   - outcomes 顺序按**被点名的队**（真实数据就是这样：`Spread: 曼联 (-1.5)`
 *     的 outcomes 是 ["曼联","马竞"]）
 *   - primarySide **恒为主队名那一侧**，可能落在第二个 —— 这正是 graph.ts 的
 *     `pickPrimarySide` 对 spread 的做法，也是本模块最容易取错的地方
 */
const spread = (subject: 'home' | 'away', line: number, cover: number) => {
  const homeLine = subject === 'away' ? -line : line
  return subject === 'home'
    ? node(`sp${subject}${line}`, { family: 'spread', subject, line, homeLine }, [[HOME, cover], [AWAY, 1 - cover]], 0)
    : node(`sp${subject}${line}`, { family: 'spread', subject, line, homeLine }, [[AWAY, 1 - cover], [HOME, cover]], 1)
}

/** 胜平负一腿。primarySide 是 Yes */
const ml = (role: 'home' | 'draw' | 'away', ask: number) =>
  node(`ml${role}`, { family: 'moneyline', role }, [['Yes', ask], ['No', 1 - ask]])

function graph(nodes: GraphNode[]): MarketGraph {
  return {
    eventId: 'e1',
    homeTeamEn: HOME,
    awayTeamEn: AWAY,
    homeTeamZh: null,
    awayTeamZh: null,
    title: `${HOME} vs. ${AWAY}`,
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

const all = (nodes: GraphNode[]) => new Set(nodes.map((n) => n.id))

/**
 * 一套自洽的输入（数字都是手算过的）：
 *   P(净胜≥1)=0.60  P(净胜≥0)=0.85 → P(净胜 0)=0.25（= 平局价）
 *   P(净胜≥2)=0.35 → P(净胜 1)=0.25
 *   P(净胜≥3)=0.15 → P(净胜 2)=0.20
 *   P(净胜≥−1)=0.92 → P(净胜 −1)=0.07
 *   P(净胜≥−2)=0.98 → P(净胜 −2)=0.06
 *   正侧 0.25+0.25+0.20+0.15 = 0.60 ✓   负侧 0.07+0.06+0.02 = 0.15 ✓
 */
function baseNodes() {
  return [
    ou(0.5, 0.9),
    ou(1.5, 0.6),
    ou(2.5, 0.3),
    ou(3.5, 0.1),
    ml('home', 0.6),
    ml('draw', 0.25),
    ml('away', 0.15),
    spread('home', -1.5, 0.35), // cover = P(净胜≥2)
    spread('home', -2.5, 0.15), // cover = P(净胜≥3)
    spread('away', -1.5, 0.92), // 客队让 1.5 → 主队视角 +1.5 → cover = P(净胜≥−1)
    spread('away', -2.5, 0.98), // → cover = P(净胜≥−2)
  ]
}

test('胜平负填上让球盘中间那个洞，净胜 0 = 平局价', () => {
  const nodes = baseNodes()
  const r = scoreGrid(graph(nodes), all(nodes))
  assert.ok(r)
  const d = new Map(r.margins.map((m) => [m.d, Number(m.prob.toFixed(6))]))
  assert.equal(d.get(0), 0.25) // 平局价，自校验点
  assert.equal(d.get(1), 0.25) // P(净胜≥1) − P(净胜≥2) = 0.60 − 0.35
  assert.equal(d.get(2), 0.2)
  assert.equal(d.get(-1), 0.07)
  assert.equal(d.get(-2), 0.06)
})

test('让球盘取主队那一侧，不是被点名那一侧', () => {
  // 「客队 -1.5」的 YES 是客队让球赢 = P(净胜 ≤ −2)。主队视角要取主队那一侧。
  const nodes = baseNodes()
  const r = scoreGrid(graph(nodes), all(nodes))
  assert.ok(r)
  // 若取错侧（拿 0.08 当 P(净胜≥−1)），P(净胜 −1) 会变成负数并被钳成 0
  const d = new Map(r.margins.map((m) => [m.d, m.prob]))
  assert.ok((d.get(-1) ?? 0) > 0, '净胜 −1 应为正数')
  assert.ok(r.margins.every((m) => m.prob >= 0), '净胜球边际不应出现负概率')
})

test('缺胜平负就没有锚，整个返回 null（不能靠让球盘硬猜）', () => {
  const nodes = baseNodes().filter((n) => n.desc.family !== 'moneyline')
  assert.equal(scoreGrid(graph(nodes), all(nodes)), null)
})

test('阈值链有缺口就停，不跨缺口相减', () => {
  // 去掉「主队 -2.5」(t=3)，链在 t=2 与 t=1 之间断掉
  const nodes = baseNodes().filter((n) => n.id !== 'sphome-2.5')
  const r = scoreGrid(graph(nodes), all(nodes))
  assert.ok(r)
  const ds = r.margins.map((m) => m.d)
  assert.ok(ds.includes(1), 't=2 与 t=1 相邻，应给出净胜 1')
  assert.ok(!ds.includes(2), 't=3 缺失，不应给出净胜 2')
})

test('网格是概率分布，且最可能是低比分', () => {
  const nodes = baseNodes()
  const r = scoreGrid(graph(nodes), all(nodes))
  assert.ok(r)
  let sum = 0
  for (const row of r.cells) for (const c of row) sum += c.prob
  assert.ok(Math.abs(sum - 1) < 1e-9, `网格应归一，实得 ${sum}`)
  // 两个边际的主峰都在低位，最可能比分不该是 4-3 这种
  assert.ok(r.ranked[0].home + r.ranked[0].away <= 4, `最可能比分不该太离谱：${r.ranked[0].home}-${r.ranked[0].away}`)
  // ranked 与 cells 是同一批对象，数值必须一致（曾经这里除过两次）
  const top = r.ranked[0]
  assert.equal(r.cells[top.home][top.away].prob, top.prob)
})

test('胜平负与让球盘倒挂时，净胜球链被投影回单调', () => {
  // 让球盘说 P(净胜≥2)=0.70，胜平负说 P(净胜≥1)=0.60 —— 不可能（赢 2 球蕴含赢 1 球）。
  // 两本独立订单簿会瞬时打架，这正是网格「隔几秒整块跳一次」的源头。
  const nodes = baseNodes().map((n) =>
    n.id === 'sphome-1.5'
      ? { ...n, sides: [{ ...n.sides[0], price: 0.7, bid: 0.7, ask: 0.7 }, n.sides[1]] }
      : n,
  )
  const r = scoreGrid(graph(nodes), all(nodes))
  assert.ok(r)
  assert.ok(r.monotoneFixups > 0, '倒挂应被记录')
  assert.ok(
    r.margins.every((m) => m.prob >= 0),
    '投影后不应出现负概率',
  )
})

test('热度列与价格列结构对称，且热度不参与预测', () => {
  const nodes = baseNodes()
  const r = scoreGrid(graph(nodes), all(nodes))
  assert.ok(r)
  const heatSum = r.cells.flat().reduce((s, c) => s + c.heatShare, 0)
  assert.ok(Math.abs(heatSum - 1) < 1e-9, `热度应独立归一，实得 ${heatSum}`)
  const c = r.ranked[0]
  assert.ok(c.heatRatio != null && Math.abs(c.heatRatio - c.heatShare / c.prob) < 1e-9)

  // 关键性质：热度**只做对照**。把成交量改成完全不同的分布，概率列必须一字不变。
  // 这条一旦破了，就说明热度偷偷混进了预测 —— 那是这套东西最不该发生的事
  const bumped = baseNodes().map((n, i) => ({ ...n, volume: 100 * (i + 1) * 13 + 7 }))
  const r2 = scoreGrid(graph(bumped), all(bumped))
  assert.ok(r2)
  assert.deepEqual(
    r2.cells.map((row) => row.map((x) => x.prob)),
    r.cells.map((row) => row.map((x) => x.prob)),
    '改成交量不应影响概率列',
  )
  assert.notDeepEqual(
    r2.cells.map((row) => row.map((x) => x.heatShare)),
    r.cells.map((row) => row.map((x) => x.heatShare)),
    '但热度列应当随之变化（否则这列是死的）',
  )
})

test('倾斜强度随成交量走：成交量越低，α 越接近 0', () => {
  const med = 0.01
  const alpha = 2
  // 没有任何成交 → 完全不推
  assert.equal(tiltExponent(0, med, alpha), 0)
  // 成交量趋零 → α 趋零
  assert.ok(tiltExponent(1e-9, med, alpha) < 1e-6)
  // 半饱和：热度正好在中位时取 α/2
  assert.ok(Math.abs(tiltExponent(med, med, alpha) - alpha / 2) < 1e-12)
  // 远高于中位 → 趋近 α
  assert.ok(tiltExponent(med * 1000, med, alpha) > alpha * 0.99)
  // 对成交量单调不减
  const xs = [1e-5, 1e-4, 1e-3, 1e-2, 5e-2, 0.5].map((h) => tiltExponent(h, med, alpha))
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], '应对成交量单调不减')
  // α = 0 恒等于不推
  assert.equal(tiltExponent(med * 10, med, 0), 0)
})

test('热度倾斜：α=0 原样返回；有成交的格子按「钱少价高」方向推', () => {
  // 让成交量分布不均匀，倾斜才有东西可推
  const nodes = baseNodes().map((n, i) => ({ ...n, volume: 100 * (i + 1) * 13 + 7 }))
  const r = scoreGrid(graph(nodes), all(nodes))
  assert.ok(r)

  // α = 0 必须原样返回同一个对象（不复制、不改动）
  assert.equal(tiltByHeat(r, 0), r)

  const t = tiltByHeat(r, 1)
  const sum = t.cells.flat().reduce((s, c) => s + c.prob, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `倾斜后应归一，实得 ${sum}`)

  // 倾斜以**总进球档**为单位（净胜球那侧热度跨了两个流动性差百倍的家族，不可比）：
  // 跨档才变，同档内不动
  const byTotal = new Map<number, { s: number; ratio: number; cell: (typeof r.cells)[number][number] }>()
  for (const c of r.cells.flat()) {
    if (c.prob <= 0 || c.totalHeat <= 0 || c.totalProb <= 0) continue
    const s = c.home + c.away
    if (!byTotal.has(s)) byTotal.set(s, { s, ratio: c.totalHeat / c.totalProb, cell: c })
  }
  const totals = [...byTotal.values()].sort((x, y) => x.ratio - y.ratio)
  const lo = totals[0] // 钱相对价最少的那一档 → 庄家最赚
  const hi = totals[totals.length - 1]
  const rel = (res: typeof r) =>
    res.cells[lo.cell.home][lo.cell.away].prob / res.cells[hi.cell.home][hi.cell.away].prob
  assert.ok(rel(t) > rel(r), '总进球热度低的那一档，相对权重应被推高')

  // 同一档内的两个格子，相对权重必须**原封不动** —— 倾斜不区分同档内的比分
  const sameTotal = r.cells.flat().filter((c) => c.prob > 0 && c.home + c.away === lo.s)
  if (sameTotal.length >= 2) {
    const [x, y] = sameTotal
    const before = x.prob / y.prob
    const after = t.cells[x.home][x.away].prob / t.cells[y.home][y.away].prob
    assert.ok(Math.abs(after / before - 1) < 1e-9, '同档内的相对权重不应改变')
  }

  // 原始那份不能被就地改掉（两套预测是并列而不是覆盖）
  const sumBase = r.cells.flat().reduce((s, c) => s + c.prob, 0)
  assert.ok(Math.abs(sumBase - 1) < 1e-9, 'A 那份应原封不动')
})

test('可见集合之外的大小球档不参与', () => {
  const nodes = baseNodes()
  const visible = new Set(nodes.filter((n) => n.desc.family !== 'ou' || (n.desc.line ?? 9) <= 1.5).map((n) => n.id))
  const r = scoreGrid(graph(nodes), visible)
  assert.ok(r)
  // 大小球只到 1.5 → 总进球只能覆盖到 2 球，比分不可能出现 3-0 这种
  assert.ok(r.cells[3][0].prob === 0)
})
