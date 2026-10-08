/**
 * 这次页面加载是「刷新」还是「打开」。
 *
 * 只服务一件事：深链（`#/market?condition=…&token=…`）在**点进来**时要自动打开
 * 下单面板 —— 那正是「从战绩页点一条记录跳过去直接下单」的全部意义；而**刷新**
 * 出来的不要：刷新只是把地址栏里那个地址重放一遍，面板再弹一次纯属打扰。
 *
 * 读 Navigation Timing：`reload` 是刷新，`navigate` / `back_forward` 都算「点进来」。
 * 拿不到这个 API（老浏览器、测试环境）时返回 false，也就是按原来的行为走 ——
 * 宁可多弹一次，也别让深链失效。
 *
 * ⚠️ 这个值说的是**本文档这次加载**，不区分 app 内的 hash 跳转（那些都发生在同一个
 * document 里）。所以调用方只在「首屏那个 hash」上看它：见 App.tsx 的 useHash。
 */
export function isPageReload(): boolean {
  try {
    const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
    return nav?.type === 'reload'
  } catch {
    return false
  }
}
