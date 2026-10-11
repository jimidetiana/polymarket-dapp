/**
 * Gamma 数据整形测试：把拆散的子赛事合回一场、把子赛事的盘口合成一份，
 * 外加列表拉取的**分页策略**（那一部分要把 fetch 换掉，见文件末尾）。
 *
 * 合并那两个函数是纯函数，只有末尾的分页用例碰「网络」（stub 掉的假 Gamma）。
 * 重点是列表**不带盘口**之后的两条：排序改用子赛事数、成交额改从 event.volume
 * 汇总 —— 这两处退化了界面上看不出来，只会觉得「顺序怎么怪怪的」。
 */
import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { fetchSoccerMatches, mergeIntoMatches, mergeMarkets, type GammaEvent } from './gamma'

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

/** 假 Gamma：`/events/pagination` 回总数，`/events` 按 offset 回一页（每页 perPage 场独立比赛） */
function fakeGamma(total: number, perPage = 100) {
  return vi.fn(async (url: string) => {
    const u = new URL(url)
    if (u.pathname === '/events/pagination') {
      return new Response(JSON.stringify({ pagination: { totalResults: total } }))
    }
    const offset = Number(u.searchParams.get('offset') ?? 0)
    // 末页不满：真实接口按剩余条数回
    const n = Math.max(0, Math.min(perPage, total - offset))
    const events = Array.from({ length: n }, (_, i) => ({
      id: String(offset + i),
      title: `Home ${offset + i} FC vs. Away ${offset + i} FC`,
      endDate: '2026-10-11T12:00:00Z',
      tags: [{ slug: 'soccer' }],
    }))
    return new Response(JSON.stringify(events))
  })
}

function offsetsOf(fetchMock: ReturnType<typeof fakeGamma>): number[] {
  return fetchMock.mock.calls
    .map(([url]) => new URL(String(url)))
    .filter((u) => u.pathname === '/events')
    .map((u) => Number(u.searchParams.get('offset') ?? 0))
}

/**
 * 总数是**事件数**（含衍生赛事），不是比赛数 —— 2026-10 线上真踩过：
 * 窗口里涨到 3018 个 event（约 460 场），老代码拿总数当比赛数、超过 20 页就抛
 * 「赛事多达 N 个，超出预期，先不拉」，整个比赛列表一场都拉不出来。
 *
 * 现在钉住两条：页数按 Gamma 的 offset 上限截（**不抛**），场数按上限截。
 */
test('总数远超预期时截页而不报错，场数按上限截', async () => {
  const fetchMock = fakeGamma(3018, 100)
  vi.stubGlobal('fetch', fetchMock)
  try {
    const matches = await fetchSoccerMatches()
    const offsets = offsetsOf(fetchMock)
    // 21 页 = offset 0…2000；再深 Gamma 会回 422
    assert.deepEqual(offsets, Array.from({ length: 21 }, (_, i) => i * 100))
    // 21 页 × 100 场 = 2100 场候选，被 MAX_MATCHES 截到 500
    assert.equal(matches.length, 500)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('窗口内就几页时按实际页数拉，不截', async () => {
  const fetchMock = fakeGamma(150, 100)
  vi.stubGlobal('fetch', fetchMock)
  try {
    const matches = await fetchSoccerMatches()
    assert.deepEqual(offsetsOf(fetchMock), [0, 100])
    assert.equal(matches.length, 150)
  } finally {
    vi.unstubAllGlobals()
  }
})
