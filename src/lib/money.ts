/**
 * 金额的展示格式化。
 *
 * ## 为什么这个文件里只剩「格式化」
 *
 * 它原来是 lib/deposit.ts，装的是站内入金那一整套：金额解析（parseUsdcAmount）、
 * 能不能充的判定（depositBlockedReason）、错误翻译（explainDepositError），
 * 外加一份把这些边界逐个钉住的测试。**那条路整个停了**，所以那些函数连同测试
 * 一起删掉，只留下还在用的两个格式化函数。
 *
 * ## 为什么入金不在站内做
 *
 * 两件事叠在一起：
 *
 *  1. Polymarket V2 的抵押代币是 **pUSD**，不是 USDC.e（见 lib/proxy-wallet.ts）。
 *  2. pUSD 是**链上 mint 出来的** —— 实测那笔入金的交易方法是 `handleOps`，
 *     也就是 ERC-4337 的 UserOp，由 Polymarket 的流程铸造。
 *
 * 而站内那条路只是从用户钱包转一笔 ERC-20 到代理钱包。ERC-20 转账**变不出
 * mint**，所以钱会卡在代理钱包里换不成 pUSD，偏偏本项目又没有提现入口 ——
 * 等于把一个「转进去就拿不回来」的按钮摆在人面前。
 *
 * 官方存款流程反而是**免 gas** 的（实测：POL 余额为 0 也存成功了），比站内
 * 那条既正确又省事。所以现在只给一个入口把人送过去，不自己做。
 *
 * ## 金额一律走整数
 *
 * 与 lib/tick.ts 的「内部一律用整数」、clob-client 的「钱的数不裸浮点」是同一条
 * 原则。展示时转一次 Number 是**可以**的（只给人看），但绝不回流到计算里 ——
 * 一旦回流，0.1+0.2 那类误差就会出现在金额上。
 */
import { formatUnits } from 'viem'

/**
 * 抵押代币（pUSD）的小数位。链上余额是 6 位定点的整数。
 *
 * ⚠️ 这条是**按 USDC 的惯例推的，还没实测确认**：Polygonscan 把代理钱包里那笔
 * 4.8 的 pUSD 显示成 $4.80，与「6 位小数 + 1:1 锚定美元」相符。面板上显示成
 * $4.80 就说明对了；显示成天文数字就是这条错了。
 */
export const PUSD_DECIMALS = 6

/** POL 是 18 位小数，与抵押代币不同，两个不能混用 */
const POL_DECIMALS = 18

/**
 * 抵押代币余额 → 展示用字符串（带 $ 的金额）。
 *
 * 参数写 bigint 而不是 number：余额一路都是 bigint 传过来的，任何一处提前转
 * 成 number 都会在大额上丢精度，而那种丢失在界面上看不出来。
 */
export function formatUsd(value: bigint | undefined, dp = 2): string {
  if (value == null) return '—'
  const s = formatUnits(value, PUSD_DECIMALS)
  const n = Number(s)
  return Number.isFinite(n) ? n.toFixed(dp) : s
}

/** POL 余额展示。gas 用，与抵押代币无关 */
export function formatPol(wei: bigint | undefined, dp = 4): string {
  if (wei == null) return '—'
  const n = Number(formatUnits(wei, POL_DECIMALS))
  return Number.isFinite(n) ? n.toFixed(dp) : formatUnits(wei, POL_DECIMALS)
}
