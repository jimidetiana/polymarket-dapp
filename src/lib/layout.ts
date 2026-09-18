/**
 * 槽位的动态排布：把设计稿的固定拓扑拉伸到任意容器比例。
 *
 * ## 为什么必须动态
 *
 * 原来 viewBox 直接用槽位的内容包围盒（约 1110×1551，比例 0.72），而屏幕
 * 绝大多数是横宽的（16:9 ≈ 1.78）。两个比例差了一倍以上，contain 模式下
 * 高度先卡死 —— 1608×1004 的画布区里缩放只有 0.58，横向白扔掉近半屏；
 * 再窄一点就掉到可读线以下，退成「贴宽 + 纵向滚动」，SVG 高度撑到 1600+px
 * 而容器只有 700px 高。这就是「画布初始太大、还得滚」的根因。
 *
 * 光调 VB.r 或 MIN_NODE_R_PX 救不了：包围盒由槽位坐标决定，跟圆半径无关，
 * 把圆改小只会让圆外的标签溢出，问题原地挪一格。**得让坐标本身跟着容器变。**
 *
 * ## 怎么做到「动态」又不破坏「所有比赛同一套标准」
 *
 * 这两件事不冲突，因为随容器变的**只有拉伸比例**，不是拓扑：
 *
 *   1. 把设计稿坐标归一到 0..1（每个槽位在图中的相对位置，写死不变）
 *   2. 按容器长宽**各自独立**拉伸回像素
 *
 * 归一化保留了「谁在谁上面、谁在谁左边」的全部关系，所以任何屏幕上看到的
 * 都是同一张图、同一个方位感 —— 换比赛不用重新找位置，这正是固定模板的初衷。
 * 变的只是疏密：宽屏横向铺开，竖屏纵向铺开。
 *
 * 用归一化而不是手写几层「深度 + 层内序号」的表：一是加槽位要同时改两处，
 * 容易对不上；二是归一化直接继承设计稿的微调（比如 total_2.5 比 total_1.5
 * 略偏左那种刻意的错位），手写分层会把这些抹平成整齐的网格。
 *
 * ## 非等比拉伸为什么不让节点变形
 *
 * 拉伸只作用在**圆心坐标**上。每个节点自己是一个 `scale(r/BASE_R)` 的组，
 * 圆、标签、品字形分隔线、涨跌箭头都在组内按设计稿的偏移画 —— 所以圆永远是
 * 圆，字永远不斜。这也是 r 和所有 fontSize 不必再手写一遍的原因：
 * 它们跟着 r 一起缩。
 */

/** 设计稿的节点半径。所有节点内部偏移（标签 −18、箭头 +62 等）都以它为基准 */
export const BASE_R = 76

/**
 * 节点半径占「最近两个节点中心距」的比例。
 *
 * 0.42 < 0.5，所以相邻节点不会贴到一起，留出约 16% 间距走连线。
 * 再大就挤，再小则同样的屏幕里字白白变小。
 */
export const R_OF_GAP = 0.42

/**
 * 节点半径的上限。
 *
 * 超宽屏上最小间距会很大，不设上限的话单个节点能涨到几百像素 —— 比设计稿还大，
 * 不会更清楚，只会让一屏装不下几个节点。封在设计稿原始尺寸。
 */
export const MAX_R = BASE_R

/**
 * 节点半径的下限。
 *
 * 低于这个值标签糊成一团，此时不再缩小节点（宁可让边距变紧），
 * 剩下的可读性交给捏合放大 —— 手机窄屏本来就得放大，见 viewport.ts。
 */
export const MIN_R = 22

/** 画布四周留白，按 r 的比例给：节点越大越需要留白装圆外的标签与箭头 */
export const EDGE_PAD_OF_R = 1.15

export type Pt = { x: number; y: number }
export type Sized = { w: number; h: number }

export type Placed<T> = T & {
  /** 拉伸后的圆心（容器像素坐标系，也就是 viewBox 单位 —— 两者 1:1） */
  x: number
  y: number
}

export type Layout<T> = {
  /** 重排后的槽位，x/y 已是最终坐标 */
  slots: Placed<T>[]
  /** 本次排布下的节点半径 */
  r: number
  /** 节点内部的统一缩放系数，= r / BASE_R */
  scale: number
  /** viewBox，与容器同比例 —— 所以 contain 恒成立，永不滚动 */
  viewBox: { x: number; y: number; w: number; h: number }
}

/**
 * 把一组点归一到 0..1。
 *
 * 退化情形（所有点同一行或同一列）返回 0.5 居中，而不是除以 0 得 NaN ——
 * NaN 会让整个 SVG 静默不渲染，排查起来很费时间。
 */
function normalize(pts: ReadonlyArray<Pt>): Pt[] {
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
  const spanX = maxX - minX
  const spanY = maxY - minY
  return pts.map((p) => ({
    x: spanX > 0 ? (p.x - minX) / spanX : 0.5,
    y: spanY > 0 ? (p.y - minY) / spanY : 0.5,
  }))
}

/** 最近两点的中心距。节点半径由它推出，保证任何比例下都不重叠 */
function minGap(pts: ReadonlyArray<Pt>): number {
  let min = Infinity
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
      if (d < min) min = d
    }
  }
  return Number.isFinite(min) ? min : 0
}

/**
 * 按容器比例排布槽位。
 *
 * 半径与留白互相牵制（留白按 r 给，而 r 又由留白后的可用区算出），
 * 所以迭代两轮：先用估计的留白算 r，再用这个 r 的留白重算。两轮足够收敛
 * —— 第二轮的修正量已在 1px 以内，继续迭代没有可见差别。
 */
export function layoutSlots<T extends Pt>(
  slots: ReadonlyArray<T>,
  container: Sized,
): Layout<T> {
  const w = Math.max(0, container.w)
  const h = Math.max(0, container.h)

  // 容器还没测到（首帧 ResizeObserver 未回调）：给一个安全的空布局，
  // 别让调用方拿到 NaN 坐标。
  if (w <= 0 || h <= 0 || slots.length === 0) {
    return {
      slots: slots.map((s) => ({ ...s, x: 0, y: 0 })),
      r: MIN_R,
      scale: MIN_R / BASE_R,
      viewBox: { x: 0, y: 0, w: Math.max(w, 1), h: Math.max(h, 1) },
    }
  }

  const unit = normalize(slots)

  let r = MIN_R
  for (let pass = 0; pass < 2; pass += 1) {
    const pad = r * EDGE_PAD_OF_R
    // 可用区至少留 1px，避免极小容器下算出负宽导致坐标翻转
    const innerW = Math.max(1, w - pad * 2)
    const innerH = Math.max(1, h - pad * 2)
    // 归一坐标乘可用区 = 实际像素间距，再取最近的一对
    const gap = minGap(unit.map((p) => ({ x: p.x * innerW, y: p.y * innerH })))
    r = Math.min(MAX_R, Math.max(MIN_R, gap * R_OF_GAP))
  }

  const pad = r * EDGE_PAD_OF_R
  const innerW = Math.max(1, w - pad * 2)
  const innerH = Math.max(1, h - pad * 2)

  return {
    slots: slots.map((s, i) => ({
      ...s,
      x: pad + unit[i].x * innerW,
      y: pad + unit[i].y * innerH,
    })),
    r,
    scale: r / BASE_R,
    // viewBox 与容器 1:1 —— 这是「画布等于屏幕」的关键：
    // 不再有 meet 留边，也不再有 width 模式的超高 SVG。
    viewBox: { x: 0, y: 0, w, h },
  }
}
