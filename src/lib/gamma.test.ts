/**
 * Gamma 数据整形测试：把拆散的子赛事合回一场、把子赛事的盘口合成一份。
 *
 * 两个函数都是纯函数，这里不碰网络。重点是列表**不带盘口**之后的两条：
 * 排序改用子赛事数、成交额改从 event.volume 汇总 —— 这两处退化了界面上
 * 看不出来，只会觉得「顺序怎么怪怪的」。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mergeIntoMatches, mergeMarkets, type GammaEvent } from './gamma'

function ev(over: Partial<GammaEvent> & { id: string; title: string }): GammaEvent {
  return { ...over }
}

test('同一场的衍生赛事合成一条，主赛事 id 优先用无后缀那个', () => {
  const ms = mergeIntoMatches([
    ev({ id: '2', title: 'Everton FC vs. Wolverhampton Wanderers FC - Exact Score', volume: '10' }),
    ev({ id: '1', title: 'Everton FC vs. Wolverhampton Wanderers FC', endDate: '2026-09-18T12:00:00Z' }),
    ev({ id: '3', title: 'Everton FC vs. Wolverhampton Wanderers FC - More Markets', volume: 5 }),
  ])
  assert.equal(ms.length, 1)
  const m = ms[0]
  assert.equal(m.id, '1')
  assert.equal(m.home, 'Everton FC')
  assert.equal(m.away, 'Wolverhampton Wanderers FC')
  assert.equal(m.endDate, '2026-09-18T12:00:00Z')
  assert.deepEqual(m.eventIds, ['2', '1', '3'])
  assert.equal(m.sources.length, 3)
})

test('成交额：各子赛事相加；拿不到就是 null 而不是 0', () => {
  const [withVol] = mergeIntoMatches([
    ev({ id: '1', title: 'A vs. B', volume: '100' }),
    ev({ id: '2', title: 'A vs. B - Exact Score', volume: 50 }),
    ev({ id: '3', title: 'A vs. B - More Markets' }),
  ])
  assert.equal(withVol.volume, 150)

  // 全都拿不到 ≠ 零成交，前者显示「—」后者显示「$0」
  const [noVol] = mergeIntoMatches([ev({ id: '4', title: 'C vs. D' })])
  assert.equal(noVol.volume, null)

  const [zero] = mergeIntoMatches([ev({ id: '5', title: 'E vs. F', volume: '0' })])
  assert.equal(zero.volume, 0)

  const [garbage] = mergeIntoMatches([ev({ id: '6', title: 'G vs. H', volume: '—' })])
  assert.equal(garbage.volume, null)
})

test('子赛事多的排前面，同样多的按成交额', () => {
  const ms = mergeIntoMatches([
    ev({ id: '1', title: 'A vs. B', volume: '1' }),
    ev({ id: '2', title: 'C vs. D', volume: '999' }),
    ev({ id: '3', title: 'E vs. F', volume: '5' }),
    ev({ id: '4', title: 'E vs. F - Exact Score' }),
    ev({ id: '5', title: 'G vs. H' }),
  ])
  assert.deepEqual(
    ms.map((m) => m.title),
    ['E vs. F', 'C vs. D', 'A vs. B', 'G vs. H'],
  )
})

test('拆不出队名的整场丢掉', () => {
  const ms = mergeIntoMatches([ev({ id: '1', title: 'Premier League Winner 2026' })])
  assert.equal(ms.length, 0)
})

test('合并盘口：按 id 去重，跳过已结束的', () => {
  const markets = mergeMarkets([
    ev({ id: '1', title: 'A vs. B', markets: [{ id: 'm1' }, { id: 'm2', closed: true }] }),
    ev({ id: '2', title: 'A vs. B - More Markets', markets: [{ id: 'm1' }, { id: 'm3' }] }),
  ])
  assert.deepEqual(
    markets.map((m) => m.id),
    ['m1', 'm3'],
  )
})
