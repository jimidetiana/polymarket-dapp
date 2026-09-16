/**
 * 全场大小球盘口的「档位」识别与递进。
 *
 * 原本这套逻辑是 soccer/server.ts 里的私有函数，只能通过 HTTP 接口间接验证。
 * 抽出来是因为下一档开档决策（next-line.ts）也要用同一套档位定义，
 * 而「哪些盘口算全场大小球」是纯字符串判断，值得单独测。
 */

/** 大小球盘口的合法总进球数线；超过 4.5 的线几乎无成交，不纳入递进 */
export const TOTAL_GOAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5]

/** 递进的起点：批量创建只建这一档，更高的线等它打出后再接 */
export const FIRST_TOTAL_LINE = 0.5

/** 一场比赛的名义总时长（分钟），时间衰减与「还剩多久」都按它算 */
export const MATCH_TOTAL_MINUTES = 90

/** 盘口行里够用来识别档位的字段，DB 行和测试对象都能满足 */
export interface TotalLineMarketLike {
  question_en?: unknown
  question_zh?: unknown
  line?: unknown
}

/**
 * 只认「全场、双方合计」的大小球盘。其余一律返回 null。
 *
 * 线可能存在于两处：DB 的 line 列（DECIMAL，mysql2 返回字符串），
 * 或问题文本里的 "X.5"。平台并非所有大小球盘都填了 line 列，
 * 故两处都取候选值，任一命中白名单即算有效，避免把有效盘口误杀。
 *
 * 三类要排除的盘口，都会被 classifyMarketType 归成 total：
 *
 * 1. 角球盘（含 over/under 字样），平台上几乎无人交易。
 * 2. 半场/下半场盘。MARKET_TYPE_KEYWORDS 里 halftime/second_half 排在 total
 *    之前且先命中先返回，所以多数已被归成 halftime——但那依赖关键词写法，
 *    "Over/Under 1.5 in the first half" 这类词序就漏了，这里再兜一层。
 * 3. 单独一方球队的进球盘（"Will Arsenal score over 1.5 goals?"）。
 *    它和全场大小球的价格逻辑完全不同：进球方是谁决定它动不动，
 *    进球买入的前提「任意进球都推高价格」在这里不成立。
 */
export function extractTotalGoalLine(m: TotalLineMarketLike): number | null {
  const qEn = String(m.question_en ?? '').toLowerCase()
  const qZh = String(m.question_zh ?? '')

  if (qEn.includes('corner') || qZh.includes('角球')) return null

  // 半场盘：兜 classifyMarketType 因词序而漏掉的写法
  if (/half|1st h|2nd h/.test(qEn) || qZh.includes('半场')) return null

  // 单队盘：主语是某一队而不是整场比赛。平台上有两种写法。
  //
  // 1) 句子式："Will Arsenal score over 1.5 goals?"
  // 2) 标题式（实际数据里占绝大多数）：
  //      全场  "FK Liepaja vs. Riga FC: O/U 0.5"
  //      单队  "FK Liepaja vs. Riga FC: FK Liepaja O/U 0.5"
  //    两者的差别只在冒号后、O/U 之前是否还夹着一个队名。
  //
  // 早先只判了句子式，标题式的单队盘全部漏过去，导致一键批量创建
  // 每场比赛建了 3 条规则（全场 + 主队 + 客队）而不是 1 条。
  //
  // 所以标题式改成正面判定：取最后一个冒号之后的部分，它必须以 O/U
  // 或 Over/Under 开头才算全场盘。有队名夹在中间就不是。
  const colonIdx = qEn.lastIndexOf(':')
  if (colonIdx >= 0) {
    const tail = qEn.slice(colonIdx + 1).trim()
    // 冒号后有内容且不是以 o/u | over/under 开头 → 夹着队名，是单队盘
    if (tail && !/^(o\/u|over\/under|total)\b/.test(tail)) return null
  }

  const isMatchTotal =
    /total\s+goals/.test(qEn) ||
    /combined/.test(qEn) ||
    qZh.includes('总进球') ||
    // "A vs B: O/U 2.5" 这种标题式写法，冒号前是对阵双方
    /\bvs\.?\b.*\b(o\/u|over\/under)\b/.test(qEn)
  const looksTeamSpecific =
    /\bwill\s+.+\s+score\b/.test(qEn) || /\bto\s+score\s+(over|under)\b/.test(qEn)
  if (looksTeamSpecific && !isMatchTotal) return null

  const candidates: number[] = []
  if (m.line != null) {
    const n = Number(m.line)
    if (Number.isFinite(n)) candidates.push(n)
  }
  const qm = qEn.match(/(\d+\.5)(?!\d)/) // 大小球线恒为半整数：0.5/1.5/2.5...
  if (qm) candidates.push(Number(qm[1]))

  return candidates.find((n) => TOTAL_GOAL_LINES.includes(n)) ?? null
}

/** 递进的下一档；已是最高档或不是合法档位时返回 null */
export function nextTotalGoalLine(line: number | null | undefined): number | null {
  if (line == null) return null
  const idx = TOTAL_GOAL_LINES.indexOf(Number(line))
  if (idx < 0) return null
  return TOTAL_GOAL_LINES[idx + 1] ?? null
}

/**
 * 把时间戳解析成毫秒，**裸 DATETIME 串按 UTC 处理**。
 *
 * MySQL 的 DATETIME 取出来是 '2026-09-05 11:00:00' 这种不带时区后缀的串，
 * 而 Date.parse 对非 ISO 格式按**本机时区**解析。本机是 UTC+8，于是每个
 * 开哨时刻都被当成北京时间，算出的比赛分钟凭空多 480 分钟——比赛全都显示
 * 在第 540 分钟以后，早过了 90 分钟，衰减把公平价压成 0，递进判断于是
 * 一律 low_fair_prob 不开档。库里存的是 UTC（与 db.ts toIsoUtc 同口径：
 * 它给裸串补的是 Z），所以这里也必须补 Z 而不是交给本机时区。
 *
 * 已带 Z 或 ±HH:MM 后缀的原样解析，所以对 ISO 串是幂等的。
 */
export function parseUtcish(raw: string | Date | null | undefined): number | null {
  if (raw == null) return null
  if (raw instanceof Date) return raw.getTime()
  const s = String(raw).trim()
  if (!s) return null
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s)
  const t = Date.parse(hasZone ? s : `${s.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? t : null
}

/**
 * 从开哨时刻推算当前是比赛第几分钟。
 *
 * kickoff 用 soccer_events.end_time（那一列才是计划开哨时刻，start_time 是
 * 挂牌日期），取整到整点/半点，所以带最多 ±30 分钟误差。
 * 返回 null 表示算不出来——调用方必须把它当「未知」而不是 0。
 */
export function matchMinuteFrom(
  kickoff: string | Date | null | undefined,
  now: number = Date.now(),
): number | null {
  const t = parseUtcish(kickoff)
  if (t == null) return null
  const elapsed = (now - t) / 60_000
  if (elapsed < 0) return 0 // 还没开哨
  return elapsed
}
