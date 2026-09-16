/**
 * 概率模型 - 从赔率推导期望进球数(λ)，实时概率计算
 *
 * 算法流程:
 * 1. 从赔率 → 隐含概率（去 vig 归一化）
 * 2. 从隐含概率 → λ_H, λ_A（网格搜索优化）
 * 3. 实时调整: λ_remaining = λ_full × timeDecayFactor(t)
 * 4. 用 Skellam 分布计算当前比分下的胜/平/负概率
 */

import { poissonPmf, calculateWinProbabilities, calculateHandicapProbabilities, timeDecayFactor } from './math-utils'
import type { InitialOdds, MatchContext } from './types'

/**
 * 从赔率计算隐含概率（去 vig 归一化）
 * @param odds 赔率数组，如 [2.5, 3.2, 3.0] 对应 [主胜, 平, 客胜]
 */
export function oddsToImpliedProbabilities(odds: number[]): number[] {
  const inversed = odds.map((o) => (o > 0 ? 1 / o : 0))
  const overround = inversed.reduce((sum, p) => sum + p, 0)
  if (overround <= 0) return inversed.map(() => 1 / inversed.length)
  return inversed.map((p) => p / overround)
}

/**
 * 从概率价格（0~1）计算隐含概率
 * Polymarket 使用 0~1 的价格表示概率，但可能有 vig
 * @param prices 价格数组，如 [0.45, 0.28, 0.27]
 */
export function pricesToImpliedProbabilities(prices: number[]): number[] {
  const sum = prices.reduce((s, p) => s + p, 0)
  if (sum <= 0) return prices.map(() => 1 / prices.length)
  return prices.map((p) => p / sum)
}

/**
 * 从 λ_H, λ_A 计算模型 1X2 概率
 */
export function calculate1x2FromLambdas(
  lambdaHome: number,
  lambdaAway: number,
  maxGoals = 10,
): { home: number; draw: number; away: number } {
  let home = 0
  let draw = 0
  let away = 0

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const prob = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway)
      if (h > a) home += prob
      else if (h === a) draw += prob
      else away += prob
    }
  }

  // 归一化
  const total = home + draw + away
  if (total > 0) {
    home /= total
    draw /= total
    away /= total
  }

  return { home, draw, away }
}

/**
 * 从市场 1X2 概率反推 λ_H, λ_A（网格搜索 + 细化）
 *
 * @param targetHome 目标主队胜率
 * @param targetDraw 目标平局率
 * @param targetAway 目标客队胜率
 * @returns { lambdaHome, lambdaAway }
 */
export function inferLambdas(
  targetHome: number,
  targetDraw: number,
  targetAway: number,
): { lambdaHome: number; lambdaAway: number } {
  // Phase 1: 粗网格搜索 (0.1 ~ 3.0, step 0.1)
  let bestLamH = 1.4
  let bestLamA = 1.1
  let bestLoss = Infinity

  for (let lh = 0.1; lh <= 3.0; lh += 0.1) {
    for (let la = 0.1; la <= 3.0; la += 0.1) {
      const { home, draw, away } = calculate1x2FromLambdas(lh, la)
      const loss =
        Math.pow(home - targetHome, 2) +
        Math.pow(draw - targetDraw, 2) +
        Math.pow(away - targetAway, 2)
      if (loss < bestLoss) {
        bestLoss = loss
        bestLamH = lh
        bestLamA = la
      }
    }
  }

  // Phase 2: 细网格搜索 (±0.15, step 0.01)
  const coarseH = bestLamH
  const coarseA = bestLamA
  for (let lh = Math.max(0.05, coarseH - 0.15); lh <= coarseH + 0.15; lh += 0.01) {
    for (let la = Math.max(0.05, coarseA - 0.15); la <= coarseA + 0.15; la += 0.01) {
      const { home, draw, away } = calculate1x2FromLambdas(lh, la)
      const loss =
        Math.pow(home - targetHome, 2) +
        Math.pow(draw - targetDraw, 2) +
        Math.pow(away - targetAway, 2)
      if (loss < bestLoss) {
        bestLoss = loss
        bestLamH = lh
        bestLamA = la
      }
    }
  }

  return { lambdaHome: Math.round(bestLamH * 1000) / 1000, lambdaAway: Math.round(bestLamA * 1000) / 1000 }
}

/**
 * 从 Polymarket 盘口数据创建初盘信息
 *
 * Polymarket 的 moneyline 可能是:
 * 1. 单个3结果市场: outcomes = ["Home", "Draw", "Away"], prices = [0.45, 0.28, 0.27]
 * 2. 多个2结果市场: 每个 "Will X win?" → Yes/No
 *
 * 对于情况2，我们需要找到主胜/平/客胜的价格
 */
export function createInitialOddsFromMarkets(
  eventId: string,
  homeTeam: string,
  awayTeam: string,
  homeProb: number,
  drawProb: number,
  awayProb: number,
): InitialOdds {
  const { lambdaHome, lambdaAway } = inferLambdas(homeProb, drawProb, awayProb)

  return {
    eventId,
    homeTeam,
    awayTeam,
    lambdaHome,
    lambdaAway,
    initialHomeProb: homeProb,
    initialDrawProb: drawProb,
    initialAwayProb: awayProb,
    source: 'polymarket',
    createdAt: new Date().toISOString(),
    biasDirection: 'none',
    biasCoefficient: 0,
  }
}

/**
 * 计算实时比赛概率
 *
 * @param initial 初盘信息（包含全场比赛的 λ）
 * @param ctx 比赛上下文（分钟、比分）
 * @returns 实时胜/平/负概率
 */
export function calculateLiveProbabilities(
  initial: InitialOdds,
  ctx: MatchContext,
): { home: number; draw: number; away: number; lambdaHomeRem: number; lambdaAwayRem: number } {
  // 时间衰减：计算剩余期望进球数
  const decayFactor = timeDecayFactor(ctx.minute, ctx.totalMatchMinutes, ctx.timeDecayExponent)
  const lambdaHomeRem = initial.lambdaHome * decayFactor
  const lambdaAwayRem = initial.lambdaAway * decayFactor

  // 当前比分差
  const d = ctx.homeGoals - ctx.awayGoals

  // 使用 Skellam 分布计算
  const { home, draw, away } = calculateWinProbabilities(d, lambdaHomeRem, lambdaAwayRem, ctx.maxGoals)

  return { home, draw, away, lambdaHomeRem, lambdaAwayRem }
}

/**
 * 计算实时让球盘概率
 */
export function calculateLiveHandicapProbabilities(
  initial: InitialOdds,
  ctx: MatchContext,
  handicap: number,
): { home: number; away: number; push: number; lambdaHomeRem: number; lambdaAwayRem: number } {
  const decayFactor = timeDecayFactor(ctx.minute, ctx.totalMatchMinutes, ctx.timeDecayExponent)
  const lambdaHomeRem = initial.lambdaHome * decayFactor
  const lambdaAwayRem = initial.lambdaAway * decayFactor

  const d = ctx.homeGoals - ctx.awayGoals
  const { home, away, push } = calculateHandicapProbabilities(d, lambdaHomeRem, lambdaAwayRem, handicap, ctx.maxGoals)

  return { home, away, push, lambdaHomeRem, lambdaAwayRem }
}
