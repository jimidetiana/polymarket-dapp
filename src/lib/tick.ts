/**
 * 价格精度（tick size）。
 *
 * ## 为什么不能写死
 *
 * CLOB 的 tick size 是**每个市场各自不同**的，只有四个合法值：
 * 0.1 / 0.01 / 0.001 / 0.0001（见 clob-client 的 `TickSize` 类型）。
 * 必须调 `getTickSize(tokenId)` 问市场，不能假定。
 *
 * 实测（2026-09 抽查足球盘口 30 个）：26 个 tick=0.01，4 个 tick=0.001，
 * 而且**同一场比赛的不同盘口 tick 可以不一样**（Chelsea vs Barcelona 两种都有）。
 * 0.001 档的真实报价就是三位小数：bid=0.155 / ask=0.175、bid=0.945 / ask=0.955。
 *
 * ## 写死 0.01 的代价
 *
 * 在 bid=0.155 / ask=0.175 这一档（点差 2 分），想在买价上方挂一档：
 * 正确做法是挂 0.156，而 0.01 精度只能挂 0.16 —— 白让 0.4 分。
 * 对照实测抽水量（赛前约 1.5pp），半个 tick 的让价不是小数目。
 *
 * ## 内部一律用整数
 *
 * 价格以 **tick 为单位的整数** 存储与运算，不用浮点。
 * 因为 `0.155 * 100 = 15.499999999999998`，`0.07 * 100 = 7.000000000000001`,
 * 浮点乘除会在边界上产生 off-by-one 的挂价。
 * 只在展示和提交给 API 的最后一步转成小数。
 */

/** CLOB 支持的四档精度。字符串形式与 clob-client 的 TickSize 一致 */
export type TickSize = '0.1' | '0.01' | '0.001' | '0.0001'

export const TICK_SIZES: readonly TickSize[] = ['0.1', '0.01', '0.001', '0.0001']

/** 兜底精度。取 0.01 而不是更细：猜细了会被 CLOB 拒单，猜粗了只是少赚 */
export const DEFAULT_TICK: TickSize = '0.01'

/** tick 字符串 → 小数位数。'0.001' → 3 */
export function tickDecimals(tick: TickSize): number {
  const dot = tick.indexOf('.')
  return dot < 0 ? 0 : tick.length - dot - 1
}

/** tick 字符串 → 一个价格单位等于多少个最小整数步。'0.001' → 1000 */
export function tickScale(tick: TickSize): number {
  return 10 ** tickDecimals(tick)
}

/**
 * 小数价 → 整数步。0.155 @ tick=0.001 → 155
 *
 * 用 Math.round 而不是截断：0.155*1000 在浮点下是 154.99999999999997，
 * 截断会得到 154（差一个 tick）。
 */
export function toSteps(price: number, tick: TickSize): number {
  return Math.round(price * tickScale(tick))
}

/** 整数步 → 小数价。155 @ tick=0.001 → 0.155 */
export function fromSteps(steps: number, tick: TickSize): number {
  return steps / tickScale(tick)
}

/**
 * 合法价格区间，**闭区间**。
 *
 * 规则来自 clob-client 的 `priceValid`：
 *   price >= tickSize && price <= 1 - tickSize
 *
 * 所以 tick=0.01 → [0.01, 0.99]，tick=0.001 → [0.001, 0.999]。
 * 注意这不是「1~99 分」——把区间写死成 1~99 只对 tick=0.01 成立。
 */
export function priceBounds(tick: TickSize): { min: number; max: number } {
  const t = parseFloat(tick)
  return { min: t, max: 1 - t }
}

/** 同上，但返回整数步，供输入框的 min/max 用 */
export function stepBounds(tick: TickSize): { minSteps: number; maxSteps: number } {
  const scale = tickScale(tick)
  return { minSteps: 1, maxSteps: scale - 1 }
}

/**
 * 价格是否可下单。与 clob-client 的 priceValid 同一口径，外加步进检查。
 *
 * 官方的 priceValid 只校验range，**不校验步进** —— 但 tick=0.01 的市场挂
 * 0.155 会被拒。所以这里多加一层，让前端能在提交前就拦住，而不是等 API 报错。
 */
export function isPriceValid(price: number, tick: TickSize): boolean {
  const { min, max } = priceBounds(tick)
  if (!(price >= min && price <= max)) return false
  // 步进：转成整数步再转回来，能对上才说明落在网格上
  const steps = toSteps(price, tick)
  return Math.abs(fromSteps(steps, tick) - price) < 1e-9
}

/** 把任意价格吸附到最近的合法网格点，并夹进区间 */
export function snapToTick(price: number, tick: TickSize): number {
  const { minSteps, maxSteps } = stepBounds(tick)
  const steps = Math.min(maxSteps, Math.max(minSteps, toSteps(price, tick)))
  return fromSteps(steps, tick)
}

/**
 * 整数步 → 定点小数字符串。不经过浮点格式化。
 *
 * 155 @ scale=1000 → "0.155"。做法是补零后插小数点，纯字符串操作，
 * 所以不可能出现 toFixed 那种「值本身是 0.1549999 于是舍成 0.15」的问题。
 */
function stepsToFixedString(steps: number, decimals: number): string {
  const neg = steps < 0
  const s = String(Math.abs(steps)).padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  const frac = decimals > 0 ? '.' + s.slice(s.length - decimals) : ''
  return (neg ? '-' : '') + int + frac
}

/**
 * 按 tick 精度格式化价格，用于展示。
 *
 * **必须与算术走同一条整数步路径**，不能直接 toFixed。实测：
 *   Math.round(0.155 * 100) = 16   → 0.16
 *   (0.155).toFixed(2)             → "0.15"
 * 两条路径在 0.155 上就分叉了（因为 0.155 的真值是 0.15499999999999999889，
 * 而 0.155*100 恰好等于 15.5）。若展示用 toFixed、下单用 toSteps，
 * 界面会显示 0.15 而实际提交 0.16 —— 对钱来说这是不能接受的。
 *
 * 另一层意义：tick=0.001 的市场必须显示三位，不能舍到分 ——
 * 那会让 0.155 和 0.156 在界面上看起来一样，而它们是两个不同的挂单价。
 */
export function formatTickPrice(price: number | null | undefined, tick: TickSize): string {
  if (price == null || !Number.isFinite(price)) return '—'
  return stepsToFixedString(toSteps(price, tick), tickDecimals(tick))
}

/**
 * 概率百分比展示。同样走整数步：0.001 档 → 15.5%，0.01 档 → 16%。
 *
 * 百分比的小数位 = tick 小数位 − 2（×100 相当于左移两位）。
 * tick=0.01 → 0 位；tick=0.001 → 1 位；tick=0.0001 → 2 位。
 */
export function formatTickPercent(price: number | null | undefined, tick: TickSize): string {
  if (price == null || !Number.isFinite(price)) return '—'
  const dp = Math.max(0, tickDecimals(tick) - 2)
  // 先转成 tick 网格上的整数步，再按「百分比小数位」重新定点，
  // 全程不做浮点乘法
  const steps = toSteps(price, tick)
  const shift = tickDecimals(tick) - 2 - dp // 需要丢掉的位数（tick=0.01 时为 0）
  const scaled = shift > 0 ? Math.round(steps / 10 ** shift) : steps
  return `${stepsToFixedString(scaled, dp)}%`
}
