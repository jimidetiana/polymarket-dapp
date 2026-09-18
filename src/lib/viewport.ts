/**
 * 画布的缩放与平移。
 *
 * ## 为什么需要
 *
 * layoutSlots 已经让画布恒等于容器、整图恒定铺满，但**小屏塞不下**这件事
 * 排布解决不了：手机 390×844（容器约 366×700）里 22 个槽位排下来，单个节点
 * 半径被挤到 MIN_R 附近，标签虽不重叠但偏小。排布能做的只是不浪费空间，
 * 空间本身不够时没有逃生路径 —— 必须让用户自己放大。
 *
 * ## 为什么用 transform 而不是改 viewBox
 *
 * 改 viewBox 也能缩放，但 preserveAspectRatio="xMidYMid meet" 会在两个方向
 * 各自留边，viewBox 变了留边也跟着变，「捏住某点放大」的定点换算要把这层
 * 也算进去，很容易差半个留边。改成 viewBox 固定 + 一层 <g transform>：
 * 留边只在 baseScale 里算一次，缩放平移全在 viewBox 用户坐标里做，
 * 两件事解耦。
 *
 * ## 坐标系
 *
 * 三层，别混：
 *   1. 容器像素   —— 鼠标/手指事件给的坐标
 *   2. viewBox 单位 —— 恒等于容器像素（layoutSlots 给的 viewBox 与容器 1:1）
 *   3. 用户坐标   —— 变换前的 viewBox 单位，即 layoutSlots 排布出的 x/y
 *
 * 变换定义为 `translate(tx ty) scale(k)`，所以第 3 层到第 2 层是
 * `v = k * u + t`。反过来 `u = (v - t) / k`。
 */

export type View = {
  /** 缩放倍数，1 = 基础适配（整图刚好铺满） */
  k: number
  /** 平移量，单位是 viewBox 单位（不是像素） */
  tx: number
  ty: number
}

export type Box = { x: number; y: number; w: number; h: number }

export const IDENTITY: View = { k: 1, tx: 0, ty: 0 }

/**
 * 不允许缩小到基础适配以下。
 *
 * k<1 意味着图比容器还小、四周留白更多，而基础适配已经是「整图刚好铺满」，
 * 再缩只会更难读，没有任何场景需要。
 */
export const MIN_K = 1

/**
 * 放大上限。
 *
 * 手机上最需要放大：366px 宽的容器里 8 倍相当于把内容盒放到 ~10500px，
 * 单个节点半径约 170px，远超可读所需。再大只会让「现在看的是哪一块」
 * 彻底失去参照。
 */
export const MAX_K = 8

/**
 * 容器像素 ↔ viewBox 单位的换算基准。
 *
 * meet 模式下取两个方向缩放的较小者，另一个方向居中留边 —— ox/oy 就是
 * 那半条留边。少算这一项会让「捏住某点放大」在非等比容器里偏移，
 * 而容器几乎永远不等比。
 */
export function baseScale(
  container: { w: number; h: number },
  box: Box,
): { s: number; ox: number; oy: number } {
  if (container.w <= 0 || container.h <= 0 || box.w <= 0 || box.h <= 0) {
    return { s: 0, ox: 0, oy: 0 }
  }
  const s = Math.min(container.w / box.w, container.h / box.h)
  return {
    s,
    ox: (container.w - s * box.w) / 2,
    oy: (container.h - s * box.h) / 2,
  }
}

/**
 * 容器内的像素坐标 → 用户坐标（变换前的节点坐标系）。
 *
 * 传进来的 px/py 必须是**相对容器左上角**的坐标（clientX - rect.left），
 * 不是页面坐标 —— 页面坐标会把滚动和 header 高度一起算进去。
 */
export function clientToUser(
  px: number,
  py: number,
  container: { w: number; h: number },
  box: Box,
  view: View,
): { x: number; y: number } {
  const { s, ox, oy } = baseScale(container, box)
  if (s <= 0) return { x: box.x, y: box.y }
  // 先到 viewBox 单位
  const vx = box.x + (px - ox) / s
  const vy = box.y + (py - oy) / s
  // 再退回用户坐标
  return { x: (vx - view.tx) / view.k, y: (vy - view.ty) / view.k }
}

/**
 * 把平移量夹到「内容不跑出画面」的范围内。
 *
 * 可见的用户坐标矩形是 ((box.x-tx)/k, (box.y-ty)/k, box.w/k, box.h/k)，
 * 要求它整个落在 box 里，解出：
 *   tx ∈ [-(k-1)(box.x+box.w), (1-k)box.x]
 * k=1 时上下界都是 0 —— 基础适配下不允许平移，正确：那时整图已经铺满，
 * 拖动只会把内容拖出去。
 *
 * 这个夹取略偏保守：meet 留边那一侧其实还有可视空间，夹到 box 意味着
 * 不让内容进入留边区。宁可保守 —— 留边区里没有内容，能拖进去只会让人
 * 以为图空了。
 */
export function clampView(view: View, box: Box): View {
  const k = Math.min(MAX_K, Math.max(MIN_K, view.k))
  const txMin = -(k - 1) * (box.x + box.w)
  const txMax = (1 - k) * box.x
  const tyMin = -(k - 1) * (box.y + box.h)
  const tyMax = (1 - k) * box.y
  return {
    k,
    tx: norm(Math.min(txMax, Math.max(txMin, view.tx))),
    ty: norm(Math.min(tyMax, Math.max(tyMin, view.ty))),
  }
}

/**
 * 把 -0 归一成 0。
 *
 * k=1 时 -(k-1)*n 算出来是 -0，夹取后 tx 就带上了负号。渲染上无害
 * （translate(-0 0) 与 translate(0 0) 等效），但 isZoomed 里的 `!== 0`
 * 判断会因此把「没动过」误判成「动过了」，复位按钮会一直亮着。
 */
function norm(n: number): number {
  return n === 0 ? 0 : n
}

/**
 * 以某个用户坐标点为锚放大/缩小 —— 该点在屏幕上的位置保持不动。
 *
 * 这是滚轮缩放和双指捏合的共同核心。不做定点补偿的话，缩放总是绕
 * 原点走，手感是「图会自己跑」。
 *
 * 推导：屏幕位置 v = k·u + t 要在缩放前后相等，
 *   k·u + t = k'·u + t'  ⟹  t' = t + (k - k')·u
 */
export function zoomAt(view: View, u: { x: number; y: number }, factor: number, box: Box): View {
  const k = Math.min(MAX_K, Math.max(MIN_K, view.k * factor))
  if (k === view.k) return view
  return clampView(
    { k, tx: view.tx + (view.k - k) * u.x, ty: view.ty + (view.k - k) * u.y },
    box,
  )
}

/**
 * 按像素位移平移。
 *
 * 入参是像素（指针/手指的位移），内部换成 viewBox 单位再累加 ——
 * 直接把像素加到 tx 上会导致放大后拖动速度和手指对不上。
 */
export function panBy(
  view: View,
  dxPx: number,
  dyPx: number,
  container: { w: number; h: number },
  box: Box,
): View {
  const { s } = baseScale(container, box)
  if (s <= 0) return view
  return clampView({ k: view.k, tx: view.tx + dxPx / s, ty: view.ty + dyPx / s }, box)
}

/** 是否已经离开基础适配（决定要不要显示「复位」按钮、要不要拦滚轮） */
export function isZoomed(view: View): boolean {
  return view.k > MIN_K + 1e-6 || view.tx !== 0 || view.ty !== 0
}

/** 变换属性字符串。集中在这里，免得组件里手拼时把 translate/scale 顺序写反 */
export function transformOf(view: View): string {
  return `translate(${view.tx} ${view.ty}) scale(${view.k})`
}
