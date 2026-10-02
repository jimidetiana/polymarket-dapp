/**
 * 挂单列表的**对账**：把页面上那份快照与交易所刚返回的那份比一比。
 *
 * ## 为什么需要它
 *
 * 挂单是按需点开的**一次性快照**，而挂单在交易所那边随时会成交。快照放久了，界面上
 * 那行「未成交」就可能早已成交 —— 这时点「撤单」撤的是一笔已经不存在的单，而旧代码
 * **不看交易所怎么回答**：把回执字符串当成功提示（绿色）显示，再把那行从本地数组里
 * 删掉。于是「显示撤销成功、实际早已买入」，用户以为没买到、又买一次，**重复买入**。
 * 实测踩过这个坑，这是本模块存在的唯一理由。
 *
 * 所以现在：撤单和刷新都**以交易所返回的那份为准**，并用这里的对账结果把差异说出来。
 * 对账只回答「变了什么」，文案由 describeDiff 给 —— 判据与措辞分开，判据才测得住。
 *
 * 纯逻辑，**不 import @polymarket/client**（只借它的行类型，`import type` 在运行时会被
 * 擦掉）。所以这个文件能单独跑测试，不必把 300 kB 的 SDK 拖进测试环境。
 */
import type { OpenOrderRow } from './clob-client'
import { tr } from './i18n'

export type OpenOrderDiff = {
  /** 上一份里有、交易所这份里没有了的：已成交、或已被（别处）撤销 */
  gone: OpenOrderRow[]
  /** 成交量变多了的，带上新成交的份额 */
  filled: Array<{ order: OpenOrderRow; addedShares: number }>
}

/** 挂单的数量字段是字符串（DecimalString）。解析不出来按 0 算，不让 NaN 传染判据。 */
function num(s: string | undefined): number {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/** 份额去掉无意义的尾零：5 而不是 5.0000 */
export function formatShares(n: number): string {
  return String(Number(n.toFixed(4)))
}

/**
 * 对账。
 *
 * `ignoreIds` 放「消失是预期结果」的那些 id —— 刚撤成功的那笔必然从列表里消失，
 * 把它报成「数据异常」就成了狼来了，真异常反而被淹掉。
 */
export function diffOpenOrders(
  prev: readonly OpenOrderRow[],
  next: readonly OpenOrderRow[],
  ignoreIds: readonly string[] = [],
): OpenOrderDiff {
  const skip = new Set(ignoreIds)
  const byId = new Map(next.map((o) => [o.id, o]))
  const gone: OpenOrderRow[] = []
  const filled: Array<{ order: OpenOrderRow; addedShares: number }> = []
  for (const o of prev) {
    if (skip.has(o.id)) continue
    const now = byId.get(o.id)
    if (!now) {
      gone.push(o)
      continue
    }
    const added = num(now.sizeMatched) - num(o.sizeMatched)
    if (added > 0) filled.push({ order: now, addedShares: added })
  }
  return { gone, filled }
}

export function hasDiff(d: OpenOrderDiff): boolean {
  return d.gone.length > 0 || d.filled.length > 0
}

/**
 * 把对账结果翻成给人看的警告。没差异返回 null（调用方据此决定要不要报）。
 *
 * 措辞要说清**后果**（可能已经买到了）和**该做什么**（先核对持仓/成交再下单），
 * 而不只是「数据已更新」—— 用户真正要避免的是重复买入。
 */
export function describeDiff(d: OpenOrderDiff): string | null {
  if (!hasDiff(d)) return null
  const parts: string[] = []
  if (d.gone.length) {
    parts.push(
      tr(
        `${d.gone.length} 笔挂单已不在交易所（已成交或已被撤销）`,
        `${d.gone.length} open order(s) are gone from the exchange (filled or cancelled)`,
      ),
    )
  }
  if (d.filled.length) {
    const shares = d.filled.reduce((n, f) => n + f.addedShares, 0)
    parts.push(
      tr(
        `${d.filled.length} 笔挂单又成交了 ${formatShares(shares)} 份`,
        `${d.filled.length} open order(s) matched ${formatShares(shares)} more share(s)`,
      ),
    )
  }
  return tr(
    `挂单数据异常：页面上这份已经过期 —— ${parts.join('；')}。已按交易所最新数据刷新，` +
      `请先核对下面的「持仓 / 成交」再下单，避免重复买入。`,
    `Open orders out of sync: the list on screen was stale — ${parts.join('; ')}. ` +
      `It has been refreshed from the exchange; check "Positions / Trades" below before placing another order so you don't buy twice.`,
  )
}
