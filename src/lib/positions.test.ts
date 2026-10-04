/**
 * 持仓索引与分类的边界。
 *
 * 值得钉住的是两条实测踩过的：**size 带小数尾巴**（按 `> 0` 判会把卖光的仓位标成
 * 还持有），以及**已完结的仓位仍要算进 eventIds**（一场踢完的比赛撤掉标记，人就
 * 无从确认自己下过单）。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  grossAvgPriceOf,
  indexPositions,
  matchHasPosition,
  positionKind,
  slotPositionMark,
  type PolyPosition,
} from './positions'

/** 一条持仓的骨架，只填测试关心的字段 */
function mk(over: Partial<PolyPosition> & { asset: string }): PolyPosition {
  return {
    conditionId: '0xcid',
    size: 10,
    avgPrice: 0.5,
    initialValue: 5,
    grossInitialValue: 5,
    entryFeesUsdc: 0,
    curPrice: 0.5,
    currentValue: 5,
    cashPnl: 0,
    percentPnl: 0,
    realizedPnl: 0,
    redeemable: false,
    outcome: 'Yes',
    eventId: '100',
    title: 'T',
    icon: '',
    endDate: '',
    ...over,
  }
}

test('positionKind：有份额是持有中', () => {
  assert.equal(positionKind(mk({ asset: 'a', size: 10 })), 'open')
  // 实测 size 带一长串小数尾巴，这也是持有中
  assert.equal(positionKind(mk({ asset: 'a', size: 36190.7986 })), 'open')
})

test('positionKind：redeemable 即已完结，份额再多也一样', () => {
  // 盘口已结算、等着赎回 —— 钱还在仓位里，但不在场上了
  assert.equal(positionKind(mk({ asset: 'a', size: 5000, redeemable: true })), 'settled')
})

test('positionKind：份额清零算已完结，小数残渣不算持有', () => {
  assert.equal(positionKind(mk({ asset: 'a', size: 0 })), 'settled')
  // 卖光之后留下的浮点残渣。按 `> 0` 判这里会错判成 open
  assert.equal(positionKind(mk({ asset: 'a', size: 1e-9 })), 'settled')
  // 负的残渣同样不算
  assert.equal(positionKind(mk({ asset: 'a', size: -1e-9 })), 'settled')
})

test('indexPositions：按 token 建表，按 eventId 收集比赛', () => {
  const idx = indexPositions([
    mk({ asset: 'tok1', eventId: '100' }),
    mk({ asset: 'tok2', eventId: '200' }),
  ])
  assert.equal(idx.byToken.size, 2)
  assert.equal(idx.byToken.get('tok1')?.eventId, '100')
  assert.deepEqual([...idx.eventIds].sort(), ['100', '200'])
})

test('indexPositions：空表给空索引，不抛', () => {
  const idx = indexPositions([])
  assert.equal(idx.byToken.size, 0)
  assert.equal(idx.eventIds.size, 0)
})

test('indexPositions：同一 token 多条时留份额绝对值大的那条', () => {
  const idx = indexPositions([
    mk({ asset: 'tok1', size: 3, title: '小' }),
    mk({ asset: 'tok1', size: 99, title: '大' }),
    mk({ asset: 'tok1', size: 7, title: '中' }),
  ])
  assert.equal(idx.byToken.size, 1)
  assert.equal(idx.byToken.get('tok1')?.title, '大')
})

test('indexPositions：已完结的仓位也要算进 eventIds', () => {
  // 比赛列表回答的是「这场我参与过吗」，结算完就撤标记等于把记录藏起来
  const idx = indexPositions([mk({ asset: 'tok1', eventId: '100', redeemable: true, size: 0 })])
  assert.ok(idx.eventIds.has('100'))
})

test('indexPositions：没有 asset 的行跳过，没有 eventId 的不污染集合', () => {
  const idx = indexPositions([
    mk({ asset: '', eventId: '100' }),
    mk({ asset: 'tok1', eventId: '' }),
  ])
  assert.equal(idx.byToken.size, 1)
  assert.ok(idx.byToken.has('tok1'))
  assert.equal(idx.eventIds.size, 0)
})

test('matchHasPosition：任一子赛事命中即算有仓', () => {
  const withPos = new Set(['200'])
  // 持仓常在「- More Markets」那一族里（大小球就在那），所以不能只看主赛事
  assert.equal(matchHasPosition(['100', '200', '300'], withPos), true)
  assert.equal(matchHasPosition(['100'], withPos), false)
})

test('matchHasPosition：空集合或空 eventIds 都是 false', () => {
  assert.equal(matchHasPosition(['100'], new Set()), false)
  assert.equal(matchHasPosition([], new Set(['100'])), false)
})

// ── slotPositionMark：同一侧 / 另一侧 ────────────────────────────────

test('indexPositions：byCondition 按 conditionId 归拢两侧', () => {
  const idx = indexPositions([
    mk({ asset: 'over', conditionId: '0xou', outcome: 'Over' }),
    mk({ asset: 'under', conditionId: '0xou', outcome: 'Under' }),
    mk({ asset: 'yes', conditionId: '0xml', outcome: 'Yes' }),
  ])
  assert.equal(idx.byCondition.get('0xou')?.length, 2)
  assert.equal(idx.byCondition.get('0xml')?.length, 1)
})

test('slotPositionMark：持在本槽这一侧 → ownSide', () => {
  const idx = indexPositions([mk({ asset: 'over', conditionId: '0xou', outcome: 'Over' })])
  const displayed = new Set(['over'])
  const mark = slotPositionMark({ tokenId: 'over', conditionId: '0xou' }, idx, displayed)
  assert.equal(mark?.ownSide, true)
  assert.equal(mark?.position.outcome, 'Over')
})

test('slotPositionMark：持在同盘另一侧（该侧无槽位）→ 借本槽标出，ownSide=false', () => {
  // 只持 Under，图上只显示 Over 槽位。Under 在模板里没有自己的槽位
  const idx = indexPositions([mk({ asset: 'under', conditionId: '0xou', outcome: 'Under' })])
  const displayed = new Set(['over']) // Under 不在其中
  const mark = slotPositionMark({ tokenId: 'over', conditionId: '0xou' }, idx, displayed)
  assert.equal(mark?.ownSide, false)
  assert.equal(mark?.position.outcome, 'Under')
})

test('slotPositionMark：另一侧自己也有槽位（让球盘）→ 不在对面重复标', () => {
  // 让球盘两侧各占一个槽位：homeTok、awayTok 都在图上显示
  const idx = indexPositions([mk({ asset: 'awayTok', conditionId: '0xsp', outcome: 'Away -1.5' })])
  const displayed = new Set(['homeTok', 'awayTok'])
  // 站在 home 那个槽位看：本侧没仓，另一侧的 awayTok 自己有槽位 → 不借这里标
  const mark = slotPositionMark({ tokenId: 'homeTok', conditionId: '0xsp' }, idx, displayed)
  assert.equal(mark, null)
})

test('slotPositionMark：本盘一条仓位都没有 → null', () => {
  const idx = indexPositions([mk({ asset: 'other', conditionId: '0xelse' })])
  const mark = slotPositionMark({ tokenId: 'over', conditionId: '0xou' }, idx, new Set(['over']))
  assert.equal(mark, null)
})

test('slotPositionMark：本侧优先于另一侧', () => {
  // 两侧都持有：应返回本侧那条（ownSide=true），不返回另一侧
  const idx = indexPositions([
    mk({ asset: 'over', conditionId: '0xou', outcome: 'Over' }),
    mk({ asset: 'under', conditionId: '0xou', outcome: 'Under' }),
  ])
  const mark = slotPositionMark({ tokenId: 'over', conditionId: '0xou' }, idx, new Set(['over']))
  assert.equal(mark?.ownSide, true)
  assert.equal(mark?.position.outcome, 'Over')
})

test('grossAvgPriceOf：含费均价 = grossInitialValue / 份额', () => {
  // 实测过的一条真实仓位：initialValue 285.7154 + 入场费 9.73842 = gross 295.453874
  const p = mk({
    asset: 'a',
    size: 569.7484,
    avgPrice: 0.5014,
    initialValue: 285.7154,
    entryFeesUsdc: 9.73842,
    grossInitialValue: 295.453874,
  })
  // 含费价必须高于接口给的 avgPrice —— 费摊进单价只会让成本变贵
  assert.ok(grossAvgPriceOf(p) > p.avgPrice)
  assert.equal(grossAvgPriceOf(p).toFixed(4), '0.5186')
})

test('grossAvgPriceOf：拿不到费用字段时退回 avgPrice', () => {
  // 接口变形/老缓存：少算费比显示 NaN 好，调用方不该为此加关卡
  assert.equal(grossAvgPriceOf(mk({ asset: 'a', grossInitialValue: 0 })), 0.5)
  // 份额清零（卖光后剩浮点残渣）时不能拿它做除数，否则是个爆炸的大数
  assert.equal(grossAvgPriceOf(mk({ asset: 'a', size: 1e-9, grossInitialValue: 5 })), 0.5)
})
