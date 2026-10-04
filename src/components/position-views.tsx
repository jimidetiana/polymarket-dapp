/**
 * 持仓行与成交行的**纯展示**组件，下单弹窗（order-dialog）和「我的订单」页
 * （pages/orders）共用。
 *
 * ## 为什么单独抽一个文件
 *
 * 这两处要画的行一样，但**打包位置相反**：order-dialog 是 lazy 加载、链到底会牵进
 * @polymarket/client（约 300 kB gzip）；订单页在主包里，必须不碰 SDK（见
 * lib/use-positions.ts 顶部那条硬约束）。所以不能让订单页 import order-dialog 去复用 ——
 * 那会把整块 SDK 打回首屏。抽到这里两边都能引：本文件只依赖 positions 类型、i18n、
 * dict（翻译）、cn，**不碰 SDK**。
 *
 * ## 两种密度
 *
 * `showTitle`（账户级列表）画成带缩略图、标题、结果标签的卡片 —— 一屏混着多张盘口，
 * 不摆出「买的是哪场、哪一侧」就只剩一串数字。弹窗里已经在某张盘口的上下文里，
 * 走紧凑单行，省纵向空间。两种都把英文结果换成中文（localizeOutcome）。
 */
import { useState } from 'react'
import { tr, zonedTimeParts } from '../lib/i18n'
import { cn } from '../lib/utils'
import { localizeMarketTitle, localizeOutcome } from '../lib/dict'
import { grossAvgPriceOf, type PolyPosition, type PolyTrade } from '../lib/positions'

/**
 * 盘口缩略图。data-api 直接给 URL；拿不到或加载失败时退到一个灰块占位 ——
 * 占位保住布局不塌，也让「有图没图」看起来一致。
 */
function Thumb({ src, size = 'md' }: { src?: string; size?: 'sm' | 'md' }) {
  const [broken, setBroken] = useState(false)
  const cls = cn(
    'shrink-0 rounded-lg border border-border object-cover',
    size === 'sm' ? 'size-8' : 'size-11',
  )
  if (!src || broken) return <div className={cn(cls, 'bg-muted')} aria-hidden />
  return <img src={src} alt="" loading="lazy" className={cls} onError={() => setBroken(true)} />
}

/** 盈亏数字，按方向着色。`+$8.40` / `−$1.20` */
function Pnl({ value, className }: { value: number; className?: string }) {
  return (
    <span
      className={cn(
        'font-mono tnum font-semibold',
        value > 0 ? 'text-success' : value < 0 ? 'text-error' : 'text-muted-foreground',
        className,
      )}
    >
      {value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}
    </span>
  )
}

/** 买/卖小标。买绿卖红，与画布、盘口深度同一套语义色 */
function SideBadge({ side }: { side: string }) {
  const buy = side === 'BUY'
  return (
    <span
      className={cn(
        'rounded px-1 py-0.5 text-[10px] font-medium',
        buy ? 'bg-success/10 text-success' : 'bg-error/10 text-error',
      )}
    >
      {buy ? tr('买', 'Buy') : tr('卖', 'Sell')}
    </span>
  )
}

/** 结果标签（买/持有的那一侧）：中文化 + 蓝底，做成一眼能认的主体信息 */
function OutcomeChip({ outcome }: { outcome: string }) {
  return (
    <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
      {localizeOutcome(outcome) || '—'}
    </span>
  )
}

/** 「已结算 / 已平仓」小标 */
function SettledTag({ redeemable }: { redeemable: boolean }) {
  return (
    <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
      {redeemable ? tr('已结算', 'Settled') : tr('已平仓', 'Exited')}
    </span>
  )
}

/**
 * 一条仓位。
 *
 * `settled` 时盈亏取**已实现**而非浮动：仓位已不在场上，结算后 curPrice 被推到 0/1，
 * 拿它算的浮盈是假的。`showTitle` 决定卡片（账户页）还是紧凑单行（弹窗）。
 */
export function PositionRow({
  p,
  settled,
  showTitle,
}: {
  p: PolyPosition
  settled?: boolean
  showTitle?: boolean
}) {
  const pnl = settled ? p.realizedPnl : p.cashPnl
  // 均价用**含费**价：手续费不摊进单价，用户看到的成本就比实际低（见 positions.grossAvgPriceOf）
  const avg = grossAvgPriceOf(p)

  // 紧凑单行（弹窗内）：不摆缩略图和标题（那儿已在盘口上下文里），只把结果换成中文。
  if (!showTitle) {
    return (
      <div className="rounded border border-border bg-background px-2 py-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] text-foreground">
            {settled && <SettledTag redeemable={p.redeemable} />}
            <span className={cn('font-medium', settled && 'ml-1.5')}>{localizeOutcome(p.outcome) || '—'}</span>
            <span className="ml-1.5 font-mono tnum text-muted-foreground">{p.size} {tr('份', 'shares')}</span>
          </span>
          <Pnl value={pnl} className="shrink-0 text-[11px]" />
        </div>
        <p className="mt-0.5 font-mono text-[10px] tnum text-muted-foreground">
          {tr('均价', 'Avg')} {avg.toFixed(3)}
          {!settled &&
            tr(
              ` · 现价 ${p.curPrice.toFixed(3)} · 市值 $${p.currentValue.toFixed(2)}`,
              ` · Now ${p.curPrice.toFixed(3)} · Value $${p.currentValue.toFixed(2)}`,
            )}
          {!settled && p.percentPnl !== 0 && ` · ${p.percentPnl > 0 ? '+' : '−'}${Math.abs(p.percentPnl).toFixed(1)}%`}
        </p>
      </div>
    )
  }

  // 卡片（账户页）：缩略图 + 中文标题 + 结果标签，右上放盈亏。
  return (
    <article className="flex gap-3 rounded-xl border border-border bg-card p-3">
      <Thumb src={p.icon} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {settled && <SettledTag redeemable={p.redeemable} />}
            <h3 className={cn('line-clamp-2 text-[13px] font-medium leading-snug text-foreground', settled && 'mt-0.5')}>
              {localizeMarketTitle(p.title) || tr('未知盘口', 'Unknown market')}
            </h3>
          </div>
          <div className="shrink-0 text-right">
            <Pnl value={pnl} className="block text-sm" />
            {!settled && p.percentPnl !== 0 && (
              <span className={cn('font-mono tnum text-[10px]', p.percentPnl > 0 ? 'text-success' : 'text-error')}>
                {p.percentPnl > 0 ? '+' : '−'}{Math.abs(p.percentPnl).toFixed(1)}%
              </span>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <OutcomeChip outcome={p.outcome} />
          <span className="font-mono tnum text-[11px] text-muted-foreground">
            {p.size} {tr('份', 'shares')} · {tr('均价', 'avg')} {avg.toFixed(3)}
          </span>
        </div>

        <p className="mt-1 font-mono text-[10px] tnum text-muted-foreground">
          {settled
            ? p.endDate && tr(`截止 ${p.endDate}`, `Ends ${p.endDate}`)
            : tr(
                `现价 ${p.curPrice.toFixed(3)} · 市值 $${p.currentValue.toFixed(2)}`,
                `Now ${p.curPrice.toFixed(3)} · Value $${p.currentValue.toFixed(2)}`,
              )}
        </p>
      </div>
    </article>
  )
}

/**
 * 一条成交明细。`showTitle` 同 PositionRow：账户页画成带缩略图、标题的行，弹窗内走紧凑单行。
 */
export function TradeRow({ t, showTitle }: { t: PolyTrade; showTitle?: boolean }) {
  if (!showTitle) {
    return (
      <div className="flex items-baseline justify-between gap-2 px-2 py-1.5">
        <span className="min-w-0 text-[10px] text-foreground">
          <SideBadge side={t.side} />
          <span className="ml-1.5 text-muted-foreground">{localizeOutcome(t.outcome)}</span>
          <span className="ml-1.5 font-mono tnum">{t.size} @ {t.price.toFixed(3)}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatTradeTime(t.timestamp)}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <Thumb src={t.icon} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium text-foreground">
          {localizeMarketTitle(t.title) || tr('未知盘口', 'Unknown market')}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[10px]">
          <SideBadge side={t.side} />
          <span className="text-muted-foreground">{localizeOutcome(t.outcome)}</span>
          <span className="font-mono tnum text-foreground">{t.size} @ {t.price.toFixed(3)}</span>
        </p>
      </div>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatTradeTime(t.timestamp)}</span>
    </div>
  )
}

/**
 * 成交时间。模块内部用（只有 TradeRow 调），不导出 —— 导出非组件会触发 fast-refresh 的
 * only-export-components 告警，而它没有第二个调用点。
 *
 * ⚠️ data-api 的 `timestamp` 是**秒**，不是毫秒 —— 直接喂 `new Date()` 会得到 1970 年。
 * 只显示到分钟：秒对「我什么时候买的」没有意义。时区跟界面语言走（见 i18n.zonedTimeParts）。
 */
function formatTradeTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  const t = zonedTimeParts(new Date(sec * 1000))
  return `${t.month}-${t.day} ${t.hour}:${t.minute}`
}
