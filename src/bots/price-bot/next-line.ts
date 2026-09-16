/**
 * 「进球后该不该开下一档」的纯决策。
 *
 * ## 为什么需要它
 *
 * 递进机制原本是无条件的：完结 Over K.5 就建 Over (K+1).5 并启动监控。
 * 实测样本（46 场已结算的 goal_surge 实单）显示这条链有资金自杀倾向——
 * 赢一次赚约 $0.50，错一次亏约 $4.40，要 9 次赢才抵 1 次错，
 * 而足球场均只有 2.5 球。最高只做到 2.5 档的那一组是唯一净亏的分组（−$2.57）。
 *
 * 亏损的形态几乎都一样：**买的是「还没打出的下一档」**。
 * 进球瞬间所有档位同涨（Over 3.5 也会从 0.05 抬到 0.09），
 * 于是刚开的下一档立刻出现「涨幅达标」的假信号，按 0.85~0.90 接进去，
 * 赌的是「还会再进一个」，而市场给的价格是「已经进了」。
 *
 * ## 这个模块判断什么
 *
 * 只判断**开不开监控**，不判断**买不买**。两者必须分开：
 *
 * - 开监控：便宜、可逆、不动钱。宁可多开也别漏掉真进球。
 * - 买入：动钱、不可逆。买入的闸门是比分（见 buyGateReason），
 *   而不是这里的任何一条价格判断。
 *
 * 所以本模块只挡「结构上没戏」的档位：盘口过薄、初盘就极低、
 * 剩余时间里公平概率已经低到不值得盯。对「此刻价格明显贵于公平价」
 * 这种情况，它照开，但给一个冷却窗口，让那波余震涨幅无法立刻触发买入信号。
 *
 * ## 公平价怎么算
 *
 * λ 从**初盘 Over 2.5** 反推，而不是从 1X2 反推：大小球的 λ 直接由
 * 大小球盘口定价，绕道 1X2 会引入让球方向的噪音。
 *
 *   P(总进球 ≥ 3) = 1 − PoissonCDF(2, λ)   → 二分法求 λ
 *   λ_剩余 = λ_全场 × timeDecayFactor(分钟)
 *   P(再进 n 球) = 1 − PoissonCDF(n−1, λ_剩余)
 *
 * 注意 n 是**还需要几个球**，不恒为 1。正常递进（每档打出后接下一档）
 * n 恒为 1；若比分落后于档位（例如只进了 1 球就跳去开 2.5），n 会是 2，
 * 公平价立刻掉下来——这正是要抓的「跳档」错误。
 */

import { poissonCdf, timeDecayFactor } from '../value-bot/math-utils.js'
import { MATCH_TOTAL_MINUTES, nextTotalGoalLine } from './goal-lines.js'

/** 开档决策的判据代号，落库/前端按它区分原因，不依赖中文文案 */
export type NextLineReasonCode =
  /** 已是最高档，或当前档位不合法 */
  | 'no_next_line'
  /** 比分源还没到该档位要求的球数：递进依据不足 */
  | 'score_behind'
  /** 没有初盘快照，算不出公平价 —— 照开，但不授权 */
  | 'no_snapshot'
  /** 下一档盘口过薄（价差过宽） */
  | 'thin_book'
  /** 该档初盘就极低：这场比赛的进球分布压根不到这个档位 */
  | 'cheap_kickoff'
  /** 剩余时间里公平概率已低于阈值 */
  | 'low_fair_prob'
  /** 此刻盘口价明显高于公平价：更低档的涨幅影子，给冷却 */
  | 'shadow_hot'
  /** 通过所有闸门 */
  | 'ok'

export interface NextLineDecision {
  /** 是否创建并启动下一档监控 */
  open: boolean
  reasonCode: NextLineReasonCode
  /** 人话理由，直接进接口响应与前端提示 */
  reason: string
  /** 下一档线；无下一档时为 null */
  nextLine: number | null
  /** 从初盘 Over 2.5 反推的全场期望总进球 */
  lambdaFull: number | null
  /** 剩余时间的期望进球 */
  lambdaRemaining: number | null
  /** 还需要几个球才能打出下一档 */
  goalsNeeded: number | null
  /** 公平价：剩余时间里再进 goalsNeeded 球的概率 */
  fairProb: number | null
  /** 用于比较的盘口价（bid 优先） */
  marketPrice: number | null
  /**
   * 开档后的买入静默毫秒数。>0 表示这段时间内不得触发买入信号——
   * 刚完结那一刻的涨幅属于上一档，不是这一档的进球。
   */
  cooldownMs: number
}

export interface NextLineInput {
  /** 刚完结的档位（0.5 / 1.5 / ...） */
  settledLine: number | null
  /** 初盘 Over 2.5 的价格；缺失则算不出 λ */
  kickoffOver25: number | null
  /** 初盘该下一档自身的价格；有则优先于用 λ 推算 */
  kickoffNextOver?: number | null
  /** 下一档此刻的买价 */
  bestBid?: number | null
  /** 下一档此刻的卖价 */
  bestAsk?: number | null
  /** 当前比赛分钟；null = 未知（不做时间衰减） */
  minute?: number | null
  /**
   * 当前双方总进球；null = 未知。
   *
   * 未知时按「上一档已打出」推断下限（settledLine 向上取整），
   * 这与人工点完结的语义一致：你看到进球才点的。
   */
  totalGoals?: number | null
  params?: Partial<NextLineParams>
}

export interface NextLineParams {
  /** 下一档最大可接受价差，超过判薄盘 */
  maxSpread: number
  /** 该档初盘价下限：低于它说明这场比赛压根不到这个档位 */
  minKickoffOver: number
  /** 公平概率下限：低于它不值得占用一条监控 */
  minFairProb: number
  /** 盘口价高于公平价多少算「更低档的影子」 */
  shadowGap: number
  /** 普通开档的买入静默毫秒 */
  cooldownMs: number
  /** 判为影子时的买入静默毫秒 */
  shadowCooldownMs: number
  /** 比赛名义总时长 */
  totalMinutes: number
}

export const DEFAULT_NEXT_LINE_PARAMS: NextLineParams = {
  // 与 AutoTradeParams.maxSpread 同量级：0.10 已是正常价差的数倍。
  maxSpread: 0.12,
  // λ=2.7 时 Over 4.5 初盘约 0.14，Over 3.5 约 0.29。取 0.10 只挡真正没戏的档位：
  // 样本里最高做到 4.5 的 3 场净赚 $4.75 且零亏损，不能把 4.5 一刀切掉。
  minKickoffOver: 0.1,
  // 0.30：再进一球的概率不足三成时，这条监控占的是额度不是机会。
  minFairProb: 0.3,
  // 0.12：实测亏损单的溢价都在 0.12 以上（塞尔塔 0.90 vs 公平 0.66，
  // 清水心跳 0.69 vs 公平 0.42），而 minute 10 的 0.88 vs 公平 0.91 是公平的。
  shadowGap: 0.12,
  // 8s：覆盖 goalSurgeDefaults.surgeWindowMs，让上一档的涨幅滑出递增窗口。
  cooldownMs: 8_000,
  // 判为影子时静默更久：此刻的高价本身就是余震，等它落定再谈。
  shadowCooldownMs: 60_000,
  totalMinutes: MATCH_TOTAL_MINUTES,
}

/**
 * 从初盘 Over 2.5 价格反推全场期望总进球 λ。
 *
 * P(总进球 ≥ 3) = 1 − PoissonCDF(2, λ)，对 λ 单调递增，二分即可。
 * 价格不在 (0,1) 开区间内时返回 null——0 和 1 对应 λ=0 和 λ=∞，都不可用。
 */
export function inferLambdaFromOver25(over25: number | null | undefined): number | null {
  if (over25 == null) return null
  const target = Number(over25)
  if (!Number.isFinite(target) || target <= 0 || target >= 1) return null

  let lo = 0.05
  let hi = 8
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const p = 1 - poissonCdf(2, mid)
    if (p < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * 剩余时间里再进 goalsNeeded 个球的概率。
 *
 * minute 为 null 时不做衰减（按全场 λ 算），这是刻意的宽松侧：
 * 算不出时间就别拿时间去否决一个档位。
 */
export function fairNextGoalProb(
  lambdaFull: number | null,
  goalsNeeded: number,
  minute: number | null | undefined,
  totalMinutes: number = MATCH_TOTAL_MINUTES,
): { fairProb: number; lambdaRemaining: number } | null {
  if (lambdaFull == null || !Number.isFinite(lambdaFull) || lambdaFull <= 0) return null
  if (!Number.isFinite(goalsNeeded) || goalsNeeded < 1) return null

  const decay = minute == null ? 1 : timeDecayFactor(minute, totalMinutes)
  const lambdaRemaining = lambdaFull * decay
  if (lambdaRemaining <= 0) return { fairProb: 0, lambdaRemaining: 0 }

  const fairProb = 1 - poissonCdf(goalsNeeded - 1, lambdaRemaining)
  return { fairProb, lambdaRemaining }
}

/** 该档初盘价的推算值：P(总进球 ≥ line+0.5) */
export function impliedOverPrice(lambdaFull: number | null, line: number): number | null {
  if (lambdaFull == null || lambdaFull <= 0) return null
  const need = Math.round(line + 0.5) // 2.5 → 需要 3 球
  if (need < 1) return null
  return 1 - poissonCdf(need - 1, lambdaFull)
}

/**
 * 买入信号是否仍在静默期内。
 *
 * 抽成纯函数是为了能单独测：真实调用点在 stepGoalSurge 里，
 * 而那条路径要连数据库，今晚跑不了。
 *
 * mutedUntil 为空表示从未设过静默，直接放行。
 */
export function isSurgeMuted(
  mutedUntil: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (mutedUntil == null) return false
  return now < mutedUntil
}

/**
 * 叠加静默期：取较晚者，不缩短已有的静默。
 *
 * 同一条规则可能被多次设静默（例如先普通开档、随后人工又点了一次完结），
 * 后一次若更短，不能把前一次的保护缩掉。
 */
export function extendMuteUntil(
  current: number | null | undefined,
  durationMs: number,
  now: number = Date.now(),
): number | undefined {
  if (!(durationMs > 0)) return current ?? undefined
  return Math.max(current ?? 0, now + durationMs)
}

/**
 * 买入闸门：只有比分真把这条线打出来了才允许买。
 *
 * 返回 null 表示放行，非 null 是拒绝理由。这是本文件里唯一与「动钱」
 * 相关的判断，也是样本里能把 8 笔亏损全部挡住的唯一判据——
 * 7/8 的亏损场次总进球 ≤ 2，另 1 场是跳档买入。
 *
 * 比分未知时**拒绝**（与开档相反）：开档错了只是多占一条监控，
 * 买错了是全额亏损，两侧的默认值必须不同。
 */
export function buyGateReason(
  line: number,
  totalGoals: number | null | undefined,
): string | null {
  const need = Math.round(line + 0.5)
  if (totalGoals == null) return `比分未知，无法确认 Over ${line} 已打出（需 ${need} 球）`
  if (totalGoals < need) {
    return `当前 ${totalGoals} 球 < Over ${line} 所需 ${need} 球，该线尚未打出`
  }
  return null
}

/**
 * 决定要不要为下一档开监控。纯函数，不读库不发请求。
 *
 * 判据顺序是刻意的：先排除「无从判断」的情况（无下一档 / 比分落后 /
 * 无初盘），再走价格闸门。无初盘时照开——今晚连不上交易所也要能递进，
 * 只是决策会标 no_snapshot 且不授权买入。
 */
export function decideNextLineOpening(input: NextLineInput): NextLineDecision {
  const p = { ...DEFAULT_NEXT_LINE_PARAMS, ...(input.params ?? {}) }
  const nextLine = nextTotalGoalLine(input.settledLine)

  const base: NextLineDecision = {
    open: false,
    reasonCode: 'ok',
    reason: '',
    nextLine,
    lambdaFull: null,
    lambdaRemaining: null,
    goalsNeeded: null,
    fairProb: null,
    marketPrice: input.bestBid ?? null,
    cooldownMs: 0,
  }

  if (nextLine == null) {
    return {
      ...base,
      reasonCode: 'no_next_line',
      reason:
        input.settledLine == null
          ? '无法识别当前盘口的总进球数线'
          : `${input.settledLine} 已是最高档，无下一档`,
    }
  }

  // 比分下限：人工点完结的语义是「我看到这一档打出了」，
  // 所以未知时按 settledLine 已打出来推断，而不是当 0 球。
  const assumedGoals = input.totalGoals ?? Math.round(input.settledLine! + 0.5)
  const settledNeed = Math.round(input.settledLine! + 0.5)
  if (assumedGoals < settledNeed) {
    return {
      ...base,
      reasonCode: 'score_behind',
      reason:
        `当前 ${assumedGoals} 球 < 已完结的 Over ${input.settledLine} 所需 ${settledNeed} 球，` +
        `比分源落后于完结动作，先不递进`,
    }
  }

  // 还需要几个球：正常递进恒为 1；跳档（比分落后于目标档）会 ≥2，公平价随之下掉
  const goalsNeeded = Math.max(1, Math.round(nextLine + 0.5) - assumedGoals)
  base.goalsNeeded = goalsNeeded

  const lambdaFull = inferLambdaFromOver25(input.kickoffOver25)
  base.lambdaFull = lambdaFull

  if (lambdaFull == null) {
    return {
      ...base,
      open: true,
      reasonCode: 'no_snapshot',
      reason:
        `缺初盘 Over 2.5 快照，无法计算公平价：已开 Over ${nextLine} 监控但不授权下单，` +
        `买入仍需比分打出该线`,
      cooldownMs: p.cooldownMs,
    }
  }

  const fair = fairNextGoalProb(lambdaFull, goalsNeeded, input.minute, p.totalMinutes)
  base.lambdaRemaining = fair?.lambdaRemaining ?? null
  base.fairProb = fair?.fairProb ?? null

  // 盘口过薄：价差本身标记薄盘，那种盘口上的价格不能拿来做任何判断
  const bid = input.bestBid ?? null
  const ask = input.bestAsk ?? null
  if (bid != null && ask != null && ask > bid) {
    const spread = ask - bid
    if (spread > p.maxSpread) {
      return {
        ...base,
        reasonCode: 'thin_book',
        reason: `Over ${nextLine} 买卖价差 ${spread.toFixed(4)} > 上限 ${p.maxSpread}，盘口过薄`,
      }
    }
  }

  // 初盘形态：该档在开哨时就极低，说明这场比赛的进球分布压根不到这里。
  // 优先用实测初盘价，缺失时用 λ 推算（两者都写进理由，便于事后对账）。
  const measuredKickoff = input.kickoffNextOver ?? null
  const derivedKickoff = impliedOverPrice(lambdaFull, nextLine)
  const kickoffNext = measuredKickoff ?? derivedKickoff
  if (kickoffNext != null && kickoffNext < p.minKickoffOver) {
    return {
      ...base,
      reasonCode: 'cheap_kickoff',
      reason:
        `Over ${nextLine} 初盘价 ${kickoffNext.toFixed(3)}` +
        `（${measuredKickoff != null ? '实测' : `由 λ=${lambdaFull.toFixed(2)} 推算`}）` +
        `< 下限 ${p.minKickoffOver}，这场比赛的进球分布不到这个档位`,
    }
  }

  // 剩余时间的公平概率：低到一定程度就不值得占监控额度。
  // 这一条同时覆盖「比赛已结束」（衰减为 0 → 公平价 0）。
  if (fair != null && fair.fairProb < p.minFairProb) {
    const minuteTxt = input.minute == null ? '分钟未知' : `第 ${input.minute.toFixed(0)} 分钟`
    return {
      ...base,
      reasonCode: 'low_fair_prob',
      reason:
        `${minuteTxt}，再进 ${goalsNeeded} 球的公平概率 ${(fair.fairProb * 100).toFixed(1)}%` +
        ` < 下限 ${(p.minFairProb * 100).toFixed(0)}%（λ剩余=${fair.lambdaRemaining.toFixed(2)}）`,
    }
  }

  // 此刻价格远高于公平价 = 上一档涨幅的影子。照开，但静默更久：
  // 不开会漏掉后面的真进球，立刻买则正是样本里那几笔亏损的形态。
  if (fair != null && bid != null && bid - fair.fairProb > p.shadowGap) {
    return {
      ...base,
      open: true,
      reasonCode: 'shadow_hot',
      reason:
        `Over ${nextLine} 现价 ${bid.toFixed(3)} 高于公平价 ` +
        `${fair.fairProb.toFixed(3)} 达 ${(bid - fair.fairProb).toFixed(3)}——` +
        `这是上一档涨幅的影子。已开监控并静默 ${Math.round(p.shadowCooldownMs / 1000)}s，` +
        `此价位不要授权下单`,
      cooldownMs: p.shadowCooldownMs,
    }
  }

  const fairTxt = fair != null ? `公平价 ${fair.fairProb.toFixed(3)}` : '公平价不可用'
  return {
    ...base,
    open: true,
    reasonCode: 'ok',
    reason:
      `已开 Over ${nextLine} 监控（${fairTxt}，现价 ${bid != null ? bid.toFixed(3) : '未知'}，` +
      `λ全场=${lambdaFull.toFixed(2)}）。买入仍需比分打出该线`,
    cooldownMs: p.cooldownMs,
  }
}
