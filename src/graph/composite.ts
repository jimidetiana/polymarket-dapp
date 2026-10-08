/**
 * 合成盘口：把官方没挂的整数线（-1、-2）和四分之一线（-0.75、-1.75）
 * 用**相邻两档**合出来。
 *
 * ## 比例由赔率定，不由几何位置定
 *
 * 这是本模块唯一要紧的一条，写错不会报错，只会让你拿到另一个仓位。
 *
 * 拿主队 -1 举例。它**不是**"一半 -0.5 加一半 -1.5"——那是赔率正好 2.0 时
 * 才成立的巧合。整数线的定义是：**多进一个球走水**（净额为零），多进两个
 * 以上赢全部。走水这条约束直接把比例钉死了：
 *
 *   A(1 − p_易)/p_易 = B        （易腿的盈利覆盖难腿的亏损）
 *   ⇒ A/(A+B) = p_易
 *
 * 也就是**押在易腿上的注金比例 = 易腿的价格**。p_易 = 0.5 时它才是 50/50；
 * 实测 p_易 = 0.6 时按 50/50 配，m=1 会亏掉本金的 19%，根本不是走水。
 *
 * 四分之一线（-0.75 / -1.25）是"半注押相邻半线 + 半注押相邻整数线"，
 * 代进去化简后（d = 从易腿往难腿走的距离）：
 *
 *   d=0.25 → W_易 = (1 + p_易)/2
 *   d=0.50 → W_易 = p_易
 *   d=0.75 → W_易 = p_易/2
 *
 * 三者只在 p_易 = 0.5 时退化成 0.75 / 0.5 / 0.25 的几何值。
 *
 * ## 由此推出的三个后果
 *
 *  1. **比例随行情漂移。** 价一动，权重就跟着变。任何"先算好权重再下单"的
 *     做法都会在盘口动过之后失真 —— 权重必须在下单那一刻按当时的价重算。
 *  2. **缺卖价时连比例都算不出来**（不只是价格算不出来）。所以没有报价时
 *     界面上不能显示任何权重，只能明说算不出来。
 *  3. **几何位置只用来"选哪条线"，不决定权重。** 所以只提供三个锚点
 *     （-0.75 / -1 / -1.25），没有自由拖动 —— 拖到四分之一处却拿到 60/40
 *     的权重，比不给这个功能更糟。
 *
 * ## 两腿必须是同一支球队、同一条梯子、只差一档
 *
 *   - 跨两档的边（主胜 ↔ 主队+1.5，从 -0.5 直接到 +1.5）中间隔着 +0.5 一档，
 *     沿它插值出来的线不是任何标准盘口。那类边在图上仍然存在（它是条有效的
 *     不等式约束），但**不能合成**。
 *   - 主队 -0.75 与客队 +0.75 是**同一条边的两侧**：同样的两张盘、同样的权重，
 *     只是各取另一侧的 token。所以"反向线"不需要新边，换侧在下单那一层做。
 *
 * ## 口径：线的正负
 *
 * 每腿的线按**自己球队**的口径记（主胜 = 主队 -0.5；客胜 = 客队 -0.5）。
 * 在这个口径下**线值越大越容易打出**（主队 -0.5 比 -1.5 易；客队 +2.5 比 +1.5 易），
 * 所以"易腿"就是线值较大的那一腿，与球队无关。
 *
 * ⚠️ 手续费（builder 5bps 与平台费）会让走水略偏负 —— 这里是纯盘口的等价，
 * 不含费。要精确到分得在下单那一层算。
 */
import { tr } from '../lib/i18n'
import type { ResolvedSlot } from './template.js'

/**
 * 线差判据的容差。
 *
 * 线都是 .5 的倍数，正常不会有浮点偏差，留一点余量只是防解析出来的线带小数尾巴
 * 时被判成"不相邻" —— 那会让整条边静默消失，比放宽更糟。
 */
const LINE_EPS = 1e-9

/**
 * 三个锚点：从易腿往难腿走的距离。
 *
 * 0.5 = 整数线（走水），0.25 / 0.75 = 两条四分之一线。这就是一个区间里
 * **全部**有名字的标准盘口 —— 别的比例合出来的东西没有名字，也就没有意义。
 */
export const ANCHOR_DS = [0.25, 0.5, 0.75] as const

export type CompositeLeg = {
  /** 槽位 key。两边槽位是同一张盘时也只按 key 区分，这里不做去重 */
  slotKey: string
  /** 这条腿打哪支球队的口径 */
  team: 'home' | 'away'
  /** 该队口径下的让球线。主胜 / 客胜记作 -0.5（赢球盘与 -0.5 让球是同一个命题） */
  line: number
  /** 槽位标签（「主队 -1.5」「主胜」），用在权重那一行 */
  label: string
  tokenId: string | null
  marketId: string | null
  /**
   * 这一腿此刻的**卖价**（买入要付的价）。null = 没有真实报价。
   *
   * 只认 ask，不退回快照价 —— 与 graph.ts 的 tradeAsk 同一条原则：拿快照价
   * 当可成交价会给出一个根本买不到的价格。而且这里更狠：比例本身就是由它算的，
   * 快照价会直接算出一套错的权重。
   */
  ask: number | null
}

export type CompositeEdge = {
  id: string
  /** t=0 落在这条腿上 */
  from: CompositeLeg
  /** t=1 落在这条腿上 */
  to: CompositeLeg
  /** 哪一端更松（更容易打出）。走水条件按它定价 */
  easy: 'from' | 'to'
}

/**
 * 槽位 → 合成腿。返回 null 表示这个槽位不参与合成。
 *
 * 让球的口径换算：`side` 与 `subject` 是同一队时，这条腿就是"该队让 line 球"；
 * 取对面那一侧时它是这条腿的**补集**，线取反（客队 -1.5 的另一侧 = 主队 +1.5）。
 */
export function legOf(slot: ResolvedSlot | undefined): CompositeLeg | null {
  if (!slot || !slot.nodeId || !slot.bind) return null
  const b = slot.bind
  if (b.period !== 'ft') return null
  if (b.family !== 'spread' && b.family !== 'moneyline') return null

  let team: 'home' | 'away' | null = null
  let line: number | null = null

  if (b.family === 'moneyline') {
    // 让球线口径下主胜 = -0.5（没有平局态，两个命题完全等价）；平局不是让球盘
    if (b.role === 'home' || b.role === 'away') {
      team = b.role
      line = -0.5
    }
  } else if (b.side === 'home' || b.side === 'away') {
    team = b.side
    line = b.line == null ? null : b.side === b.subject ? b.line : -b.line
  }

  if (!team || line == null) return null
  return {
    slotKey: slot.key,
    team,
    line,
    label: slot.label,
    tokenId: slot.tokenId,
    marketId: slot.marketId,
    ask: slot.ask,
  }
}

/**
 * 从模板边里挑出**可合成**的那些。
 *
 * 判据全在数据里（同队 + 只差一档），不写死边表 —— 写死会在盘口增减、
 * 模板加档时静默失效，而失效的表现是"那几条线的锚点不见了"，
 * 很容易被当成没挂盘口。
 *
 * `slots` 传当前**可见**的槽位：折叠起来的外档不该有锚点。
 */
export function compositeEdges(
  slots: readonly ResolvedSlot[],
  templateEdges: ReadonlyArray<readonly [string, string]>,
): CompositeEdge[] {
  const byKey = new Map(slots.map((s) => [s.key, s]))
  const out: CompositeEdge[] = []
  for (const [a, b] of templateEdges) {
    const from = legOf(byKey.get(a))
    const to = legOf(byKey.get(b))
    if (!from || !to) continue
    if (from.team !== to.team) continue
    if (Math.abs(Math.abs(to.line - from.line) - 1) > LINE_EPS) continue
    out.push({ id: `${a}~${b}`, from, to, easy: from.line > to.line ? 'from' : 'to' })
  }
  return out
}

/** 易腿（更容易打出的那一档）。走水条件按它的价定价 */
export function easyLeg(e: CompositeEdge): CompositeLeg {
  return e.easy === 'from' ? e.from : e.to
}

/** 难腿 */
export function hardLeg(e: CompositeEdge): CompositeLeg {
  return e.easy === 'from' ? e.to : e.from
}

/**
 * 锚点在边上的几何位置 t（0~1，从 from 走到 to）。
 *
 * 只用来画点：权重与线值都由 d 直接算，不经过 t —— 免得"几何比例 = 注金比例"
 * 这个错觉又从某条路径上溜回来。
 */
export function anchorT(e: CompositeEdge, d: number): number {
  return e.easy === 'from' ? d : 1 - d
}

/** 离指针最近的那个锚点。悬停时用它把指针位置折成一条标准线 */
export function nearestAnchorD(e: CompositeEdge, t: number): number {
  let best: number = ANCHOR_DS[0]
  let bestDist = Infinity
  for (const d of ANCHOR_DS) {
    const dist = Math.abs(anchorT(e, d) - t)
    if (dist < bestDist) {
      bestDist = dist
      best = d
    }
  }
  return best
}

/** 合成出来的让球线（易腿球队的口径）。难腿方向线值递减，所以是减 */
export function lineOf(e: CompositeEdge, d: number): number {
  return easyLeg(e).line - d
}

export type CompositeWeights = {
  /** 押在易腿上的注金比例 */
  easy: number
  hard: number
}

/**
 * 两腿的注金权重 —— **由赔率定**，见文件头。
 *
 * 易腿没有卖价就返回 null：比例本身就是从它的价推出来的，没有价就没有比例，
 * 不存在"先按 50/50 摆着"这种退路。
 */
export function weightsOf(e: CompositeEdge, d: number): CompositeWeights | null {
  const p = easyLeg(e).ask
  if (p == null || !(p > 0) || p > 1) return null
  const easy = d === 0.5 ? p : d === 0.25 ? (1 + p) / 2 : p / 2
  return { easy, hard: 1 - easy }
}

/**
 * 两腿都赢时花 1 美元收回多少（欧赔口径）。
 *
 * 权重是按**当前**报价算的，所以这个数只在当下成立 —— 价一动，权重和赔率一起变。
 */
export function oddsOf(e: CompositeEdge, d: number): number | null {
  const w = weightsOf(e, d)
  const pE = easyLeg(e).ask
  const pH = hardLeg(e).ask
  if (!w || pE == null || pH == null || pE <= 0 || pH <= 0) return null
  return w.easy / pE + w.hard / pH
}

/** 两腿都有卖价：合成价能算出来 */
export function isReady(e: CompositeEdge): boolean {
  return e.from.ask != null && e.to.ask != null
}

export function teamName(team: 'home' | 'away'): string {
  return team === 'home' ? tr('主队', 'Home') : tr('客队', 'Away')
}

/** -1.75 → "-1.75"；1.5 → "+1.5"。让球线正负都要显示出来 */
export function formatLine(line: number): string {
  const r = Math.round(line * 100) / 100
  return `${r > 0 ? '+' : ''}${r}`
}

/** 合成线的标题，如「主队 -1.75」 */
export function lineLabel(e: CompositeEdge, d: number): string {
  return `${teamName(easyLeg(e).team)} ${formatLine(lineOf(e, d))}`
}

/**
 * 权重那一行，如「60% 主胜 + 40% 主队 -1.5」。
 *
 * 显示的权重**就是真正会被提交的东西**，所以两个百分比要自洽（第二个用 100 减
 * 第一个），不能各自 round。线名只是这条线的名字，权重才是仓位。
 */
export function weightsLabel(e: CompositeEdge, d: number): string | null {
  const w = weightsOf(e, d)
  if (!w) return null
  const p1 = Math.round(w.easy * 100)
  return `${p1}% ${easyLeg(e).label} + ${100 - p1}% ${hardLeg(e).label}`
}
