/**
 * 一场比赛的盘口网：节点 = 盘口，边 = **可检验的结构约束**。
 *
 * ## 边不是装饰
 *
 * 每条边都带一个不等式，两侧都有报价时就能判它有没有被破。
 * 破了就是真套利（不是「看起来怪」），例如：
 *
 *   Over 1.5 的卖价 0.60，Over 2.5 的买价 0.65
 *   → 买 Over 1.5 花 0.60，卖 Over 2.5 收 0.65，
 *     而「进 3 球」必然蕴含「进 2 球」，这 0.05 是白捡的。
 *
 * 所以边的判据一律用**可成交价**（买用 ask、卖用 bid），不用中价——
 * 中价上的「违约」多半只是价差宽，根本成交不了。
 *
 * ## 四类边
 *
 *   ladder     同一 (period, metric, subject) 的相邻档：Over 低档 ≥ Over 高档
 *   implies    子集蕴含：单队 ⊂ 全场、双方进球 ⊂ Over 1.5、准确比分 ⊂ 胜平负
 *   period     跨期间的蕴含：半场 ⊂ 全场（与 implies 同不等式，分开标便于着色）
 *   partition  完整划分：主胜 + 平 + 客胜 = 1
 *
 * ## 布局为什么不用力导向
 *
 * 力导向每次刷新节点都在飘，而这里**节点身份是固定的**（盘口不会变），
 * 动的只有价格。列 = 家族域，行 = 期间 + 线，于是同一条梯子在图上就是
 * 竖着相邻的一串，肉眼能顺着看下去。
 */
import { parseMarket } from './parse.js'
import {
  goalImpact,
  inferLambdas,
  nodeProbability,
  PRE_MATCH,
  type Lambdas,
  type LambdaSample,
  type MatchState,
} from './sensitivity.js'
import type {
  GraphColumn,
  GraphEdge,
  GraphGroup,
  GraphNode,
  GraphSide,
  MarketDescriptor,
  MarketGraph,
  Period,
} from './types.js'

export interface GraphMarketInput {
  id: string
  /**
   * 盘口的 conditionId。**按盘口查持仓/成交只能用它** —— data-api 的 `asset=`
   * 参数是静默忽略的（见 lib/positions.ts 顶部）。与 id 是两个不同的标识符：
   * id 是 Gamma 自己的编号，conditionId 是链上那张盘。
   */
  conditionId?: string | null
  questionEn: string
  questionZh?: string | null
  line?: number | string | null
  outcomes: string[]
  clobTokenIds: (string | null)[]
  outcomePrices?: (number | string | null)[]
  volume?: number | string | null
  liquidity?: number | string | null
}

export interface GraphEventInput {
  id: string
  titleZh?: string | null
  titleEn?: string | null
  homeTeamEn: string
  awayTeamEn: string
  homeTeamZh?: string | null
  awayTeamZh?: string | null
  league?: string | null
  endTime?: string | null
}

export interface BuildOptions {
  /**
   * 成交量下限（严格大于）。**不给就不过滤**。
   *
   * 原项目默认 0，因为那边的需求是「有交易量的盘口」。dapp 不能这么筛：
   * 赛前刚挂出来的盘口成交量是 0 但已经有挂单、能下单，筛掉它图上就是
   * 「无此盘」，而平台上明明有。能不能交易看 CLOB 的实时盘口，不看历史成交。
   */
  minVolume?: number
  state?: MatchState
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 队名归一：去 FC/CF/SC/AFC 后缀再比。outcome 里的写法与 event 里常不一致 */
function normTeam(s: string): string {
  return String(s || '')
    .trim()
    .replace(/\s+(FC|CF|SC|AFC)$/i, '')
    .toLowerCase()
}

/**
 * 节点的「主侧」——图上显示的那个价格，也是约束不等式里的那一侧。
 *
 * 让球盘必须取**主队那一侧**：库里两条让球盘的 outcomes 是
 * ["被点名的队","另一队"]，主客各挂一条。若各自取 outcomes[0]，
 * 两条边就一条在说「主队打过」、一条在说「客队打过」，
 * 放进同一条梯子直接比大小是错的。统一到主队视角后才可比。
 */
function pickPrimarySide(
  desc: MarketDescriptor,
  outcomes: string[],
  homeTeamEn: string,
): string {
  const find = (pred: (o: string) => boolean): string | null => outcomes.find(pred) ?? null
  switch (desc.family) {
    case 'ou':
      return find((o) => o.trim().toLowerCase() === 'over') ?? outcomes[0] ?? 'Over'
    case 'spread':
    case 'advance':
    case 'first_corner': {
      const home = normTeam(homeTeamEn)
      return find((o) => normTeam(o) === home) ?? outcomes[0] ?? ''
    }
    case 'odd_even':
      return find((o) => o.trim().toLowerCase() === 'odd') ?? outcomes[0] ?? 'Odd'
    default:
      return find((o) => o.trim().toLowerCase() === 'yes') ?? outcomes[0] ?? 'Yes'
  }
}

/** 列 = 家族域。顺序即「离进球有多近」，角球被推到最右 */
export const COLUMN_DEFS: GraphColumn[] = [
  { key: 'ml', title: '胜平负', index: 0 },
  { key: 'spread', title: '让球', index: 1 },
  { key: 'total', title: '总进球', index: 2 },
  { key: 'team', title: '单队进球', index: 3 },
  { key: 'struct', title: '进球结构', index: 4 },
  { key: 'exact', title: '准确比分', index: 5 },
  { key: 'other', title: '球员/赛果', index: 6 },
  { key: 'corner', title: '角球', index: 7 },
]

function columnOf(d: MarketDescriptor): string {
  if (d.metric === 'corners' || d.family === 'odd_even' || d.family === 'first_corner') return 'corner'
  switch (d.family) {
    case 'moneyline':
      return 'ml'
    case 'spread':
      return 'spread'
    case 'ou':
      return d.subject === 'match' ? 'total' : 'team'
    case 'btts':
    case 'first_goal':
      return 'struct'
    case 'exact':
      return 'exact'
    default:
      return 'other'
  }
}

const PERIOD_ORDER: Record<Period, number> = { ft: 0, ht: 1, '2h': 2 }
const ROLE_ORDER: Record<string, number> = { home: 0, draw: 1, away: 2 }

/** 行内排序键：期间 → 主体 → 角色 → 线。让同一条梯子竖着相邻 */
function sortKey(d: MarketDescriptor): number[] {
  const subj = d.subject === 'home' ? 0 : d.subject === 'away' ? 1 : d.subject === 'player' ? 3 : 2
  const line = d.family === 'spread' ? (d.homeLine ?? 0) : (d.line ?? 0)
  const role = d.role ? (ROLE_ORDER[d.role] ?? 9) : 0
  const score = d.score ? d.score.home * 10 + d.score.away : 0
  return [PERIOD_ORDER[d.period], subj, role, line, score]
}

function cmpKey(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 取节点主侧的报价。bid/ask 缺失时回退到 gamma 快照价（两侧同值） */
function sideOf(n: GraphNode): GraphSide | null {
  return n.sides.find((s) => s.name === n.primarySide) ?? n.sides[0] ?? null
}

function bidOf(n: GraphNode): number | null {
  const s = sideOf(n)
  return s?.bid ?? s?.price ?? null
}

function askOf(n: GraphNode): number | null {
  const s = sideOf(n)
  return s?.ask ?? s?.price ?? null
}

/**
 * 严格可成交价：**只认真实盘口的那一侧**，绝不退回快照价。
 *
 * 判违约必须用这个，不能用 bidOf/askOf。后者为了让赛前（只有快照价的）
 * 图也能算 λ 而退回 price，但拿快照价当买价/卖价就是凭空造出可成交性。
 *
 * 实测线上抓到三条假违约，全是这个原因：
 *   半场双方进球 bid=0.999 ask=null（已结算，无人卖），
 *   askOf 退回快照 0.992 当卖价 → 判出 −0.0025 的「套利」；
 *   准确比分 2-2 bid=null ask=0.508（无人买），
 *   bidOf 退回快照 0.508 当买价 → 判出 −0.0575 的「套利」。
 * 两者都根本成交不了。
 *
 * 注意 quoted=true 只表示「这个 token 回了书」，不表示两侧都有报价——
 * 已结算的盘口回的书里卖档是空的。所以这里还要各自判 null。
 */
function tradeBid(n: GraphNode): number | null {
  const s = sideOf(n)
  return s?.quoted ? (s.bid ?? null) : null
}

function tradeAsk(n: GraphNode): number | null {
  const s = sideOf(n)
  return s?.quoted ? (s.ask ?? null) : null
}

/**
 * 判 P(from) ≥ P(to) 这条边。
 *
 * 违约的可成交形式：卖 to 收 bid(to)，买 from 付 ask(from)，
 * bid(to) > ask(from) 就是净收正而风险为零（to 赢则 from 必赢）。
 */
function judgeGte(from: GraphNode, to: GraphNode): { violated: boolean; slack: number | null } {
  // 卖 to 收 bid(to)、买 from 付 ask(from)，两者都必须是真实报价
  const b = tradeBid(to)
  const a = tradeAsk(from)
  if (b == null || a == null) return { violated: false, slack: null }
  const slack = a - b
  return { violated: slack < 0, slack }
}

/** 判 P(from) ≤ P(to)，即 judgeGte 反向 */
function judgeLte(from: GraphNode, to: GraphNode): { violated: boolean; slack: number | null } {
  return judgeGte(to, from)
}

/**
 * 节点给 λ 反推用的概率样本。
 *
 * 零成交且没有实时报价的节点给 null：它的 Gamma 快照价不是任何人成交过的
 * 价，多半是挂盘时的默认值，拿它反推 λ 会把整张图的进球幅度带偏。等 CLOB
 * 回了书（quoted）再用它的买卖价 —— 那才是市场的意见。
 */
function lambdaSampleOf(n: GraphNode): LambdaSample {
  const s = sideOf(n)
  if (n.volume <= 0 && !s?.quoted) return { desc: n.desc, prob: null }
  const b = bidOf(n)
  const a = askOf(n)
  return { desc: n.desc, prob: b != null && a != null ? (b + a) / 2 : (b ?? a) }
}

function edge(
  kind: GraphEdge['kind'],
  op: GraphEdge['op'],
  from: GraphNode,
  to: GraphNode,
  constraint: string,
  judged: { violated: boolean; slack: number | null },
): GraphEdge {
  return {
    id: `${kind}:${from.id}->${to.id}`,
    kind,
    from: from.id,
    to: to.id,
    fromSide: from.primarySide,
    toSide: to.primarySide,
    op,
    constraint,
    violated: judged.violated,
    slack: judged.slack,
  }
}

/** 同一条梯子的分组键：期间 + 指标 + 主体 */
const ladderKey = (d: MarketDescriptor): string => `${d.period}|${d.metric}|${d.subject}`

function buildLadderEdges(nodes: GraphNode[]): GraphEdge[] {
  const out: GraphEdge[] = []

  // 大小球梯子：线越高越难 → P 递减
  const ouGroups = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    if (n.desc.family !== 'ou' || n.desc.line == null) continue
    const k = ladderKey(n.desc)
    if (!ouGroups.has(k)) ouGroups.set(k, [])
    ouGroups.get(k)!.push(n)
  }
  for (const group of ouGroups.values()) {
    group.sort((a, b) => (a.desc.line ?? 0) - (b.desc.line ?? 0))
    for (let i = 0; i + 1 < group.length; i++) {
      const lo = group[i]
      const hi = group[i + 1]
      out.push(
        edge(
          'ladder',
          'monotonic_desc',
          lo,
          hi,
          `P(${lo.desc.label}) ≥ P(${hi.desc.label})`,
          judgeGte(lo, hi),
        ),
      )
    }
  }

  // 让球梯子：主队受让越多 → 主队打过的概率越高（按主队视角的 homeLine 排）
  const spGroups = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    if (n.desc.family !== 'spread' || n.desc.homeLine == null) continue
    const k = `${n.desc.period}`
    if (!spGroups.has(k)) spGroups.set(k, [])
    spGroups.get(k)!.push(n)
  }
  for (const group of spGroups.values()) {
    group.sort((a, b) => (a.desc.homeLine ?? 0) - (b.desc.homeLine ?? 0))
    for (let i = 0; i + 1 < group.length; i++) {
      const low = group[i]
      const high = group[i + 1]
      out.push(
        edge(
          'ladder',
          'monotonic_asc',
          low,
          high,
          `P(主队打过 ${low.desc.homeLine}) ≤ P(主队打过 ${high.desc.homeLine})`,
          judgeLte(low, high),
        ),
      )
    }
  }
  return out
}

/** 找一个 ou 节点：给定期间/主体/线 */
function findOu(
  nodes: GraphNode[],
  period: Period,
  subject: MarketDescriptor['subject'],
  line: number,
): GraphNode | null {
  return (
    nodes.find(
      (n) =>
        n.desc.family === 'ou' &&
        n.desc.metric === 'goals' &&
        n.desc.period === period &&
        n.desc.subject === subject &&
        n.desc.line === line,
    ) ?? null
  )
}

/** 该期间/主体下所有大小球线，升序 */
function linesOf(
  nodes: GraphNode[],
  period: Period,
  subject: MarketDescriptor['subject'],
): number[] {
  return nodes
    .filter(
      (n) =>
        n.desc.family === 'ou' &&
        n.desc.metric === 'goals' &&
        n.desc.period === period &&
        n.desc.subject === subject &&
        n.desc.line != null,
    )
    .map((n) => n.desc.line!)
    .sort((a, b) => a - b)
}

function buildImpliesEdges(nodes: GraphNode[]): GraphEdge[] {
  const out: GraphEdge[] = []

  // 单队进球 ⊂ 全场总进球（同期间同线）：一队进 K 球，全场至少 K 球
  for (const n of nodes) {
    if (n.desc.family !== 'ou' || n.desc.metric !== 'goals') continue
    if (n.desc.subject !== 'home' && n.desc.subject !== 'away') continue
    if (n.desc.line == null) continue
    const match = findOu(nodes, n.desc.period, 'match', n.desc.line)
    if (!match) continue
    out.push(
      edge('implies', 'implies_lte', n, match, `P(${n.desc.label}) ≤ P(${match.desc.label})`, judgeLte(n, match)),
    )
  }

  // 半场 / 下半场 ⊂ 全场（同主体同线）
  for (const n of nodes) {
    if (n.desc.family !== 'ou' || n.desc.metric !== 'goals') continue
    if (n.desc.period === 'ft' || n.desc.line == null) continue
    const ft = findOu(nodes, 'ft', n.desc.subject, n.desc.line)
    if (!ft) continue
    out.push(
      edge('period', 'implies_lte', n, ft, `P(${n.desc.label}) ≤ P(${ft.desc.label})`, judgeLte(n, ft)),
    )
  }

  // 双方进球 ⟹ 该期间总进球 ≥ 2，且两队各进 ≥1
  for (const n of nodes) {
    if (n.desc.family !== 'btts') continue
    const over15 = findOu(nodes, n.desc.period, 'match', 1.5)
    if (over15) {
      out.push(
        edge('implies', 'implies_lte', n, over15, `P(${n.desc.label}) ≤ P(${over15.desc.label})`, judgeLte(n, over15)),
      )
    }
    for (const subject of ['home', 'away'] as const) {
      const teamOver = findOu(nodes, n.desc.period, subject, 0.5)
      if (teamOver) {
        out.push(
          edge(
            'implies',
            'implies_lte',
            n,
            teamOver,
            `P(${n.desc.label}) ≤ P(${teamOver.desc.label})`,
            judgeLte(n, teamOver),
          ),
        )
      }
    }
  }

  // 半场双方进球 ⊂ 全场双方进球
  const bttsFt = nodes.find((n) => n.desc.family === 'btts' && n.desc.period === 'ft')
  if (bttsFt) {
    for (const n of nodes) {
      if (n.desc.family !== 'btts' || n.desc.period === 'ft') continue
      out.push(
        edge('period', 'implies_lte', n, bttsFt, `P(${n.desc.label}) ≤ P(${bttsFt.desc.label})`, judgeLte(n, bttsFt)),
      )
    }
  }

  // 某队先进球 ⟹ 该队进球 ≥ 1
  for (const n of nodes) {
    if (n.desc.family !== 'first_goal') continue
    if (n.desc.subject !== 'home' && n.desc.subject !== 'away') continue
    const teamOver = findOu(nodes, n.desc.period, n.desc.subject, 0.5)
    if (!teamOver) continue
    out.push(
      edge('implies', 'implies_lte', n, teamOver, `P(${n.desc.label}) ≤ P(${teamOver.desc.label})`, judgeLte(n, teamOver)),
    )
  }

  // 球员进球 ⟹ 全场有进球
  const over05 = findOu(nodes, 'ft', 'match', 0.5)
  if (over05) {
    for (const n of nodes) {
      if (n.desc.family !== 'scorer') continue
      out.push(
        edge('implies', 'implies_lte', n, over05, `P(${n.desc.label}) ≤ P(${over05.desc.label})`, judgeLte(n, over05)),
      )
    }
  }

  // 准确比分 ⟹ 它蕴含的最紧那条大小球线 + 对应的胜平负腿
  for (const n of nodes) {
    if (n.desc.family !== 'exact' || n.desc.score == null) continue
    const total = n.desc.score.home + n.desc.score.away
    const candidates = linesOf(nodes, n.desc.period, 'match').filter((l) => l < total)
    const tightest = candidates.length ? candidates[candidates.length - 1] : null
    if (tightest != null) {
      const target = findOu(nodes, n.desc.period, 'match', tightest)
      if (target) {
        out.push(
          edge('implies', 'implies_lte', n, target, `P(${n.desc.label}) ≤ P(${target.desc.label})`, judgeLte(n, target)),
        )
      }
    }
    const role =
      n.desc.score.home > n.desc.score.away ? 'home' : n.desc.score.home < n.desc.score.away ? 'away' : 'draw'
    const leg = nodes.find(
      (m) => m.desc.family === 'moneyline' && m.desc.period === n.desc.period && m.desc.role === role,
    )
    if (leg) {
      out.push(
        edge('implies', 'implies_lte', n, leg, `P(${n.desc.label}) ≤ P(${leg.desc.label})`, judgeLte(n, leg)),
      )
    }
  }

  return out
}

/**
 * 胜平负三腿构成完整划分：主胜 + 平 + 客胜 = 1。
 *
 * 违约的可成交形式有两侧：三腿买价之和 > 1（全卖掉，净收 >1 而必付 1），
 * 或三腿卖价之和 < 1（全买下，付 <1 而必收 1）。只判能成交的那种。
 */
function buildPartitionGroups(nodes: GraphNode[]): GraphGroup[] {
  const out: GraphGroup[] = []
  const periods: Period[] = ['ft', 'ht', '2h']
  for (const period of periods) {
    const legs = ['home', 'draw', 'away'].map((role) =>
      nodes.find((n) => n.desc.family === 'moneyline' && n.desc.period === period && n.desc.role === role),
    )
    if (legs.some((l) => !l)) continue
    const three = legs as GraphNode[]
    // 三腿都要有真实盘口才谈得上「三腿之和」违约
    const allQuoted = three.every((n) => sideOf(n)?.quoted)
    // 三腿之和的违约判定同样只能用真实报价，见 tradeBid 注释
    const bids = three.map(tradeBid)
    const asks = three.map(tradeAsk)
    const mids = three.map((n) => {
      const b = bidOf(n)
      const a = askOf(n)
      if (b != null && a != null) return (b + a) / 2
      return b ?? a
    })
    const sum = mids.every((m) => m != null) ? (mids as number[]).reduce((s, m) => s + m, 0) : null
    const bidSum = bids.every((b) => b != null) ? (bids as number[]).reduce((s, b) => s + b, 0) : null
    const askSum = asks.every((a) => a != null) ? (asks as number[]).reduce((s, a) => s + a, 0) : null
    // bidSum/askSum 已经只由真实报价构成（缺任一腿就是 null），
    // allQuoted 仍保留作显式意图声明
    const violated =
      allQuoted && ((bidSum != null && bidSum > 1) || (askSum != null && askSum < 1))
    out.push({
      id: `1x2:${period}`,
      kind: '1x2',
      period,
      nodeIds: three.map((n) => n.id),
      sum,
      violated,
    })
  }
  return out
}

/**
 * 建图。纯函数：不读库、不发请求，价格由调用方喂进来。
 *
 * 成交量过滤是可选的（见 BuildOptions.minVolume），默认全收。
 * 认不出的问句直接丢弃，不塞成 other 再连出错误的约束边。
 */
export function buildMarketGraph(
  event: GraphEventInput,
  markets: GraphMarketInput[],
  opts: BuildOptions = {},
): MarketGraph {
  const minVolume = opts.minVolume
  const state = opts.state ?? PRE_MATCH

  const kept: Array<{ m: GraphMarketInput; desc: MarketDescriptor }> = []
  for (const m of markets) {
    if (minVolume != null && num(m.volume) <= minVolume) continue
    const desc = parseMarket({
      questionEn: m.questionEn,
      questionZh: m.questionZh,
      line: m.line,
      homeTeamEn: event.homeTeamEn,
      awayTeamEn: event.awayTeamEn,
      homeTeamZh: event.homeTeamZh,
      awayTeamZh: event.awayTeamZh,
    })
    if (!desc) continue
    kept.push({ m, desc })
  }

  const nodes: GraphNode[] = kept.map(({ m, desc }) => {
    const outcomes = m.outcomes ?? []
    const sides: GraphSide[] = outcomes.map((name, i) => ({
      name,
      tokenId: m.clobTokenIds?.[i] != null ? String(m.clobTokenIds[i]) : null,
      price: numOrNull(m.outcomePrices?.[i]),
      bid: null,
      ask: null,
      quoted: false,
    }))
    return {
      id: `m${m.id}`,
      marketId: String(m.id),
      conditionId: m.conditionId == null ? null : String(m.conditionId),
      desc,
      questionEn: m.questionEn,
      questionZh: m.questionZh ?? null,
      volume: num(m.volume),
      liquidity: num(m.liquidity),
      sides,
      primarySide: pickPrimarySide(desc, outcomes, event.homeTeamEn),
      impact: {
        homeGoal: 'flat',
        awayGoal: 'flat',
        magnitude: 0,
        deltaHome: null,
        deltaAway: null,
        modelled: false,
      },
      emphasis: desc.goalSensitive ? 'major' : 'minor',
      column: columnOf(desc),
      row: 0,
    }
  })

  // λ 从盘口报价反推，再回填每个节点的进球影响
  const samples = nodes.map(lambdaSampleOf)
  const lam: Lambdas | null = inferLambdas(samples, state)
  for (const n of nodes) {
    n.impact = goalImpact(n.desc, lam, state)
  }

  // 行号：列内按排序键排，梯子于是竖着相邻
  const byColumn = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    if (!byColumn.has(n.column)) byColumn.set(n.column, [])
    byColumn.get(n.column)!.push(n)
  }
  for (const list of byColumn.values()) {
    list.sort((a, b) => cmpKey(sortKey(a.desc), sortKey(b.desc)))
    list.forEach((n, i) => {
      n.row = i
    })
  }

  const edges = [...buildLadderEdges(nodes), ...buildImpliesEdges(nodes)]
  const groups = buildPartitionGroups(nodes)
  const columns = COLUMN_DEFS.filter((c) => byColumn.has(c.key))

  return {
    eventId: String(event.id),
    homeTeamEn: event.homeTeamEn,
    awayTeamEn: event.awayTeamEn,
    homeTeamZh: event.homeTeamZh ?? null,
    awayTeamZh: event.awayTeamZh ?? null,
    title: event.titleZh || event.titleEn || `${event.homeTeamEn} vs ${event.awayTeamEn}`,
    league: event.league ?? null,
    endTime: event.endTime ?? null,
    lambdaTotal: lam?.total ?? null,
    lambdaHome: lam?.home ?? null,
    lambdaAway: lam?.away ?? null,
    nodes,
    edges,
    groups,
    columns,
    stats: {
      markets: markets.length,
      withVolume: nodes.filter((n) => n.volume > 0).length,
      goalSensitive: nodes.filter((n) => n.desc.goalSensitive).length,
      edges: edges.length,
      violations: edges.filter((e) => e.violated).length + groups.filter((g) => g.violated).length,
    },
  }
}

/**
 * 把实时盘口价盖到图上，并重算所有依赖价格的量。
 *
 * 原地改而不是重建：节点身份固定，重建会让前端所有节点重新挂载、
 * 动画全部重放。返回新的 edges/groups/λ——那些确实随价格变。
 */
export function applyLivePrices(
  graph: MarketGraph,
  quotes: Record<string, { bid: number | null; ask: number | null }>,
  state: MatchState = PRE_MATCH,
): MarketGraph {
  for (const n of graph.nodes) {
    for (const s of n.sides) {
      if (!s.tokenId) continue
      const q = quotes[s.tokenId]
      if (!q) continue
      s.bid = q.bid
      s.ask = q.ask
      s.quoted = true
    }
  }

  const samples = graph.nodes.map(lambdaSampleOf)
  const lam = inferLambdas(samples, state)
  for (const n of graph.nodes) {
    n.impact = goalImpact(n.desc, lam, state)
  }

  const edges = [...buildLadderEdges(graph.nodes), ...buildImpliesEdges(graph.nodes)]
  const groups = buildPartitionGroups(graph.nodes)
  return {
    ...graph,
    lambdaTotal: lam?.total ?? null,
    lambdaHome: lam?.home ?? null,
    lambdaAway: lam?.away ?? null,
    edges,
    groups,
    stats: {
      ...graph.stats,
      edges: edges.length,
      violations: edges.filter((e) => e.violated).length + groups.filter((g) => g.violated).length,
    },
  }
}

/** 节点主侧的模型公平价，供前端显示「贵了还是便宜了」 */
export function fairPriceOf(
  node: GraphNode,
  graph: MarketGraph,
  state: MatchState = PRE_MATCH,
): number | null {
  if (graph.lambdaTotal == null || graph.lambdaHome == null || graph.lambdaAway == null) return null
  return nodeProbability(
    node.desc,
    { total: graph.lambdaTotal, home: graph.lambdaHome, away: graph.lambdaAway },
    state,
  )
}
