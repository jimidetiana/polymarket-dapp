/**
 * 比赛列表逻辑测试。
 *
 * 重点是那条「搜中文能搜到」—— 这正是这次改动的目的：词典一直加载着、
 * 管理页面也一直在维护它，但比赛下拉里显示的始终是英文原文。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import type { SoccerMatch } from './gamma'
import {
  LIVE_WINDOW_MS,
  countStatuses,
  defaultMatchId,
  filterMatches,
  matchHaystack,
  matchStatus,
  mergeMatchLists,
  searchMatches,
  sortForList,
} from './match-list'

/** 一场比赛的骨架，只填测试关心的字段 */
function mk(over: Partial<SoccerMatch> & { id: string; home: string; away: string }): SoccerMatch {
  return {
    title: `${over.home} vs. ${over.away}`,
    leagueCode: null,
    leagueIcon: null,
    endDate: null,
    eventIds: [],
    sources: [],
    volume: null,
    ...over,
  }
}

/** 两支有译名的队（词典里是真有的），外加一个能反解出联赛代码的 */
const EVERTON = mk({ id: '1', home: 'Everton FC', away: 'Wolverhampton Wanderers FC' })
const CHELSEA = mk({ id: '2', home: 'Chelsea FC', away: 'FC Barcelona', leagueCode: 'col1' })
const ALL = [EVERTON, CHELSEA]

const KICKOFF = Date.parse('2026-09-18T12:00:00Z')
const AT = (ms: number) => KICKOFF + ms
const MIN = 60_000

test('开赛状态：未开始 / 进行中 / 已结束，窗口是 2 小时', () => {
  const iso = '2026-09-18T12:00:00Z'
  assert.equal(matchStatus(iso, AT(-MIN)), 'not_started')
  assert.equal(matchStatus(iso, KICKOFF), 'live') // 开哨这一刻算进行中
  assert.equal(matchStatus(iso, AT(30 * MIN)), 'live')
  assert.equal(matchStatus(iso, AT(120 * MIN - 1)), 'live')
  assert.equal(matchStatus(iso, AT(120 * MIN)), 'ended') // 右端是开区间
  assert.equal(matchStatus(iso, AT(300 * MIN)), 'ended')
})

test('开赛状态：时间缺失或解析不了都算未开始，不抛', () => {
  assert.equal(matchStatus(null, KICKOFF), 'not_started')
  assert.equal(matchStatus('', KICKOFF), 'not_started')
  assert.equal(matchStatus('不是时间', KICKOFF), 'not_started')
})

test('窗口长度与原项目同值 —— 改了会让两边对同一场比赛给出不同状态', () => {
  assert.equal(LIVE_WINDOW_MS, 2 * 60 * 60 * 1000)
})

test('搜中文队名能搜到 —— 这次改动本身', () => {
  assert.deepEqual(
    searchMatches(ALL, '狼队').map((m) => m.id),
    ['1'],
  )
  assert.deepEqual(
    searchMatches(ALL, '埃弗顿').map((m) => m.id),
    ['1'],
  )
  assert.deepEqual(
    searchMatches(ALL, '巴塞罗那').map((m) => m.id),
    ['2'],
  )
})

/**
 * 搜的是**队名子串**，不是别名：词典的键是 Gamma 的官方全名
 * （"Wolverhampton Wanderers FC"），所以 "wanderers" 搜得到、
 * 英文绰号（Wolves / Spurs 这类）搜不到；中文译名「狼队」搜得到。
 *
 * 这是当前的数据形态，不是 bug —— 真支持绰号得给词典加一层别名表，
 * 那是另一件事，别指望在这里顺手实现。
 */
test('英文原名照样能搜，且不分大小写', () => {
  assert.deepEqual(
    searchMatches(ALL, 'wanderers').map((m) => m.id),
    ['1'],
  )
  assert.deepEqual(
    searchMatches(ALL, 'WOLVERHAMPTON').map((m) => m.id),
    ['1'],
  )
})

test('联赛按中文名和代码都能搜', () => {
  assert.deepEqual(
    searchMatches(ALL, '哥伦比亚').map((m) => m.id),
    ['2'],
  )
  assert.deepEqual(
    searchMatches(ALL, 'col1').map((m) => m.id),
    ['2'],
  )
})

test('多个词是 AND 不是 OR', () => {
  assert.deepEqual(
    searchMatches(ALL, 'everton wanderers').map((m) => m.id),
    ['1'],
  )
  // 这两支队不在同一场里，就不该命中
  assert.deepEqual(searchMatches(ALL, 'everton barcelona'), [])
})

test('空查询返回全部 —— 清空输入框不该清空列表', () => {
  assert.equal(searchMatches(ALL, '').length, 2)
  assert.equal(searchMatches(ALL, '   ').length, 2)
})

test('搜不到就是空数组', () => {
  assert.deepEqual(searchMatches(ALL, '不存在的队'), [])
})

test('搜索文本里中英文都在，缺译名的队也不会从搜索里消失', () => {
  const hay = matchHaystack(EVERTON)
  assert.ok(hay.includes('everton fc'), hay)
  assert.ok(hay.includes('埃弗顿'), hay)
  assert.ok(hay.includes('狼队'), hay)
})

test('列表顺序：没结束的按开赛时间升序在前，已结束的沉底', () => {
  const ms = [
    mk({ id: 'ended-old', home: 'A', away: 'B', endDate: '2026-09-17T16:00:00Z' }),
    mk({ id: 'upcoming', home: 'C', away: 'D', endDate: '2026-09-18T20:00:00Z' }),
    mk({ id: 'none', home: 'E', away: 'F' }),
    mk({ id: 'live', home: 'G', away: 'H', endDate: '2026-09-18T12:00:00Z' }),
    mk({ id: 'garbage', home: 'I', away: 'J', endDate: '不是时间' }),
    mk({ id: 'ended-new', home: 'K', away: 'L', endDate: '2026-09-17T18:00:00Z' }),
  ]
  // now = 开哨后 30 分钟：live 还在进行中，17 号那两场都已经结束
  assert.deepEqual(
    sortForList(ms, AT(30 * MIN)).map((m) => m.id),
    ['live', 'upcoming', 'none', 'garbage', 'ended-old', 'ended-new'],
  )
  // 入参是 react-query 的缓存，就地排序会把它也改掉
  assert.deepEqual(
    ms.map((m) => m.id),
    ['ended-old', 'upcoming', 'none', 'live', 'garbage', 'ended-new'],
  )
})

test('筛选与标签计数用同一个口径', () => {
  const now = AT(30 * MIN) // 1 号刚开哨，2 号还没开始
  const ms = [
    mk({ ...EVERTON, endDate: '2026-09-18T12:00:00Z' }),
    mk({ ...CHELSEA, endDate: '2026-09-18T20:00:00Z' }),
  ]
  assert.deepEqual(
    filterMatches(ms, 'live', now).map((m) => m.id),
    ['1'],
  )
  assert.deepEqual(
    filterMatches(ms, 'not_started', now).map((m) => m.id),
    ['2'],
  )
  assert.equal(filterMatches(ms, 'all', now).length, 2)

  // 标签上的数字若与筛出来的条数不一致，用户会以为丢了比赛
  const counts = countStatuses(ms, now)
  assert.equal(counts.live, filterMatches(ms, 'live', now).length)
  assert.equal(counts.not_started, filterMatches(ms, 'not_started', now).length)
  assert.equal(counts.ended, filterMatches(ms, 'ended', now).length)
})

test('默认打开最近的那场未结束比赛，而不是列表顺序里的第一场', () => {
  const ms = [
    mk({ id: 'important', home: 'A', away: 'B', endDate: '2026-09-18T20:00:00Z' }),
    mk({ id: 'nearest', home: 'C', away: 'D', endDate: '2026-09-18T13:00:00Z' }),
    mk({ id: 'far', home: 'E', away: 'F', endDate: '2026-09-19T13:00:00Z' }),
  ]
  const now = AT(30 * MIN) // 1 号 12:00 开哨，now = 12:30
  assert.equal(defaultMatchId(ms, now), 'nearest')
  // 入参顺序不该影响结果：口径是「按时间取最近」，不是「取第一个」
  assert.equal(defaultMatchId([...ms].reverse(), now), 'nearest')
})

test('默认那场就是列表第一行 —— 两处口径必须一致', () => {
  const ms = [
    mk({ id: 'ended-old', home: 'A', away: 'B', endDate: '2026-09-17T16:00:00Z' }),
    mk({ id: 'live', home: 'C', away: 'D', endDate: '2026-09-18T12:00:00Z' }),
    mk({ id: 'upcoming', home: 'E', away: 'F', endDate: '2026-09-18T14:00:00Z' }),
  ]
  const now = AT(30 * MIN)
  assert.equal(defaultMatchId(ms, now), sortForList(ms, now)[0].id)
})

test('全都已结束时默认取刚踢完的那场', () => {
  const ms = [
    mk({ id: 'old', home: 'A', away: 'B', endDate: '2026-09-17T10:00:00Z' }),
    mk({ id: 'newest', home: 'C', away: 'D', endDate: '2026-09-17T18:00:00Z' }),
  ]
  assert.equal(defaultMatchId(ms, AT(30 * MIN)), 'newest')
})

test('时间缺失的比赛不当默认值；一场都没有时给 null', () => {
  const garbage = mk({ id: 'garbage', home: 'A', away: 'B', endDate: '不是时间' })
  const ok = mk({ id: 'ok', home: 'C', away: 'D', endDate: '2026-09-18T13:00:00Z' })
  assert.equal(defaultMatchId([garbage, ok], AT(30 * MIN)), 'ok')
  // 一个时间可用的都没有时退回第一个：总比不选强，不选就是一张空画布
  assert.equal(defaultMatchId([garbage]), 'garbage')
  assert.equal(defaultMatchId([]), null)
})

test('合并窗口外的比赛：同标题的并 eventIds，新标题追加在后面', () => {
  const base = [
    mk({ id: '1', home: 'Everton FC', away: 'Wolverhampton Wanderers FC', eventIds: ['a'], volume: 100 }),
  ]
  const extra = [
    // 同一场比赛（标题相同），另一族子赛事在窗口外 —— eventIds 必须并起来，
    // 否则徽标只在窗口内那几条子赛事上命中
    mk({ id: '1', home: 'Everton FC', away: 'Wolverhampton Wanderers FC', eventIds: ['b', 'a'], volume: 300 }),
    mk({ id: '9', home: 'Chelsea FC', away: 'FC Barcelona', eventIds: ['z'] }),
  ]
  const out = mergeMatchLists(base, extra)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0].eventIds, ['a', 'b'])
  // 成交额两边各统计过一次，相加会翻倍，所以取大的
  assert.equal(out[0].volume, 300)
  assert.equal(out[1].id, '9')
  // 入参是 react-query 的缓存，不该被就地改
  assert.deepEqual(base[0].eventIds, ['a'])
})

test('合并：没有要补的就原样返回', () => {
  const base = [mk({ id: '1', home: 'A', away: 'B' })]
  assert.equal(mergeMatchLists(base, []), base)
})
