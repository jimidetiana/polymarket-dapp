/**
 * 比分网格 —— 从图上显示的盘口推「主队进 h 球、客队进 a 球」的联合分布。
 *
 * ## 两个边际，各自都是盘口直接给的
 *
 * **总进球 S = h + a**：从大小球梯子相邻两档相减（见 total-goals.ts）。
 *
 * **净胜球 D = h − a**：从一条**阈值链**相减：
 *
 *   P(净胜 ≥ t) = P(净胜 ≥ t+1) + P(恰好净胜 t)
 *
 * 这条链由两个来源拼成 —— 单靠任何一个都断：
 *
 *   | 阈值 | 来源 |
 *   |---|---|
 *   | t ≥ 2  | 让球盘「主队 -1.5 / -2.5 / …」 |
 *   | t = 1  | **胜平负「主胜」** |
 *   | t = 0  | **胜平负「主胜 + 平」** |
 *   | t ≤ −1 | 让球盘「客队 -1.5 / -2.5 / …」 |
 *
 * ⚠️ **让球盘中间是断的**：Polymarket 只挂 ±1.5 及以外，**没有 ±0.5**（那是
 * 「平局退款」盘，不在这里）。而 ±0.5 恰好是把「平局」和「净胜 1 球」分开的地方。
 * 缺了它，让球梯子单独推不出净胜 0 和 1 的概率 —— 而**胜平负盘正好就是这两个**。
 * 所以这两块必须合起来用，只取一边会得到一段错的分布。
 *
 * ⚠️ **让球盘取哪一侧**：outcomes 是**队名**不是 Yes/No。`Spread: 曼联 (-1.5)`
 * 的 YES 是「曼联让球赢」= P(净胜 ≤ −2)。要拿主队视角的 P(净胜 ≥ −1)，必须取
 * **主队那一侧**，不是被点名那一侧 —— 取错就是拿补集去相减，整条链全废。
 * 口径与 graph.ts 的 `pickPrimarySide` 一致（spread 找主队名那一侧）。
 *
 * ## 两个边际拼不出联合 —— 这一步是假设，不是盘口给的
 *
 * 比分 = (S, D) 的联合分布。而两个**边际**分布在数学上确定不了联合分布，
 * 这跟数据够不够无关，是恒等式层面的限制。
 *
 * 这里用**独立**拼接，理由是：在所有符合这两个边际的联合分布里，独立分布是
 * **最大熵**的那个 —— 也就是「不引入边际之外的任何信息」。所以它不是随手拍的
 * 选择，但也**不是盘口直接给出的东西**，界面上必须标出来。
 *
 * 已知它偏在哪：真实足球里总进球与净胜球正相关（大比分往往大分差），独立假设
 * 会把概率摊平、系统性高估平局。所以网格只用来「看可能是哪几个」，不用来定价。
 */
import type { GraphNode, MarketGraph } from './types.js'
import { midOf, totalGoalsDistribution } from './total-goals.js'

export type ScoreCell = {
  home: number
  away: number
  /** 由**价格**推的概率。网格主口径 */
  prob: number
  /**
   * 由**成交量**推的占比，同一套拼接方式（也走独立假设）—— **只给对照用，不参与预测**。
   *
   * 近似写在两处：成交量是**流量**不是存量（做市商刷单会放大），且是按**盘口**统计的、
   * 不是按「恰好这个比分」统计的 —— 归因取相邻两档的较小者（见 marginDistribution）。
   * 所以这列只能看相对高低，不能当概率、更不能当定价。
   */
  heatShare: number
  /** heatShare ÷ prob。>1 = 这个比分的钱比它的价多，<1 = 钱比价少。prob 为 0 时是 null */
  heatRatio: number | null
  /**
   * 这个比分所在**总进球档**（S = h+a）的价格占比与热度占比。同一个 S 的格子共享同一组值。
   *
   * 为什么要单独存：**只有总进球这一侧的热度是可比的** —— 它的量全部来自大小球梯子
   * 一个盘口家族。净胜球那侧跨了胜平负和让球两个家族（实测成交量差约一百倍），
   * 拼出来的热度比的是「哪个结果由厚盘口定价」，不是「哪个结果上钱多」。
   * 所以**倾斜只用这两个字段**，见 tiltByHeat。
   */
  totalProb: number
  totalHeat: number
}

/**
 * 把预测按热度**推向庄家盈利方向**，返回一套新预测（不改原来那份）。
 *
 * ## 公式
 *
 * 设比分 s 的热度占比 `v_s`、价格占比 `p_s`。卖出方（「庄家」）在 s 上打出时的
 * 每单位池子盈亏是 `1 − v_s/p_s` —— 所以它**最想在钱少价高的比分上成交**：
 *
 * ```
 * ratio_s    = v_s / p_s                     钱相对价的比例
 * 庄家赚得多 ⟺ ratio_s 小
 * α_s        = α × v_s / (v_s + v_中位)        ← 逐格的有效强度
 * B 的权重   = A 的权重 × (1 / ratio_s)^α_s
 * ```
 *
 * ## 为什么 α 要逐格算（这一步是必须的，不是润色）
 *
 * 用固定的 α 会**炸**。实测（马竞 vs 曼联，α=1）：`3-1` 从 5.91% 跳到 21.60%，
 * 成了"最可能比分"——一场主胜 47%、期望总进球 3 的比赛里这不可信。
 *
 * 原因是 `(1/ratio)^α` **没有上界**：成交量几十美元的格子 `v_s → 0`，ratio 趋零，
 * 放大倍数趋于无穷。而那些"没人下注"的格子恰恰是**数据最空**的格子。
 *
 * 更要紧的是：这不是实现瑕疵，是**方向本身的性质**——「钱少价高的比分」的极端情况
 * 就是「没有任何人下注的比分」。所以这个向量天然指向数据的空洞，必须靠 α_s 加一道闸门：
 *
 *   v_s ≫ v_中位  →  α_s → α      有足够成交，按原意推
 *   v_s = v_中位   →  α_s = α/2
 *   v_s ≪ v_中位  →  α_s → 0      几乎没成交，**不推**，留在原处
 *
 * 半饱和点取中位热度，是让"一半的格子推得比 α/2 轻、一半更重"。这是个启发式，
 * 但它编码的是一条硬道理：**没有成交的地方没有证据，就不该被推动。**
 *
 * ## 为什么只用总进球那一侧的热度
 *
 * 热度(比分) 本来是 `总进球热度 × 净胜球热度`。但**净胜球那一侧不可比**：
 *
 * ```
 * 净胜 ≥ 1  ← 胜平负「主胜」      实测成交量 $550,780
 * 净胜 ≥ 2  ← 让球「主队 -1.5」   实测成交量 几千美元
 * ```
 *
 * 同一条链跨了两个流动性差约**一百倍**的盘口家族。于是 `hD(+1)` 巨大、`hD(+2)` 极小，
 * 而这不是「这批人偏好净胜 1 球」，是「定这两个结果的盘口根本不在一个量级上」。
 *
 * 后果实测：`2-1`（总进球 3、净胜 +1）热度 6.46%，`2-0`（总进球 2、净胜 +2）只有 0.61%
 * —— 两者总进球只差 1，而 `2.5`/`3.5` 两条大小球线几乎等厚（$21,924 / $21,616），
 * 差不该来自总进球侧。于是倾斜把「净胜 ≥2」的结果一律当成"冷"来抬，
 * **两套口径（绝对 / 中位）都被推到同一个 `2-0`** —— 那是流动性假象，不是庄家偏好。
 *
 * 所以倾斜**只吃总进球档**（`totalProb` / `totalHeat`）：那一侧的量全部来自大小球梯子
 * **一个家族**，同样厚的盘口定同样的问题，钱多钱少才真的可比。
 *
 * ## 两个口径：以什么为「正常」
 *
 * 因子是 `(中心 / ratio_s)^α_s`，**中心的取法会实质改变结果**：
 *
 *   `center: 'absolute'`（默认）中心 = 1，即「钱和价一样多」才算正常。
 *   `center: 'median'`          中心 = 实际的**中位 ratio**。
 *
 * 实测（马竞 vs 曼联）ratio 的中位只有 **0.192** —— 因为成交量极度集中在 `2-1`/`2-2`
 * 两个格子上（热度 12.35% / 11.51%），其余二十几个格子的热度**全都低于价格**。
 * 这种数据下用绝对口径，等于把二十几个格子**一起**抬高、把两个热门格子压低 ——
 * 那是在做「反集中化」，不是在表达庄家偏好。
 *
 * 中位口径只推**比典型情况更极端**的格子，幅度小得多。哪个对取决于意图：
 * 「庄家盈利方向」如果就等同于「反集中化」，用绝对；如果要表达「相对典型更偏哪边」，
 * 用中位。两者的差别在中位离 1 很远时才显著 —— 所以中位本身是个应该被看见的数。
 *
 * ## 这是**假设**，不是预测变准了
 *
 * 它回答的不是「最可能踢成几比几」，而是「**如果结果能往庄家最赚的方向偏，会偏到哪去**」。
 * 前者是预测，后者是反推意图 —— 用户明确当假设用（原话：「这是一个假设，不代表事实」）。
 * 界面上必须两套并列、分别标注，不能混成一套。
 */
export function tiltByHeat(
  result: ScoreGridResult,
  alpha: number,
  opts: { center?: 'absolute' | 'median' } = {},
): ScoreGridResult {
  if (!(alpha > 0)) return result
  const center = opts.center ?? 'absolute'

  /**
   * 按**总进球档**（S = h+a）归组。同一 S 的格子共享同一份证据 —— 这是有意为之：
   * 净胜球那一侧的热度跨了两个流动性差约一百倍的盘口家族，不能用来比"谁的钱多"，
   * 所以整个倾斜**只看总进球这一侧**。见 ScoreCell 的 totalProb/totalHeat 说明。
   */
  const totals = new Map<number, { p: number; h: number }>()
  for (const c of result.cells.flat()) {
    if (c.totalProb > 0) totals.set(c.home + c.away, { p: c.totalProb, h: c.totalHeat })
  }
  const usable = [...totals.values()].filter((t) => t.p > 0 && t.h > 0)

  // 半饱和点 = 有成交的总进球档里，热度的中位数
  const heats = usable.map((t) => t.h).sort((a, b) => a - b)
  const medHeat = heats.length > 0 ? heats[Math.floor(heats.length / 2)] : 0
  /**
   * 中位数口径的中心。`absolute` 下中心是 1（原点 = 「钱和价一样多」）；
   * `median` 下中心是**实际的中位 ratio** —— 见顶部关于「中位远小于 1 时」的说明。
   */
  const ratios = usable.map((t) => t.h / t.p).sort((a, b) => a - b)
  const medRatio = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : 1
  const origin = center === 'median' ? medRatio : 1

  const cells = result.cells.map((row) =>
    row.map((c) => {
      const t = totals.get(c.home + c.away)
      if (!t || !(t.p > 0) || !(t.h > 0) || !(c.prob > 0)) return { ...c }
      const a = tiltExponent(t.h, medHeat, alpha)
      if (!(a > 0) || !(origin > 0)) return { ...c }
      // 钱相对价少（ratio < 中心）→ 因子 > 1 → 推高
      return { ...c, prob: c.prob * Math.pow(origin / (t.h / t.p), a) }
    }),
  )

  let sum = 0
  for (const row of cells) for (const c of row) sum += c.prob
  if (sum <= 0) return result
  for (const row of cells) for (const c of row) c.prob = c.prob / sum

  const ranked = cells.flat().filter((c) => c.prob > 0)
  ranked.sort((x, y) => y.prob - x.prob || x.home - y.home || x.away - y.away)

  return { ...result, cells, ranked }
}

/**
 * 逐格的有效倾斜强度 `α_s`。
 *
 * **成交量越低，α_s 越接近 0** —— 这是明确的口径，不是调参：没有成交的格子没有证据，
 * 就不该被推动（见 `tiltByHeat` 顶部关于「固定 α 会炸」的说明）。
 *
 * 半饱和曲线 `α·v/(v + v_中位)`：中位处正好取 α/2，远高于中位趋近 α，远低于中位趋近 0。
 * 导出成独立函数，是为了这条口径能被**直接测**，而不是藏在 `tiltByHeat` 里靠间接断言守。
 */
export function tiltExponent(heatShare: number, medianHeat: number, alpha: number): number {
  if (!(heatShare > 0) || !(medianHeat > 0) || !(alpha > 0)) return 0
  return (alpha * heatShare) / (heatShare + medianHeat)
}

export type ScoreGridResult = {
  /** cells[home][away]，只覆盖有意义的范围（见 maxGoals） */
  cells: ScoreCell[][]
  /** 按概率降序，取前若干名给「最可能比分」用 */
  ranked: ScoreCell[]
  /** 网格覆盖的进球上限（两队相同，方便画方阵） */
  maxGoals: number
  /** 净胜球边际，供自校验（P(净胜 0) 应当等于平局价） */
  margins: { d: number; prob: number }[]
  marginQuoted: number
  /**
   * 归一**之前**，网格里那些格子的概率之和。
   *
   * ⚠️ 它明显小于 1 **主要不是因为尾巴**，而是**奇偶约束**：`h=(S+D)/2` 要是整数，
   * 所以只有 S 与 D 同奇偶的组合才对应得了合法比分 —— 大约一半的组合直接不合法。
   * 实测这个数在 0.45 上下，其中约一半是奇偶、另一半才是边缘桶没进网格。
   *
   * 所以它**不是**「丢了多少信息」的指标，只用来说明归一化除的是哪个数。
   */
  rawMass: number
  /**
   * 两个边际各自被单调性投影过多少档（相加）。
   *
   * 之所以要公开它：投影是**静默**的 —— 它把噪声压掉了，屏幕上就看不出来输入其实
   * 不自洽。> 0 说明此刻胜平负盘 / 让球盘 / 大小球梯子之间有倒挂。不影响可用性
   * （倒挂是薄盘口的常态），但排查「数字为什么在动」时要能看到它。
   */
  monotoneFixups: number
}

/** 该节点的主显示侧，口径同 graph.ts 的 sideOf */
function primarySideOf(n: GraphNode) {
  return n.sides.find((s) => s.name === n.primarySide) ?? n.sides[0] ?? null
}

/**
 * 净胜球阈值链：t → P(净胜 ≥ t)。只取有真实双边盘的档。
 *
 * 让球档 homeLine = L 的含义是 P(D ≥ −L + 0.5)（见顶部说明）。
 */
function marginThresholds(
  nodes: GraphNode[],
  visible: ReadonlySet<string>,
): { t: Map<number, number>; vol: Map<number, number>; fixups: number } {
  const t = new Map<number, number>()
  /** 阈值 → 该档盘口的累计成交量。只给「热度对照」用，不参与价格那条链 */
  const vol = new Map<number, number>()
  // 中价，不是卖一 —— 理由见 total-goals.ts 的 midOf：桶是大数相减，卖一的抖动会被放大
  const priceOf = (n: GraphNode): number | null => midOf(primarySideOf(n))
  const set = (key: number, n: GraphNode, p: number) => {
    t.set(key, p)
    vol.set(key, n.volume)
  }

  const ml = { home: null as number | null, draw: null as number | null }
  const mlVol = { home: 0, draw: 0 }
  for (const n of nodes) {
    if (!visible.has(n.id) || n.desc.family !== 'moneyline' || n.desc.period !== 'ft') continue
    const p = priceOf(n)
    if (p == null) continue
    if (n.desc.role === 'home') {
      ml.home = p
      mlVol.home = n.volume
    }
    if (n.desc.role === 'draw') {
      ml.draw = p
      mlVol.draw = n.volume
    }
  }
  // 胜平负填让球盘中间那个洞：±0.5 那两条盘根本不存在，但这两个值就是它。
  // 热度取对应盘口的量；t=0 是「主胜 + 平」的合成值，没有单一来源，取两者较小者
  if (ml.home != null) {
    t.set(1, ml.home)
    vol.set(1, mlVol.home)
  }
  if (ml.home != null && ml.draw != null) {
    t.set(0, ml.home + ml.draw)
    vol.set(0, Math.min(mlVol.home, mlVol.draw))
  }

  for (const n of nodes) {
    if (!visible.has(n.id) || n.desc.family !== 'spread' || n.desc.period !== 'ft') continue
    if (n.desc.homeLine == null) continue
    const p = priceOf(n)
    if (p == null) continue
    set(-n.desc.homeLine + 0.5, n, p)
  }

  /**
   * **单调性投影**：`P(净胜 ≥ t)` 必须随 t 递减（赢 3 球必然赢 2 球）。恒真约束。
   *
   * 这条链把**胜平负盘**和**让球盘**缝在一起 —— 两本独立的订单簿，还会各自抖，
   * 所以实测会瞬时倒挂。倒挂时相减得到负概率，钳到 0 会让整个网格重新归一化，
   * 屏幕上是「数字隔几秒整块换一组」。投影掉比钳掉好：负桶从根上不会出现。
   *
   * 与 total-goals.ts 里那个投影是同一件事，理由写在那里。
   */
  const keys = [...t.keys()].sort((a, b) => b - a) // 阈值由高到低
  let fixups = 0
  for (let i = 1; i < keys.length; i++) {
    // 阈值越低、条件越弱、概率必须越大 —— 降序遍历下应当非递减
    if ((t.get(keys[i]) as number) < (t.get(keys[i - 1]) as number)) {
      t.set(keys[i], t.get(keys[i - 1]) as number)
      fixups++
    }
  }
  return { t, vol, fixups }
}

/**
 * 阈值链 → 恰好净胜 d 的概率（和热度）。链断了就停，绝不跨缺口相减。
 *
 * 热度那一列是**近似**：成交量按盘口统计，不是按「恰好净胜 d 球」统计的，
 * 所以取相邻两档成交量的较小者作保守归因（相减会出负数 —— 量不随阈值单调）。
 * 与 total-goals.ts 里对总进球桶的做法一致。这列只看不能用。
 */
function marginDistribution(
  t: Map<number, number>,
  vol: Map<number, number>,
): { d: number; prob: number; heat: number }[] {
  const keys = [...t.keys()].sort((a, b) => b - a) // 由高到低
  const out: { d: number; prob: number; heat: number }[] = []
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i] !== keys[i + 1] + 1) break // 缺口：见顶部说明，跨过去就是错的
    // 降序里 keys[i] 是**更高的阈值**，它的价更小（条件更强）。
    // 恰好 d 球 = P(≥d) − P(≥d+1)，所以 d = keys[i+1]，且要用低的减高的。
    const d = keys[i + 1]
    out.push({
      d,
      prob: (t.get(d) as number) - (t.get(keys[i]) as number),
      heat: Math.min(vol.get(d) ?? 0, vol.get(keys[i]) ?? 0),
    })
  }
  return out
}

/**
 * 推比分网格。
 *
 * 返回 null 表示推不出来（可见档不够、或阈值链在关键处断掉）。
 * **不要为此加加载关卡** —— 拿不到就不显示，跟项目既有取舍一致。
 */
export function scoreGrid(
  graph: MarketGraph,
  visibleNodeIds: ReadonlySet<string>,
  opts: { maxGoals?: number } = {},
): ScoreGridResult | null {
  const totals = totalGoalsDistribution(graph, visibleNodeIds)
  if (!totals) return null

  const { t: thresholds, vol: thresholdVol, fixups: marginFixups } = marginThresholds(
    graph.nodes,
    visibleNodeIds,
  )
  // 没有胜平负就没有净胜球的锚，整条链无从谈起
  if (!thresholds.has(1) || !thresholds.has(0)) return null
  const margins = marginDistribution(thresholds, thresholdVol)
  if (margins.length === 0) return null

  const maxGoals = opts.maxGoals ?? 5

  // 两个边际的查表。总进球最后一个桶是「≥ 该值」，当点质量用 —— 天花板
  // 已经远离主峰，这个近似只影响尾部的最后一行，不影响任何判断
  const pS = new Map<number, number>()
  const hS = new Map<number, number>()
  for (const b of totals.buckets) {
    pS.set(b.goals, Math.max(0, b.prob))
    hS.set(b.goals, b.heatShare)
  }
  const pD = new Map<number, number>()
  const hD = new Map<number, number>()
  const marginHeat = margins.reduce((s, m) => s + Math.max(0, m.heat), 0)
  for (const m of margins) {
    pD.set(m.d, Math.max(0, m.prob))
    hD.set(m.d, marginHeat > 0 ? Math.max(0, m.heat) / marginHeat : 0)
  }

  // 独立拼接：P(h,a) ∝ P(S=h+a) · P(D=h−a)，只保留两个边际都覆盖到的格子。
  // 热度那一列用同样式的乘积 —— 结构对称才好对照
  const cells: ScoreCell[][] = []
  const ranked: ScoreCell[] = []
  let sum = 0
  let heatSum = 0
  for (let h = 0; h <= maxGoals; h++) {
    cells[h] = []
    for (let a = 0; a <= maxGoals; a++) {
      const s = pS.get(h + a)
      const d = pD.get(h - a)
      const prob = s != null && d != null ? s * d : 0
      const hs = hS.get(h + a)
      const hd = hD.get(h - a)
      const heat = prob > 0 && hs != null && hd != null ? hs * hd : 0
      cells[h][a] = {
        home: h,
        away: a,
        prob,
        heatShare: heat,
        heatRatio: null,
        // 总进球那一侧的两个边际值 —— 只有这一侧可比，倾斜只用它（见 ScoreCell 说明）
        totalProb: s ?? 0,
        totalHeat: hs ?? 0,
      }
      if (prob > 0) {
        ranked.push(cells[h][a])
        sum += prob
        heatSum += heat
      }
    }
  }
  if (sum <= 0) return null

  // 归一：除的是「合法格子上的原始质量」（见 rawMass 的说明 —— 它 ~0.45，
  // 主要是奇偶约束，不是尾巴）。ranked 与 cells 是**同一批对象引用**，
  // 所以只需在这里除一次 —— 再除一遍是 bug
  const rawMass = sum
  for (const h of cells) {
    for (const c of h) {
      c.prob = c.prob / sum
      c.heatShare = heatSum > 0 ? c.heatShare / heatSum : 0
      c.heatRatio = c.prob > 0 && heatSum > 0 ? c.heatShare / c.prob : null
    }
  }
  // tie-break 用比分本身。概率相等时不换位 —— 否则每次 tick 前几名会互相踩，
  // 看着像在"跳"，实际只是排序不稳定
  ranked.sort((x, y) => y.prob - x.prob || x.home - y.home || x.away - y.away)

  return {
    cells,
    ranked,
    maxGoals,
    margins,
    marginQuoted: margins.length,
    rawMass,
    monotoneFixups: totals.monotoneFixups + marginFixups,
  }
}
