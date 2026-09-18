/**
 * 盘口深度。点某一档就把那个价填进限价。
 *
 * 纯展示：数据由调用方（下单弹窗）拉。这样 tick 只有一个来源 ——
 * 弹窗拿 CLOB 报的 tickSize 定表单精度，深度里显示的价也按同一个 tick
 * 格式化，不会出现「深度显示 0.155、限量框显示 0.16」这种自相矛盾。
 */
import { cn } from '../lib/utils'
import { formatTickPrice, type TickSize } from '../lib/tick'
import type { BookLevelView, BookView } from '../lib/use-clob'

const ROWS = 6

interface Props {
  book: BookView | null
  loading: boolean
  error: string | null
  tick: TickSize
  onPick: (price: number) => void
}

export function OrderBook({ book, loading, error, tick, onPick }: Props) {
  if (error) {
    return (
      <div className="rounded-lg border border-border bg-background p-3 text-[11px] text-warning">
        盘口深度拉不到：{error}
      </div>
    )
  }
  if (loading && !book) {
    return (
      <div className="rounded-lg border border-border bg-background p-3 text-[11px] text-muted-foreground">
        读取盘口深度…
      </div>
    )
  }
  if (!book || (!book.asks.length && !book.bids.length)) {
    return (
      <div className="rounded-lg border border-border bg-background p-3 text-[11px] leading-snug text-muted-foreground">
        这个盘口此刻没有任何挂单，所以没有可成交的价。
        <br />
        赛前盘口常常是这样 —— 限价单可以挂，但不会立刻成交。
      </div>
    )
  }

  const asks = book.asks.slice(0, ROWS)
  const bids = book.bids.slice(0, ROWS)
  const maxSize = Math.max(...[...asks, ...bids].map((l) => l.size), 1)
  const spread =
    book.bestAsk != null && book.bestBid != null ? book.bestAsk - book.bestBid : null

  return (
    <div className="space-y-1 rounded-lg border border-border bg-background p-2">
      <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground">
        <span>盘口深度</span>
        <span>
          {book.minOrderSize != null && `最小 ${book.minOrderSize} 份 · `}
          点价格填入限价
        </span>
      </div>

      {/* 卖盘：从远到近，最优卖价紧贴中间那行 */}
      <div className="space-y-px">
        {[...asks].reverse().map((l, i) => (
          <DepthRow key={`ask${i}`} level={l} tick={tick} side="ask" maxSize={maxSize} onPick={onPick} />
        ))}
        {asks.length === 0 && <EmptyRow>无卖盘</EmptyRow>}
      </div>

      <div className="flex items-center justify-between border-y border-border px-1 py-1 text-[10px]">
        <span className="text-muted-foreground">点差</span>
        <span className="font-mono tnum text-foreground">
          {spread == null ? '—' : formatTickPrice(spread, tick)}
        </span>
      </div>

      {/* 买盘：从近到远 */}
      <div className="space-y-px">
        {bids.map((l, i) => (
          <DepthRow key={`bid${i}`} level={l} tick={tick} side="bid" maxSize={maxSize} onPick={onPick} />
        ))}
        {bids.length === 0 && <EmptyRow>无买盘</EmptyRow>}
      </div>
    </div>
  )
}

/**
 * 一档。
 *
 * 背量条按**本侧最大量**归一，而不是全盘最大：买盘量级常常比卖盘大一个
 * 数量级，用同一个分母会让卖盘那一列全是看不见的细线。
 */
function DepthRow({
  level,
  tick,
  side,
  maxSize,
  onPick,
}: {
  level: BookLevelView
  tick: TickSize
  side: 'bid' | 'ask'
  maxSize: number
  onPick: (price: number) => void
}) {
  const pct = Math.max(2, Math.min(100, (level.size / maxSize) * 100))
  return (
    <button
      type="button"
      onClick={() => onPick(level.price)}
      className="relative flex w-full items-center justify-between rounded px-1 py-0.5 text-[11px] hover:bg-muted"
    >
      <span
        className={cn('absolute inset-y-0 right-0 rounded', side === 'bid' ? 'bg-success/15' : 'bg-error/15')}
        style={{ width: `${pct}%` }}
      />
      <span
        className={cn(
          'relative z-10 font-mono tnum',
          side === 'bid' ? 'text-success' : 'text-error',
        )}
      >
        {formatTickPrice(level.price, tick)}
      </span>
      <span className="relative z-10 font-mono tnum text-muted-foreground">{level.size}</span>
    </button>
  )
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-0.5 text-[10px] text-muted-foreground">{children}</p>
}
