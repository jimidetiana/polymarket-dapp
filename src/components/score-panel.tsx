/**
 * 比分面板 —— 画布右上角常驻，**两套预测并列**。
 *
 *   A. 不含热度 —— 纯由盘口价推出来（两个边际：总进球、净胜球）
 *   B. 含热度   —— 在 A 的基础上按 `(1/ratio)^α` 推向**庄家盈利方向**
 *
 * ## 为什么是两套而不是加一列
 *
 * 两者回答的是**不同的问题**：
 *
 *   A 问「最可能踢成几比几」
 *   B 问「如果结果能往庄家最赚的方向偏，会偏到哪去」
 *
 * 前者是预测，后者是反推意图。把 B 并成 A 的一列会让人以为它是一个更强的预测，
 * 而它其实是另一个问题 —— 用户自己也是把它当**假设**用的（原话：「这是一个假设，
 * 不代表事实」）。所以并列显示、各自标注，谁都不冒充谁。
 *
 * ## 必须标出来的假设（两套都有）
 *
 * 两个**边际**都是图上盘口直接给的、精确的；但比分是它们的**联合分布**，而两个边际
 * 在数学上确定不了联合 —— 这里按**独立**（= 最大熵）拼接。**不是盘口给出的东西。**
 * 已知偏差：真实足球里总进球与净胜球正相关，独立假设会摊平分布、系统性高估平局。
 */
import { cn } from '../lib/utils'
import { tr } from '../lib/i18n'
import type { ScoreGridResult } from '../graph/score-grid'

interface Props {
  title: string
  /** A：不含热度 */
  base: ScoreGridResult | null
  /** B：含热度。α = 0 时与 A 相同 */
  tilted: ScoreGridResult | null
  alpha: number
}

export function ScorePanel({ title, base, tilted, alpha }: Props) {
  if (!base) {
    return (
      <Card>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {tr(
            '图上可见的大小球 / 让球档位不够，推不出比分。',
            'Not enough visible totals or spread lines to infer scores.',
          )}
        </p>
      </Card>
    )
  }

  // 两套共用一个色标分母，否则深浅不可比
  const max = Math.max(...base.cells.flat().map((c) => c.prob))
  const topA = base.ranked[0]
  const topB = (tilted ?? base).ranked[0]
  const shifted = topA.home !== topB.home || topA.away !== topB.away

  return (
    <Card>
      <p className="mb-2 text-[11px] font-semibold text-foreground">{title}</p>

      <Grid label={tr('A · 不含热度', 'A · no heat')} result={base} max={max} />
      <Grid
        label={tr(`B · 含热度 α=${alpha.toFixed(1)}`, `B · heat α=${alpha.toFixed(1)}`)}
        result={tilted ?? base}
        max={max}
      />

      <p className="mt-2 border-t border-border pt-1.5 text-[10px] leading-snug">
        {shifted ? (
          <span className="text-foreground">
            {tr('最可能比分 ', 'Most likely ')}
            <span className="font-mono tnum">
              {topA.home}-{topA.away}
            </span>
            {tr(' → ', ' → ')}
            <span className="font-mono tnum font-semibold">
              {topB.home}-{topB.away}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">
            {tr('最可能比分未变（', 'Most likely unchanged (')}
            <span className="font-mono tnum">
              {topA.home}-{topA.away}
            </span>
            {tr('）—— 热度没有把它推去别处', ') — heat does not push it elsewhere')}
          </span>
        )}
      </p>

      <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
        {tr(
          '两个边际（总进球、净胜球）由图上可见的大小球 / 让球 / 胜平负相减得出，无模型。',
          'Both marginals (total goals, goal difference) are derived by subtracting visible totals / spread / moneyline lines — no model.',
        )}
      </p>
      <p className="mt-1 text-[10px] leading-snug text-warning">
        {tr(
          '两套的联合分布都按独立假设拼接（最大熵，非盘口给出），已知会高估平局。',
          'Both joints use an independence assumption (max-entropy, not given by the book); known to overstate draws.',
        )}
      </p>
      <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
        {tr(
          'B 是反推「庄家希望比赛往哪偏」的假设，不是更准的预测。热度用成交量，是流量不是存量、且按盘口统计。',
          'B is a hypothesis about where a book would want the result to drift — not a better forecast. Heat uses volume: a flow, not a stock, and per-market.',
        )}
      </p>
    </Card>
  )
}

/** 一套预测：标签 + 最可能 + 网格 */
function Grid({ label, result, max }: { label: string; result: ScoreGridResult; max: number }) {
  const n = result.maxGoals
  const idx = Array.from({ length: n + 1 }, (_, i) => i)
  const top = result.ranked[0]
  return (
    <div className="mb-2">
      <p className="mb-1 flex items-baseline justify-between text-[10px]">
        <span className="font-semibold text-foreground">{label}</span>
        <span className="font-mono tnum text-muted-foreground">
          <span className="text-foreground">
            {top.home}-{top.away}
          </span>{' '}
          {(top.prob * 100).toFixed(1)}%
        </span>
      </p>
      <div
        className="grid gap-px text-[9px] leading-none"
        style={{ gridTemplateColumns: `auto repeat(${n + 1}, 1fr)` }}
      >
        <span />
        {idx.map((a) => (
          <span key={a} className="pb-0.5 text-center text-muted-foreground">
            {a}
          </span>
        ))}
        {idx.map((h) => (
          <GridRow key={h} h={h} n={n} cells={result.cells[h]} max={max} />
        ))}
      </div>
    </div>
  )
}

/** 网格的一行：行标签 + 各列格子。抽出来是因为 JSX 里不能在 map 里直接返回多元素 */
function GridRow({
  h,
  n,
  cells,
  max,
}: {
  h: number
  n: number
  cells: ScoreGridResult['cells'][number]
  max: number
}) {
  return (
    <>
      <span className="pr-1 text-right text-muted-foreground">{h}</span>
      {cells.slice(0, n + 1).map((c) => {
        const t = max > 0 ? c.prob / max : 0
        return (
          <span
            key={c.away}
            className="tnum rounded-[2px] py-1 text-center font-mono text-foreground"
            style={{ backgroundColor: `color-mix(in srgb, var(--color-primary) ${Math.round(t * 70)}%, transparent)` }}
            title={tr(
              `${c.home}-${c.away}：${(c.prob * 100).toFixed(2)}%`,
              `${c.home}-${c.away}: ${(c.prob * 100).toFixed(2)}%`,
            )}
          >
            {c.prob >= 0.005 ? Math.round(c.prob * 100) : '·'}
          </span>
        )
      })}
    </>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-border bg-card p-3 shadow-sm')}>{children}</div>
  )
}
