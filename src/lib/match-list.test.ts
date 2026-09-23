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
  filterMatches,
  matchHaystack,
  matchStatus,
  searchMatches,
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
