/**
 * 下单表单。从原项目 frontend/src/components/order-form.tsx 搬来。
 *
 * ## 搬过来时改了什么
 *
 * 原版的限价用**美分整数**（0~99）。那只对 tick=0.01 成立：tick=0.001 的
 * 盘口真实报价是 0.155 / 0.156，挤不进「分」这个网格，切到分就会白让半个
 * tick。所以这里改成**以 tick 为单位的整数步**，展示走 lib/tick.ts 的
 * formatTickPrice —— 与提交给 CLOB 的是同一条整数路径，不会出现「界面显示
 * 0.15 而实际提交 0.16」。
 *
 * 其余（买入/卖出、市价/限价、按份额/按金额、±5/±1、预估总额）与原版一致，
 * 包括 MIN_SHARES 与 MIN_AMOUNT 的取值。
 */
import { useEffect, useState } from 'react'
import { cn } from '../lib/utils'
import {
  formatTickPercent,
  formatTickPrice,
  fromSteps,
  isPriceValid,
  priceBounds,
  stepBounds,
  toSteps,
  type TickSize,
} from '../lib/tick'
import type { OrderKind, OrderSideName } from '../lib/clob-client'

/** 与原项目同值。真正的下限还受 CLOB 的 minOrderSize 约束，由调用方传进来 */
const MIN_SHARES = 5
const MIN_AMOUNT = 1

export type OrderFormValues = {
  side: OrderSideName
  size: number
  price: number
  type: OrderKind
}

interface Props {
  outcomeName: string
  marketQuestion: string
  /**
   * 可成交的价。**买看卖一、卖看买一** —— 只有一个价是不对的：
   * 这两者差着一个点差，用买一去估买单的成交价会系统性偏乐观。
   */
  bestBid: number | null
  bestAsk: number | null
  /** 某侧缺失时的兜底（WS 只有单边、或全是 Gamma 快照时） */
  fallbackPrice: number
  tick: TickSize
  /** 最小下单份额。CLOB 盘口给了就用它的，没给用 5 */
  minShares?: number
  /** 可用余额（USDC）。undefined = 拿不到，此时不做上限校验 */
  maxAmount?: number
  /** 从盘口深度点进来的价。timestamp 变了才生效，避免每次渲染都覆盖用户输入 */
  externalPrice?: { steps: number; timestamp: number } | null
  submitting: boolean
  /** 未就绪的原因。有值时整个表单禁用并显示这句话 */
  blockedReason?: string | null
  onSubmit: (values: OrderFormValues) => void
}

export function OrderForm({
  outcomeName,
  marketQuestion,
  bestBid,
  bestAsk,
  fallbackPrice,
  tick,
  minShares = MIN_SHARES,
  maxAmount,
  externalPrice,
  submitting,
  blockedReason,
  onSubmit,
}: Props) {
  const [side, setSide] = useState<OrderSideName>('BUY')
  const [type, setType] = useState<OrderKind>('market')
  const [mode, setMode] = useState<'shares' | 'amount'>('shares')
  const [sizeStr, setSizeStr] = useState(String(minShares))
  const [amountStr, setAmountStr] = useState('')

  const bounds = stepBounds(tick)
  const clampSteps = (s: number) => Math.min(bounds.maxSteps, Math.max(bounds.minSteps, Math.round(s)))

  /** 这一侧的可成交价。买吃卖一、卖吃买一 */
  const sidePrice = (side === 'BUY' ? bestAsk : bestBid) ?? fallbackPrice

  // 限价是**整数步**，不是小数。初始值取当前价吸附到网格上的那一格。
  // 调用方必须给它 key（弹窗用的是 `${tokenId}:${tick}`）：这里是 useState
  // 初值，只算一次，换到另一侧（互补价，差得很远）或换了 tick 精度时不重挂
  // 就会把上一侧的挂价留着。
  const [limitSteps, setLimitSteps] = useState(() => clampSteps(toSteps(sidePrice, tick)))

  // 用户在表单里换买卖方向时，把限价重置到那一侧的可成交价。
  // 不重置的话，切到卖出会留着买入的价 —— 那是两个差着一个点差的数，
  // 挂着不动就是一张永远不成交的单。
  useEffect(() => {
    setLimitSteps(clampSteps(toSteps((side === 'BUY' ? bestAsk : bestBid) ?? fallbackPrice, tick)))
    // 只在换方向时触发：把 bestAsk/bestBid 放进依赖会让盘口每次跳动都
    // 覆盖用户正在输的价
  }, [side]) // eslint-disable-line react-hooks/exhaustive-deps

  // 点深度里的某一档 → 填进限价并切到限价模式（市价单没有「挂哪个价」一说）
  useEffect(() => {
    if (!externalPrice) return
    setLimitSteps(clampSteps(externalPrice.steps))
    setType('limit')
    // 只在 timestamp 变化时生效
  }, [externalPrice?.timestamp]) // eslint-disable-line react-hooks/exhaustive-deps

  const price = type === 'market' ? sidePrice : fromSteps(limitSteps, tick)
  const size =
    mode === 'shares'
      ? Math.floor(Number(sizeStr) || 0)
      : price > 0
        ? Math.floor((Number(amountStr) || 0) / price)
        : 0
  // 与 clob-client 的 usdOf 同口径：界面上显示的总额就是会发出去的数
  const total = Math.round(size * price * 100) / 100

  const pb = priceBounds(tick)
  const priceOk = type === 'market' ? price > 0 && price < 1 : isPriceValid(price, tick)

  /**
   * 市价单要吃的那一侧此刻没有挂单。
   *
   * 这是个必须单独拦的情况：只有买盘而没有卖盘时，fallbackPrice 会退到买一，
   * 于是「市价买入」看上去有个合理价格，实际发出去是一张按买价买单、
   * 而对面根本没有卖单的单 —— 要么被拒，要么僵在那里。限价单不受此限。
   */
  const noMarketSide = type === 'market' && (side === 'BUY' ? bestAsk == null : bestBid == null)

  const overBalance = maxAmount != null && total > maxAmount
  const valid = size >= minShares && priceOk && !noMarketSide && !overBalance && total >= MIN_AMOUNT

  const error = noMarketSide
    ? `此刻没有${side === 'BUY' ? '卖盘' : '买盘'}，市价${side === 'BUY' ? '买' : '卖'}吃不到东西。改成限价挂一单，或者等有报价再来。`
    : !priceOk
      ? `价格必须是 ${formatTickPrice(pb.min, tick)} ~ ${formatTickPrice(pb.max, tick)} 且落在 ${tick} 的网格上`
      : size > 0 && size < minShares
        ? `最少 ${minShares} 份`
        : overBalance
          ? `超出可用余额 $${(maxAmount ?? 0).toFixed(2)}`
          : size > 0 && total < MIN_AMOUNT
            ? `总额至少 $${MIN_AMOUNT}`
            : null

  const blocked = !!blockedReason

  /**
   * ± 按钮。
   *
   * 按**当前口径**调整，而不是固定改成份额：原来无论在哪一档都写 sizeStr，
   * 于是在「按金额」下点 +5 会悄悄把口径切成份额 —— 用户看到输入框里的
   * 数字变了、单位也变了，但没人告诉他。
   */
  function bump(delta: number) {
    if (mode === 'shares') {
      setSizeStr(String(Math.max(0, size + delta)))
      return
    }
    const next = Math.max(0, (Number(amountStr) || 0) + delta)
    setAmountStr(next.toFixed(2))
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-background p-3">
        <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{marketQuestion}</p>
        <div className="mt-1.5 flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-foreground">{outcomeName}</span>
          <span className="font-mono text-lg font-bold tnum text-primary">
            {formatTickPercent(price, tick)}
          </span>
        </div>
        <p className="mt-0.5 text-right text-[10px] text-muted-foreground">
          单价 {formatTickPrice(price, tick)} · tick {tick}
        </p>
      </div>

      {/* 买入 / 卖出 */}
      <div className="grid grid-cols-2 gap-2">
        {(['BUY', 'SELL'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={cn(
              'rounded-md border px-2 py-1.5 text-xs font-semibold transition-colors',
              side === s
                ? s === 'BUY'
                  ? 'border-success bg-success/15 text-success'
                  : 'border-error bg-error/15 text-error'
                : 'border-border bg-background text-muted-foreground hover:bg-muted',
            )}
          >
            {s === 'BUY' ? '买入' : '卖出'}
          </button>
        ))}
      </div>

      {/* 市价 / 限价 */}
      <div className="grid grid-cols-2 gap-2">
        {(['market', 'limit'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={cn(
              'rounded-md border px-2 py-1.5 text-xs transition-colors',
              type === t
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-background text-muted-foreground hover:bg-muted',
            )}
          >
            {t === 'market' ? '市价' : '限价'}
          </button>
        ))}
      </div>

      {type === 'market' ? (
        <p className="rounded-md border border-border bg-background px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
          {side === 'BUY' ? '吃单买入' : '吃单卖出'}，最差可接受价就是此刻的
          {side === 'BUY' ? '卖一 ' : '买一 '}
          <span className="font-mono text-foreground">{formatTickPrice(sidePrice, tick)}</span>
          。盘口一动就挂不出去 —— 这是有意的：宁可没成交，也不按一个你没看见的价成交。
        </p>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">限价</span>
            <button
              type="button"
              onClick={() => setLimitSteps((v) => clampSteps(v - 1))}
              disabled={limitSteps <= bounds.minSteps}
              className="size-7 shrink-0 rounded-md border border-border text-sm text-foreground disabled:opacity-40"
            >
              −
            </button>
            <div className="flex-1 rounded-md border border-border bg-background py-1 text-center font-mono text-sm font-semibold tnum text-foreground">
              {formatTickPrice(price, tick)}
            </div>
            <button
              type="button"
              onClick={() => setLimitSteps((v) => clampSteps(v + 1))}
              disabled={limitSteps >= bounds.maxSteps}
              className="size-7 shrink-0 rounded-md border border-border text-sm text-foreground disabled:opacity-40"
            >
              +
            </button>
          </div>
          <div className="flex gap-1.5 pl-14">
            {[-10, -5, -1, 1, 5, 10].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setLimitSteps((v) => clampSteps(v + d))}
                className="flex-1 rounded border border-border py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
              >
                {d > 0 ? `+${d}` : d}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 按份额 / 按金额 */}
      <div className="flex gap-1.5">
        {(['shares', 'amount'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              if (m === mode) return
              // 换口径时把当前值带过去，而不是清空 —— 清空后用户得重新输一遍
              if (m === 'amount') setAmountStr(total > 0 ? total.toFixed(2) : '')
              else setSizeStr(String(size || ''))
              setMode(m)
            }}
            className={cn(
              'rounded border px-2 py-0.5 text-[10px] transition-colors',
              mode === m
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {m === 'shares' ? '按份额' : '按金额'}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-muted-foreground">
            {mode === 'shares' ? '份额' : '金额'}
          </span>
          <button
            type="button"
            onClick={() => bump(-5)}
            className="size-7 shrink-0 rounded-md border border-border text-sm text-foreground"
          >
            −
          </button>
          <input
            inputMode="decimal"
            value={mode === 'shares' ? sizeStr : amountStr}
            onChange={(e) => {
              const v = e.target.value
              if (mode === 'shares') setSizeStr(v)
              else setAmountStr(v)
            }}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-center font-mono text-sm tnum text-foreground outline-none focus:border-primary"
            placeholder={mode === 'shares' ? String(minShares) : '0.00'}
          />
          <button
            type="button"
            onClick={() => bump(5)}
            className="size-7 shrink-0 rounded-md border border-border text-sm text-foreground"
          >
            +
          </button>
        </div>
        <div className="flex gap-1.5 pl-14">
          {[-5, -1, 1, 5].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => bump(d)}
              className="flex-1 rounded border border-border py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
            >
              {d > 0 ? `+${d}` : d}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1 rounded-md border border-border bg-background p-2.5 text-[11px]">
        <SumRow k="单价" v={formatTickPrice(price, tick)} />
        <SumRow k="份额" v={String(size)} />
        <SumRow k="预估总额" v={`$${total.toFixed(2)}`} strong />
        {maxAmount != null && (
          <SumRow k="可用余额" v={`$${maxAmount.toFixed(2)}`} />
        )}
      </div>

      {(error || blocked) && (
        <p className="text-[11px] leading-snug text-warning">{blocked || error}</p>
      )}

      <button
        type="button"
        disabled={!valid || submitting || blocked}
        onClick={() => onSubmit({ side, size, price, type })}
        className={cn(
          'w-full rounded-md px-3 py-2 text-sm font-semibold transition-colors',
          side === 'BUY'
            ? 'bg-success text-background hover:brightness-110'
            : 'bg-error text-background hover:brightness-110',
          'disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
        )}
      >
        {submitting ? '提交中…' : `${side === 'BUY' ? '买入' : '卖出'} ${outcomeName} · $${total.toFixed(2)}`}
      </button>
    </div>
  )
}

function SumRow({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn('font-mono tnum', strong ? 'font-semibold text-foreground' : 'text-foreground')}>
        {v}
      </span>
    </div>
  )
}
