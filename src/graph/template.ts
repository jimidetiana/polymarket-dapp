/**
 * 盘口关系图的**固定模板**（来自设计稿 盘口关系图.pdf）。
 *
 * ## 为什么是固定模板，而不是按数据长出来的布局
 *
 * 需求原话：「所有比赛应该可以采用同一套标准进行梳理，形成一张网状图」。
 * 所以骨架必须与具体比赛无关——同一个槽位在每场比赛都在同一个位置，
 * 这样看第二场时不用重新找方位。数据只决定槽位里填什么，不决定拓扑。
 *
 * 之前那版按 family 分列、按 line 排行，等于把网状图摊成了表格：
 * 位置由数据长出来，每场比赛的形状都不一样，且完全看不出「进球」是
 * 整张图的中心。这次改成照搬设计稿的坐标与连线。
 *
 * ## 三类槽位
 *
 *   goals   中间三个（进球 / 主队进球 / 客队进球）——**没有对应盘口**，
 *           显示由盘口反推出的进球数（见 inferGoalCounts）。
 *   market  其余 23 个，各绑一个真实盘口的**某一侧**，显示该侧价格。
 *   缺失     某场比赛没挂这条线时槽位保留但标记为空，位置不动——
 *           位置固定才是「同一套标准」的意思。
 *
 * ## 让球槽位为什么要指定「哪一侧」
 *
 * 平台只挂让球方（线恒为负）：库里只有 `Spread: {H} (-1.5)` 和
 * `Spread: {A} (-1.5)` 两种问句，没有 `(+1.5)` 的写法。
 * 所以设计稿里的「主队 +1.5」其实是 `Spread: {A} (-1.5)` 这张盘的**主队那一侧**。
 * 一张盘喂两个槽位，两个槽位的价格之和应当≈1，正好可以互相校验。
 */
import type { MarketGraph, GraphNode, Period } from './types.js'

export type SlotKind = 'goals' | 'market'

/** 绑定规则：从盘口描述里认出该槽位对应的那张盘、那一侧 */
export interface SlotBind {
  family: 'ou' | 'moneyline' | 'spread'
  period: Period
  /** ou 用：match/home/away；spread 用：被点名的队（决定线的符号与取哪侧） */
  subject?: 'match' | 'home' | 'away'
  /** ou 的线；spread 的线（以 subject 视角，正负都可能） */
  line?: number
  /** moneyline 的槽位 */
  role?: 'home' | 'draw' | 'away'
  /** 取哪一侧的价：over=Over 侧，yes=Yes 侧，home/away=对应球队那一侧 */
  side: 'over' | 'yes' | 'home' | 'away'
}

export interface TemplateSlot {
  key: string
  label: string
  kind: SlotKind
  /** SVG 坐标（已按设计稿翻转 Y） */
  x: number
  y: number
  bind?: SlotBind
  /** kind=goals 时算哪个主体的进球数 */
  goalsOf?: 'total' | 'home' | 'away'
}

/**
 * 26 个槽位。
 *
 * 前 22 个的坐标直接取设计稿，Y 已翻转（PDF 的 Y 向上，SVG 向下）：
 *   svgY = 1775 − pdfY
 *
 * 后加的 4 个（总进球 4.5 / 5.5、主客队总进球 2.5）不在设计稿里，按各自梯子
 * **最后一步的向量再走一步**推出来，所以会落到设计稿 1334×1775 的框外
 * （y 为负、x 越界）。这无妨：排布时 lib/layout.ts 把全部坐标归一到容器，
 * 只有相对位置有意义。
 */
export const TEMPLATE_SLOTS: TemplateSlot[] = [
  // ---- 全场大小球梯子（图的上半），自下而上左右交替 ----
  { key: 'total_5.5', label: '总进球 5.5', kind: 'market', x: 813, y: -300,
    bind: { family: 'ou', period: 'ft', subject: 'match', line: 5.5, side: 'over' } },
  { key: 'total_4.5', label: '总进球 4.5', kind: 'market', x: 552, y: -94,
    bind: { family: 'ou', period: 'ft', subject: 'match', line: 4.5, side: 'over' } },
  { key: 'total_3.5', label: '总进球 3.5', kind: 'market', x: 813, y: 112,
    bind: { family: 'ou', period: 'ft', subject: 'match', line: 3.5, side: 'over' } },
  { key: 'total_2.5', label: '总进球 2.5', kind: 'market', x: 552, y: 318,
    bind: { family: 'ou', period: 'ft', subject: 'match', line: 2.5, side: 'over' } },
  { key: 'total_1.5', label: '总进球 1.5', kind: 'market', x: 818, y: 481,
    bind: { family: 'ou', period: 'ft', subject: 'match', line: 1.5, side: 'over' } },
  { key: 'total_0.5', label: '总进球 0.5', kind: 'market', x: 552, y: 626,
    bind: { family: 'ou', period: 'ft', subject: 'match', line: 0.5, side: 'over' } },

  // ---- 单队大小球（两翼），从中心向外上方延伸 ----
  { key: 'home_2.5', label: '主队总进球 2.5', kind: 'market', x: -93, y: 671,
    bind: { family: 'ou', period: 'ft', subject: 'home', line: 2.5, side: 'over' } },
  { key: 'away_2.5', label: '客队总进球 2.5', kind: 'market', x: 1419, y: 709,
    bind: { family: 'ou', period: 'ft', subject: 'away', line: 2.5, side: 'over' } },
  { key: 'home_1.5', label: '主队总进球 1.5', kind: 'market', x: 112, y: 799,
    bind: { family: 'ou', period: 'ft', subject: 'home', line: 1.5, side: 'over' } },
  { key: 'away_1.5', label: '客队总进球 1.5', kind: 'market', x: 1222, y: 799,
    bind: { family: 'ou', period: 'ft', subject: 'away', line: 1.5, side: 'over' } },
  { key: 'away_0.5', label: '客队总进球 0.5', kind: 'market', x: 1025, y: 889,
    bind: { family: 'ou', period: 'ft', subject: 'away', line: 0.5, side: 'over' } },
  { key: 'home_0.5', label: '主队总进球 0.5', kind: 'market', x: 317, y: 927,
    bind: { family: 'ou', period: 'ft', subject: 'home', line: 0.5, side: 'over' } },

  // ---- 中心三个：无盘口，显示推断进球数 ----
  { key: 'goals_total', label: '进球', kind: 'goals', x: 693, y: 846, goalsOf: 'total' },
  { key: 'goals_home', label: '主队进球', kind: 'goals', x: 567, y: 1017, goalsOf: 'home' },
  { key: 'goals_away', label: '客队进球', kind: 'goals', x: 818, y: 1017, goalsOf: 'away' },

  // ---- 胜平负 ----
  { key: 'ml_home', label: '主胜', kind: 'market', x: 415, y: 1211,
    bind: { family: 'moneyline', period: 'ft', role: 'home', side: 'yes' } },
  { key: 'ml_draw', label: '平', kind: 'market', x: 693, y: 1220,
    bind: { family: 'moneyline', period: 'ft', role: 'draw', side: 'yes' } },
  { key: 'ml_away', label: '客胜', kind: 'market', x: 985, y: 1220,
    bind: { family: 'moneyline', period: 'ft', role: 'away', side: 'yes' } },

  // ---- 让球（图的下半）。line 以 subject 视角，side 决定取哪侧价 ----
  { key: 'sp_home_-1.5', label: '主队 -1.5', kind: 'market', x: 230, y: 1396,
    bind: { family: 'spread', period: 'ft', subject: 'home', line: -1.5, side: 'home' } },
  { key: 'sp_home_+1.5', label: '主队 +1.5', kind: 'market', x: 563, y: 1411,
    bind: { family: 'spread', period: 'ft', subject: 'home', line: 1.5, side: 'home' } },
  { key: 'sp_away_-1.5', label: '客队 -1.5', kind: 'market', x: 843, y: 1411,
    bind: { family: 'spread', period: 'ft', subject: 'away', line: -1.5, side: 'away' } },
  { key: 'sp_away_+1.5', label: '客队 +1.5', kind: 'market', x: 1164, y: 1411,
    bind: { family: 'spread', period: 'ft', subject: 'away', line: 1.5, side: 'away' } },
  { key: 'sp_home_-2.5', label: '主队 -2.5', kind: 'market', x: 230, y: 1663,
    bind: { family: 'spread', period: 'ft', subject: 'home', line: -2.5, side: 'home' } },
  { key: 'sp_home_+2.5', label: '主队 +2.5', kind: 'market', x: 563, y: 1663,
    bind: { family: 'spread', period: 'ft', subject: 'home', line: 2.5, side: 'home' } },
  { key: 'sp_away_-2.5', label: '客队 -2.5', kind: 'market', x: 843, y: 1654,
    bind: { family: 'spread', period: 'ft', subject: 'away', line: -2.5, side: 'away' } },
  { key: 'sp_away_+2.5', label: '客队 +2.5', kind: 'market', x: 1164, y: 1663,
    bind: { family: 'spread', period: 'ft', subject: 'away', line: 2.5, side: 'away' } },
]

/** 设计稿的 22 条连线加后补的 4 条，按槽位 key */
export const TEMPLATE_EDGES: Array<[string, string]> = [
  // 中心向两侧展开
  ['goals_total', 'goals_home'],
  ['goals_total', 'goals_away'],
  // 中心 → 全场大小球梯子
  ['goals_total', 'total_0.5'],
  ['total_0.5', 'total_1.5'],
  ['total_1.5', 'total_2.5'],
  ['total_2.5', 'total_3.5'],
  ['total_3.5', 'total_4.5'],
  ['total_4.5', 'total_5.5'],
  // 单队进球 → 单队大小球
  ['goals_home', 'home_0.5'],
  ['home_0.5', 'home_1.5'],
  ['home_1.5', 'home_2.5'],
  ['goals_away', 'away_0.5'],
  ['away_0.5', 'away_1.5'],
  ['away_1.5', 'away_2.5'],
  // 单队进球 → 胜平负
  ['goals_home', 'ml_home'],
  ['goals_home', 'ml_draw'],
  ['goals_away', 'ml_draw'],
  ['goals_away', 'ml_away'],
  // 胜平负 → 让球
  ['ml_home', 'sp_home_-1.5'],
  ['ml_home', 'sp_home_+1.5'],
  ['ml_away', 'sp_away_-1.5'],
  ['ml_away', 'sp_away_+1.5'],
  // 让球梯子
  ['sp_home_-1.5', 'sp_home_-2.5'],
  ['sp_home_+1.5', 'sp_home_+2.5'],
  ['sp_away_-1.5', 'sp_away_-2.5'],
  ['sp_away_+1.5', 'sp_away_+2.5'],
]

/** 队名归一：库里与 outcome 里的写法常不一致（FC/CF/SC/AFC 后缀） */
function normTeam(s: string): string {
  return String(s || '')
    .trim()
    .replace(/\s+(FC|CF|SC|AFC)$/i, '')
    .toLowerCase()
}

/**
 * 让球槽位换算到主队视角，用来找盘口。
 *
 * 「客队 -1.5」= 客队让 1.5 球 = 主队受让 1.5 → homeLine = +1.5。
 * 「主队 +1.5」= 主队受让 1.5 → homeLine = +1.5（同一张盘的另一侧）。
 */
function slotHomeLine(bind: SlotBind): number | null {
  if (bind.line == null) return null
  return bind.subject === 'away' ? -bind.line : bind.line
}

function findNode(graph: MarketGraph, bind: SlotBind): GraphNode | null {
  for (const n of graph.nodes) {
    const d = n.desc
    if (d.family !== bind.family || d.period !== bind.period) continue
    if (bind.family === 'ou') {
      if (d.metric !== 'goals') continue
      if (d.subject !== bind.subject) continue
      if (d.line !== bind.line) continue
      return n
    }
    if (bind.family === 'moneyline') {
      if (d.role !== bind.role) continue
      return n
    }
    // spread：按主队视角的线找盘，两个槽位会命中同一张
    if (d.homeLine != null && d.homeLine === slotHomeLine(bind)) return n
  }
  return null
}

/** 在节点的 sides 里挑出该槽位要显示的那一侧 */
function findSide(node: GraphNode, bind: SlotBind, graph: MarketGraph): string | null {
  const names = node.sides.map((s) => s.name)
  if (bind.side === 'over') {
    return names.find((n) => n.trim().toLowerCase() === 'over') ?? names[0] ?? null
  }
  if (bind.side === 'yes') {
    return names.find((n) => n.trim().toLowerCase() === 'yes') ?? names[0] ?? null
  }
  const want = normTeam(bind.side === 'home' ? graph.homeTeamEn : graph.awayTeamEn)
  return names.find((n) => normTeam(n) === want) ?? null
}

export interface ResolvedSlot extends TemplateSlot {
  /** 绑到的盘口节点 id；null = 这场比赛没挂这条线 */
  nodeId: string | null
  /** 原始盘口 id，给足球页下单深链用（nodeId 是进程内生成的 `m${id}`） */
  marketId: string | null
  /** 显示哪一侧的价 */
  sideName: string | null
  /**
   * 该侧的 token。回放时用它把槽位对到历史价格序列——
   * 历史表是按 token 存的，nodeId 是进程内生成的，跨请求不稳定。
   */
  tokenId: string | null
  /** 该侧的买一/卖一与中价 */
  bid: number | null
  ask: number | null
  price: number | null
  /** 是否有真实双边盘口（false = 只有可能过期的快照价） */
  quoted: boolean
  /** kind=goals 时的进球数；推不出来为 null */
  goals: number | null
  /**
   * 「这条线要几个球才算打出」。只有大小球进球盘有值，其余为 null。
   *
   * 给的是**判据**而不是判定结果（hit 布尔），因为回放时要按所选帧的比分
   * 重新判，而那个比分只有前端知道。判据是结构性的、不随时间变，判定留给
   * 拿到比分的那一方做，两边就不会各写一份规则。
   *
   * 让球盘和胜平负没有这个概念：让球是「此刻领先够不够」，会来回变，
   * 不是「打出了就不回头」。所以它们不参与变绿。
   */
  hitNeed: number | null
  /** 跟谁的进球数比。match 记成 total，与 GoalCounts 的字段名对齐 */
  hitSubject: 'total' | 'home' | 'away' | null
  /** 进球影响幅度（来自绑定节点），供着色 */
  magnitude: number
  modelled: boolean
}

export interface GoalCounts {
  total: number | null
  home: number | null
  away: number | null
}

/** 这条大小球线要几个球才算打出。非进球盘返回 null */
function hitNeedOf(bind: SlotBind | undefined): number | null {
  if (!bind || bind.family !== 'ou' || bind.line == null) return null
  return Math.round(bind.line + 0.5)
}

function hitSubjectOf(bind: SlotBind | undefined): 'total' | 'home' | 'away' | null {
  if (!bind || bind.family !== 'ou') return null
  if (bind.subject === 'home') return 'home'
  if (bind.subject === 'away') return 'away'
  return 'total'
}

/**
 * 这条线是否已被进球打出。null = 比分未知，判不了。
 *
 * 与前端同一份规则——前端在回放时按所选帧的比分调它，实时时用后端算好的。
 */
export function isSlotHit(
  hitNeed: number | null,
  hitSubject: 'total' | 'home' | 'away' | null,
  goals: GoalCounts,
): boolean | null {
  if (hitNeed == null || hitSubject == null) return null
  const g = goals[hitSubject]
  if (g == null) return null
  return g >= hitNeed
}

/**
 * 把模板与一场比赛的数据合成可渲染的槽位。
 *
 * 找不到盘口时**保留槽位**并置 nodeId=null：位置固定是「同一套标准」的
 * 前提，缺哪条线要能一眼看出来，而不是让图变形。
 */
export function resolveTemplate(graph: MarketGraph, goals: GoalCounts): ResolvedSlot[] {
  return TEMPLATE_SLOTS.map((slot) => {
    const base: ResolvedSlot = {
      ...slot,
      nodeId: null,
      marketId: null,
      sideName: null,
      tokenId: null,
      bid: null,
      ask: null,
      price: null,
      quoted: false,
      goals: null,
      magnitude: 0,
      modelled: false,
      hitNeed: hitNeedOf(slot.bind),
      hitSubject: hitSubjectOf(slot.bind),
    }
    if (slot.kind === 'goals') {
      base.goals = slot.goalsOf ? goals[slot.goalsOf] : null
      return base
    }
    if (!slot.bind) return base
    const node = findNode(graph, slot.bind)
    if (!node) return base
    const sideName = findSide(node, slot.bind, graph)
    const side = node.sides.find((s) => s.name === sideName) ?? null
    const bid = side?.bid ?? null
    const ask = side?.ask ?? null
    return {
      ...base,
      nodeId: node.id,
      marketId: node.marketId,
      sideName,
      tokenId: side?.tokenId ?? null,
      bid,
      ask,
      price: bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask ?? side?.price ?? null),
      quoted: Boolean(side?.quoted),
      magnitude: node.impact.magnitude,
      modelled: node.impact.modelled,
    }
  })
}
