/**
 * 固定模板与绑定规则测试。
 *   npx tsx --test src/market-graph/template.test.ts
 *
 * 最要紧的是让球：设计稿有「主队 ±1.5 / 客队 ±1.5」四个槽位，
 * 而平台只挂让球方（线恒为负）两张盘。四个槽位必须两两落到同一张盘的
 * 两侧，且价格之和≈1。搞错就会出现「两个槽位显示同一个价」这种错。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { buildMarketGraph, applyLivePrices, type GraphMarketInput } from './graph.js'
import {
  isOuterSlot,
  isSlotHit,
  resolveTemplate,
  TEMPLATE_EDGES,
  TEMPLATE_SLOTS,
} from './template.js'

const EVENT = {
  id: '1',
  titleZh: '切尔西 vs 布莱顿',
  homeTeamEn: 'Chelsea FC',
  awayTeamEn: 'Brighton & Hove Albion FC',
  homeTeamZh: '切尔西',
  awayTeamZh: '布莱顿',
}

let seq = 0
function ou(line: number, subject: 'match' | 'home' | 'away' = 'match'): GraphMarketInput {
  seq += 1
  const who =
    subject === 'home' ? 'Chelsea FC ' : subject === 'away' ? 'Brighton & Hove Albion FC ' : ''
  return {
    id: String(seq),
    questionEn: `Chelsea FC vs. Brighton & Hove Albion FC: ${who}O/U ${line}`,
    line,
    outcomes: ['Over', 'Under'],
    clobTokenIds: [`t${seq}a`, `t${seq}b`],
    volume: 1000,
  }
}
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

const NO_GOALS = { total: null, home: null, away: null }

// ==================== 模板本身 ====================

test('47 个槽位、47 条边覆盖总进球 8.5、单队 5.5 和让球 ±5.5', () => {
  assert.equal(TEMPLATE_SLOTS.length, 47)
  assert.equal(TEMPLATE_EDGES.length, 47)
  assert.equal(TEMPLATE_SLOTS.filter((s) => s.kind === 'goals').length, 3)
  assert.equal(TEMPLATE_SLOTS.filter((s) => s.kind === 'market').length, 44)
})

test('折叠恰好隐藏七条支线各自最外侧的两档，保留全部中心和胜平负', () => {
  for (const prefix of ['total_', 'home_', 'away_', 'sp_home_-', 'sp_home_+', 'sp_away_-', 'sp_away_+']) {
    const branch = TEMPLATE_SLOTS.filter((s) => s.key.startsWith(prefix))
    const outer = [...branch].sort((a, b) => Math.abs(b.bind!.line!) - Math.abs(a.bind!.line!)).slice(0, 2)
    assert.deepEqual(branch.filter(isOuterSlot).map((s) => s.key).sort(), outer.map((s) => s.key).sort(), prefix)
  }
  const visible = TEMPLATE_SLOTS.filter((s) => !isOuterSlot(s))
  assert.equal(visible.length, 33)
  assert.equal(visible.filter((s) => s.kind === 'goals').length, 3)
  assert.equal(visible.filter((s) => s.bind?.family === 'moneyline').length, 3)
  assert.equal(TEMPLATE_SLOTS.length, 47, '折叠不能删除完整模板中的盘口')
})

test('折叠后连线只连接可见盘口，各支线没有断点', () => {
  const keys = new Set(TEMPLATE_SLOTS.filter((s) => !isOuterSlot(s)).map((s) => s.key))
  const edges = TEMPLATE_EDGES.filter(([a, b]) => keys.has(a) && keys.has(b))
  assert.equal(edges.length, 33)
  const reached = new Set(['goals_total'])
  for (let pass = 0; pass < keys.size; pass += 1) {
    for (const [a, b] of edges) {
      if (reached.has(a)) reached.add(b)
      if (reached.has(b)) reached.add(a)
    }
  }
  assert.deepEqual([...reached].sort(), [...keys].sort())
})

test('槽位 key 唯一，边只引用存在的 key', () => {
  const keys = new Set(TEMPLATE_SLOTS.map((s) => s.key))
  assert.equal(keys.size, TEMPLATE_SLOTS.length)
  for (const [a, b] of TEMPLATE_EDGES) {
    assert.ok(keys.has(a), `边引用了不存在的槽位 ${a}`)
    assert.ok(keys.has(b), `边引用了不存在的槽位 ${b}`)
  }
})

test('新增档位沿原有梯子延伸，且每档连到上一档', () => {
  const at = (k: string) => TEMPLATE_SLOTS.find((s) => s.key === k)!
  const linked = (a: string, b: string) => TEMPLATE_EDGES.some(([from, to]) => from === a && to === b)
  for (const line of [6.5, 7.5, 8.5]) {
    const s = at(`total_${line}`)
    assert.ok(s.y < at(`total_${line - 1}`).y)
    assert.equal(s.x, at(`total_${line - 2}`).x)
    assert.deepEqual(s.bind, { family: 'ou', period: 'ft', subject: 'match', line, side: 'over' })
    assert.ok(linked(`total_${line - 1}`, s.key))
  }
  for (const subject of ['home', 'away'] as const) {
    for (const line of [3.5, 4.5, 5.5]) {
      const s = at(`${subject}_${line}`)
      const prev = at(`${subject}_${line - 1}`)
      assert.ok(s.y < prev.y)
      assert.ok(subject === 'home' ? s.x < prev.x : s.x > prev.x)
      assert.deepEqual(s.bind, { family: 'ou', period: 'ft', subject, line, side: 'over' })
      assert.ok(linked(prev.key, s.key))
      for (const sign of ['-', '+']) {
        const spread = at(`sp_${subject}_${sign}${line}`)
        const prevSpread = at(`sp_${subject}_${sign}${line - 1}`)
        assert.equal(spread.x, prevSpread.x)
        assert.ok(spread.y > prevSpread.y)
        assert.deepEqual(spread.bind, {
          family: 'spread', period: 'ft', subject, line: sign === '-' ? -line : line, side: subject,
        })
        assert.ok(linked(prevSpread.key, spread.key))
      }
    }
  }
})

test('中心三节点是 goals 类型且不绑盘口', () => {
  for (const key of ['goals_total', 'goals_home', 'goals_away']) {
    const s = TEMPLATE_SLOTS.find((x) => x.key === key)!
    assert.equal(s.kind, 'goals')
    assert.equal(s.bind, undefined)
    assert.ok(s.goalsOf)
  }
})

// ==================== 坐标规整性 ====================

/**
 * 全图轴线。中心三节点、「平」、两翼、让球四列都关于它镜像。
 *
 * 下面这几个测试断言的是**性质**（镜像 / 等步长 / 齐平），不是把坐标抄一遍
 * —— 抄一遍只能证明「文件没被改过」，证明不了「摆得齐」。
 */
const AXIS_X = 693
const slot = (k: string) => TEMPLATE_SLOTS.find((s) => s.key === k)!

test('成对的槽位关于轴线镜像，且两侧在同一行', () => {
  const pairs: Array<[string, string]> = [
    ['goals_home', 'goals_away'],
    ['ml_home', 'ml_away'],
  ]
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
    pairs.push([`home_${line}`, `away_${line}`])
    if (line >= 1.5) {
      pairs.push([`sp_home_-${line}`, `sp_away_+${line}`])
      pairs.push([`sp_home_+${line}`, `sp_away_-${line}`])
    }
  }
  for (const [l, r] of pairs) {
    assert.equal(slot(l).x + slot(r).x, AXIS_X * 2, `${l} / ${r} 不关于轴线镜像`)
    assert.equal(slot(l).y, slot(r).y, `${l} / ${r} 不在同一行`)
  }
})

test('全场大小球梯子：只有互为镜像的两列，且纵向等步长', () => {
  const ladder = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5].map((line) => slot(`total_${line}`))
  const xs = [...new Set(ladder.map((s) => s.x))].sort((a, b) => a - b)
  assert.equal(xs.length, 2, '梯子应当只有左右两列')
  assert.equal(xs[0] + xs[1], AXIS_X * 2, '两列不关于轴线镜像')
  // 自下而上左右交替，不能有哪一级站错列
  ladder.forEach((s, i) => {
    assert.equal(s.x, i % 2 === 0 ? xs[0] : xs[1], `${s.key} 破坏了左右交替`)
  })
  // 等步长：相邻的 y 差只允许有一个值（原稿有 145 / 163 / 206 三种）
  const steps = ladder.slice(1).map((s, i) => ladder[i].y - s.y)
  assert.equal(new Set(steps).size, 1, `纵向步长不齐：${steps.join(' / ')}`)
  assert.ok(steps[0] > 0, '梯子应当自下而上')
})

test('两翼是同一把梯子：各档 |Δx| 与 Δy 一致，只是方向相反', () => {
  const steps = (subject: string) => [1.5, 2.5, 3.5, 4.5, 5.5].map((line) => {
    const p = slot(`${subject}_${line - 1}`)
    const q = slot(`${subject}_${line}`)
    return `${Math.abs(q.x - p.x)},${q.y - p.y}`
  })
  assert.deepEqual(steps('home'), steps('away'))
  assert.equal(new Set(steps('home')).size, 1, '两翼各档步长应一致')
})

test('让球四列对称、五行齐平且纵向等步长', () => {
  const rows = [1.5, 2.5, 3.5, 4.5, 5.5].map((line) =>
    [`sp_home_-${line}`, `sp_home_+${line}`, `sp_away_-${line}`, `sp_away_+${line}`].map(slot),
  )
  for (const row of rows) {
    assert.equal(new Set(row.map((s) => s.y)).size, 1, `${row[0].key} 所在行不齐平`)
    assert.deepEqual(row.map((s) => s.x), rows[0].map((s) => s.x))
    assert.equal(row[0].x + row[3].x, AXIS_X * 2)
    assert.equal(row[1].x + row[2].x, AXIS_X * 2)
  }
  const steps = rows.slice(1).map((row, i) => row[0].y - rows[i][0].y)
  assert.equal(new Set(steps).size, 1)
  assert.ok(steps[0] > 0)
})

test('没有哪两个槽位靠得比 200 更近：规整不会把节点挤小', () => {
  let best = Infinity
  let who = ''
  for (let i = 0; i < TEMPLATE_SLOTS.length; i += 1) {
    for (let j = i + 1; j < TEMPLATE_SLOTS.length; j += 1) {
      const a = TEMPLATE_SLOTS[i]
      const b = TEMPLATE_SLOTS[j]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d < best) {
        best = d
        who = `${a.key} / ${b.key}`
      }
    }
  }
  // 节点半径 = 最近两点间距 × R_OF_GAP(0.42)（见 lib/layout.ts），所以间距一紧，
  // 全图的字就跟着变小。现在最近的一对仍然是中心那个三角的腿
  // （goals_total ↔ goals_home|away，224.2）—— 比上一版还松了一点，因为两条腿
  // 一起往外挪到了 ±145（见 TEMPLATE_SLOTS 上方的步长说明）。
  // 这条断言就是防止以后调坐标时悄悄挤紧，留了一点余量卡在 200。
  assert.ok(best >= 200, `最近的一对 ${who} 只有 ${best.toFixed(1)}，太挤了`)
})

// ==================== 缺盘口时槽位保留 ====================

test('比赛没挂任何盘口时，全部槽位仍在原位，只是 nodeId 为空', () => {
  const g = buildMarketGraph(EVENT, [])
  const slots = resolveTemplate(g, NO_GOALS)
  assert.equal(slots.length, TEMPLATE_SLOTS.length)
  for (const s of slots.filter((x) => x.kind === 'market')) {
    assert.equal(s.nodeId, null)
    assert.equal(s.price, null)
  }
  // 位置不因缺数据而变
  const t35 = slots.find((s) => s.key === 'total_3.5')!
  assert.equal(t35.x, 825)
})

test('只挂低档盘口时，新增高档槽位保持空位，不借用低档盘口', () => {
  const g = buildMarketGraph(EVENT, [
    ou(5.5), ou(2.5, 'home'), ou(2.5, 'away'), spread('home', -2.5), spread('away', -2.5),
  ])
  const slots = resolveTemplate(g, NO_GOALS)
  const missing = [
    'total_6.5', 'total_7.5', 'total_8.5',
    ...[3.5, 4.5, 5.5].flatMap((line) => [
      `home_${line}`, `away_${line}`,
      `sp_home_-${line}`, `sp_home_+${line}`, `sp_away_-${line}`, `sp_away_+${line}`,
    ]),
  ]
  for (const key of missing) {
    const s = slots.find((x) => x.key === key)!
    assert.equal(s.nodeId, null, key)
    assert.equal(s.marketId, null, key)
    assert.equal(s.tokenId, null, key)
    assert.equal(s.price, null, key)
  }
})

// ==================== 大小球绑定 ====================

test('全场大小球九档各绑各的线，取 Over 侧并保留下单标识', () => {
  const lines = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5]
  const markets = lines.map((line) => ou(line))
  const g = buildMarketGraph(EVENT, markets)
  const slots = resolveTemplate(g, NO_GOALS)
  for (const [i, line] of lines.entries()) {
    const s = slots.find((x) => x.key === `total_${line}`)!
    assert.ok(s.nodeId, `total_${line} 应绑到盘口`)
    assert.equal(s.sideName, 'Over')
    assert.equal(s.marketId, markets[i].id)
    assert.equal(s.tokenId, markets[i].clobTokenIds![0])
    assert.equal(s.hitNeed, line + 0.5)
    assert.equal(s.hitSubject, 'total')
  }
})

test('单队大小球六档按主客队和线绑定，不与全场盘口串台', () => {
  const lines = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]
  const markets = lines.flatMap((line) => [ou(line), ou(line, 'home'), ou(line, 'away')])
  const g = buildMarketGraph(EVENT, markets)
  const slots = resolveTemplate(g, NO_GOALS)
  for (const [i, line] of lines.entries()) {
    for (const [j, subject] of ['total', 'home', 'away'].entries()) {
      const s = slots.find((x) => x.key === `${subject}_${line}`)!
      const market = markets[i * 3 + j]
      assert.ok(s.nodeId)
      assert.equal(s.sideName, 'Over')
      assert.equal(s.marketId, market.id)
      assert.equal(s.tokenId, market.clobTokenIds![0])
      assert.equal(s.hitNeed, line + 0.5)
      assert.equal(s.hitSubject, subject)
    }
  }
})

// ==================== 胜平负 ====================

test('胜平负三腿各绑各的 role，取 Yes 侧', () => {
  const g = buildMarketGraph(EVENT, [
    yesNo('Will Chelsea FC win on 2026-08-30?'),
    yesNo('Will Chelsea FC vs. Brighton & Hove Albion FC end in a draw?'),
    yesNo('Will Brighton & Hove Albion FC win on 2026-08-30?'),
  ])
  const slots = resolveTemplate(g, NO_GOALS)
  const ids = ['ml_home', 'ml_draw', 'ml_away'].map(
    (k) => slots.find((s) => s.key === k)!.nodeId,
  )
  assert.ok(ids.every(Boolean))
  assert.equal(new Set(ids).size, 3)
  assert.equal(slots.find((s) => s.key === 'ml_home')!.sideName, 'Yes')
})

// ==================== 让球：四槽位落到两张盘 ====================

test('主队-1.5 与客队+1.5 是同一张盘的两侧', () => {
  // 平台只挂 Spread: Chelsea (-1.5)
  const g = buildMarketGraph(EVENT, [spread('home', -1.5)])
  const slots = resolveTemplate(g, NO_GOALS)
  const homeMinus = slots.find((s) => s.key === 'sp_home_-1.5')!
  const awayPlus = slots.find((s) => s.key === 'sp_away_+1.5')!
  assert.ok(homeMinus.nodeId, '主队 -1.5 应绑到这张盘')
  assert.equal(awayPlus.nodeId, homeMinus.nodeId, '客队 +1.5 是同一张盘')
  assert.equal(homeMinus.sideName, 'Chelsea FC')
  assert.equal(awayPlus.sideName, 'Brighton & Hove Albion FC')
  assert.notEqual(homeMinus.sideName, awayPlus.sideName, '必须取不同侧')
})

test('客队-1.5 与主队+1.5 是另一张盘的两侧', () => {
  const g = buildMarketGraph(EVENT, [spread('away', -1.5)])
  const slots = resolveTemplate(g, NO_GOALS)
  const awayMinus = slots.find((s) => s.key === 'sp_away_-1.5')!
  const homePlus = slots.find((s) => s.key === 'sp_home_+1.5')!
  assert.ok(awayMinus.nodeId)
  assert.equal(homePlus.nodeId, awayMinus.nodeId)
  assert.equal(awayMinus.sideName, 'Brighton & Hove Albion FC')
  assert.equal(homePlus.sideName, 'Chelsea FC')
})

test('两张让球盘同时存在时，四个槽位两两配对且不串台', () => {
  const g = buildMarketGraph(EVENT, [spread('home', -1.5), spread('away', -1.5)])
  const slots = resolveTemplate(g, NO_GOALS)
  const pick = (k: string) => slots.find((s) => s.key === k)!
  const hm = pick('sp_home_-1.5')
  const ap = pick('sp_away_+1.5')
  const am = pick('sp_away_-1.5')
  const hp = pick('sp_home_+1.5')
  assert.equal(hm.nodeId, ap.nodeId)
  assert.equal(am.nodeId, hp.nodeId)
  assert.notEqual(hm.nodeId, am.nodeId, '两张盘不能混成一张')
})

test('同一张让球盘的两个槽位价格之和≈1', () => {
  const g = buildMarketGraph(EVENT, [spread('home', -1.5)])
  const node = g.nodes[0]
  const live = applyLivePrices(g, {
    [node.sides[0].tokenId!]: { bid: 0.34, ask: 0.36 },
    [node.sides[1].tokenId!]: { bid: 0.64, ask: 0.66 },
  })
  const slots = resolveTemplate(live, NO_GOALS)
  const a = slots.find((s) => s.key === 'sp_home_-1.5')!.price!
  const b = slots.find((s) => s.key === 'sp_away_+1.5')!.price!
  assert.ok(Math.abs(a + b - 1) < 0.02, `两侧之和 ${a + b} 应≈1`)
})

test('让球 1.5 至 5.5 各档两两配对，主客队取互补的 token 和价格', () => {
  const lines = [1.5, 2.5, 3.5, 4.5, 5.5]
  const markets = lines.flatMap((line) => [spread('home', -line), spread('away', -line)])
  const g = buildMarketGraph(EVENT, markets)
  const quotes = Object.fromEntries(g.nodes.flatMap((n) => [
    [n.sides[0].tokenId!, { bid: 0.34, ask: 0.36 }],
    [n.sides[1].tokenId!, { bid: 0.64, ask: 0.66 }],
  ]))
  const slots = resolveTemplate(applyLivePrices(g, quotes), NO_GOALS)
  const pick = (k: string) => slots.find((s) => s.key === k)!
  for (const [i, line] of lines.entries()) {
    for (const [j, subject] of ['home', 'away'].entries()) {
      const other = subject === 'home' ? 'away' : 'home'
      const minus = pick(`sp_${subject}_-${line}`)
      const plus = pick(`sp_${other}_+${line}`)
      const market = markets[i * 2 + j]
      assert.ok(minus.nodeId)
      assert.equal(minus.nodeId, plus.nodeId)
      assert.equal(minus.marketId, market.id)
      assert.equal(plus.marketId, market.id)
      assert.equal(minus.tokenId, market.clobTokenIds![0])
      assert.equal(plus.tokenId, market.clobTokenIds![1])
      assert.equal(minus.sideName, market.outcomes![0])
      assert.equal(plus.sideName, market.outcomes![1])
      assert.ok(Math.abs(minus.price! + plus.price! - 1) < 1e-9)
      assert.equal(minus.hitNeed, null)
    }
  }
})

// ==================== 中心节点显示进球数 ====================

test('中心三节点显示传入的进球数', () => {
  const g = buildMarketGraph(EVENT, [])
  const slots = resolveTemplate(g, { total: 3, home: 2, away: 1 })
  assert.equal(slots.find((s) => s.key === 'goals_total')!.goals, 3)
  assert.equal(slots.find((s) => s.key === 'goals_home')!.goals, 2)
  assert.equal(slots.find((s) => s.key === 'goals_away')!.goals, 1)
})

test('推不出来的进球数保持 null，不显示 0', () => {
  const g = buildMarketGraph(EVENT, [])
  const slots = resolveTemplate(g, { total: 4, home: null, away: null })
  assert.equal(slots.find((s) => s.key === 'goals_total')!.goals, 4)
  assert.equal(slots.find((s) => s.key === 'goals_home')!.goals, null)
})

// ==================== 「该线已打出」判据 ====================

test('大小球线给出「要几个球」，并指明跟谁的进球数比', () => {
  const g = buildMarketGraph(EVENT, [ou(0.5), ou(2.5), ou(1.5, 'home'), ou(0.5, 'away')])
  const slots = resolveTemplate(g, NO_GOALS)
  const pick = (k: string) => slots.find((s) => s.key === k)!
  assert.equal(pick('total_0.5').hitNeed, 1)
  assert.equal(pick('total_0.5').hitSubject, 'total')
  assert.equal(pick('total_2.5').hitNeed, 3)
  assert.equal(pick('home_1.5').hitNeed, 2)
  assert.equal(pick('home_1.5').hitSubject, 'home')
  assert.equal(pick('away_0.5').hitSubject, 'away')
})

test('让球与胜平负没有「打出」概念，不参与变绿', () => {
  const g = buildMarketGraph(EVENT, [
    spread('home', -1.5),
    yesNo('Will Chelsea FC win on 2026-08-30?'),
  ])
  const slots = resolveTemplate(g, NO_GOALS)
  for (const key of ['sp_home_-1.5', 'sp_away_+1.5', 'ml_home']) {
    const s = slots.find((x) => x.key === key)!
    assert.equal(s.hitNeed, null, `${key} 不该有 hitNeed`)
    assert.equal(s.hitSubject, null)
  }
})

test('中心三节点也没有 hitNeed（它们显示的是进球数本身）', () => {
  const g = buildMarketGraph(EVENT, [])
  const slots = resolveTemplate(g, NO_GOALS)
  for (const key of ['goals_total', 'goals_home', 'goals_away']) {
    assert.equal(slots.find((s) => s.key === key)!.hitNeed, null)
  }
})

test('isSlotHit：进球数达到就算打出', () => {
  const G = (t: number | null, h: number | null, a: number | null) => ({ total: t, home: h, away: a })
  assert.equal(isSlotHit(1, 'total', G(0, 0, 0)), false)
  assert.equal(isSlotHit(1, 'total', G(1, 1, 0)), true)
  assert.equal(isSlotHit(3, 'total', G(2, 1, 1)), false)
  assert.equal(isSlotHit(3, 'total', G(3, 2, 1)), true)
  assert.equal(isSlotHit(4, 'total', G(5, 3, 2)), true, '超过也算打出')
})

test('isSlotHit：按主体各自比，不混算', () => {
  const G = { total: 2, home: 2, away: 0 }
  assert.equal(isSlotHit(1, 'home', G), true)
  assert.equal(isSlotHit(1, 'away', G), false, '客队没进，不能因为总数够了就算打出')
})

test('isSlotHit：比分未知或非进球盘返回 null，不猜', () => {
  assert.equal(isSlotHit(1, 'total', { total: null, home: null, away: null }), null)
  assert.equal(isSlotHit(null, null, { total: 3, home: 2, away: 1 }), null)
  assert.equal(isSlotHit(2, 'home', { total: 3, home: null, away: 1 }), null)
})

// ==================== 价格与报价标记 ====================

test('只有快照价时 quoted=false，有真实盘口才 true', () => {
  const mk = ou(2.5)
  mk.outcomePrices = [0.55, 0.45]
  const g = buildMarketGraph(EVENT, [mk])
  let slots = resolveTemplate(g, NO_GOALS)
  const s1 = slots.find((s) => s.key === 'total_2.5')!
  assert.equal(s1.quoted, false)
  assert.equal(s1.price, 0.55, '退回快照价供显示')

  const live = applyLivePrices(g, { [g.nodes[0].sides[0].tokenId!]: { bid: 0.5, ask: 0.52 } })
  slots = resolveTemplate(live, NO_GOALS)
  const s2 = slots.find((s) => s.key === 'total_2.5')!
  assert.equal(s2.quoted, true)
  assert.ok(Math.abs(s2.price! - 0.51) < 1e-9)
})
