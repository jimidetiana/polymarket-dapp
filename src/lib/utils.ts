/**
 * 画布用到的两个小工具。
 *
 * 原项目这里是 clsx + tailwind-merge 的 `cn`。dapp 没装那两个包，也不需要：
 * 画布里 `cn()` 只有两处调用，都是「基础类 + 一个三元条件类」，不存在
 * 同类冲突（比如 px-2 和 px-4 同时出现）需要 tailwind-merge 去仲裁。
 * 真到需要仲裁的时候再装，不要为两次调用拉两个依赖进来。
 */
import { displayLocale, displayTimeZone } from './i18n'

/** 拼 class：丢掉 false / null / undefined，其余按空格连接 */
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(' ')
}

function formatNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return '-'
  const num = Number(n)
  if (Number.isNaN(num)) return '-'
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/**
 * 成交额/流动性金额显示，带 $ 前缀并按 K/M 缩写。
 *
 * 缺数据返回 '—' 而不是 '$0'：盘口真的零成交，和接口没给这个字段，
 * 是两件不同的事，混在一起看不出来。
 */
export function formatVolume(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '—'
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  return `$${formatNumber(num)}`
}

/**
 * 开赛时间。**时区跟着界面语言走**：中文按 Asia/Shanghai（北京时间），英文按 UTC ——
 * 具体口径见 i18n.displayTimeZone。赛程、盘口、订单全走同一个 displayTimeZone，
 * 中英切换时一起换，两处不会再对不上（用户报过的「订单页时间差 8 小时」就是早年
 * 一边钉北京、一边跟浏览器时区，两套口径打架引起的）。
 *
 * Gamma 的 endDate 是带 Z 的完整 ISO，所以这里没有原项目那个
 * 「裸串当 UTC 补 Z」的坑，直接 new Date 即可。
 */
export function formatKickoff(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(displayLocale(), {
    timeZone: displayTimeZone(),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
