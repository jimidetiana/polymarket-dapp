/**
 * 总进球分布 —— 从**图上显示的大小球梯子**推出来，不用任何模型。
 *
 * ## 为什么不建模
 *
 * 相邻两档的报价相减就是「恰好 k 球」的概率：
 *
 *   P(恰好 k 球) = P(Over (k−0.5)) − P(Over (k+0.5))
 *
 * 这是恒等式不是近似：「进 2 球以上」减去「进 3 球以上」就是「恰好进 2 球」。
 * 所以这条路径一个模型参数都不需要，避开了 λ / Poisson 那套定价不够精确的问题
 * （用户已经判定那套不能用来参考）。
 *
 * ## 为什么只吃「可见」的那些档
 *
 * 口径是「只分析图上显示了的盘口」。折叠态下 `total_7.5` / `total_8.5` 不显示
 * （`isOuterSlot`，见 graph/template.ts），推算范围就停在 7 球；点「展示更多」
 * 多两档，范围跟着变宽。**分析范围 = 显示范围**，不额外拉任何数据。
 *
 * ## 梯子必须连续，断了就停
 *
 * 只取**从最小线开始连续**的那一段。中间缺一档必须停：缺了 2.5 时
 * `P(Over 1.5) − P(Over 3.5)` 得到的是「恰好 2 **或** 3 球」，混在一个桶里，
 * 名字就对不上了。宁可不给，也不给一个名字对不上的数。
 *
 * ## 热度只是近似，别当筹码
 *
 * 成交量是按**盘口**统计的（Over 2.5 这个二元盘一共成交多少），不是按
 * 「恰好 k 球」统计的。桶（恰好 k 球）夹在 k−0.5 与 k+0.5 两档之间，取两档
 * 成交量的**较小者**作为这一桶的保守热度 —— 不用差值法，因为成交量随线并不
 * 单调（标准盘 2.5 的量常常高于 1.5），相减会出负数。
 *
 * 所以 `heatRatio` 只能读作「这一桶附近的钱相对它的概率是多还是少」，
 * 不能读作「这一桶上有多少筹码」。
 */
import type { GraphNode, GraphSide, MarketGraph } from './types.js'

export type GoalBucket = {
  /** 恰好进几个球 */
  goals: number
  /** 概率。同一份结果里各桶之和恒为 1（除非报价被钳过，见 sumProb） */
  prob: number
  /** 保守热度（见顶部「热度只是近似」），已归一成份额 */
  heatShare: number
  /** heatShare / prob。>1 = 钱比概率多，<1 = 钱比概率少。prob 为 0 时是 null */
  heatRatio: number | null
}

export type TotalGoalsResult = {
  buckets: GoalBucket[]
  /** 推算到的最大线（受可见范围限制），buckets 覆盖 0 .. maxLine+0.5 球 */
  maxLine: number
  /**
   * 归一**之前**的概率之和。
   *
   * 做了单调性投影之后它**恒等于 1**（telescoping，且不会有负桶被钳），所以它不再是
   * 「脏报价」的信号 —— 那个改由 `monotoneFixups` 承担。留着是为了说明归一化除的是哪个数。
   */
  sumProb: number
  /**
   * 有多少档因为相邻倒挂被投影过（取前值）。> 0 说明这几档的报价此刻不自洽。
   * 这是现在唯一能看出「输入有问题」的地方 —— 它不报错，只是把噪声压掉了。
   */
  monotoneFixups: number
  /** 参与推算的档数（有真实双边盘、且落在连续段里） */
  quotedLines: number
  /** 可见的 match 全场大小球档位总数（含没报价的） */
  totalLines: number
}

/** 这个节点是不是「全场总进球」的某一档 */
function isMatchTotalOu(n: GraphNode): boolean {
  const d = n.desc
  return d.family === 'ou' && d.subject === 'match' && d.period === 'ft' && d.line != null
}

/** 该节点的主显示侧（大小球就是 Over 那侧），口径同 graph.ts 的 sideOf */
function overSide(n: GraphNode) {
  return n.sides.find((s) => s.name === n.primarySide) ?? n.sides[0] ?? null
}

/**
 * 中价。**推导分布一律用中价，不用卖一。**
 *
 * 卖一是最不稳的单一报价 —— 最上面那笔挂单被吃掉或撤掉，它立刻跳。而这里的桶是
 * 「大数相减」得到的（`P(恰好 2 球) = P(Over 1.5) − P(Over 2.5)`，实测 0.810 − 0.580
 * = 0.230），盘口动一个 tick（0.01）就让桶动一个百分点 —— 对一个 5% 的桶是 20% 的
 * 相对变化。用中价（买一卖一取平均）能平掉一大半这种抖动。
 *
 * 口径必须**整条链统一**：混用买一 / 卖一会相减出无意义的负数。
 * （判「此刻能不能成交」是另一套口径，那边必须用卖一，见 graph.ts 的 tradeAsk。）
 */
export function midOf(s: GraphSide | null | undefined): number | null {
  if (!s?.quoted || s.bid == null || s.ask == null) return null
  return (s.bid + s.ask) / 2
}

/**
 * 从可见的大小球梯子推「恰好 k 球」的分布。
 *
 * 返回 null 表示推不出来：可见档少于 2，或连续段里不足 2 档有真实双边盘。
 * **调用方不要为此加加载关卡** —— 拿不到就不显示，同项目既有取舍。
 */
export function totalGoalsDistribution(
  graph: MarketGraph,
  visibleNodeIds: ReadonlySet<string>,
): TotalGoalsResult | null {
  const visible = graph.nodes.filter((n) => visibleNodeIds.has(n.id) && isMatchTotalOu(n))
  if (visible.length < 2) return null

  // 线 → 节点。同一档正常只有一张盘；真出现重复取成交量大的那张，别静默丢掉
  const byLine = new Map<number, GraphNode>()
  for (const n of visible) {
    const line = n.desc.line as number
    const prev = byLine.get(line)
    if (!prev || n.volume > prev.volume) byLine.set(line, n)
  }

  const lines = [...byLine.keys()].sort((a, b) => a - b)

  /**
   * 从最小线开始走连续段。遇到缺口（下一档不是 +1）立刻停 —— 见顶部说明。
   * 同时要求有真实双边盘：没报价的档参与不了相减（单边价相减会得到无意义的数）。
   */
  const run: Array<{ line: number; prob: number; volume: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i > 0 && line !== lines[i - 1] + 1) break
    const n = byLine.get(line) as GraphNode
    const s = overSide(n)
    const mid = midOf(s)
    if (mid == null) break
    run.push({ line, prob: mid, volume: n.volume })
  }

  /**
   * **单调性投影**：`P(Over L)` 必须随 L 递减（进 3 球必然进 2 球），这是恒真约束。
   *
   * 为什么必须做：报价来自真实订单簿、还会抖，实测相邻档会瞬时倒挂。倒挂时相减得到
   * **负概率**，钳到 0 会让整条分布重新归一化 —— 那是一次断崖式跳变，屏幕上就是
   * 「数字隔几秒整块换一组」。与其钳结果，不如把**输入**投影回约束集：倒挂处取前值，
   * 负桶从根上不会出现，跳变也就没有了。
   *
   * 代价：这是有偏的（把噪声压向约束边界一侧）。但约束是恒真的，投影到约束集上
   * 降方差是标准做法，比让负概率穿过去再截断好。
   */
  let monotoneFixups = 0
  for (let i = 1; i < run.length; i++) {
    if (run[i].prob > run[i - 1].prob) {
      run[i].prob = run[i - 1].prob
      monotoneFixups++
    }
  }

  /**
   * **梯子必须从 0.5 起步**，否则第一个桶会张冠李戴。
   *
   * 第一个桶的算法是 `1 − P(Over 0.5)`，「1」代表「一定进 0 球以上」这个全集。
   * 若最低档是 1.5，`1 − P(Over 1.5)` 得到的是「0 **或** 1 球」，
   * 标成「0 球」就是错的。宁可推不出来也不给一个名字对不上的数。
   *
   * 这条同时挡住了开赛后的一个坑：盘口结算后 ask 变成 1，而 `toLiveQuotes`
   * （lib/book.ts）把 `ask >= 1` 当不可成交滤掉，于是已打出的档会掉出报价集合、
   * 梯子从底部断掉。那种情况下这里返回 null —— 少显示，但不显示错的。
   * （若该档在结算前曾被推送过，报价会沿用最后已知值 0.99 左右，那没事，
   * 见 lib/use-graph.ts 里关于「quoted 一旦为 true 就不退回」的说明。）
   */
  if (run.length < 2 || run[0].line !== 0.5) return null

  // 依次相减：0 球 = 1 − P(Over 0.5)；k 球 = P(Over k−0.5) − P(Over k+0.5)；末桶 = P(Over maxLine)
  const raw: Array<{ goals: number; prob: number; heat: number }> = []
  for (let i = 0; i < run.length; i++) {
    const prevProb = i === 0 ? 1 : run[i - 1].prob
    const prob = prevProb - run[i].prob
    const heat = i === 0 ? run[i].volume : Math.min(run[i - 1].volume, run[i].volume)
    raw.push({ goals: run[i].line - 0.5, prob, heat })
  }
  const last = run[run.length - 1]
  raw.push({ goals: last.line + 0.5, prob: last.prob, heat: last.volume })

  // 负概率 = 单调性被破（脏报价）。钳到 0 但**不隐藏** —— sumProb 会把损失暴露出来
  const sumProb = raw.reduce((s, r) => s + Math.max(0, r.prob), 0)
  const totalHeat = raw.reduce((s, r) => s + r.heat, 0)

  const buckets: GoalBucket[] = raw.map((r) => {
    const prob = Math.max(0, r.prob)
    const heatShare = totalHeat > 0 ? r.heat / totalHeat : 0
    return {
      goals: r.goals,
      prob,
      heatShare,
      heatRatio: prob > 0 && totalHeat > 0 ? heatShare / prob : null,
    }
  })

  return {
    buckets,
    maxLine: last.line,
    sumProb,
    monotoneFixups,
    quotedLines: run.length,
    totalLines: visible.length,
  }
}
