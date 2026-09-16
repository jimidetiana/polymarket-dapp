/**
 * 数学工具函数 - 泊松分布、Skellam 分布、阶乘等
 */

const factorialCache: number[] = [1, 1]

/** 计算阶乘 n!，带缓存 */
export function factorial(n: number): number {
  if (n < 0) return NaN
  if (n < factorialCache.length) return factorialCache[n]
  let result = factorialCache[factorialCache.length - 1]
  for (let i = factorialCache.length; i <= n; i++) {
    result *= i
    factorialCache[i] = result
  }
  return result
}

/**
 * 泊松分布 PMF: P(X = k; λ) = λ^k * e^(-λ) / k!
 */
export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || lambda <= 0) return 0
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k)
}

/**
 * 泊松分布 CDF: P(X ≤ k; λ) = Σ_{i=0}^{k} P(X = i; λ)
 */
export function poissonCdf(k: number, lambda: number): number {
  let sum = 0
  for (let i = 0; i <= k; i++) {
    sum += poissonPmf(i, lambda)
  }
  return sum
}

/**
 * Skellam 分布 PMF: P(Δ = k; λ1, λ2)
 * Δ = X - Y, X ~ Poisson(λ1), Y ~ Poisson(λ2)
 *
 * 使用直接求和法（避免贝塞尔函数）:
 * P(Δ = k) = Σ_{y=max(0,-k)}^{maxGoals} P(X = y+k; λ1) * P(Y = y; λ2)
 */
export function skellamPmf(k: number, lambda1: number, lambda2: number, maxGoals = 10): number {
  let sum = 0
  const startY = Math.max(0, -k)
  for (let y = startY; y <= maxGoals; y++) {
    const x = y + k
    if (x < 0) continue
    sum += poissonPmf(x, lambda1) * poissonPmf(y, lambda2)
  }
  return sum
}

/**
 * 计算当前比分差 d 下的胜/平/负概率（使用 Skellam 分布）
 *
 * @param d 当前比分差 = homeGoals - awayGoals
 * @param lambdaHome 剩余主队期望进球数
 * @param lambdaAway 剩余客队期望进球数
 * @param maxGoals 最大进球数（截断）
 */
export function calculateWinProbabilities(
  d: number,
  lambdaHome: number,
  lambdaAway: number,
  maxGoals = 10,
): { home: number; draw: number; away: number } {
  let homeProb = 0
  let drawProb = 0
  let awayProb = 0

  // 需要剩余进球差 Δ 使最终主队胜: d + Δ > 0, 即 Δ > -d, 即 Δ >= -d + 1
  // 平: d + Δ = 0, 即 Δ = -d
  // 客胜: d + Δ < 0, 即 Δ < -d, 即 Δ <= -d - 1

  for (let k = -maxGoals; k <= maxGoals; k++) {
    const prob = skellamPmf(k, lambdaHome, lambdaAway, maxGoals)
    if (d + k > 0) {
      homeProb += prob
    } else if (d + k === 0) {
      drawProb += prob
    } else {
      awayProb += prob
    }
  }

  // 归一化（截断误差）
  const total = homeProb + drawProb + awayProb
  if (total > 0) {
    homeProb /= total
    drawProb /= total
    awayProb /= total
  }

  return { home: homeProb, draw: drawProb, away: awayProb }
}

/**
 * 亚洲让球盘概率计算
 *
 * @param d 当前比分差 = homeGoals - awayGoals
 * @param lambdaHome 剩余主队期望进球数
 * @param lambdaAway 剩余客队期望进球数
 * @param handicap 让球线（主队视角，负值=主队让球，如 -0.5 表示主队让0.5球）
 * @param maxGoals 最大进球数
 * @returns { home: 有效胜率, away: 有效胜率 }
 */
export function calculateHandicapProbabilities(
  d: number,
  lambdaHome: number,
  lambdaAway: number,
  handicap: number,
  maxGoals = 10,
): { home: number; away: number; push: number } {
  let homeWin = 0
  let awayWin = 0
  let push = 0
  let halfWin = 0
  let halfLose = 0

  for (let extraHome = 0; extraHome <= maxGoals; extraHome++) {
    for (let extraAway = 0; extraAway <= maxGoals; extraAway++) {
      const prob = poissonPmf(extraHome, lambdaHome) * poissonPmf(extraAway, lambdaAway)
      // 最终比分差 + 让球线
      const net = d + extraHome - extraAway + handicap

      if (net > 0) {
        if (Math.abs(net - 0.25) < 1e-9) {
          halfWin += prob
        } else {
          homeWin += prob
        }
      } else if (net < 0) {
        if (Math.abs(net + 0.25) < 1e-9) {
          halfLose += prob
        } else {
          awayWin += prob
        }
      } else {
        push += prob
      }
    }
  }

  // 有效胜率：半赢=0.5权重
  const effectiveHome = homeWin + 0.5 * halfWin
  const effectiveAway = awayWin + 0.5 * halfLose

  // 归一化
  const total = effectiveHome + effectiveAway + push
  if (total > 0) {
    return {
      home: effectiveHome / total,
      away: effectiveAway / total,
      push: push / total,
    }
  }

  return { home: 0.5, away: 0.5, push: 0 }
}

/**
 * 时间衰减因子: 计算剩余期望进球数比例
 *
 * @param minute 当前比赛分钟
 * @param totalMinutes 比赛总时长（默认90）
 * @param exponent 衰减指数（默认0.84）
 * @returns 剩余期望进球比例 (0~1)
 */
export function timeDecayFactor(
  minute: number,
  totalMinutes = 90,
  exponent = 0.84,
): number {
  if (minute <= 0) return 1
  if (minute >= totalMinutes) return 0
  const ratio = Math.pow(1 - minute / totalMinutes, exponent)
  return Math.max(0, Math.min(1, ratio))
}
