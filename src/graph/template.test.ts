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

test('26 个槽位、26 条边：设计稿的 22 + 后补的 4', () => {
  assert.equal(TEMPLATE_SLOTS.length, 26)
  assert.equal(TEMPLATE_EDGES.length, 26)
  assert.equal(TEMPLATE_SLOTS.filter((s) => s.kind === 'goals').length, 3)
  assert.equal(TEMPLATE_SLOTS.filter((s) => s.kind === 'market').length, 23)
})

test('槽位 key 唯一，边只引用存在的 key', () => {
  const keys = new Set(TEMPLATE_SLOTS.map((s) => s.key))
  assert.equal(keys.size, TEMPLATE_SLOTS.length)
  for (const [a, b] of TEMPLATE_EDGES) {
    assert.ok(keys.has(a), `边引用了不存在的槽位 ${a}`)
    assert.ok(keys.has(b), `边引用了不存在的槽位 ${b}`)
  }
})

test('后补的 4 个槽位沿各自梯子的方向延伸', () => {
  const at = (k: string) => TEMPLATE_SLOTS.find((s) => s.key === k)!
  // 全场梯子自下而上、左右交替：4.5 在 3.5 上方且回到 2.5 那一列，5.5 再上去回到 3.5 那一列
  assert.ok(at('total_4.5').y < at('total_3.5').y)
  assert.ok(at('total_5.5').y < at('total_4.5').y)
  assert.equal(at('total_4.5').x, at('total_2.5').x)
  assert.equal(at('total_5.5').x, at('total_3.5').x)
  // 两翼继续向外上方：主队往左上，客队往右上
  assert.ok(at('home_2.5').x < at('home_1.5').x && at('home_2.5').y < at('home_1.5').y)
  assert.ok(at('away_2.5').x > at('away_1.5').x && at('away_2.5').y < at('away_1.5').y)
  // 四个都是全场进球大小盘的 Over 侧
  for (const [k, subject, line] of [
    ['total_4.5', 'match', 4.5],
    ['total_5.5', 'match', 5.5],
    ['home_2.5', 'home', 2.5],
    ['away_2.5', 'away', 2.5],
  ] as const) {
    assert.deepEqual(at(k).bind, { family: 'ou', period: 'ft', subject, line, side: 'over' })
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
    ['home_0.5', 'away_0.5'],
    ['home_1.5', 'away_1.5'],
    ['home_2.5', 'away_2.5'],
    // 让球同一行的两端互为镜像：第 1 列 ↔ 第 4 列、第 2 列 ↔ 第 3 列
    ['sp_home_-1.5', 'sp_away_+1.5'],
    ['sp_home_+1.5', 'sp_away_-1.5'],
    ['sp_home_-2.5', 'sp_away_+2.5'],
    ['sp_home_+2.5', 'sp_away_-2.5'],
  ]
  for (const [l, r] of pairs) {
    assert.equal(slot(l).x + slot(r).x, AXIS_X * 2, `${l} / ${r} 不关于轴线镜像`)
    assert.equal(slot(l).y, slot(r).y, `${l} / ${r} 不在同一行`)
  }
})

test('全场大小球梯子：只有互为镜像的两列，且纵向等步长', () => {
  const ladder = ['total_0.5', 'total_1.5', 'total_2.5', 'total_3.5', 'total_4.5', 'total_5.5'].map(slot)
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

test('两翼是同一把梯子：|Δx| 与 Δy 一致，只是方向相反', () => {
  const shape = ([a, b, c]: [string, string, string]) => {
    const [p, q, r] = [slot(a), slot(b), slot(c)]
    return [Math.abs(q.x - p.x), q.y - p.y, Math.abs(r.x - q.x), r.y - q.y].join(',')
  }
  assert.equal(
    shape(['home_0.5', 'home_1.5', 'home_2.5']),
    shape(['away_0.5', 'away_1.5', 'away_2.5']),
    '左右两翼步长不一致',
  )
})

test('让球四列等距对称、两行各自齐平', () => {
  const row1 = ['sp_home_-1.5', 'sp_home_+1.5', 'sp_away_-1.5', 'sp_away_+1.5'].map(slot)
  const row2 = ['sp_home_-2.5', 'sp_home_+2.5', 'sp_away_-2.5', 'sp_away_+2.5'].map(slot)
  for (const [name, row] of [['第一行', row1], ['第二行', row2]] as const) {
    assert.equal(new Set(row.map((s) => s.y)).size, 1, `${name}不齐平`)
  }
  // 同一列的两行必须同 x（原稿 sp_home_-1.5 比同列的下一个高 15）
  row1.forEach((s, i) => assert.equal(s.x, row2[i].x, `${s.key} 与同列的下一个不同列`))
  // 第 1 / 4 列、第 2 / 3 列各自互为镜像
  assert.equal(row1[0].x + row1[3].x, AXIS_X * 2)
  assert.equal(row1[1].x + row1[2].x, AXIS_X * 2)
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
  // 全图的字就跟着变小。规整前最近的一对 211.8，规整后 212.4（goals_total ↔
  // goals_home|away），没有变紧 —— 这条断言就是防止以后调坐标时悄悄挤紧，
  // 留了一点余量卡在 200。
  assert.ok(best >= 200, `最近的一对 ${who} 只有 ${best.toFixed(1)}，太挤了`)
})

// ==================== 缺盘口时槽位保留 ====================

test('比赛没挂任何盘口时，26 个槽位仍在原位，只是 nodeId 为空', () => {
  const g = buildMarketGraph(EVENT, [])
  const slots = resolveTemplate(g, NO_GOALS)
  assert.equal(slots.length, 26)
  for (const s of slots.filter((x) => x.kind === 'market')) {
    assert.equal(s.nodeId, null)
    assert.equal(s.price, null)
  }
  // 位置不因缺数据而变
  const t35 = slots.find((s) => s.key === 'total_3.5')!
  assert.equal(t35.x, 825)
})

// ==================== 大小球绑定 ====================

test('全场大小球六档各绑各的线，取 Over 侧', () => {
  const g = buildMarketGraph(EVENT, [ou(0.5), ou(1.5), ou(2.5), ou(3.5), ou(4.5), ou(5.5)])
  const slots = resolveTemplate(g, NO_GOALS)
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
    const s = slots.find((x) => x.key === `total_${line}`)!
    assert.ok(s.nodeId, `total_${line} 应绑到盘口`)
    assert.equal(s.sideName, 'Over')
    assert.ok(s.marketId, `total_${line} 应带原始盘口 id`)
    assert.ok(s.tokenId, `total_${line} 应带 tokenId`)
  }
})

test('单队大小球不会被全场盘抢走', () => {
  const g = buildMarketGraph(EVENT, [ou(0.5), ou(0.5, 'home'), ou(0.5, 'away')])
  const slots = resolveTemplate(g, NO_GOALS)
  const ids = ['total_0.5', 'home_0.5', 'away_0.5'].map(
    (k) => slots.find((s) => s.key === k)!.nodeId,
  )
  assert.ok(ids.every(Boolean), '三个槽位都应绑到盘口')
  assert.equal(new Set(ids).size, 3, '必须是三张不同的盘')
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

test('2.5 档同理配对', () => {
  const g = buildMarketGraph(EVENT, [spread('home', -2.5), spread('away', -2.5)])
  const slots = resolveTemplate(g, NO_GOALS)
  const pick = (k: string) => slots.find((s) => s.key === k)!
  assert.equal(pick('sp_home_-2.5').nodeId, pick('sp_away_+2.5').nodeId)
  assert.equal(pick('sp_away_-2.5').nodeId, pick('sp_home_+2.5').nodeId)
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
