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
 * 用归一化而不是手写几层「深度 + 层内序号」的表：加槽位只要改 template.ts
 * 一处，不用同时维护「层」和「层内序号」两套编号，也就不会对不上。
 *
 * （模板坐标本身已经在 template.ts 里规整成「轴线镜像 + 等步长」了，所以这里
 * 不需要再去继承什么设计稿的手工微调 —— 归一化只是把已经齐的那份等比拉伸。）
 *
 * ## 非等比拉伸为什么不让节点变形
 *
 * 拉伸只作用在**圆心坐标**上。每个节点自己是一个 `scale(r/BASE_R)` 的组，
 * 圆、标签、品字形分隔线、涨跌箭头都在组内按设计稿的偏移画 —— 所以圆永远是
 * 圆，字永远不斜。这也是 r 和所有 fontSize 不必再手写一遍的原因：
 * 它们跟着 r 一起缩。
 *
 * ## 窄屏收束（中心那两条腿）
 *
 * 非等比拉伸有个副作用：容器越窄，x 被压得越扁，中心「进球 → 主队进球 /
 * 客队进球」那个三角跟着横向塌陷，而纵向按比例铺开 —— 看上去就是两条腿又长
 * 又挤。所以这两个槽位在模板里带了 `converge` 目标（见 graph/template.ts），
 * 容器越窄越向目标位置靠拢：**同时向中轴收 + 上移**，把纵向空间让给下面的
 * 胜平负与让球两行。强度随宽高比连续变化，宽屏也略微收一点。
 *
 * 两处刻意的设计，都是被几何逼出来的：
 *
 *   1. **半径 r 仍然按收束前的位置算**，所以节点大小完全不随收束变化。收束
 *      只挪位置，不是重新缩放整张图。
 *   2. 代价是收束可能把某一对挤到比直径还近 —— r 本身就贴着「最小间距 ×0.42」
 *      取值，而中心那个三角（212.4）**正好是全图的最近一对**，一收它就是新的
 *      最近一对，r 会跟着缩。所以收束强度不是直接用的：先按想要的强度摆一遍，
 *      最近的一对若不到 2r × 余量，就把强度退一档重摆，直到通过。
 *      **窄屏上退到 0 是正常的** —— 那时布局本来就贴着密度下限，没有余地可收，
 *      剩下的可读性交给捏合放大（见 viewport.ts）。
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

/** 一组点的包围盒 */
type Extent = { minX: number; minY: number; spanX: number; spanY: number }

function extentOf(pts: ReadonlyArray<Pt>): Extent {
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
  return { minX, minY, spanX: maxX - minX, spanY: maxY - minY }
}

/**
 * 把一个点按某个包围盒归一到 0..1。
 *
 * 退化情形（所有点同一行或同一列）返回 0.5 居中，而不是除以 0 得 NaN ——
 * NaN 会让整个 SVG 静默不渲染，排查起来很费时间。
 *
 * 单独抽出来（而不是在 layoutSlots 里就地算）是为了让 `converge` 目标也能走
 * **同一套**归一化：目标点必须和槽位落在同一个坐标系里，否则会收到别处去。
 */
function project(p: Pt, e: Extent): Pt {
  return {
    x: e.spanX > 0 ? (p.x - e.minX) / e.spanX : 0.5,
    y: e.spanY > 0 ? (p.y - e.minY) / e.spanY : 0.5,
  }
}

/**
 * 收束强度随容器宽高比变化的两个端点。
 *
 * 宽高比 ≥ WIDE 时 t≈0（还会留一点点，见下面的线性式），≤ NARROW 时 t=1。
 * 取 2.4 / 0.6 是为了让**整个区间都在动**：实测桌面画布约 2.3、平板竖屏约
 * 0.75、手机画布约 0.52，全落在区间内，所以几种比例下都看得出差别，而不是
 * 只有极端比例才触发。
 */
export const CONVERGE_WIDE_ASPECT = 2.4
export const CONVERGE_NARROW_ASPECT = 0.6

/**
 * 收束后最近的一对至少要留多少倍直径。1 就是「刚好不重叠」，留一点余量，
 * 免得贴着边界时视觉上像黏在一起。
 */
const CONVERGE_CLEARANCE = 1.06

/** 退让的档数。收束强度按几何回退时一档一档试，24 档的台阶视觉上察觉不到 */
const CONVERGE_STEPS = 24

/**
 * 容器宽高比 → 收束强度 t ∈ [0,1]。
 *
 * 宽高比越大越不收（横向本来就铺得开，中心三角张着是对的），越小收得越狠。
 * 特意**不**做成「窄于 1 才生效」的开关：开关会在跨过阈值的瞬间跳一下，而
 * 连续插值在拖窗口时是平滑变化的。
 */
export function convergeStrength(w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return 0
  const t = (CONVERGE_WIDE_ASPECT - w / h) / (CONVERGE_WIDE_ASPECT - CONVERGE_NARROW_ASPECT)
  return Math.min(1, Math.max(0, t))
}

/**
 * 按强度 t 把带目标的槽位向目标靠拢，并保证没有任何一对被挤到重叠。
 *
 * 从想要的强度往下逐档试，第一个通过的档就用它。不用二分（不假设「强度越小
 * 越安全」—— 收束点对非收束点的距离未必单调），逐档线性试更省心：24 档 ×
 * 325 对也就是几千次距离计算，拖窗口时每帧跑一次也无感。
 *
 * 所有档都不通过时返回原位（base），也就是退回今天这个布局 —— 最坏情况不会
 * 比现在差。
 */
function convergePositions(
  base: ReadonlyArray<Pt>,
  target: ReadonlyArray<Pt | null>,
  t: number,
  r: number,
): Pt[] {
  const limit = 2 * r * CONVERGE_CLEARANCE
  for (let step = CONVERGE_STEPS; step >= 0; step -= 1) {
    const k = (t * step) / CONVERGE_STEPS
    const pts = base.map((p, i) => {
      const q = target[i]
      return q ? { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k } : p
    })
    // minGap 在点数不足 2 时返回 0，于是一路退到 k=0，返回原位 —— 退化情形正确
    if (minGap(pts) >= limit) return pts
  }
  return base.slice()
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
export function layoutSlots<T extends Pt & { converge?: Pt }>(
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

  const e = extentOf(slots)
  const unit = slots.map((s) => project(s, e))

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

  // 收束前的落点。r 是在这之上算出来的，所以收束**不会**反过来改变节点大小。
  const base = unit.map((p) => ({ x: pad + p.x * innerW, y: pad + p.y * innerH }))

  // 收束目标走同一个包围盒 e，保证它和槽位在同一个坐标系里
  const target = slots.map((s) => {
    if (!s.converge) return null
    const u = project(s.converge, e)
    return { x: pad + u.x * innerW, y: pad + u.y * innerH }
  })
  const placed = target.some((q) => q !== null)
    ? convergePositions(base, target, convergeStrength(w, h), r)
    : base

  return {
    slots: slots.map((s, i) => ({ ...s, x: placed[i].x, y: placed[i].y })),
    r,
    scale: r / BASE_R,
    // viewBox 与容器 1:1 —— 这是「画布等于屏幕」的关键：
    // 不再有 meet 留边，也不再有 width 模式的超高 SVG。
    viewBox: { x: 0, y: 0, w, h },
  }
}
