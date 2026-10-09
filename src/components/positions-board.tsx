/**
 * 持仓板 —— 「我的订单」页里持仓的展示，长得和导出的 PNG（lib/orders-export）**大致一样**：
 * 蓝色品牌渐变头、按比赛分组的表格（组头一条主色竖条 + 浅蓝底 + 「谁对谁」）、
 * 盘口 / 选择药丸 / 时间 / 均价·欧赔 / 份额 / 花费 六列，底部合计 + 门户水印。
 *
 * ## 为什么不直接用导出那份数据
 *
 * 导出是 canvas 画到位图（可分享、跨端一致），这里是 DOM（能勾选、能点、能滚）。两处
 * 共用**同一条归组规则**（orders-export 的 groupByMatch）和**同一套数字口径**（pct /
 * euroOdds / positionTimeText），所以看起来对得上；只有排版各画各的。行数据由页面层用
 * 同一个 toExportRow 造好（ExportRow），板子只管排版与勾选，不碰词典。
 *
 * ## 两套排版
 *
 * 桌面（sm+）走和图片一致的对齐表格（网格列宽同比例）；窄屏排不下六列，退成两行卡片
 * （首行：盘口 + 花费；次行：选择药丸 · 均价·欧赔 · 份额 · 时间），信息不丢，只是换行。
 */
import { tr } from '../lib/i18n'
import { siteDisplayUrl } from '../lib/site'
import { cn } from '../lib/utils'
import { euroOdds, groupByMatch, pct, positionTimeText, type ExportRow } from '../lib/orders-export'

/** 一行持仓 + 它在勾选集里的键（与页面的 posKey 同源） */
export type BoardRow = { key: string; row: ExportRow; href: string }

/** 门户网址，印在页脚水印处（与导出图片一致）。换域名只改 lib/site.ts 一处 */
const SITE_URL = siteDisplayUrl()

/**
 * 桌面表格列宽，与导出图片同比例（盘口 168 / 选择 200 / 时间 130 / 均价·欧赔 138 /
 * 份额 78 / 花费 134）。首列 16px 留给勾选框。表头与每行都套同一份，列才对得齐。
 */
const GRID = 'grid-cols-[16px_1.68fr_2fr_1.3fr_1.38fr_0.78fr_1.34fr]'

/** 份额去掉多余小数：整数就整数，否则两位 */
function trimShares(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** 已格式化的一行（数字口径与导出图片同源） */
function fmt(r: ExportRow) {
  return {
    market: r.market || '—',
    pick: r.pick || '—',
    time: positionTimeText(r.timeSec),
    price: `${pct(r.avgPrice)} · ${euroOdds(r.avgPrice)}`,
    shares: trimShares(r.size),
    cost: `$${(r.size * r.avgPrice).toFixed(2)}`,
  }
}

/** 选择药丸：淡蓝底，与卡片 OutcomeChip 同一套观感 */
function Pick({ text }: { text: string }) {
  return (
    <span className="inline-block max-w-full truncate rounded-md bg-primary/10 px-2 py-0.5 align-middle text-[11px] font-semibold text-primary">
      {text}
    </span>
  )
}

export function PositionsBoard({
  rows,
  account,
  selected,
  onToggle,
}: {
  rows: BoardRow[]
  account?: string
  selected: Set<string>
  onToggle: (key: string) => void
}) {
  const groups = groupByMatch(rows, (br) => br.row.match)
  let totalShares = 0
  let totalCost = 0
  let totalFee = 0
  for (const { row } of rows) {
    totalShares += row.size
    // avgPrice 已是含费价，所以手续费不再加进合计，只另报一次 —— 见 orders-export 顶部口径
    totalCost += row.size * row.avgPrice
    if (Number.isFinite(row.feeUsd)) totalFee += row.feeUsd
  }

  return (
    <div className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_8px_28px_rgba(20,20,40,0.10)]">
      {/* 品牌渐变头 */}
      <div className="flex items-start justify-between gap-3 bg-gradient-to-r from-[#007aff] to-[#0a5bd0] px-5 py-4 text-white">
        <div className="min-w-0">
          <p className="text-lg font-bold leading-tight">PolySoccer</p>
          <p className="text-[11px] font-medium text-white/80">{tr('足球盘口交易门户', 'Soccer markets portal')}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold">{tr('我的持仓', 'My Positions')}</p>
          {account && <p className="mt-0.5 font-mono text-[10px] text-white/80">{account}</p>}
        </div>
      </div>

      {/* 表头（只在桌面画：窄屏两行布局自解释） */}
      <div className={cn('hidden gap-2 border-b border-border px-5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-wide text-[#9a9aa0] sm:grid', GRID)}>
        <span />
        <span>{tr('盘口', 'MARKET')}</span>
        <span>{tr('选择', 'PICK')}</span>
        <span>{tr('时间', 'TIME')}</span>
        <span>{tr('均价 · 欧赔', 'AVG · ODDS')}</span>
        <span className="text-right">{tr('份额', 'SHARES')}</span>
        <span className="text-right">{tr('花费', 'COST')}</span>
      </div>

      {/* 各比赛分组 */}
      {groups.map((g, gi) => (
        <div key={gi}>
          {/* 组头：主色竖条 + 浅蓝底 + 「谁对谁」，右侧盘口数 */}
          <div className="flex items-center justify-between gap-2 border-l-[3px] border-primary bg-primary/[0.06] px-5 py-2">
            <span className="min-w-0 truncate text-[13px] font-bold text-foreground">{g.match}</span>
            <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
              {tr(`${g.items.length} 个盘口`, `${g.items.length} markets`)}
            </span>
          </div>

          {g.items.map((br) => {
            const f = fmt(br.row)
            const on = selected.has(br.key)
            return (
              <div
                key={br.key}
                className={cn(
                  'relative block border-b border-border/70 transition-colors last:border-0 hover:bg-muted/50',
                  on && 'bg-primary/[0.05]',
                )}
              >
                <a href={br.href} aria-label={`${br.row.match} · ${f.market} · ${f.pick}`} className="absolute inset-y-0 left-10 right-0 focus-visible:outline-primary" />
                {/* 桌面：对齐表格 */}
                <div className={cn('hidden items-center gap-2 px-5 py-2.5 sm:grid', GRID)}>
                  <input type="checkbox" aria-label={tr('选择导出', 'Select for export')} checked={on} onChange={() => onToggle(br.key)} className="size-4 accent-[var(--color-primary)]" />
                  <span className="truncate text-[12px] font-semibold text-foreground">{f.market}</span>
                  <span className="min-w-0"><Pick text={f.pick} /></span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{f.time}</span>
                  <span className="font-mono text-[12px] text-foreground">{f.price}</span>
                  <span className="text-right font-mono text-[12px] text-foreground">{f.shares}</span>
                  <span className="text-right font-mono text-[12px] font-bold text-foreground">{f.cost}</span>
                </div>

                {/* 窄屏：两行 */}
                <div className="px-4 py-2.5 sm:hidden">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" aria-label={tr('选择导出', 'Select for export')} checked={on} onChange={() => onToggle(br.key)} className="size-4 shrink-0 accent-[var(--color-primary)]" />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">{f.market}</span>
                    <span className="shrink-0 font-mono text-[12px] font-bold text-foreground">{f.cost}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[11px]">
                    <Pick text={f.pick} />
                    <span className="font-mono text-muted-foreground">{f.price}</span>
                    <span className="font-mono text-muted-foreground">{f.shares} {tr('份', 'sh')}</span>
                    <span className="font-mono text-[10px] text-muted-foreground/80">{f.time}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ))}

      {/* 页脚合计 + 门户水印 */}
      <div className="border-t-2 border-foreground/70 px-5 pb-2 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="text-[11px] text-muted-foreground">
            {tr(
              `${groups.length} 场比赛 · ${rows.length} 个盘口 · 总份额 ${trimShares(totalShares)}`,
              `${groups.length} matches · ${rows.length} markets · ${trimShares(totalShares)} shares`,
            )}
            {totalFee > 0 &&
              tr(` · 含手续费 $${totalFee.toFixed(2)}`, ` · incl. fees $${totalFee.toFixed(2)}`)}
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="text-[11px] text-muted-foreground">{tr('总成本', 'Total cost')}</span>
            <span className="font-mono text-base font-bold text-primary">${totalCost.toFixed(2)}</span>
          </span>
        </div>
        <p className="mt-1 text-center font-mono text-[10px] text-muted-foreground/70">{SITE_URL}</p>
      </div>
    </div>
  )
}
