/**
 * 问句解析测试。
 *
 * 跑法：npx tsx --test src/market-graph/parse.test.ts
 *
 * 全部用例都是**库里真实的 question_en**（scripts 探查所得的 30 种骨架），
 * 不是编出来的写法。重点盯三类会被 soccer_markets.market_type 弄错的：
 * 角球盘、单队盘、半场盘——它们在那一列里全是 'total'。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseMarket, skeletonOf } from './parse.js'

const CHE = 'Chelsea FC'
const BHA = 'Brighton & Hove Albion FC'

function p(questionEn: string, line?: number | null) {
  return parseMarket({
    questionEn,
    line: line ?? null,
    homeTeamEn: CHE,
    awayTeamEn: BHA,
    homeTeamZh: '切尔西',
    awayTeamZh: '布莱顿',
  })
}

// ==================== 骨架 ====================

test('骨架把主客队名抽成占位符，长名先替换', () => {
  assert.equal(
    skeletonOf({
      questionEn: 'Chelsea FC vs. Brighton & Hove Albion FC: O/U 2.5',
      homeTeamEn: CHE,
      awayTeamEn: BHA,
    }),
    '{H} vs. {A}: O/U 2.5',
  )
})

test('骨架抽掉日期但保留线与比分的数字', () => {
  assert.equal(
    skeletonOf({ questionEn: 'Will Chelsea FC win on 2026-08-30?', homeTeamEn: CHE, awayTeamEn: BHA }),
    'Will {H} win on {DATE}?',
  )
  assert.match(
    skeletonOf({ questionEn: 'Chelsea FC vs. Brighton & Hove Albion FC: O/U 2.5', homeTeamEn: CHE, awayTeamEn: BHA }),
    /2\.5$/,
  )
})

test('问句用短名而库里存带 FC 的长名，照样能抽出占位符', () => {
  assert.equal(
    skeletonOf({ questionEn: 'Will Chelsea win on 2026-08-30?', homeTeamEn: CHE, awayTeamEn: BHA }),
    'Will {H} win on {DATE}?',
  )
})

// ==================== 总进球 ====================

test('全场总进球', () => {
  const d = p('Chelsea FC vs. Brighton & Hove Albion FC: O/U 2.5', 2.5)!
  assert.equal(d.family, 'ou')
  assert.equal(d.metric, 'goals')
  assert.equal(d.subject, 'match')
  assert.equal(d.period, 'ft')
  assert.equal(d.line, 2.5)
  assert.equal(d.goalSensitive, true)
})

test('半场总进球归到 ht，不是全场——"1st" 里的 1 不能被当成线', () => {
  const d = p('Chelsea FC vs. Brighton & Hove Albion FC: 1st Half O/U 1.5', 1.5)!
  assert.equal(d.period, 'ht')
  assert.equal(d.metric, 'goals')
  assert.equal(d.subject, 'match')
  assert.equal(d.line, 1.5)
})

test('下半场总进球归到 2h', () => {
  const d = p('Chelsea FC vs. Brighton & Hove Albion FC: 2nd Half O/U 2.5', 2.5)!
  assert.equal(d.period, '2h')
  assert.equal(d.line, 2.5)
})

// ==================== 会被 market_type 弄错的三类 ====================

test('角球盘不是总进球盘：metric=corners 且与进球无关', () => {
  const d = p('Chelsea FC vs. Brighton & Hove Albion FC: O/U 10.5 Total Corners', 10.5)!
  assert.equal(d.family, 'ou')
  assert.equal(d.metric, 'corners')
  assert.equal(d.line, 10.5)
  assert.equal(d.goalSensitive, false, '进球不推动角球盘，不能连进球梯子')
})

test('半场角球盘：period=ht 且 metric=corners', () => {
  const d = p('Chelsea FC vs. Brighton & Hove Albion FC: 1st Half O/U 4.5 Total Corners', 4.5)!
  assert.equal(d.period, 'ht')
  assert.equal(d.metric, 'corners')
  assert.equal(d.line, 4.5)
})

test('单队进球盘：subject 认到具体某队，不是 match', () => {
  const home = p('Chelsea FC vs. Brighton & Hove Albion FC: Chelsea FC O/U 2.5', 2.5)!
  assert.equal(home.subject, 'home')
  assert.equal(home.metric, 'goals')
  const away = p('Chelsea FC vs. Brighton & Hove Albion FC: Brighton & Hove Albion FC O/U 1.5', 1.5)!
  assert.equal(away.subject, 'away')
  assert.equal(away.line, 1.5)
})

test('单队半场进球盘：subject 与 period 同时认对', () => {
  const d = p('Chelsea FC vs. Brighton & Hove Albion FC: Brighton & Hove Albion FC 1st Half O/U 0.5', 0.5)!
  assert.equal(d.subject, 'away')
  assert.equal(d.period, 'ht')
  assert.equal(d.line, 0.5)
})

test('单队角球盘：subject + corners 都认对', () => {
  const d = p('Chelsea FC vs. Brighton & Hove Albion FC: Chelsea FC O/U 5.5 Corners', 5.5)!
  assert.equal(d.subject, 'home')
  assert.equal(d.metric, 'corners')
  assert.equal(d.goalSensitive, false)
})

// ==================== 让球 ====================

test('主队让球：线按主队视角为负', () => {
  const d = p('Spread: Chelsea FC (-1.5)', -1.5)!
  assert.equal(d.family, 'spread')
  assert.equal(d.subject, 'home')
  assert.equal(d.line, -1.5)
  assert.equal(d.homeLine, -1.5)
})

test('客队让球：换算到主队视角要翻符号', () => {
  const d = p('Spread: Brighton & Hove Albion FC (-1.5)', -1.5)!
  assert.equal(d.subject, 'away')
  assert.equal(d.line, -1.5)
  assert.equal(d.homeLine, 1.5, '客队让 1.5 = 主队受让 1.5')
})

test('半场让球：period=ht', () => {
  const d = p('1st Half Spread: Brighton & Hove Albion FC (-1.5)', -1.5)!
  assert.equal(d.family, 'spread')
  assert.equal(d.period, 'ht')
  assert.equal(d.homeLine, 1.5)
})

// ==================== 胜平负 ====================

test('主胜 / 客胜 / 平各是一个节点，role 区分槽位', () => {
  const home = p('Will Chelsea FC win on 2026-08-30?')!
  assert.equal(home.family, 'moneyline')
  assert.equal(home.role, 'home')
  assert.equal(home.period, 'ft')

  const away = p('Will Brighton & Hove Albion FC win on 2026-08-30?')!
  assert.equal(away.role, 'away')

  const draw = p('Will Chelsea FC vs. Brighton & Hove Albion FC end in a draw?')!
  assert.equal(draw.role, 'draw')
})

test('半场胜平负：leading at halftime 归到 ht 的 moneyline', () => {
  const lead = p('Chelsea FC leading at halftime?')!
  assert.equal(lead.family, 'moneyline')
  assert.equal(lead.period, 'ht')
  assert.equal(lead.role, 'home')

  const draw = p('Chelsea FC vs. Brighton & Hove Albion FC: Draw at halftime?')!
  assert.equal(draw.period, 'ht')
  assert.equal(draw.role, 'draw')
})

test('下半场胜平负归到 2h', () => {
  const win = p('Chelsea FC to win the second half?')!
  assert.equal(win.period, '2h')
  assert.equal(win.role, 'home')

  const draw = p('Chelsea FC vs. Brighton & Hove Albion FC: Second half draw?')!
  assert.equal(draw.period, '2h')
  assert.equal(draw.role, 'draw')
})

// ==================== 其余家族 ====================

test('双方进球，含半场版本', () => {
  const ft = p('Chelsea FC vs. Brighton & Hove Albion FC: Both Teams to Score')!
  assert.equal(ft.family, 'btts')
  assert.equal(ft.period, 'ft')
  const ht = p('Chelsea FC vs. Brighton & Hove Albion FC: Both Teams to Score in First Half')!
  assert.equal(ht.period, 'ht')
})

test('准确比分读出比分，「其他比分」score 为 null', () => {
  const d = p('Exact Score: Chelsea FC 2 - 3 Brighton & Hove Albion FC?')!
  assert.equal(d.family, 'exact')
  assert.deepEqual(d.score, { home: 2, away: 3 })
  const other = p('Exact Score: Any Other Score?')!
  assert.equal(other.family, 'exact')
  assert.equal(other.score, null)
})

test('先进球：认队，「无人先进球」归 match', () => {
  const home = p('Chelsea FC to score first vs. Brighton & Hove Albion FC?')!
  assert.equal(home.family, 'first_goal')
  assert.equal(home.subject, 'home')
  const away = p('Brighton & Hove Albion FC to score first vs. Chelsea FC?')!
  assert.equal(away.subject, 'away')
  const none = p('Chelsea FC vs. Brighton & Hove Albion FC: Neither team to score first?')!
  assert.equal(none.subject, 'match')
})

test('球员进球盘认出球员名', () => {
  const d = p('Joao Pedro: Anytime Goalscorer')!
  assert.equal(d.family, 'scorer')
  assert.equal(d.subject, 'player')
  assert.equal(d.player, 'Joao Pedro')
  assert.equal(d.goalSensitive, true)
})

test('晋级 / 点球大战 / 角球奇偶 / 首个角球', () => {
  assert.equal(p('Chelsea FC vs. Brighton & Hove Albion FC: Team to Advance')!.family, 'advance')
  assert.equal(
    p('Chelsea FC vs. Brighton & Hove Albion FC: Will the Match Go to a Penalty Shootout?')!.family,
    'penalty',
  )
  const odd = p('Chelsea FC vs. Brighton & Hove Albion FC: Total Corners Odd or Even?')!
  assert.equal(odd.family, 'odd_even')
  assert.equal(odd.goalSensitive, false)
  const fc = p('Chelsea FC vs. Brighton & Hove Albion FC: Team to Take First Corner')!
  assert.equal(fc.family, 'first_corner')
  assert.equal(fc.goalSensitive, false)
})

test('首个角球不能被「先进球」抢走', () => {
  const d = p('Chelsea FC vs. Brighton & Hove Albion FC: Team to Take First Corner')!
  assert.equal(d.metric, 'first_corner')
})

test('认不出的问句返回 null，不塞进 other 再连错边', () => {
  assert.equal(p('Who will be the referee?'), null)
})

// ==================== 标签 ====================

test('标签短到能放进节点，且带上期间与主体', () => {
  assert.equal(p('Chelsea FC vs. Brighton & Hove Albion FC: O/U 2.5', 2.5)!.label, '2.5 球')
  assert.equal(p('Chelsea FC vs. Brighton & Hove Albion FC: 1st Half O/U 1.5', 1.5)!.label, '半场1.5 球')
  assert.equal(
    p('Chelsea FC vs. Brighton & Hove Albion FC: O/U 10.5 Total Corners', 10.5)!.label,
    '10.5 角球',
  )
  assert.equal(p('Will Chelsea FC win on 2026-08-30?')!.label, '切尔西胜')
  assert.equal(p('Chelsea FC vs. Brighton & Hove Albion FC end in a draw?')!.label, '全场平')
  assert.equal(p('Exact Score: Chelsea FC 2 - 3 Brighton & Hove Albion FC?')!.label, '2-3')
})
