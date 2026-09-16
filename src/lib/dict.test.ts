/**
 * 词典与问句替换测试。
 *
 * 重点两条：
 *  1. 归一化匹配不能过度 —— "Manchester United FC" 要命中 "Manchester United"，
 *     但绝不能命中 "Manchester City"。
 *  2. 问句里队名必须**长的先换**，否则短名先命中会把长名切碎。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  BASE_LEAGUES,
  BASE_TEAMS,
  leagueCodeFromImage,
  normalizeTeamKey,
  translateLeague,
  translateQuestion,
  translateTeam,
} from './dict'

test('基准词典已加载且不含说明字段', () => {
  assert.ok(Object.keys(BASE_TEAMS).length > 100)
  assert.ok(Object.keys(BASE_LEAGUES).length > 20)
  assert.equal(BASE_TEAMS['_comment'], undefined)
  assert.equal(BASE_LEAGUES['_comment'], undefined)
})

test('精确命中', () => {
  assert.equal(translateTeam('Everton FC'), '埃弗顿')
  assert.equal(translateTeam('FC Barcelona'), '巴塞罗那')
})

test('查不到原样返回英文，不返回空或占位符', () => {
  // 译名是渐进增强：新球队每周都出现，显示英文远好过显示空白
  const unknown = 'Totally Unknown Sport Club 9999'
  assert.equal(translateTeam(unknown), unknown)
})

test('空值安全', () => {
  assert.equal(translateTeam(null), '')
  assert.equal(translateTeam(undefined), '')
  assert.equal(translateTeam(''), '')
})

test('归一化：去掉俱乐部后缀/前缀', () => {
  assert.equal(normalizeTeamKey('Everton FC'), 'everton')
  assert.equal(normalizeTeamKey('FC Barcelona'), 'barcelona')
  assert.equal(normalizeTeamKey('AS Monaco FC'), 'monaco')
  assert.equal(normalizeTeamKey('Manchester  United   FC'), 'manchester united')
})

test('归一化不会把不同球队混成一个', () => {
  // 这是归一化最大的风险：过度剥离会让同城球队撞键
  assert.notEqual(normalizeTeamKey('Manchester United FC'), normalizeTeamKey('Manchester City FC'))
  assert.notEqual(normalizeTeamKey('AC Milan'), normalizeTeamKey('Inter Milan'))
  assert.notEqual(normalizeTeamKey('Real Madrid'), normalizeTeamKey('Atletico Madrid'))
})

test('联赛代码从图片 URL 反解', () => {
  assert.equal(
    leagueCodeFromImage(
      'https://polymarket-upload.s3.us-east-2.amazonaws.com/soccer-leagues/col1.png',
    ),
    'col1',
  )
  assert.equal(translateLeague('col1'), '哥伦比亚甲级联赛')
})

test('非联赛徽标的图片返回 null', () => {
  // 很多赛事的 image 是海报（金球奖那种非对阵盘），不能当联赛代码用
  assert.equal(
    leagueCodeFromImage(
      'https://polymarket-upload.s3.us-east-2.amazonaws.com/ballon-dor-winner-2025-vTCj.jpg',
    ),
    null,
  )
  assert.equal(leagueCodeFromImage(null), null)
})

test('未知联赛代码返回 null 而不是代码本身', () => {
  // 显示 "zzz9" 对用户没有任何意义，不如不显示联赛
  assert.equal(translateLeague('zzz9'), null)
})

test('问句：队名 + 术语替换', () => {
  const q = translateQuestion(
    'Will Everton FC win on 2026-08-27?',
    'Everton FC',
    'Wolverhampton Wanderers FC',
  )
  assert.ok(q.includes('埃弗顿'), q)
  assert.ok(!q.includes('Will'), q)
  assert.ok(!q.includes('Everton'), q)
})

test('问句：长队名先换，短名不切碎长名', () => {
  // 若先换 "Manchester City" 之外的短名，"Manchester" 会被误伤
  const q = translateQuestion(
    'Will Manchester City FC vs. Manchester United FC end in a draw?',
    'Manchester City FC',
    'Manchester United FC',
  )
  assert.ok(q.includes('曼城'), q)
  assert.ok(q.includes('曼联'), q)
  assert.ok(!q.includes('Manchester'), q)
})

/**
 * 断言用的都是**实测存在的句式**，不是自己编的。
 *
 * 之前这里断的是 "Halftime Result" / "Total Corners" 这类照原项目搬来的
 * 字符串，而 Gamma 的 944 个足球问句归并成 29 个模板，里面根本没有它们 ——
 * 测试通过也不代表线上能翻对。
 */
test('问句：实测模板逐个翻得动', () => {
  const cases: Array<[string, string]> = [
    ['Everton FC leading at halftime?', '半场领先'],
    ['Everton FC to win the second half?', '赢下下半场'],
    ['Everton FC vs. Wolves: Draw at halftime?', '半场平局'],
    ['Everton FC vs. Wolves: Second half draw?', '下半场平局'],
    ['Everton FC vs. Wolves: O/U 2.5', '大小球 2.5'],
    ['Everton FC vs. Wolves: O/U 9.5 Total Corners', '总角球 9.5'],
    ['Everton FC vs. Wolves: Total Corners Odd or Even?', '总角球单双'],
    ['Everton FC vs. Wolves: Team to Take First Corner', '率先获得角球'],
    ['Everton FC vs. Wolves: Both Teams to Score', '双方均进球'],
    ['Everton FC vs. Wolves: Neither team to score first?', '双方均未率先进球'],
    ['Exact Score: Any Other Score?', '准确比分：其他'],
    ['Spread: Everton FC (-1.5)', '让球'],
    ['Everton FC vs. Wolves: 1st Half O/U 1.5', '上半场'],
  ]
  for (const [en, expect] of cases) {
    assert.ok(translateQuestion(en).includes(expect), `${en} -> ${translateQuestion(en)}`)
  }
})

test('问句：具体术语先于笼统，不被拆碎', () => {
  // "Total Corners Odd or Even" 若晚于裸 "Total Corners"，会剩下 "Odd or Even"
  assert.ok(!translateQuestion('A vs. B: Total Corners Odd or Even?').includes('Odd'))
  // "O/U 9.5 Total Corners" 若晚于裸 "O/U"，会变成「大小球 9.5 总角球」两个量词叠加
  assert.ok(!translateQuestion('A vs. B: O/U 9.5 Total Corners').includes('大小球'))
  // "in Second Half" 若晚于 "Both Teams to Score"，后半截留英文
  assert.ok(!translateQuestion('A vs. B: Both Teams to Score in Second Half').includes('Half'))
})

test('问句：标点归一，不留中英混排', () => {
  const q = translateQuestion('Will Everton FC win on 2026-09-09?', 'Everton FC', 'Wolves')
  // 半角问号混在中文里看着像没翻完
  assert.ok(!q.includes('?'), q)
  assert.ok(q.endsWith('？'), q)
  // 日期是噪音：盘口本来就属于某场比赛
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(q), q)
})

test('问句空值安全', () => {
  assert.equal(translateQuestion(null), '')
  assert.equal(translateQuestion(''), '')
})
