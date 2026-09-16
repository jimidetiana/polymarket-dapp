/**
 * 概率价 ↔ 赔率的换算与显示。
 *
 * Polymarket 的价格本身就是**隐含概率**（0~1，赢了每份赔 1 美元），
 * 所以欧赔（十进制赔率）就是 1/价格：花 0.55 买一份、赢了收 1，赔率 1.82。
 *
 * ## 为什么两侧各自换算，而不是只换一个数
 *
 * 节点上「卖」是你买入要付的价、「买」是你卖出能收的价。换成赔率后各自
 * 仍是那一侧的赔率：卖价 0.55 → 你买入的赔率 1.82；买价 0.49 → 1/0.49 = 2.04。
 * 两个赔率之间的差就是点差在赔率口径下的样子，不能合成一个数。
 *
 * ## 为什么不做美式赔率
 *
 * 中文足球语境里「赔率」默认指欧赔。美式赔率在 p=0.5 附近会跳符号
 * （+100 / −100），在这张图上并排显示会更难读。要的话再加。
 *
 * 这个模块是纯函数、无 DOM 依赖，可以直接用 node 测试跑：
 *   npx tsx --test frontend/src/lib/odds.test.ts
 */

export type PriceMode = 'prob' | 'odds'

/** 显示上限。超过这个赔率的盘口本来也没有实际交易意义，截断以免撑破圆形 */
const ODDS_CAP = 999

/**
 * 概率 → 欧赔。返回 null 表示换算不出来（不是 0，也不是 ∞）。
 *
 * p <= 0 在数学上对应无穷大赔率，但那不是一个能显示的数，也不是一个
 * 能成交的盘口——返回 null 让调用方显示「—」，不要显示 Infinity 或 0。
 */
export function toDecimalOdds(price: number | null | undefined): number | null {
  if (price == null || !Number.isFinite(price)) return null
  if (price <= 0 || price > 1) return null
  return 1 / price
}

/**
 * 赔率的显示位数按量级递减：小赔率要精度，大赔率精度没意义且占宽度。
 * 1.82 / 12.5 / 250 / 999+
 */
export function formatOdds(price: number | null | undefined): string {
  const o = toDecimalOdds(price)
  if (o == null) return '—'
  if (o > ODDS_CAP) return `${ODDS_CAP}+`
  if (o >= 100) return o.toFixed(0)
  if (o >= 10) return o.toFixed(1)
  return o.toFixed(2)
}

/** 概率显示。与 utils.formatPercent 同口径，放在这里是为了让两种模式对称 */
export function formatProb(price: number | null | undefined): string {
  if (price == null || !Number.isFinite(price)) return '—'
  return `${(price * 100).toFixed(1)}%`
}

/** 按当前模式格式化一侧的价格 */
export function formatPrice(price: number | null | undefined, mode: PriceMode): string {
  return mode === 'odds' ? formatOdds(price) : formatProb(price)
}

/** 模式切换按钮上的文字 */
export const PRICE_MODE_LABEL: Record<PriceMode, string> = {
  prob: '概率 %',
  odds: '欧赔',
}
