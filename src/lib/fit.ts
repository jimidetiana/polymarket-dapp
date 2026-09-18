/**
 * 画布自适应：内容包围盒 + 两种适配方式的取舍。
 *
 * 抽成纯函数是为了能测。这段是纯算术，但结论并不直观——
 * 「宽屏该贴宽」是错的，「窄屏该滚动」也是错的，都得按数算（见 chooseFit）。
 * 放在组件里只能靠改窗口大小手工试，回归无从察觉。
 */

/** 设计稿画布尺寸与节点半径。模板坐标就是按这个系画的 */
export const VB = { width: 1334, height: 1775, r: 64 } as const

/**
 * 内容边界的外扩量。
 *
 * 不能只按节点半径 64 留白：标签画在圆心上方 18px 处、涨跌箭头在下方 62px，
 * 都在圆外。按 r 裁会把最外圈节点的文字切掉。
 */
export const PAD = 85

/**
 * 节点渲染后的最小可接受半径（CSS 像素）。
 *
 * 标签最小字号 17px（见 labelFont），画在圆内。半径低于 28px 时，
 * 17px 的字已经宽于圆的可用半宽，标签必然溢出或糊在一起——
 * 那时候「一屏看全」反而不如「贴宽 + 滚动」。
 *
 * 28 约是最小字号的 1.65 倍：考虑到标签会收缩字号（见 labelFont），
 * 这个阈值能在保持可读性的同时让更多内容适配进一屏。
 */
export const MIN_NODE_R_PX = 28

/**
 * width 模式至少要比 contain 大这么多倍，才值得付纵向滚动的代价。
 *
 * 窄容器（平板竖屏 522×1036）卡在宽度上，两种模式的缩放几乎一样——
 * 那时滚动换不来任何可读性。1.08 = 至少大 8% 才换。
 * 降低这个阈值让更多场景优先选择 contain 模式，尽量在一屏内显示全部节点。
 */
export const WIDTH_GAIN = 1.08

export type Box = { x: number; y: number; w: number; h: number }
export type FitMode = 'contain' | 'width'

/**
 * 槽位的实际包围盒。
 *
 * 用它而不是设计稿全幅 0 0 1334 1775：模板 22 个槽位实测只占
 * x 112..1222、y 112..1663，四周本来就有空白。按全幅缩放等于把这些空白
 * 也一起缩进去，屏幕越宽浪费越明显。
 *
 * 入参只要 {x,y}，不绑 GraphSlot——包围盒和盘口语义无关。
 */
export function contentBox(pts: ReadonlyArray<{ x: number; y: number }>): Box {
  if (pts.length === 0) return { x: 0, y: 0, w: VB.width, h: VB.height }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const x = minX - PAD
  const y = minY - PAD
  return { x, y, w: maxX + PAD - x, h: maxY + PAD - y }
}

export type Fit = {
  mode: FitMode
  /** contain 模式下的缩放比，用于判定与调试 */
  scaleContain: number
  /** width 模式下的缩放比 */
  scaleWidth: number
  /** width 模式下 svg 的像素宽度（contain 模式无意义，返回容器宽） */
  widthPx: number
  /** width 模式下 svg 的像素高度 */
  heightPx: number
}

/**
 * 选适配方式。判据是**节点渲染后的实际半径**，不是屏幕方向。
 *
 * contain（整张图塞进容器、不滚动）在宽屏上会被高度卡死：内容约 3:4 竖长，
 * 容器 2:1 时缩放只有 0.4 上下，节点半径落到 30px 以内，标签就糊了。
 * 所以半径不够就退成 width（贴宽 + 纵向滚动），宁可滚动也不牺牲可读性。
 *
 * 但只有**高度是瓶颈**时退 width 才有意义。窄容器（平板竖屏 522×1036）
 * 卡在宽度上，贴宽得到的半径和 contain 一样，滚动纯属白付代价——
 * 所以还要求 width 确实能把节点放大 WIDTH_GAIN 倍以上，否则宁可小一点也不滚。
 *
 * width 模式下宽度不超过内容盒原始宽度：矮而宽的窗口（2000×500）贴宽会把图
 * 放大到 1.5 倍、纵向滚动几千像素，放大超过设计稿并不更清楚，只是更难找位置。
 */
export function chooseFit(container: { w: number; h: number }, box: Box): Fit {
  const { w, h } = container
  if (w <= 0 || h <= 0 || box.w <= 0 || box.h <= 0) {
    return { mode: 'contain', scaleContain: 0, scaleWidth: 0, widthPx: w, heightPx: h }
  }
  const scaleContain = Math.min(w / box.w, h / box.h)
  const widthPx = Math.min(w, box.w)
  const scaleWidth = widthPx / box.w

  const readable = scaleContain * VB.r >= MIN_NODE_R_PX
  const worthScrolling = scaleWidth > scaleContain * WIDTH_GAIN
  const mode: FitMode = readable || !worthScrolling ? 'contain' : 'width'

  return {
    mode,
    scaleContain,
    scaleWidth,
    widthPx,
    heightPx: (box.h / box.w) * widthPx,
  }
}
