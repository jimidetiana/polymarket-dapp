/**
 * 交易手续费的展示与计算。
 *
 * ## 这笔钱是什么
 *
 * 本项目的收入来自 Polymarket 的 Builder Program：我们注册一个 builder code，
 * 下单时挂上它，平台按归到我们名下的成交量抽一笔手续费。SDK 里对应的东西是
 * `BuilderFeeRates = { maker, taker }`，单位是**基点（bps）**，来自
 * `builder_maker_fee_rate_bps` / `builder_taker_fee_rate_bps`。
 *
 * 1 bps = 0.01%，所以 5 bps = 0.05%。**费率是我们自己定的，不是平台强制的。**
 *
 * ## 确认面板上少报手续费 = 少报自己的收入
 *
 * SDK 的文档写得很死：市价买的 `amount` 是 "Desired USD notional to buy,
 * **before market and builder taker fees**"，而 `maxSpend` 才是 "**all-in**
 * USD spend target, **including applicable fees**"。
 *
 * 也就是说 `份额 × 单价` 是**税前**的数。界面若把它标成「总额」，用户实际被扣
 * 的比看到的少 —— 少的那部分正是我们的手续费。用户发现的方式不会是想「平台
 * 收费了」，而是「这站骗我」。
 *
 * 挂上 builder code 之前这个 bug 不发作（费率 0，数字是对的），挂上之后就真的
 * 会少报。所以这个模块存在的意义就是把「总额 = 本金 + 手续费」这个结构摆对 ——
 * 代码挂上 code 只是让这条从「潜在」变成「现实」。
 *
 * ## 费率从哪来：API，不是这里的常量
 *
 * 界面显示用的费率应当来自 `fetchFeeRates()`（见 lib/clob-client.ts），它读的是
 * Polymarket 那边按 builder code 配的真实值。本模块的 `BUILDER_FEE_RATES` 只是
 * **API 拿不到时的兜底**，见那个常量的注释。
 *
 * ## 为什么这里可以用浮点
 *
 * 与 lib/tick.ts 的「内部一律用整数」、clob-client 的「钱的数不裸浮点」看着
 * 矛盾，其实不是：**输入本身就是浮点**（表单给的份额与单价），而且这里算的是
 * **展示用的预估值** —— 真正扣多少由交易所按整数算，以 `listBuilderTrades`
 * 回执里的 `feeUsdc` 为准。把表单值硬转 bigint 只会把一个显示问题变成一个
 * 精度问题。
 *
 * ## 还不确定的一条
 *
 * 费率是**按成交名义额**（份额 × 单价）算的 —— 这是行业惯例，也符合
 * `*_fee_rate_bps` 这个命名，但我**没有实测确认**。拿到 builder code、跑通
 * 第一笔之后，拿 `listBuilderTrades({builderCode})` 里的 `feeUsdc` 对一下：
 * 对上就删掉这段，对不上就改公式。
 */

/**
 * 一组费率。maker 与 taker 现在同值，但**它们是可以分开的**（官方设置页两个
 * 独立字段），所以按两个字段建模，别合并成一个数 —— 合并之后想分开就要改
 * 每一个调用点。
 */
export type FeeRates = { makerBps: number; takerBps: number }

/**
 * **兜底**费率，基点。真正生效的费率配在 Polymarket 那边（builder 设置页），
 * 由 `fetchFeeRates()` 从 API 读（见 lib/clob-client.ts），界面优先用那个。
 *
 * ## 为什么还要留这个常量
 *
 * 费率查询是异步的，而它只影响**显示**：查不到不该挡住下单，用户被扣多少钱跟
 * 我们查不查得到无关。所以拿不到 API 值时退回这里，界面照常可用。
 *
 * ## 仍然不要把它当成真相
 *
 * 它对应的只是「设置页里写着 5」这个事实在代码里的副本。哪天在设置页改成别的
 * 数而忘了改这里，API 拿得到时界面是对的（会用 API 的值），**API 失败时界面就
 * 会报一个错的数**。所以 use-clob 的 useBuilderFeeRates 在两值不一致时会往
 * 控制台留一行 —— 那是这个副本已经过期的信号。
 */
export const BUILDER_FEE_RATES: FeeRates = {
  makerBps: 5,
  takerBps: 5,
}

/**
 * 报给用户的费率：maker / taker 里**较高**的那个。
 *
 * 市价单必然是 taker；限价单挂上去成交时可能是 maker（通常更便宜），但下单的
 * 那一刻**不知道会怎么成交**，所以按高的报。报多了用户不会生气，报少了才是问题
 * —— 界面显示的总额会低于真实扣款。
 *
 * 提取出来是因为下单表单与确认面板都要这个数，而「取哪个」这个决定错一次就会
 * 在两条路径上同时错。
 */
export function maxBpsOf(rates: FeeRates): number {
  const m = Number.isFinite(rates.makerBps) ? rates.makerBps : 0
  const t = Number.isFinite(rates.takerBps) ? rates.takerBps : 0
  return Math.max(0, m, t)
}

/** bps → 百分数字面量，如 5 → "0.05%"，50 → "0.5%"，200 → "2%" */
export function bpsLabel(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0%'
  // 除以 100 得到百分数。先 toFixed(4) 再削尾零，避免 0.05 被格式化成 "0.0500"，
  // 也避免 1 bps（0.01%）被 toFixed(2) 削成 "0.01%" 之外的东西。
  const pct = (bps / 100).toFixed(4)
  const trimmed = pct.includes('.') ? pct.replace(/0+$/, '').replace(/\.$/, '') : pct
  return `${trimmed}%`
}

/**
 * 手续费，**单位是分**，向上取整。
 *
 * 两个刻意的决定：
 *
 *  1. **向上取整** —— 宁可显示得比实际多一丁点，也绝不少报。少报的是我们自己的
 *     收入，而且用户看到的总额会低于真实扣款。单笔误差 ≤ 1 分。
 *  2. 减 `1e-9` 再 ceil —— 防浮点误差把本该整分的值顶上去。$100 × 5bps 在浮点下
 *     可能是 4.999999999，直接 ceil 就成了 5 分（其实也是 5 分，但 $20 × 5bps
 *     这类本该 1 分的会被顶成 2 分）。
 *
 * 副作用要说清楚：小额单上相对误差很大。$1 的单实际收 $0.005，这里给 1 分 ——
 * 20 倍。绝对误差永远是 1 分以内，但**别拿这个数去反推有效费率**。
 */
export function feeCentsOf(notionalUsd: number, bps: number): number {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return 0
  if (!Number.isFinite(bps) || bps <= 0) return 0
  const raw = (notionalUsd * 100 * bps) / 10_000
  return Math.ceil(raw - 1e-9)
}

export type FeeBreakdown = {
  /** 份额 × 单价，税前 */
  notionalUsd: number
  /** 手续费（分，向上取整） */
  feeUsd: number
  /** 买入实际付出：notionalUsd + feeUsd */
  totalUsd: number
  /** 卖出实际到手：notionalUsd − feeUsd */
  proceedsUsd: number
  /** 费率文案，如 "0.05%"。**金额舍成 0 时它是唯一还说得清的东西** */
  rateLabel: string
}

/**
 * 把「份额 × 单价 + 手续费」算成几个数给确认面板。
 *
 * 份额与单价都来自表单，已经是浮点；`Math.round(...*100)/100` 是为了跟
 * clob-client 的 `usdOf` 保持同一个数 —— 界面预估和提交金额不一致等于界面骗人。
 *
 * ## 为什么买卖两个数都给出来
 *
 * 手续费是**加减方向相反**的：买入是本金**加上**费（扣款），卖出是本金**减去**费
 * （到账）。只留一个数就必须在调用点按方向挑，挑反了界面就把钱说多/说少，
 * 而这正是本模块要防的那类错。所以两个都算好，由 `settleOf` 按方向取。
 */
export function feeBreakdown(size: number, price: number, bps: number): FeeBreakdown {
  const notionalUsd = Math.round(size * price * 100) / 100
  const feeUsd = feeCentsOf(notionalUsd, bps) / 100
  return {
    notionalUsd,
    feeUsd,
    totalUsd: Math.round((notionalUsd + feeUsd) * 100) / 100,
    proceedsUsd: Math.round((notionalUsd - feeUsd) * 100) / 100,
    rateLabel: bpsLabel(bps),
  }
}

/**
 * 这一侧用户**实际付出 / 实际到手**的钱，以及那行的标题。
 *
 * 数字和标题放在一个函数里返回，是因为它们必须同时正确：标题写「实际扣款」
 * 而数字是卖出到手，比两个都写错还难发现。判断余额、按钮上的数字、合计这一行
 * 全部走这里。
 *
 * ## 卖出侧的机制没实测过
 *
 * 「卖出的手续费从成交额里扣」是按 `*_fee_rate_bps` 按名义额计费推出来的，
 * 与费率的算法同源、同样**未实测**（见文件头）。已知错的只有一种：若实际是
 * 卖出**另收**一笔费而不是从成交额里扣，那这里的 `proceedsUsd` 会偏乐观。
 * 拿到 builder code 跑通第一笔后，拿回执里的 `feeUsdc` 一并核对。
 */
export function settleOf(
  b: FeeBreakdown,
  side: 'BUY' | 'SELL',
): { label: string; usd: number } {
  return side === 'BUY'
    ? { label: b.feeUsd > 0 ? '合计（实际扣款）' : '预估总额', usd: b.totalUsd }
    : { label: b.feeUsd > 0 ? '合计（扣费后到账）' : '预估总额', usd: b.proceedsUsd }
}

/**
 * 手续费那行怎么显示。
 *
 * ## 为什么金额小时要加小数位
 *
 * 5 bps 下 $10 的单手续费是 $0.005，两位小数显示成 **$0.00** ——
 * 「显示 0 但实际扣了钱」比不显示更糟。所以金额小于 1 分时给到 4 位小数。
 * 费率文案（"0.05%"）无论如何都显示，它是金额被舍成 0 时唯一还说得清的东西。
 */
export function formatFeeAmount(feeUsd: number): string {
  if (!Number.isFinite(feeUsd) || feeUsd <= 0) return '$0.00'
  if (feeUsd < 0.01) return `$${feeUsd.toFixed(4)}`
  return `$${feeUsd.toFixed(2)}`
}
