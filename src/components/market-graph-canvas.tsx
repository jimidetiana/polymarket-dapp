/**
 * 盘口关系图画布——照设计稿（盘口关系图.pdf）的固定拓扑画。
 *
 * ## 为什么不是按数据长出来的布局
 *
 * 需求要的是「所有比赛采用同一套标准，形成一张网状图」。所以骨架与具体
 * 比赛无关：22 个槽位在每场比赛都在同一位置，看第二场时不用重新找方位。
 * 数据只决定槽位里填什么。
 *
 * 上一版按 family 分列、按 line 排行，等于把网状图摊成了表格——位置由
 * 数据长出来，每场形状都不同，也完全看不出「进球」是整张图的中心。
 *
 * ## 两类节点
 *
 *   粉色（3 个）  进球 / 主队进球 / 客队进球。**没有对应盘口**，
 *                 显示由大小球梯子反推出的进球数——是推断值，不是报价。
 *   蓝色（19 个） 各绑一张真实盘口的某一侧，品字形显示该侧的卖价与买价。
 *   绿色          其中的**进球盘在推断比分越过该线之后**变绿，表示已打出。
 *                 这是整张图随比赛推进最主要的动态。
 *
 * 某场比赛没挂某条线时，槽位**留在原位**画成虚线空位——位置固定才是
 * 「同一套标准」的意思，缺哪条线要能一眼看出来，而不是让图变形。
 *
 * 颜色只编这两件事（报价 vs 推断、已打出 vs 未打出），不再用颜色编进球
 * 敏感度：这 19 个槽位按构造全都受进球影响，再叠一层深浅只会互相打架。
 * 敏感度放在悬浮详情里。
 *
 * ## 为什么节点上不显示中价
 *
 * 中价（(买+卖)/2）在点差宽的盘口上是个**没人能成交的数字**：买卖挂在
 * 0.30/0.70 时中价 0.50，而你既买不到 0.50 也卖不到 0.50。原来节点只显示
 * 中价，那些盘口的数字完全反映不了真实价格。
 *
 * 所以盘口节点按品字形排：上面盘口信息，下面左「卖」（你买入要付的价，
 * best ask）、右「买」（你卖出能收的价，best bid）。两个数字并排，点差
 * 有多宽一眼就看出来。缺哪一侧就显示「—」，不用另一侧顶替。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { formatVolume } from '@/lib/utils'
import { formatPrice, type PriceMode } from '@/lib/odds'
import type { GraphGoalCounts, GraphNode, GraphSlot, MarketGraph } from '@/types/market-graph'
import { BASE_R, layoutSlots } from '@/lib/layout'
import {
  IDENTITY,
  MIN_K,
  clientToUser,
  isZoomed,
  panBy,
  transformOf,
  zoomAt,
  type View,
} from '@/lib/viewport'

/** 一格滚轮的缩放倍数。1.15 ≈ 每 5 格翻一倍，手感不至于过冲 */
const WHEEL_STEP = 1.15

/**
 * 点一次 +/− 的缩放倍数。
 *
 * 比滚轮那一格大：按钮是「有意为之」的操作，一次要看得出变化；
 * 滚轮会连发很多格，单格必须小。
 */
const BUTTON_STEP = 1.5

/**
 * 超过这个像素位移才算拖动，否则当点击。
 *
 * 少了这道判断，节点上极小的抖动会把点击吃掉 —— 触屏上尤其明显，
 * 手指按下几乎不可能零位移。
 */
const DRAG_SLOP_PX = 4

/**
 * 观察容器实际像素尺寸。
 *
 * 自适应必须拿真实尺寸算，不能靠 CSS 百分比：SVG 要按容器宽高比在
 * 「贴宽」和「贴高」之间选，这个判断只有拿到数字才能做。
 * 用 ResizeObserver 而不是 window resize —— 侧栏展开、面板增减都会改变
 * 容器宽度，而窗口尺寸没变，监听 window 收不到。
 */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

/** 盘口节点：设计稿的蓝，为深色底压暗一档。DIM = 只有快照价 */
const BLUE = '#2b8fc9'
const BLUE_DIM = '#1c4a63'

/** 中心三个推断节点：设计稿的粉 */
const PINK = '#c9407f'

/**
 * 进球盘已被打出后的绿。
 *
 * 只用在大小球进球盘上：推断比分已经越过这条线，它就不再是「会不会」而是
 * 「已经是」——价格钉在 0.99 附近不再动。变绿把「还在博弈」和「已成定局」
 * 一眼分开，这也是整张图随比赛推进最主要的动态。
 *
 * 让球与胜平负不参与：它们是「此刻领先够不够」，会来回变，没有「打出了
 * 就不回头」的语义。
 *
 * 取 #2f9e5f 而不是复用 --pm-state-success：那个绿是价格上涨箭头在用的，
 * 色相拉开一点，免得同一张图里两个绿被读成同一个含义。
 */
const GREEN = '#2f9e5f'
const GREEN_DIM = '#1d5c3a'

export function primaryPrice(n: GraphNode): number | null {
  const s = n.sides.find((x) => x.name === n.primarySide) ?? n.sides[0]
  if (!s) return null
  if (s.bid != null && s.ask != null) return (s.bid + s.ask) / 2
  return s.bid ?? s.ask ?? s.price ?? null
}

interface Props {
  graph: MarketGraph
  slots: GraphSlot[]
  /** 模板边表（静态，由后端给，保证前后端同一份） */
  templateEdges: Array<[string, string]>
  /**
   * 当前显示的推断进球数。实时态是最新的，回放态是所选帧的——
   * 「该线是否已打出」由它现算，所以回放拖动时颜色会跟着变。
   */
  goals: GraphGoalCounts | null
  /** 价格显示口径：概率 % 或欧赔 */
  priceMode: PriceMode
  /** 上一轮价格，key = slot.key */
  prevPrices: Record<string, number>
  selectedKey: string | null
  onSelect: (key: string | null) => void
  /**
   * 点到绑了盘口的节点时调用。空槽和中心推断节点没有盘口，不会触发。
   * 由页面决定怎么开下单界面——画布不该知道下单这件事怎么做。
   */
  onBuy?: (slot: GraphSlot) => void
}

/**
 * 标签字号按长度收缩，避免长标签溢出圆形。
 *
 * 圆在纵向偏移 dy 处的可用半宽是 sqrt(r² − dy²)，不是 r。标签画在 y−18，
 * 那里半宽只有 sqrt(76²−18²)≈73.8。而「主队总进球 1.5」这种 9 字标签在
 * 23px 下半宽约 80，会顶出圆外——之前就在溢出，这次一并收掉。
 */
function labelFont(label: string): number {
  const n = label.length
  if (n <= 6) return 23
  if (n <= 9) return 19
  return 17
}

/** 该线是否已被进球打出。规则与后端 isSlotHit 一致 */
function slotHit(s: GraphSlot, goals: GraphGoalCounts | null): boolean | null {
  if (s.hitNeed == null || s.hitSubject == null || !goals) return null
  const g = goals[s.hitSubject]
  if (g == null) return null
  return g >= s.hitNeed
}

export function MarketGraphCanvas({
  graph,
  slots,
  templateEdges,
  goals,
  priceMode,
  prevPrices,
  selectedKey,
  onSelect,
  onBuy,
}: Props) {
  const [hover, setHover] = useState<GraphSlot | null>(null)

  /** 与选中节点直接相连的槽位，用来做聚焦高亮 */
  const neighbours = useMemo(() => {
    if (!selectedKey) return null
    const set = new Set<string>([selectedKey])
    for (const [a, b] of templateEdges) {
      if (a === selectedKey) set.add(b)
      if (b === selectedKey) set.add(a)
    }
    return set
  }, [selectedKey, templateEdges])

  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode>()
    for (const n of graph.nodes) m.set(n.id, n)
    return m
  }, [graph.nodes])

  const [wrapRef, size] = useElementSize<HTMLDivElement>()

  /**
   * 按容器比例重排槽位。
   *
   * 排布是纯算术，抽到 lib/layout 里跟测试放一起（见 layout.test.ts）。
   * 拉伸后的 viewBox 与容器同比例，所以整图恒定「刚好铺满」——
   * 不再需要在「一屏看全」和「贴宽滚动」之间选，也就没有 fit 模式了。
   */
  const { slots: placed, scale: nodeScale, viewBox: box } = useMemo(
    () => layoutSlots(slots, size),
    [slots, size],
  )

  /** 重排后的坐标查表，连线要用 */
  const posByKey = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    for (const s of placed) m.set(s.key, { x: s.x, y: s.y })
    return m
  }, [placed])

  const [view, setView] = useState<View>(IDENTITY)

  /**
   * 换比赛就复位视图。
   *
   * 不复位的话，上一场放大后的位置会套到新一场上 —— 两场的槽位分布不同，
   * 看到的会是一片空白，用户不知道图去哪了。
   */
  useEffect(() => {
    setView(IDENTITY)
  }, [graph.nodes])

  /** 容器内相对坐标。事件给的是页面坐标，必须减掉容器位置 */
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current?.getBoundingClientRect()
    return r ? { px: e.clientX - r.left, py: e.clientY - r.top } : { px: 0, py: 0 }
  }

  /**
   * 滚轮缩放。
   *
   * 用 passive:false 的原生监听而不是 React 的 onWheel：React 挂的是 passive
   * 监听，preventDefault 会被浏览器忽略，页面照样滚。而这里必须拦 ——
   * 不拦的话在画布上滚轮会同时缩放和滚页面。
   *
   * 基础适配（k=1）时不拦：那时整图已看全，把滚轮让给页面更符合预期。
   */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // 未缩放且是向外滚（缩小方向）时不接管，留给页面
      if (!isZoomed(view) && e.deltaY > 0) return
      e.preventDefault()
      const { px, py } = localPoint(e)
      const u = clientToUser(px, py, size, box, view)
      setView((v) => zoomAt(v, u, e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, box))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [view, size, box, wrapRef])

  /**
   * 指针拖动与双指捏合，用 Pointer Events 统一处理鼠标和触摸。
   *
   * 记在 ref 里而不是 state：拖动过程每帧都在变，用 state 会触发额外渲染，
   * 而这些中间值只有下一次事件用得到。
   */
  const drag = useRef<{
    pointers: Map<number, { x: number; y: number }>
    moved: number
    /** 双指起始间距与中点（用户坐标），捏合时用 */
    pinch: { dist: number; u: { x: number; y: number }; k: number } | null
  }>({ pointers: new Map(), moved: 0, pinch: null })

  const onPointerDown = (e: React.PointerEvent) => {
    const { px, py } = localPoint(e)
    const d = drag.current
    d.pointers.set(e.pointerId, { x: px, y: py })
    d.moved = 0
    if (d.pointers.size === 2) {
      const [a, b] = [...d.pointers.values()]
      const mid = { px: (a.x + b.x) / 2, py: (a.y + b.y) / 2 }
      d.pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        u: clientToUser(mid.px, mid.py, size, box, view),
        k: view.k,
      }
    }
    // 捕获指针，拖到画布外也能继续收到事件
    ;
    //(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    const prev = d.pointers.get(e.pointerId)
    if (!prev) return
    const { px, py } = localPoint(e)
    d.pointers.set(e.pointerId, { x: px, y: py })

    if (d.pointers.size >= 2 && d.pinch) {
      const [a, b] = [...d.pointers.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (d.pinch.dist > 0) {
        // 相对起始间距算目标倍数，而不是逐帧累乘 —— 累乘会积累误差，
        // 手指回到原位时缩放回不到原值。
        const target = (d.pinch.k * dist) / d.pinch.dist
        setView((v) => zoomAt({ ...v, k: v.k }, d.pinch!.u, target / v.k, box))
      }
      d.moved = Infinity // 捏合过就不算点击
      return
    }

    const dx = px - prev.x
    const dy = py - prev.y
    d.moved += Math.hypot(dx, dy)
    // 只有放大后才允许拖：k=1 时 clampView 会把平移夹回 0，拖动是无效动作，
    // 此时保持默认行为（让容器/页面自己滚）更合理。
    if (view.k > MIN_K + 1e-6) setView((v) => panBy(v, dx, dy, size, box))
  }

  const endPointer = (e: React.PointerEvent) => {
    const d = drag.current
    d.pointers.delete(e.pointerId)
    if (d.pointers.size < 2) d.pinch = null
  }

  /** 刚拖过就不要把 pointerup 当成点击 */
  const wasDrag = () => drag.current.moved > DRAG_SLOP_PX

  /**
   * +/− 按钮：以容器中心为锚缩放。
   *
   * 用中心而不是原点 —— 按钮缩放时用户正看着画面中间，绕原点会让当前
   * 关注的区域跑出视野。与滚轮/捏合共用 zoomAt，锚点换成中心即可。
   */
  const zoomAtCenter = (factor: number) => {
    const u = clientToUser(size.w / 2, size.h / 2, size, box, view)
    setView((v) => zoomAt(v, u, factor, box))
  }

  const zoomed = isZoomed(view)

  return (
    <div
      ref={wrapRef}
      className={cn(
        // 画布永远等于容器：viewBox 与容器同比例，没有溢出可滚，
        // 所以这里恒定 overflow-hidden（原来的 overflow-auto 是给
        // width 模式那个比容器高一倍的 SVG 用的，现在不存在了）。
        'relative h-full w-full overflow-hidden',
      )}
      // 关掉浏览器默认的触摸手势（下拉刷新、双指缩放整页），
      // 否则手机上捏合会缩放整个页面而不是画布
      style={{ touchAction: zoomed ? 'none' : 'pan-y' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      <svg
        // viewBox 由 layoutSlots 给，与容器 1:1 —— 槽位坐标已经按容器比例
        // 拉伸过，所以这里不需要 meet 留边，也不再有「贴宽 + 滚动」的分支。
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        className={cn('h-full w-full', zoomed && 'cursor-grab')}
        onClick={(e) => {
          if (wasDrag()) return
          if (e.target === e.currentTarget) onSelect(null)
        }}
      >
        {/* 缩放平移只作用在这一层：viewBox 固定，留边只在 baseScale 里算一次 */}
        <g transform={transformOf(view)}>
        {/* 连线压在节点下面 */}
        <g>
          {templateEdges.map(([a, b]) => {
            // 用重排后的坐标，不是槽位原始坐标 —— 原始坐标是设计稿系，
            // 连线会画到画布外面去。
            const sa = posByKey.get(a)
            const sb = posByKey.get(b)
            if (!sa || !sb) return null
            const dim = neighbours != null && !(neighbours.has(a) && neighbours.has(b))
            return (
              <line
                key={`${a}-${b}`}
                x1={sa.x}
                y1={sa.y}
                x2={sb.x}
                y2={sb.y}
                stroke="var(--pm-border)"
                // 线宽跟着节点缩：viewBox 现在是 1:1 像素，写死 5 会让小节点
                // 被粗线压住（原来 viewBox 有 0.58 的缩放，视觉上只有 3px）。
                strokeWidth={5 * nodeScale}
                opacity={dim ? 0.15 : 0.65}
              />
            )
          })}
        </g>

        <g>
          {placed.map((s) => {
            const isGoals = s.kind === 'goals'
            const empty = !isGoals && !s.nodeId
            const selected = selectedKey === s.key
            const dim = neighbours != null && !neighbours.has(s.key)
            const prev = prevPrices[s.key]
            const delta = s.price != null && prev != null ? s.price - prev : null

            const hit = slotHit(s, goals)
            const fill = empty
              ? 'transparent'
              : isGoals
                ? PINK
                : hit
                  ? s.quoted
                    ? GREEN
                    : GREEN_DIM
                  : s.quoted
                    ? BLUE
                    : BLUE_DIM
            const stroke = selected
              ? 'var(--pm-primary)'
              : empty
                ? 'var(--pm-neutral-500)'
                : 'transparent'

            return (
              <g
                key={s.key}
                // 拉伸只作用在圆心坐标；节点自身按 r/BASE_R 等比缩放，
                // 所以圆永远是圆、字永远不斜。内部偏移与字号仍写设计稿的数，
                // 跟着这层 scale 一起变 —— 不必再手写第二份「小屏用的字号」。
                transform={`translate(${s.x} ${s.y}) scale(${nodeScale})`}
                opacity={dim ? 0.28 : 1}
                style={{ cursor: empty ? 'default' : 'pointer' }}
                onClick={(ev) => {
                  ev.stopPropagation()
                  // 拖动结束时浏览器也会派发 click。少了这道判断，
                  // 在节点上平移会误触发下单 —— 触屏上几乎必然发生。
                  if (wasDrag()) return
                  if (empty) return
                  // 绑了盘口的节点点进去直接开下单界面。中心三个推断节点没有
                  // 盘口，只做聚焦高亮。
                  if (onBuy && s.kind === 'market' && s.tokenId && s.marketId) {
                    onBuy(s)
                    return
                  }
                  onSelect(selected ? null : s.key)
                }}
                onMouseEnter={() => !empty && setHover(s)}
                onMouseLeave={() => setHover(null)}
              >
                <circle
                  cx={0}
                  cy={0}
                  r={BASE_R}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={selected ? 6 : 3}
                  strokeDasharray={empty ? '10 8' : s.quoted || isGoals ? undefined : '12 8'}
                />
                {/* 已打出的标记：不让「已打出」只靠颜色表达 */}
                {hit === true && (
                  <text
                    x={0}
                    y={-46}
                    textAnchor="middle"
                    fill="#ffffff"
                    style={{ fontSize: 18, fontWeight: 700 }}
                  >
                    ✓ 已打出
                  </text>
                )}

                {/* 上：盘口信息 */}
                <text
                  x={0}
                  y={-18}
                  textAnchor="middle"
                  fill={empty ? 'var(--pm-neutral-400)' : '#ffffff'}
                  style={{ fontSize: labelFont(s.label), fontWeight: 600 }}
                >
                  {s.label}
                </text>

                {isGoals ? (
                  /* 推断节点没有买卖两侧，居中显示进球数 */
                  <text
                    x={0}
                    y={30}
                    textAnchor="middle"
                    fill="#ffffff"
                    className="font-mono"
                    style={{ fontSize: 40, fontWeight: 700 }}
                  >
                    {s.goals != null ? `${s.goals} 球` : '—'}
                  </text>
                ) : empty ? (
                  <text
                    x={0}
                    y={26}
                    textAnchor="middle"
                    fill="var(--pm-neutral-500)"
                    style={{ fontSize: 24, fontWeight: 600 }}
                  >
                    无此盘
                  </text>
                ) : (
                  <>
                    {/* 品字形的横竖分隔：让「上一 / 下二」的结构一眼可读 */}
                    <line
                      x1={-52}
                      y1={-2}
                      x2={52}
                      y2={-2}
                      stroke="#ffffff"
                      strokeWidth={1}
                      opacity={0.35}
                    />
                    <line
                      x1={0}
                      y1={-2}
                      x2={0}
                      y2={46}
                      stroke="#ffffff"
                      strokeWidth={1}
                      opacity={0.35}
                    />
                    {/* 下左：卖盘（你买入要付的价） */}
                    <text
                      x={-27}
                      y={16}
                      textAnchor="middle"
                      fill="#ffffff"
                      style={{ fontSize: 15, fontWeight: 600 }}
                      opacity={0.8}
                    >
                      卖
                    </text>
                    <text
                      x={-27}
                      y={38}
                      textAnchor="middle"
                      fill="#ffffff"
                      className="font-mono"
                      style={{ fontSize: 20, fontWeight: 700 }}
                    >
                      {formatPrice(s.ask, priceMode)}
                    </text>
                    {/* 下右：买盘（你卖出能收的价） */}
                    <text
                      x={27}
                      y={16}
                      textAnchor="middle"
                      fill="#ffffff"
                      style={{ fontSize: 15, fontWeight: 600 }}
                      opacity={0.8}
                    >
                      买
                    </text>
                    <text
                      x={27}
                      y={38}
                      textAnchor="middle"
                      fill="#ffffff"
                      className="font-mono"
                      style={{ fontSize: 20, fontWeight: 700 }}
                    >
                      {formatPrice(s.bid, priceMode)}
                    </text>
                    {/* 价格变化：贴在底部，不挤占品字形 */}
                    {delta != null && Math.abs(delta) >= 0.001 && (
                      <text
                        x={0}
                        y={62}
                        textAnchor="middle"
                        className="font-mono"
                        fill={delta > 0 ? 'var(--pm-state-success)' : 'var(--pm-state-error)'}
                        style={{ fontSize: 19, fontWeight: 700 }}
                      >
                        {delta > 0 ? '▲' : '▼'}
                        {Math.abs(delta * 100).toFixed(1)}
                      </text>
                    )}
                  </>
                )}
              </g>
            )
          })}
        </g>
        </g>
      </svg>

      {/*
        缩放控件。放在容器里而不是 SVG 里：SVG 内的按钮会跟内容一起缩放和平移，
        放大后自己就跑出画面了 —— 而那正是最需要「复位」的时候。
      */}
      <div className="pointer-events-auto absolute bottom-3 right-3 z-40 flex flex-col gap-1">
        <button
          type="button"
          aria-label="放大"
          onClick={() => zoomAtCenter(BUTTON_STEP)}
          className="h-8 w-8 rounded-md border border-border bg-popover/90 text-sm text-foreground/80 hover:bg-muted"
        >
          +
        </button>
        <button
          type="button"
          aria-label="缩小"
          onClick={() => zoomAtCenter(1 / BUTTON_STEP)}
          className="h-8 w-8 rounded-md border border-border bg-popover/90 text-sm text-foreground/80 hover:bg-muted"
        >
          −
        </button>
        {zoomed && (
          <button
            type="button"
            aria-label="复位"
            onClick={() => setView(IDENTITY)}
            className="h-8 w-8 rounded-md border border-primary/60 bg-popover/90 text-[10px] text-primary hover:bg-muted"
          >
            复位
          </button>
        )}
      </div>

      {hover && (
        <SlotTooltip
          slot={hover}
          node={hover.nodeId ? nodeById.get(hover.nodeId) : undefined}
          hit={slotHit(hover, goals)}
          priceMode={priceMode}
        />
      )}
    </div>
  )
}

const DIR_TEXT: Record<string, string> = {
  up: '推高',
  down: '压低',
  kill: '直接判死',
  flat: '几乎不动',
}

function SlotTooltip({
  slot,
  node,
  hit,
  priceMode,
}: {
  slot: GraphSlot
  node?: GraphNode
  /** 该线是否已打出。null = 比分未知或非进球盘 */
  hit: boolean | null
  priceMode: PriceMode
}) {
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-50 w-80 rounded-lg border border-border bg-popover p-3 shadow-2">
      <p className="text-xs font-semibold text-foreground">{slot.label}</p>
      {slot.kind === 'market' && slot.tokenId && (
        <p className="mt-0.5 text-[10px] text-primary">点击直接下单</p>
      )}

      {hit != null && slot.hitNeed != null && (
        <p className={cn('mt-1 text-[10px]', hit ? 'text-success' : 'text-muted-foreground')}>
          {hit
            ? `已打出（需 ${slot.hitNeed} 球，推断已达）`
            : `未打出（需 ${slot.hitNeed} 球）`}
        </p>
      )}

      {slot.kind === 'goals' ? (
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          无对应盘口。进球数由大小球梯子反推：某条线的 Over 买价钉在 0.99
          就说明该线已打出。推不出来时显示「—」，不猜。
        </p>
      ) : !node ? (
        <p className="mt-1 text-[10px] text-muted-foreground">这场比赛没有挂这条线。</p>
      ) : (
        <>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            {node.questionZh || node.questionEn}
          </p>
          <div className="mt-2 space-y-1">
            {node.sides.map((sd) => (
              <div key={sd.name} className="flex items-center justify-between gap-2 text-[10px]">
                <span
                  className={cn(
                    'truncate',
                    sd.name === slot.sideName ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {sd.name}
                  {sd.name === slot.sideName && ' ·本节点'}
                </span>
                {/* 顺序与节点上一致：卖 / 买 */}
                <span className="shrink-0 font-mono text-foreground">
                  {sd.bid != null || sd.ask != null ? (
                    <>
                      卖 {formatPrice(sd.ask, priceMode)} / 买 {formatPrice(sd.bid, priceMode)}
                    </>
                  ) : sd.price != null ? (
                    <span className="text-muted-foreground">
                      {formatPrice(sd.price, priceMode)} 快照
                    </span>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 border-t border-border pt-2 text-[10px] text-muted-foreground">
            <p>
              进球影响：主队进球{DIR_TEXT[node.impact.homeGoal]}，客队进球
              {DIR_TEXT[node.impact.awayGoal]}
            </p>
            {node.impact.modelled ? (
              <p>
                幅度{' '}
                <span className="font-mono text-foreground">
                  {node.impact.magnitude.toFixed(3)}
                </span>
              </p>
            ) : (
              <p className="text-warning">幅度未建模</p>
            )}
            <p>
              成交 {formatVolume(node.volume)} · 挂单 {formatVolume(node.liquidity)}
            </p>
            {!slot.quoted && <p className="text-warning">仅快照价，非实时盘口</p>}
          </div>
        </>
      )}
    </div>
  )
}
