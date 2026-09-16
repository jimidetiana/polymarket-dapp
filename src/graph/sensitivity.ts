/**
 * 「进球会把这个盘推动多少」——用模型算，不靠猜。
 *
 * ## 为什么要算，而不是按盘口类型排个序
 *
 * 需求里的重点是「受进球影响剧烈的盘口」。按类型硬编一个顺序
 * （胜平负 > 让球 > 总进球）是错的：同一场里 Over 0.5 在 0-0 第 80 分钟
 * 几乎不动（λ剩余小），而 Over 2.5 在 2-2 时一个球就从 0 跳到 1。
 * 剧烈程度取决于**当前比分与剩余时间**，只能现算。
 *
 * ## 算法
 *
 * λ 全场总进球从**大小球盘**反推（与 next-line.ts 同口径：大小球的 λ
 * 直接由大小球定价，绕道 1X2 会引入让球方向的噪音）；主客拆分再从 1X2
 * 反推，然后按总量重标定，保证 λ_home + λ_away = λ_total。
 *
 * 每个节点算三次概率：当前比分、主队再进一球、客队再进一球。
 *   magnitude = max(|Δ主|, |Δ客|)
 *
 * ## 方向与幅度是两件事
 *
 * 有些盘口方向明确但幅度算不出来（晋级要看两回合与加时，点球大战同理，
 * 球员进球要看阵容）。这些给方向、幅度留 0，**不编数字**。
 * 角球盘则连方向都是 flat：进球不推动角球。
 */
import { poissonPmf, poissonCdf, calculateWinProbabilities, calculateHandicapProbabilities } from '../bots/value-bot/math-utils.js'
import { inferLambdas as inferLambdasFrom1x2 } from '../bots/value-bot/probability-model.js'
import { inferLambdaFromOver25 } from '../bots/price-bot/next-line.js'
import { MATCH_TOTAL_MINUTES } from '../bots/price-bot/goal-lines.js'
import type { Family, GoalDir, GoalImpact, MarketDescriptor, Period } from './types.js'

/** 比赛此刻的状态。minute=null 表示赛前 */
export interface MatchState {
  homeGoals: number
  awayGoals: number
  minute: number | null
}

export interface Lambdas {
  total: number
  home: number
  away: number
}

export const PRE_MATCH: MatchState = { homeGoals: 0, awayGoals: 0, minute: null }

/**
 * 上下半场的进球占比。
 *
 * 足球的进球不是均匀分布在 90 分钟里，下半场明显更多（体力下降、
 * 落后方压上）。取 45/55 而不是 50/50，否则半场盘的公平价系统性偏高。
 */
const H1_SHARE = 0.45
const H2_SHARE = 0.55

/** 半场边界（分钟） */
const HALF_MINUTE = 45

/** 某个期间内「还剩多少 λ、期间内已进几球」。null = 无从判断 */
interface PeriodScope {
  scale: number
  goalsHome: number
  goalsAway: number
}

/**
 * 把全场 λ 折算到某个期间的剩余部分。
 *
 * 返回 null 是刻意的：半场盘在下半场进行时，「上半场进了几个」无法从
 * 当前总比分推出来（库里只有总比分）。这时候宁可不给幅度，也不要拿
 * 全场比分冒充半场比分——那会把已经结算的半场盘算成还在动。
 */
export function periodScope(period: Period, state: MatchState): PeriodScope | null {
  const m = state.minute
  const { homeGoals: h, awayGoals: a } = state

  if (period === 'ft') {
    if (m == null) return { scale: 1, goalsHome: h, goalsAway: a }
    if (m < HALF_MINUTE) {
      const scale = H1_SHARE * ((HALF_MINUTE - m) / HALF_MINUTE) + H2_SHARE
      return { scale, goalsHome: h, goalsAway: a }
    }
    const scale = H2_SHARE * Math.max(0, (MATCH_TOTAL_MINUTES - m) / HALF_MINUTE)
    return { scale, goalsHome: h, goalsAway: a }
  }

  if (period === 'ht') {
    if (m == null) return { scale: H1_SHARE, goalsHome: 0, goalsAway: 0 }
    if (m >= HALF_MINUTE) return null // 上半场已结束，且不知道半场比分
    return {
      scale: H1_SHARE * ((HALF_MINUTE - m) / HALF_MINUTE),
      goalsHome: h,
      goalsAway: a,
    }
  }

  // 2h
  if (m == null) return { scale: H2_SHARE, goalsHome: 0, goalsAway: 0 }
  if (m < HALF_MINUTE) return { scale: H2_SHARE, goalsHome: 0, goalsAway: 0 }
  const scale = H2_SHARE * Math.max(0, (MATCH_TOTAL_MINUTES - m) / HALF_MINUTE)
  return { scale, goalsHome: h, goalsAway: a }
}

/**
 * 从任意一条大小球线反推 λ：P(总进球 ≥ need) = 1 − PoissonCDF(need−1, λ)。
 *
 * next-line.ts 的 inferLambdaFromOver25 只认 2.5 档。这里推广到任意线，
 * 因为不是每场都有 2.5 的报价（低量比赛常常只挂 0.5/1.5）。
 * 2.5 档仍走原函数，保证与现有决策同口径。
 */
export function inferLambdaFromOver(
  overPrice: number | null | undefined,
  line: number,
  /**
   * 这条线**还需要几个球**才打出。默认 line+0.5（赛前口径）。
   *
   * 赛中必须传剩余需求，否则会把「还差 1 球」读成「从开哨算起要 6 球」。
   * 实测富勒姆vs切尔西已进 5 球，Over 5.5 报 0.725（=还会再进 1 球的概率），
   * 按赛前口径反推出 λ=7.21（场均 7 球），而真实剩余需求只有 1 球。
   */
  needOverride?: number,
): number | null {
  if (needOverride == null && line === 2.5) return inferLambdaFromOver25(overPrice)
  if (overPrice == null) return null
  const target = Number(overPrice)
  if (!Number.isFinite(target) || target <= 0 || target >= 1) return null
  const need = needOverride ?? Math.round(line + 0.5)
  if (need < 1) return null

  let lo = 0.05
  let hi = 15
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (1 - poissonCdf(need - 1, mid) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** λ 反推的输入：一条盘口的描述 + 它主侧的概率（用盘口中价） */
export interface LambdaSample {
  desc: MarketDescriptor
  prob: number | null
}

/** 主队优势的默认拆分。只在完全没有 1X2 报价时用 */
const DEFAULT_HOME_SHARE = 0.55

/**
 * 这个价格能不能用来反推 λ。
 *
 * 钉死的价（≥0.99 或 ≤0.01）**不含速率信息**，它只是结果。
 * 实测拿它反推会得出荒谬的 λ：已结束比赛的 Over 5.5 停在 0.9995，
 * 反推出 λ=8.00（场均 8 球）；反过来 Under 全钉死的场次反推出 λ=0.15。
 * 这两个数字随后会污染每个节点的进球幅度，让「重点盘口」排序完全失真。
 */
function isInformative(p: number | null | undefined): boolean {
  return p != null && Number.isFinite(p) && p > 0.01 && p < 0.99
}

/**
 * 从盘口报价反推 λ。
 *
 * 优先级刻意如此：总量用大小球（直接定价），拆分用 1X2（唯一含方向的信息）。
 * 两者都缺就返回 null——没有 λ 就不给幅度，不拿默认值冒充测量值。
 */
export function inferLambdas(
  samples: LambdaSample[],
  /**
   * 当前比分与分钟。赛前（默认）时与旧行为完全一致：已进 0 球、不衰减。
   *
   * 赛中必须传：盘口价反映的是**剩余**进球，而 Lambdas 的口径是
   * 「从开哨算起的全场速率」（nodeProbability 内部再按剩余时间折算）。
   * 两者差一个换算，不做换算就会把「已进 5 球还差 1 个」读成「场均 7 球」。
   */
  state: MatchState = PRE_MATCH,
): Lambdas | null {
  const scored = state.homeGoals + state.awayGoals
  // 全场剩余时间占比。用它把「剩余速率」还原成「全场速率」
  const ftScale = periodScope('ft', state)?.scale ?? 1

  // 总量：优先 2.5，其次取离 2.5 最近的那条线
  const ouMatch = samples.filter(
    (s) =>
      s.desc.family === 'ou' &&
      s.desc.period === 'ft' &&
      s.desc.metric === 'goals' &&
      s.desc.subject === 'match' &&
      s.desc.line != null &&
      isInformative(s.prob),
  )
  ouMatch.sort((a, b) => Math.abs((a.desc.line ?? 9) - 2.5) - Math.abs((b.desc.line ?? 9) - 2.5))
  let total: number | null = null
  for (const s of ouMatch) {
    // 剩余需求：这条线要 need 个球，已经进了 scored 个
    const needRemaining = Math.round(s.desc.line! + 0.5) - scored
    if (needRemaining < 1) continue // 该线已打出，价里没有速率信息
    const lamRemaining = inferLambdaFromOver(s.prob, s.desc.line!, needRemaining)
    if (lamRemaining == null) continue
    // 还原成全场速率。剩余时间为 0（比赛结束）时无从还原，不给数字
    if (ftScale <= 1e-6) return null
    total = lamRemaining / ftScale
    break
  }

  // 拆分：1X2 三条腿的 Yes 价，归一化去 vig
  const ml = samples.filter(
    (s) => s.desc.family === 'moneyline' && s.desc.period === 'ft' && isInformative(s.prob),
  )
  const pick = (role: 'home' | 'draw' | 'away'): number | null =>
    ml.find((s) => s.desc.role === role)?.prob ?? null
  const h = pick('home')
  const d = pick('draw')
  const a = pick('away')

  // 1X2 反推假定价格是「从 0-0 算起」的胜平负概率。比分不平时这个假定不成立
  // （1-0 的主胜价里含着已有的领先），拿它推比例会把领先方的 λ 抬高。
  // 所以只在比分持平时用它定比例，否则退回默认主队占比。
  const levelScore = state.homeGoals === state.awayGoals
  let split: { lambdaHome: number; lambdaAway: number } | null = null
  if (levelScore && h != null && d != null && a != null) {
    const sum = h + d + a
    if (sum > 0) split = inferLambdasFrom1x2(h / sum, d / sum, a / sum)
  }

  // 总量**只**由大小球定。1X2 只供比例，绝不用来推总量：
  // 实测已结束比赛的 1X2 停在 0.02/0.02/0.98，虽然还没到 0.99 的钉死线，
  // 拿它推总量会得出 λ=7.21（场均 7 球）。而这正是本函数开头写的规则
  // ——「总量用大小球，拆分用 1X2」。之前这里的回退违背了自己的规则。
  if (total == null) return null

  if (split == null) {
    return { total, home: total * DEFAULT_HOME_SHARE, away: total * (1 - DEFAULT_HOME_SHARE) }
  }
  // 两者都有：用 1X2 定比例，用大小球定总量
  const sp = split.lambdaHome + split.lambdaAway
  const share = sp > 0 ? split.lambdaHome / sp : DEFAULT_HOME_SHARE
  return { total, home: total * share, away: total * (1 - share) }
}

/** 泊松尾概率 P(X ≥ k)。k ≤ 0 时为 1 */
function atLeast(k: number, lambda: number): number {
  if (k <= 0) return 1
  if (lambda <= 0) return 0
  return 1 - poissonCdf(k - 1, lambda)
}

/**
 * 节点主侧的模型概率。返回 null = 这个家族没有可靠模型，**不编数字**。
 *
 * 各家族的「主侧」口径（必须与 graph.ts 的 primarySide 一致）：
 *   ou        Over
 *   moneyline role 对应的那一腿（主胜/平/客胜）
 *   spread    主队打过 homeLine（margin_home + homeLine > 0）
 *   btts      双方都进
 *   exact     该比分
 *   first_goal subject 那一方先进球；subject=match 表示「无人先进球」
 */
export function nodeProbability(
  desc: MarketDescriptor,
  lam: Lambdas,
  state: MatchState,
): number | null {
  const scope = periodScope(desc.period, state)
  if (scope == null) return null
  const lamH = lam.home * scope.scale
  const lamA = lam.away * scope.scale
  const lamT = lamH + lamA
  const gh = scope.goalsHome
  const ga = scope.goalsAway
  const d = gh - ga

  switch (desc.family) {
    case 'ou': {
      if (desc.metric !== 'goals' || desc.line == null) return null
      const need = Math.round(desc.line + 0.5)
      if (desc.subject === 'home') return atLeast(need - gh, lamH)
      if (desc.subject === 'away') return atLeast(need - ga, lamA)
      return atLeast(need - gh - ga, lamT)
    }
    case 'moneyline': {
      const { home, draw, away } = calculateWinProbabilities(d, lamH, lamA)
      if (desc.role === 'home') return home
      if (desc.role === 'away') return away
      if (desc.role === 'draw') return draw
      return null
    }
    case 'spread': {
      if (desc.homeLine == null) return null
      return calculateHandicapProbabilities(d, lamH, lamA, desc.homeLine).home
    }
    case 'btts': {
      const pH = gh > 0 ? 1 : atLeast(1, lamH)
      const pA = ga > 0 ? 1 : atLeast(1, lamA)
      return pH * pA
    }
    case 'exact': {
      if (desc.score == null) return null // 「其他比分」是大集合的补，不建模
      const needH = desc.score.home - gh
      const needA = desc.score.away - ga
      if (needH < 0 || needA < 0) return 0
      return poissonPmf(needH, lamH) * poissonPmf(needA, lamA)
    }
    case 'first_goal': {
      if (desc.subject === 'match') {
        // 「无人先进球」= 期间内 0 球
        return gh + ga > 0 ? 0 : Math.exp(-lamT)
      }
      if (gh > 0 && ga === 0) return desc.subject === 'home' ? 1 : 0
      if (ga > 0 && gh === 0) return desc.subject === 'away' ? 1 : 0
      if (gh > 0 && ga > 0) return null // 总比分推不出谁先进的
      if (lamT <= 0) return 0
      const anyGoal = atLeast(1, lamT)
      const share = desc.subject === 'home' ? lamH / lamT : lamA / lamT
      return share * anyGoal
    }
    default:
      return null // scorer / advance / penalty / 角球系：无可靠模型
  }
}

/**
 * 结构上与进球无关的家族：进球了这些盘也不动。
 * 这不是「算不出来」，而是「答案已知且为零」，所以 modelled=true。
 */
const GOAL_INDEPENDENT = new Set<Family>(['odd_even', 'first_corner'])

/** 方向未知也算不出幅度的家族：给 flat + modelled=false，前端标「未建模」 */
const UNMODELLED = new Set<Family>(['scorer', 'advance', 'penalty', 'other'])

/** 概率变化的方向。归零（且原本非零）记 kill：这一侧被进球直接判死 */
function dirOf(base: number, after: number): GoalDir {
  const eps = 1e-6
  if (after <= eps && base > eps) return 'kill'
  if (after - base > eps) return 'up'
  if (base - after > eps) return 'down'
  return 'flat'
}

const FLAT: GoalImpact = {
  homeGoal: 'flat',
  awayGoal: 'flat',
  magnitude: 0,
  deltaHome: 0,
  deltaAway: 0,
  modelled: true,
}

/**
 * 进球对这个节点的影响：方向 + 幅度。
 *
 * 幅度是「再进一个球，主侧概率会跳多少」，取主客两种进法里较大的那个。
 * 这是需求里「受进球影响剧烈」的量化口径：magnitude 越大越剧烈。
 */
export function goalImpact(
  desc: MarketDescriptor,
  lam: Lambdas | null,
  state: MatchState,
): GoalImpact {
  // 角球盘：进球不推动它，方向与幅度都确定为零
  if (GOAL_INDEPENDENT.has(desc.family) || desc.metric === 'corners') return FLAT

  // 方向靠结构、幅度未建模
  if (UNMODELLED.has(desc.family)) {
    return { ...FLAT, modelled: false }
  }

  if (lam == null) {
    return { homeGoal: 'flat', awayGoal: 'flat', magnitude: 0, deltaHome: null, deltaAway: null, modelled: false }
  }

  const base = nodeProbability(desc, lam, state)
  if (base == null) {
    return { homeGoal: 'flat', awayGoal: 'flat', magnitude: 0, deltaHome: null, deltaAway: null, modelled: false }
  }

  // 「此刻再进一个球」——分钟不变，只加比分
  const afterHome = nodeProbability(desc, lam, { ...state, homeGoals: state.homeGoals + 1 })
  const afterAway = nodeProbability(desc, lam, { ...state, awayGoals: state.awayGoals + 1 })
  if (afterHome == null || afterAway == null) {
    return { homeGoal: 'flat', awayGoal: 'flat', magnitude: 0, deltaHome: null, deltaAway: null, modelled: false }
  }

  const dH = afterHome - base
  const dA = afterAway - base
  return {
    homeGoal: dirOf(base, afterHome),
    awayGoal: dirOf(base, afterAway),
    magnitude: Math.max(Math.abs(dH), Math.abs(dA)),
    deltaHome: dH,
    deltaAway: dA,
    modelled: true,
  }
}

