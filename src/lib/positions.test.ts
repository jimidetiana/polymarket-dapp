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
  indexPositions,
  matchHasPosition,
  positionKind,
  type PolyPosition,
} from './positions'

/** 一条持仓的骨架，只填测试关心的字段 */
function mk(over: Partial<PolyPosition> & { asset: string }): PolyPosition {
  return {
    conditionId: '0xcid',
    size: 10,
    avgPrice: 0.5,
    curPrice: 0.5,
    currentValue: 5,
    cashPnl: 0,
    percentPnl: 0,
    realizedPnl: 0,
    redeemable: false,
    outcome: 'Yes',
    eventId: '100',
    title: 'T',
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
