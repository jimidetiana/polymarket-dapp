/**
 * 中英文切换。
 *
 * ## 为什么不上 i18next 之类
 *
 * 只有两种语言、文案就地写在组件里，一个 key 表只会让人在两个文件之间来回跳。
 * 所以文案仍写在用它的地方，只是写成一对：`tr('比赛', 'Matches')`。
 *
 * ## 当前语言是模块级变量，不是 Context
 *
 * 图的标签（graph/parse.ts、graph/graph.ts）和 lib 里的报错文案都在 React 之外生成，
 * Context 够不着它们。所以语言放在模块里，谁要都能直接 `tr()`；组件用 `useLang()`
 * 订阅变化，切换时重渲染。**注意 useMemo 里产出文案的，要把 lang 放进依赖**，
 * 否则切换后还是旧语言。
 *
 * 默认中文，只认 localStorage 里存过的选择 —— 不按浏览器语言猜：这个站本来就是
 * 中文优先，而测试跑在 node 里（navigator.language 是 en-US），按浏览器猜会让
 * 所有断言中文标签的测试翻车。
 */
import { useSyncExternalStore } from 'react'

export type Lang = 'zh' | 'en'

const LS_KEY = 'lang'

function initial(): Lang {
  try {
    const v = localStorage.getItem(LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {
    // node 测试环境没有 localStorage，隐私模式也可能禁用 —— 都按默认走
  }
  return 'zh'
}

let lang: Lang = initial()
const subs = new Set<() => void>()

function syncHtmlLang(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
}
syncHtmlLang()

export function getLang(): Lang {
  return lang
}

export function setLang(next: Lang): void {
  if (next === lang) return
  lang = next
  try {
    localStorage.setItem(LS_KEY, next)
  } catch {
    /* 存不下只是下次打开回到默认，不影响本次 */
  }
  syncHtmlLang()
  for (const f of subs) f()
}

function subscribe(f: () => void): () => void {
  subs.add(f)
  return () => subs.delete(f)
}

/** 订阅当前语言。组件里调一次，切换语言时它会重渲染 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang)
}

/** 按当前语言二选一 */
export function tr(zh: string, en: string): string {
  return lang === 'en' ? en : zh
}

/**
 * 显示时区，跟着当前语言走 —— 中英切换时时间也跟着换口径。
 *
 * 中文按北京时间（Asia/Shanghai）：站点中文优先，赛程 / 盘口 / 订单一律按北京时间看，
 * 这是老口径（见 utils.formatKickoff 注释里那个「订单页差 8 小时」的由来）。
 * 英文按 UTC：面向国际用户，UTC 无歧义，也不用替某个国家的本地时区做主张。
 * 要改成别的（如美东 America/New_York），只动下面这一处 EN_TZ 即可。
 */
const EN_TZ = 'UTC'

export function displayTimeZone(): string {
  return lang === 'en' ? EN_TZ : 'Asia/Shanghai'
}

/** toLocaleString 用的区域格式：英文走 en-GB（24 小时制），与持仓 / 成交的时间列同口径 */
export function displayLocale(): string {
  return lang === 'en' ? 'en-GB' : 'zh-CN'
}

/**
 * 把一个时刻按**当前显示时区**拆成零填充的 年/月/日/时/分 串。
 *
 * 持仓、成交、导出水印几处时间列各自拼格式（有的带年、有的不带），但都要「按语言时区、
 * 24 小时制」这同一套口径，所以把这段 Intl 调用收在这里，免得各写一遍还写不齐。
 * hourCycle 钉 'h23'：部分引擎在 hour12:false 下会把 0 点给成 "24"，h23 才稳定给 "00"。
 */
export function zonedTimeParts(d: Date): {
  year: string
  month: string
  day: string
  hour: string
  minute: string
} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: displayTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const g = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? '00'
  return { year: g('year'), month: g('month'), day: g('day'), hour: g('hour'), minute: g('minute') }
}
