/**
 * 进球敏感度测试。
 *
 * 跑法：npx tsx --test src/market-graph/sensitivity.test.ts
 *
 * 盯的是几条「一旦搞反就会让网状图给出错误重点」的性质：
 * 单调性、比分推进后的归零、角球与进球无关、半场盘在下半场不可判。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  goalImpact,
  inferLambdaFromOver,
  inferLambdas,
  nodeProbability,
  periodScope,
  PRE_MATCH,
  type Lambdas,
  type MatchState,
} from './sensitivity.js'
import type { MarketDescriptor } from './types.js'

const LAM: Lambdas = { total: 2.7, home: 1.5, away: 1.2 }

function desc(over: Partial<MarketDescriptor>): MarketDescriptor {
  return {
    family: 'ou',
    period: 'ft',
    metric: 'goals',
    subject: 'match',
    line: 2.5,
    homeLine: null,
    score: null,
    player: null,
    role: null,
    label: '',
    goalSensitive: true,
    ...over,
  }
}

const at = (minute: number | null, h = 0, a = 0): MatchState => ({
  homeGoals: h,
  awayGoals: a,
  minute,
})

// ==================== λ 反推 ====================

test('任意档反推的 λ 能还原回原价', () => {
  for (const line of [0.5, 1.5, 2.5, 3.5]) {
    const lam = inferLambdaFromOver(0.55, line)
    assert.ok(lam != null, `line=${line} 应能反推`)
  }
})

test('2.5 档与 next-line.ts 同口径（同一函数）', () => {
  const a = inferLambdaFromOver(0.52, 2.5)!
  // P(≥3) = 0.52 时 λ 约 2.9
  assert.ok(a > 2.5 && a < 3.4, `λ=${a} 应落在合理区间`)
})

test('越界价格反推不出 λ，不拿假数字往下算', () => {
  assert.equal(inferLambdaFromOver(0, 1.5), null)
  assert.equal(inferLambdaFromOver(1, 1.5), null)
  assert.equal(inferLambdaFromOver(null, 1.5), null)
})

test('λ 拆分：总量用大小球，比例用 1X2', () => {
  const lam = inferLambdas([
    { desc: desc({ line: 2.5 }), prob: 0.52 },
    { desc: desc({ family: 'moneyline', metric: 'result', role: 'home', line: null }), prob: 0.5 },
    { desc: desc({ family: 'moneyline', metric: 'result', role: 'draw', line: null }), prob: 0.25 },
    { desc: desc({ family: 'moneyline', metric: 'result', role: 'away', line: null }), prob: 0.25 },
  ])
  assert.ok(lam != null)
  assert.ok(Math.abs(lam!.home + lam!.away - lam!.total) < 1e-9, '拆分后必须仍等于总量')
  assert.ok(lam!.home > lam!.away, '主胜价更高 → 主队 λ 更大')
})

test('完全没有报价时返回 null，不编默认 λ', () => {
  assert.equal(inferLambdas([]), null)
  assert.equal(inferLambdas([{ desc: desc({}), prob: null }]), null)
})

// ==================== 期间折算 ====================

test('全场剩余 λ 随时间单调下降，终场为 0', () => {
  const pre = periodScope('ft', at(null))!.scale
  const m30 = periodScope('ft', at(30))!.scale
  const m70 = periodScope('ft', at(70))!.scale
  const end = periodScope('ft', at(90))!.scale
  assert.equal(pre, 1)
  assert.ok(pre > m30 && m30 > m70 && m70 > end, `应递减：${pre} ${m30} ${m70} ${end}`)
  assert.equal(end, 0)
})

test('下半场进行时，半场盘不可判——不拿全场比分冒充半场比分', () => {
  assert.equal(periodScope('ht', at(60, 2, 1)), null)
  assert.equal(nodeProbability(desc({ period: 'ht', line: 1.5 }), LAM, at(60, 2, 1)), null)
})

test('赛前的下半场盘：期间内 0 球，λ 是全场的下半场份额', () => {
  const s = periodScope('2h', at(null))!
  assert.equal(s.goalsHome, 0)
  assert.equal(s.goalsAway, 0)
  assert.ok(s.scale > 0.5 && s.scale < 0.6, `下半场份额 ${s.scale} 应约 0.55`)
})

// ==================== 概率 ====================

test('Over 概率随线升高而下降', () => {
  const p05 = nodeProbability(desc({ line: 0.5 }), LAM, PRE_MATCH)!
  const p15 = nodeProbability(desc({ line: 1.5 }), LAM, PRE_MATCH)!
  const p25 = nodeProbability(desc({ line: 2.5 }), LAM, PRE_MATCH)!
  assert.ok(p05 > p15 && p15 > p25, `应递减：${p05} ${p15} ${p25}`)
})

test('比分已打出该线时 Over 概率为 1', () => {
  assert.equal(nodeProbability(desc({ line: 1.5 }), LAM, at(50, 2, 0)), 1)
})

test('单队盘只看那队的 λ 与那队的进球', () => {
  const homeOver = desc({ subject: 'home', line: 0.5 })
  const pre = nodeProbability(homeOver, LAM, PRE_MATCH)!
  assert.ok(pre > 0 && pre < 1)
  // 客队进球不该推动主队进球盘
  assert.equal(nodeProbability(homeOver, LAM, at(30, 0, 1))! > 0, true)
  assert.equal(nodeProbability(homeOver, LAM, at(30, 1, 0)), 1)
})

test('让球盘按主队视角：受让越多，主侧概率越高', () => {
  const minus = nodeProbability(desc({ family: 'spread', homeLine: -1.5, line: -1.5 }), LAM, PRE_MATCH)!
  const plus = nodeProbability(desc({ family: 'spread', homeLine: 1.5, line: -1.5 }), LAM, PRE_MATCH)!
  assert.ok(plus > minus, `受让 +1.5 (${plus}) 应高于让出 -1.5 (${minus})`)
})

test('准确比分：比分越过目标后归零', () => {
  const d = desc({ family: 'exact', metric: 'exact', score: { home: 1, away: 0 }, line: null })
  assert.ok(nodeProbability(d, LAM, PRE_MATCH)! > 0)
  assert.equal(nodeProbability(d, LAM, at(60, 2, 0)), 0)
})

test('「其他比分」不建模，返回 null 而不是编一个数', () => {
  const d = desc({ family: 'exact', metric: 'exact', score: null, line: null })
  assert.equal(nodeProbability(d, LAM, PRE_MATCH), null)
})

test('先进球：0-0 时两侧按 λ 分摊；已有进球后判定完成', () => {
  const home = desc({ family: 'first_goal', metric: 'first_goal', subject: 'home', line: null })
  const away = desc({ family: 'first_goal', metric: 'first_goal', subject: 'away', line: null })
  const none = desc({ family: 'first_goal', metric: 'first_goal', subject: 'match', line: null })
  const ph = nodeProbability(home, LAM, PRE_MATCH)!
  const pa = nodeProbability(away, LAM, PRE_MATCH)!
  const pn = nodeProbability(none, LAM, PRE_MATCH)!
  assert.ok(ph > pa, '主队 λ 更大 → 先进球概率更高')
  assert.ok(Math.abs(ph + pa + pn - 1) < 1e-6, `三者应构成完整划分，实为 ${ph + pa + pn}`)
  assert.equal(nodeProbability(home, LAM, at(20, 1, 0)), 1)
  assert.equal(nodeProbability(away, LAM, at(20, 1, 0)), 0)
})

test('双方都进球后，「谁先进」从总比分推不出来 → null', () => {
  const home = desc({ family: 'first_goal', metric: 'first_goal', subject: 'home', line: null })
  assert.equal(nodeProbability(home, LAM, at(70, 1, 1)), null)
})

// ==================== 进球影响 ====================

test('Over 盘：任一方进球都往上，方向不分主客', () => {
  const im = goalImpact(desc({ line: 2.5 }), LAM, PRE_MATCH)
  assert.equal(im.homeGoal, 'up')
  assert.equal(im.awayGoal, 'up')
  assert.ok(im.magnitude > 0)
  assert.equal(im.modelled, true)
})

test('主胜盘：主队进球往上，客队进球往下', () => {
  const im = goalImpact(
    desc({ family: 'moneyline', metric: 'result', role: 'home', subject: 'home', line: null }),
    LAM,
    PRE_MATCH,
  )
  assert.equal(im.homeGoal, 'up')
  assert.equal(im.awayGoal, 'down')
})

test('剧烈程度随比分逼近线而升高——这就是「重点盘口」的排序依据', () => {
  // 1-1 第 70 分钟：Over 2.5 只差一个球，一个球直接判定
  const near = goalImpact(desc({ line: 2.5 }), LAM, at(70, 1, 1)).magnitude
  // 同一时刻的 Over 4.5 还差三个球，一个球推不动多少
  const far = goalImpact(desc({ line: 4.5 }), LAM, at(70, 1, 1)).magnitude
  assert.ok(near > far, `逼近的线 ${near} 应比远的线 ${far} 更剧烈`)
  assert.ok(near > 0.5, `差一球时一个进球应造成剧变，实为 ${near}`)
})

test('已打出的线不再敏感：进球推不动一个恒为 1 的盘', () => {
  const im = goalImpact(desc({ line: 1.5 }), LAM, at(60, 2, 0))
  assert.equal(im.magnitude, 0)
  assert.equal(im.homeGoal, 'flat')
})

test('准确比分被进球判死 → kill', () => {
  const d = desc({ family: 'exact', metric: 'exact', score: { home: 0, away: 0 }, line: null })
  const im = goalImpact(d, LAM, PRE_MATCH)
  assert.equal(im.homeGoal, 'kill')
  assert.equal(im.awayGoal, 'kill')
})

test('角球盘与进球无关：flat 且已建模（答案是零，不是算不出）', () => {
  const im = goalImpact(desc({ metric: 'corners', line: 10.5 }), LAM, PRE_MATCH)
  assert.equal(im.homeGoal, 'flat')
  assert.equal(im.magnitude, 0)
  assert.equal(im.modelled, true)
})

test('球员/晋级/点球：不编幅度，标未建模', () => {
  for (const family of ['scorer', 'advance', 'penalty'] as const) {
    const im = goalImpact(desc({ family, line: null }), LAM, PRE_MATCH)
    assert.equal(im.modelled, false, `${family} 应标未建模`)
    assert.equal(im.magnitude, 0)
  }
})

test('没有 λ 时不给幅度', () => {
  const im = goalImpact(desc({ line: 2.5 }), null, PRE_MATCH)
  assert.equal(im.modelled, false)
  assert.equal(im.deltaHome, null)
})
