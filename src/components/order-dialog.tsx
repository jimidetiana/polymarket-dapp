/**
 * 下单弹窗。从原项目 frontend/src/components/order-dialog.tsx 搬来，
 * **提交那半截重写了** —— 原版是 `submitOrder() → POST /api/soccer/orders`，
 * 私钥和 CLOB 凭据在后端；dapp 没有后端，所以改成浏览器内签名
 * （见 lib/clob-client.ts）。
 *
 * 结构上与原版一致：左深度、右表单，头部盘口信息 + 两侧切换。
 * 「我的订单」那条改成**按需加载**：读挂单也要先建已认证客户端，
 * 而建客户端会让用户签一次名 —— 打开弹窗就弹签名没人受得了。
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils'
import { OrderForm } from './order-form'
import { OrderBook } from './order-book'
import { DEFAULT_TICK, formatTickPrice, TICK_SIZES, toSteps, type TickSize } from '../lib/tick'
import { PUSD_DECIMALS } from '../lib/money'
import { feeBreakdown, formatFeeAmount, settleOf } from '../lib/fee'
import {
  useBuilderFeeRates,
  useClob,
  useCollateralBalance,
  useOrderBook,
  useProxyWallet,
} from '../lib/use-clob'
import { explainError, type OpenOrderRow, type PlaceOutcome } from '../lib/clob-client'
import type { Quote } from '../lib/book'

export type OrderSideChoice = { name: string; tokenId: string }

interface Props {
  tokenId: string
  /** 买的是哪一侧，如 Over / 主胜 */
  sideName: string
  /** 「已选盘口」那行的显示文案 */
  marketLabel: string
  /** 完整问句 */
  marketQuestion: string
  /** 赛事标题 */
  eventTitle: string
  /** 同一张盘口的可选两侧（Over/Under、Yes/No）。多于一个时显示切换 */
  sides: OrderSideChoice[]
  onSelectSide: (s: OrderSideChoice) => void
  /** tokenId → Gamma 给的 tick size */
  tickByToken: Record<string, TickSize>
  /** WS 实时报价表（只有顶档，够定市价，深度另拉） */
  quotes: ReadonlyMap<string, Quote>
  onClose: () => void
}

export function OrderDialog({
  tokenId,
  sideName,
  marketLabel,
  marketQuestion,
  eventTitle,
  sides,
  onSelectSide,
  tickByToken,
  quotes,
  onClose,
}: Props) {
  const clob = useClob()
  const proxy = useProxyWallet()
  const usdc = useCollateralBalance(proxy.proxyAddr)
  const depth = useOrderBook(tokenId, true)
  // 费率在这一层查一次，往下传给表单和确认面板。两处各查一次就会出现
  // 「表单显示 0.05%、确认面板显示别的」这种自相矛盾。
  const { feeBps } = useBuilderFeeRates()

  const [phase, setPhase] = useState<'idle' | 'placing' | 'listing' | 'cancelling'>('idle')
  const [outcome, setOutcome] = useState<PlaceOutcome | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  /** 成功但非订单结果的通知（如撤单回执）。与 fatal 分开：撤单成功不该显示成警告色 */
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<{ side: string; size: number; price: number; type: string } | null>(null)
  const [picked, setPicked] = useState<{ steps: number; timestamp: number } | null>(null)
  const [mine, setMine] = useState<OpenOrderRow[] | null>(null)

  // Esc 关闭 + 锁背景滚动。滚轮穿透到画布上会让人以为图在动，很困惑。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  // 切到另一侧时清掉上一侧的结果。互补 token 的价格差很远，
  // 把 Over 的「下单成功」留在 Under 上是纯粹的误导。
  useEffect(() => {
    setOutcome(null)
    setFatal(null)
    setNotice(null)
    setPending(null)
    setPicked(null)
  }, [tokenId])

  const q = quotes.get(tokenId)
  const fallbackPrice = useMemo(() => {
    // 盘口深度比 WS 顶档新（5 秒轮询 vs 推送），有深度就先用深度
    const b = depth.book
    if (b?.bestBid != null && b.bestAsk != null) return (b.bestBid + b.bestAsk) / 2
    if (q?.bid != null && q.ask != null) return (q.bid + q.ask) / 2
    return q?.bid ?? q?.ask ?? b?.bestBid ?? b?.bestAsk ?? 0
  }, [depth.book, q])

  const bestBid = depth.book?.bestBid ?? q?.bid ?? null
  const bestAsk = depth.book?.bestAsk ?? q?.ask ?? null

  /**
   * tick 取哪一份。
   *
   * CLOB 盘口自己报的 `tickSize` 最权威 —— 它是下单时真正会被校验的那个值。
   * Gamma 的 orderPriceMinTickSize 是抓取时刻的快照，理论上会滞后。
   * 两者都没有才兜底 0.01：猜粗了只是少赚，猜细了会被 CLOB 拒单。
   */
  const tick = useMemo<TickSize>(() => {
    const fromBook = depth.book?.tickSize
    if (fromBook && (TICK_SIZES as readonly string[]).includes(fromBook)) return fromBook as TickSize
    return tickByToken[tokenId] ?? DEFAULT_TICK
  }, [depth.book?.tickSize, tickByToken, tokenId])

  const minShares = depth.book?.minOrderSize ?? 5
  // 唯一一处把 bigint 余额转成 number 的地方：OrderForm 的 maxAmount 是 number。
  // 用 PUSD_DECIMALS 而不是写死 1e6 —— 这个位数目前还是推出来的（见 lib/money.ts），
  // 万一要改，两处各写一份必然漏一处。转 number 只为了给表单做上限，
  // 真下单的金额仍走整数（见 clob-client 的 usdOf）。
  const balance = usdc.value != null ? Number(usdc.value) / 10 ** PUSD_DECIMALS : undefined

  const blockedReason = clob.readiness.ready
    ? phase !== 'idle'
      ? '上一笔还在处理中…'
      : null
    : clob.readiness.reason

  async function doPlace(v: { side: string; size: number; price: number; type: string }) {
    setPhase('placing')
    setOutcome(null)
    setFatal(null)
    try {
      const r = await clob.submit({
        assetId: tokenId,
        side: v.side === 'SELL' ? 'SELL' : 'BUY',
        kind: v.type === 'limit' ? 'limit' : 'market',
        price: v.price,
        size: v.size,
      })
      setOutcome(r)
      if (r.ok) {
        setPending(null)
        void depth.refresh()
        setMine(null) // 挂单列表已过期，下次点开重拉
      }
    } catch (e) {
      setFatal(explainError(e))
    } finally {
      setPhase('idle')
    }
  }

  async function loadMine() {
    if (mine) {
      setMine(null)
      return
    }
    setPhase('listing')
    setFatal(null)
    try {
      setMine(await clob.listMine())
    } catch (e) {
      setFatal(explainError(e))
    } finally {
      setPhase('idle')
    }
  }

  async function doCancel(id: string) {
    setPhase('cancelling')
    setFatal(null)
    setNotice(null)
    try {
      const msg = await clob.cancel(id)
      setMine((prev) => prev?.filter((o) => o.id !== id) ?? null)
      setNotice(msg)
    } catch (e) {
      setFatal(explainError(e))
    } finally {
      setPhase('idle')
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] overflow-y-auto bg-black/70 p-3 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex min-h-full items-start justify-center py-4">
        <div className="w-full max-w-3xl rounded-xl border border-border bg-card shadow-2xl">
          {/* 头部 */}
          <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">下单 · {sideName}</p>
              <p className="truncate text-[10px] text-muted-foreground">{eventTitle}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              aria-label="关闭"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
            {/* 左：盘口信息 + 深度 */}
            <div className="space-y-3">
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                <p className="text-[10px] text-muted-foreground">已选盘口</p>
                <p className="text-sm font-medium text-foreground">{marketLabel}</p>
                <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                  {marketQuestion}
                </p>

                {/* 买哪一侧。两侧是互补 token，切过去价格会跳到另一边，
                    这是对的，不是刷新错乱。 */}
                {sides.length > 1 && (
                  <div className="mt-2.5">
                    <p className="mb-1 text-[10px] text-muted-foreground">买哪一侧</p>
                    <div className="flex gap-1.5">
                      {sides.map((s) => {
                        const active = s.tokenId === tokenId
                        return (
                          <button
                            key={s.tokenId}
                            type="button"
                            onClick={() => !active && onSelectSide(s)}
                            className={cn(
                              'flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                              active
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-background text-foreground hover:bg-muted',
                            )}
                          >
                            {s.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

              <OrderBook
                book={depth.book}
                loading={depth.loading}
                error={depth.error}
                tick={tick}
                onPick={(price) => setPicked({ steps: toSteps(price, tick), timestamp: Date.now() })}
              />
            </div>

            {/* 右：余额 + 表单 / 确认 / 结果 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-border bg-card p-2.5">
                <span className="text-xs text-muted-foreground">可用余额</span>
                <span className="font-mono text-sm font-bold tnum text-foreground">
                  {usdc.isLoading || proxy.isLoading ? '读取中…' : balance != null ? `$${balance.toFixed(2)}` : '—'}
                </span>
              </div>

              {pending ? (
                <ConfirmPanel
                  pending={pending}
                  tick={tick}
                  feeBps={feeBps}
                  busy={phase === 'placing'}
                  onBack={() => setPending(null)}
                  onConfirm={() => void doPlace(pending)}
                />
              ) : (
                <div className="rounded-lg border border-border bg-card p-3">
                  <OrderForm
                    // key 让切侧时整个表单重挂：限价初始值是 useState 只算一次的，
                    // 不重挂就会把 Over 的限价留在 Under 上（两侧是互补价）
                    key={`${tokenId}:${tick}`}
                    outcomeName={sideName}
                    marketQuestion={marketQuestion}
                    bestBid={bestBid}
                    bestAsk={bestAsk}
                    fallbackPrice={fallbackPrice}
                    tick={tick}
                    feeBps={feeBps}
                    minShares={minShares}
                    maxAmount={balance}
                    externalPrice={picked}
                    submitting={phase === 'placing'}
                    blockedReason={blockedReason}
                    // 不直接下单：先过一道确认。这笔单会真的动钱，
                    // 而钱包弹窗只显示签名内容，看不出「总共花多少」
                    onSubmit={(v) => {
                      setOutcome(null)
                      setFatal(null)
                      setNotice(null)
                      setPending(v)
                    }}
                  />
                </div>
              )}

              {fatal && (
                <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-snug text-warning">
                  {fatal}
                </p>
              )}

              {notice && (
                <p className="rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-[11px] leading-snug text-success">
                  {notice}
                </p>
              )}

              {outcome &&
                (outcome.ok ? (
                  <div className="rounded-md border border-success/30 bg-success/10 px-2.5 py-2 text-[11px] leading-snug text-success">
                    <p className="font-semibold">
                      已提交 · {outcome.order.status}
                      {outcome.order.status === 'matched' && '（已成交）'}
                    </p>
                    <p className="mt-0.5 font-mono">订单号 {outcome.order.orderId}</p>
                    <p className="mt-0.5 font-mono">
                      付出 {outcome.order.makingAmount} · 得到 {outcome.order.takingAmount}
                    </p>
                    {outcome.order.status !== 'matched' && (
                      <p className="mt-1 text-success/80">
                        挂单中（未成交），可以在下面「我的挂单」里撤。
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="rounded-md border border-error/30 bg-error/10 px-2.5 py-2 text-[11px] leading-snug text-error">
                    <p className="font-semibold">交易所拒单</p>
                    <p className="mt-0.5 font-mono">{outcome.code}</p>
                    <p className="mt-0.5">{outcome.message}</p>
                  </div>
                ))}

              {/* 我的挂单。**按需**加载 —— 读它也要先建已认证客户端，
                  而建客户端会让用户签一次名，不能打开弹窗就弹。 */}
              <button
                type="button"
                onClick={() => void loadMine()}
                disabled={!clob.readiness.ready || phase !== 'idle'}
                className="flex w-full items-center justify-between rounded-lg border border-border bg-card px-2.5 py-2 text-left text-xs text-foreground hover:bg-muted/50 disabled:opacity-50"
              >
                <span className="font-medium">
                  我的挂单
                  {mine && (
                    <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                      {mine.length}
                    </span>
                  )}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {phase === 'listing' ? '读取中…' : mine ? '收起' : '点开（需签名一次）'}
                </span>
              </button>

              {mine && (
                <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-card">
                  {!mine.length ? (
                    <p className="p-3 text-center text-[11px] text-muted-foreground">没有挂单</p>
                  ) : (
                    <div className="divide-y divide-border">
                      {mine.map((o) => (
                        <div key={o.id} className="flex items-center justify-between gap-2 p-2">
                          <div className="min-w-0">
                            <p className="text-[11px] text-foreground">
                              <span
                                className={cn(
                                  'mr-1.5 rounded px-1 py-0.5 text-[10px] font-medium',
                                  o.side === 'BUY'
                                    ? 'bg-success/10 text-success'
                                    : 'bg-error/10 text-error',
                                )}
                              >
                                {o.side === 'BUY' ? '买' : '卖'}
                              </span>
                              <span className="font-mono tnum">
                                {formatTickPrice(Number(o.price), tick)}
                              </span>
                              <span className="ml-1.5 font-mono tnum text-muted-foreground">
                                {o.sizeMatched}/{o.originalSize}
                              </span>
                            </p>
                            <p className="truncate font-mono text-[10px] text-muted-foreground">
                              {o.assetId === tokenId ? '本盘口' : `${o.assetId.slice(0, 10)}…`} · {o.orderType}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void doCancel(o.id)}
                            disabled={phase !== 'idle'}
                            className="shrink-0 rounded border border-error/30 bg-error/10 px-1.5 py-0.5 text-[10px] font-medium text-error hover:bg-error/20 disabled:opacity-50"
                          >
                            撤单
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 确认面板。
 *
 * 这一层不是「多点一下」的形式主义：钱包弹窗只显示要签的 EIP-712 结构，
 * 人看不懂里面的 makerAmount 是几美元。而动钱的判断要用**美元和份额**做。
 *
 * ## 总额必须是税前 + 手续费
 *
 * `份额 × 单价` 是**税前**的数 —— SDK 的 `amount` 参数文档写的是
 * "before market and builder taker fees"，`maxSpend` 才是 "all-in"。
 * 把它直接标成「总额」，用户实际被扣的会比看到的多，而多的那部分正是本平台的
 * 手续费。用户发现的方式不会是想「平台收费了」，而是「这站骗我」。
 *
 * 费率由调用方查好传来（`useBuilderFeeRates` 取 maker/taker 里**较高**的那个：
 * 市价单必然是 taker；限价单挂上去成交时可能是 maker（通常更便宜），但事先不知
 * 道会怎么成交，所以按高的报。报多了用户不会生气，报少了才是问题）。
 *
 * 这里**不自己查**：同一笔单的表单和确认面板必须显示同一个费率，各查一次就有了
 * 分叉的可能 —— 而那种分叉的表现是「上一步说 0.05%，这一步说别的」。
 *
 * 卖出的方向是**反**的：手续费从成交额里扣，到手的是本金减去费。所以这里的
 * 数字与标题都从 `settleOf` 按方向取，不在这一层自己拼 —— 拼错方向就是「标题
 * 写实际扣款、数字是到账」。
 *
 * 下面那段风险提示必须留 —— 它讲的四件事都是真的且影响这笔钱。
 */
function ConfirmPanel({
  pending,
  tick,
  feeBps,
  busy,
  onBack,
  onConfirm,
}: {
  pending: { side: string; size: number; price: number; type: string }
  tick: TickSize
  /** 展示用的费率，bps。已由调用方取过 max(maker, taker) */
  feeBps: number
  busy: boolean
  onBack: () => void
  onConfirm: () => void
}) {
  const cost = feeBreakdown(pending.size, pending.price, feeBps)
  const buy = pending.side === 'BUY'
  const settle = settleOf(cost, buy ? 'BUY' : 'SELL')
  return (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <p className="text-xs font-semibold text-foreground">确认这一笔</p>
      <div className="space-y-1 text-[11px]">
        <Row k="方向" v={buy ? '买入' : '卖出'} />
        <Row k="类型" v={pending.type === 'limit' ? '限价（挂单，可能不成交）' : '市价（立即吃单）'} />
        <Row k="单价" v={`${formatTickPrice(pending.price, tick)}（${tick} 档）`} />
        <Row k="份额" v={String(pending.size)} />
        <Row k="本金" v={`$${cost.notionalUsd.toFixed(2)}`} />
        {feeBps > 0 && (
          <Row k={`手续费（${cost.rateLabel}）`} v={formatFeeAmount(cost.feeUsd)} />
        )}
        <Row k={settle.label} v={`$${settle.usd.toFixed(2)}`} strong />
      </div>

      <div className="space-y-1 rounded border border-warning/30 bg-warning/10 p-2 text-[10px] leading-snug text-warning">
        {feeBps > 0 && (
          <p>
            · 本平台按成交额收 <span className="font-semibold">{cost.rateLabel}</span> 的手续费，
            已含在上面「合计」里。
            <span className="font-semibold">Polymarket 官方站不收这笔钱</span>
            —— 觉得不值可以改用官方站下单。
          </p>
        )}
        <p>
          · 首次下单会先让你在钱包里签一次名，用来派生 API key（L1 消息，
          <span className="font-semibold">不上链、不花 gas</span>）。之后同一会话不再问。
        </p>
        <p>
          · 这条下单路径在本项目里<span className="font-semibold">从未真正跑通过</span>。
          建议先拿最小份额试一笔。
        </p>
        <p>
          · 上游那次供应链事故的待办（转移资金、重新派生 CLOB key）还没做完，
          用同一个钱包下单会继承那份风险。
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="flex-1 rounded-md border border-border px-2 py-1.5 text-xs text-foreground hover:bg-muted disabled:opacity-50"
        >
          返回
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={cn(
            'flex-1 rounded-md px-2 py-1.5 text-xs font-semibold text-background disabled:opacity-50',
            buy ? 'bg-success' : 'bg-error',
          )}
        >
          {busy ? '提交中…' : '确认下单'}
        </button>
      </div>
    </div>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn('font-mono tnum text-foreground', strong && 'font-semibold')}>{v}</span>
    </div>
  )
}
