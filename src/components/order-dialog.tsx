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
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '../lib/utils'
import { OrderForm } from './order-form'
import { OrderBook } from './order-book'
import { DEFAULT_TICK, formatTickPrice, TICK_SIZES, toSteps, type TickSize } from '../lib/tick'
import { PUSD_DECIMALS } from '../lib/money'
import {
  useBuilderFeeRates,
  useClob,
  useCollateralBalance,
  useOrderBook,
  useProxyWallet,
} from '../lib/use-clob'
import { explainError, type OpenOrderRow, type PlaceOutcome } from '../lib/clob-client'
/**
 * 持仓 / 成交走**公开 REST**（免鉴权），不经 SecureClient。
 *
 * 这不只是省一次签名：那条鉴权路径要先打到本地签名服务（server/sign-server.mjs），
 * 它没启动时整条链路是 502 —— 而持仓和成交本来就不需要它。分开之后，签名服务没起
 * 只影响下面那一段「持仓中」，另外两段照常显示。
 */
import { useMarketOrders } from '../lib/use-positions'
import { positionKind, type PolyPosition } from '../lib/positions'
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
  /**
   * 这张盘口的 conditionId。持仓与成交按它查。
   *
   * ⚠️ **不能用 tokenId 代替** —— data-api 的 `asset=` 参数是静默忽略的，传了会返回
   * 全部盘口的数据，看起来完全像生效了（见 lib/positions.ts 顶部）。
   * 拿不到（老数据里没有这个字段）时那两段不查，只留挂单。
   */
  conditionId: string | null
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
  conditionId,
  sides,
  onSelectSide,
  tickByToken,
  quotes,
  onClose,
}: Props) {
  const clob = useClob()
  const proxy = useProxyWallet()
  const queryClient = useQueryClient()
  const usdc = useCollateralBalance(proxy.proxyAddr)
  const depth = useOrderBook(tokenId, true)
  // 费率在这一层查一次，往下传给表单和确认面板。两处各查一次就会出现
  // 「表单显示 0.05%、确认面板显示别的」这种自相矛盾。
  const { feeBps } = useBuilderFeeRates()
  /**
   * 本盘口的持仓与成交。走公开 REST，**免鉴权、不弹签名**，所以打开弹窗就能自动加载 ——
   * 与下面的挂单不同，那个必须先建已认证客户端。
   */
  const orders = useMarketOrders(conditionId, true)
  /**
   * 把本盘口的仓位分成「持仓」和「完结」两堆。
   *
   * 分类规则在 lib/positions.ts 的 positionKind 里（有测试钉着）：`redeemable` 或份额已
   * 清零算完结。**判据不在这里自己写** —— 那个「份额清零」的判断不能用 `> 0`，实测卖光
   * 之后会留下 1e-9 这种浮点残渣，按 `> 0` 判会把它显示成还持有着。
   *
   * 一张盘口两侧（Yes/No、Over/Under）都可能有仓位，两堆都可能不止一条。
   */
  const [held, settled] = useMemo(() => {
    const open: PolyPosition[] = []
    const done: PolyPosition[] = []
    for (const p of orders.positions) {
      if (positionKind(p) === 'open') open.push(p)
      else done.push(p)
    }
    return [open, done] as const
  }, [orders.positions])

  /**
   * 持仓 / 成交 / 完结三段共用 useMarketOrders 这一个查询，都只在**读完之后**
   * 才说自己的内容。读之前那三段是空的，而空在界面上读起来就是「没有」——
   * 所以状态由下面那段共用状态行统一报一次（见 JSX 里的注释）。
   */
  const ordersReady = !orders.loading && !orders.error

  const [phase, setPhase] = useState<'idle' | 'placing' | 'listing' | 'cancelling'>('idle')
  const [outcome, setOutcome] = useState<PlaceOutcome | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  /** 成功但非订单结果的通知（如撤单回执）。与 fatal 分开：撤单成功不该显示成警告色 */
  const [notice, setNotice] = useState<string | null>(null)
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
        void depth.refresh()
        setMine(null) // 挂单列表已过期，下次点开重拉
        // 本盘口的持仓/成交**立刻重拉**。它的 staleTime 是 30 秒，而这一段在弹窗里
        // 是**开着**的 —— 不主动刷就一直是下单之前那份（多半是空的），看起来正好是
        // 「成交了却查不到」。30 秒的缓存对「打开弹窗看一眼」是合理的，
        // 对「刚下完单」不是。
        orders.refresh()
        // 成交要等 data-api 索引完才出现，紧接的那一次多半还是空的，隔几秒补一次。
        // 只是多一次 GET，不猜索引延迟到底几秒。
        window.setTimeout(orders.refresh, 5000)
        // 画布与比赛列表上的持仓角标走另一个 query（usePositions 的 ['positions']），
        // 一并作废 —— 刚成交的那张盘口应当马上出现角标。
        void queryClient.invalidateQueries({ queryKey: ['positions'] })
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

              {/*
                我的订单。三段，**加载方式不同**，所以不是一个统一的列表：

                  持仓中  未成交的委托。公开接口**没有**这份数据，只有 CLOB 的鉴权接口有 ——
                          所以必须先建已认证客户端，而那会弹签名、还要本地签名服务在跑。
                          因此保持**按需**点开，不随弹窗自动加载。
                  持仓    已买入、正在持有的仓位。公开 REST，免鉴权，自动加载。
                  完结    已结算 / 已平仓的仓位，加上成交明细。同上，自动加载。

                三段各自独立失败：签名服务没起时「持仓中」点不开，另两段照常显示。
                把它们合成一个列表就做不到这件事 —— 一处失败会拖垮全部。
              */}
              <div className="rounded-lg border border-border bg-card">
                <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-2">
                  <span className="text-xs font-medium text-foreground">我的订单</span>
                  <span className="text-[10px] text-muted-foreground">本盘口</span>
                </div>

                {/* ── 持仓中（未成交委托）── */}
                <div className="border-b border-border">
                  <button
                    type="button"
                    onClick={() => void loadMine()}
                    disabled={!clob.readiness.ready || phase !== 'idle'}
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-[11px] text-foreground hover:bg-muted/50 disabled:opacity-50"
                  >
                    <span className="font-medium">
                      持仓中
                      <span className="ml-1 text-muted-foreground">（挂单，未成交）</span>
                      {mine && (
                        <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                          {mine.length}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {phase === 'listing' ? '读取中…' : mine ? '收起' : '点开（需签名一次）'}
                    </span>
                  </button>

                  {mine &&
                    (!mine.length ? (
                      <p className="px-2.5 pb-2 text-[10px] text-muted-foreground">没有未成交的挂单</p>
                    ) : (
                      <div className="max-h-40 divide-y divide-border overflow-y-auto border-t border-border">
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
                                {o.assetId === tokenId ? '本盘口' : `${o.assetId.slice(0, 10)}…`} ·{' '}
                                {o.orderType}
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
                    ))}
                </div>

                {/*
                  下面三段（持仓 / 成交 / 完结）来自**同一个查询**（useMarketOrders），
                  所以「读取中 / 读不到」只在这里报一次。在三段里各写一遍的话会同时出现
                  「读取中…」和「这张盘口没有持仓」—— 自相矛盾，而且正好出现在最需要
                  可信的地方。
                */}
                {orders.loading ? (
                  <p className="border-b border-border px-2.5 py-2 text-[10px] text-muted-foreground">
                    读取中…
                  </p>
                ) : orders.error ? (
                  <p className="border-b border-border px-2.5 py-2 text-[10px] text-warning">
                    读不到持仓与成交：{orders.error}
                  </p>
                ) : null}

                {/* ── 持仓（已买入）── */}
                <div className="border-b border-border px-2.5 py-2">
                  <p className="text-[11px] font-medium text-foreground">
                    持仓
                    <span className="ml-1 text-muted-foreground">（已买入）</span>
                    {held.length > 0 && (
                      <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                        {held.length}
                      </span>
                    )}
                  </p>
                  {ordersReady &&
                    (!held.length ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">这张盘口没有持仓</p>
                    ) : (
                      <div className="mt-1.5 space-y-1.5">
                        {held.map((p) => (
                          <PositionRow key={p.asset} p={p} />
                        ))}
                      </div>
                    ))}
                </div>

                {/*
                  ── 成交（明细）──

                  **单独一段，不并进「完结」。** 成交是「这笔单成交了」这个事实，
                  与「这张盘有没有结算/平掉」是两件事：比赛还没开哨时买入，成交马上
                  就有，而完结要等到结算 —— 把成交挂在「完结（已结算 / 已平仓）」
                  下面是**说反了**，实测就是这么被指出来的（截图里比赛还没开始，
                  那笔买单却躺在「完结」里）。
                */}
                <div className="border-b border-border px-2.5 py-2">
                  <p className="text-[11px] font-medium text-foreground">
                    成交
                    <span className="ml-1 text-muted-foreground">（明细）</span>
                    {orders.trades.length > 0 && (
                      <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                        {orders.trades.length}
                      </span>
                    )}
                  </p>
                  {ordersReady &&
                    (!orders.trades.length ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">这张盘口没有成交记录</p>
                    ) : (
                      <div className="mt-1.5 max-h-40 divide-y divide-border overflow-y-auto rounded border border-border">
                        {orders.trades.map((t) => (
                          <div
                            key={`${t.transactionHash}:${t.asset}:${t.timestamp}`}
                            className="flex items-baseline justify-between gap-2 px-2 py-1.5"
                          >
                            <span className="min-w-0 text-[10px] text-foreground">
                              <span
                                className={cn(
                                  'mr-1.5 rounded px-1 py-0.5 text-[10px] font-medium',
                                  t.side === 'BUY'
                                    ? 'bg-success/10 text-success'
                                    : 'bg-error/10 text-error',
                                )}
                              >
                                {t.side === 'BUY' ? '买' : '卖'}
                              </span>
                              <span className="text-muted-foreground">{t.outcome}</span>
                              <span className="ml-1.5 font-mono tnum">
                                {t.size} @ {t.price.toFixed(3)}
                              </span>
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                              {formatTradeTime(t.timestamp)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                </div>

                {/* ── 完结（已结算 / 已平仓）── 只有仓位，成交明细在上面的「成交」里 */}
                <div className="px-2.5 py-2">
                  <p className="text-[11px] font-medium text-foreground">
                    完结
                    <span className="ml-1 text-muted-foreground">（已结算 / 已平仓）</span>
                    {settled.length > 0 && (
                      <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                        {settled.length}
                      </span>
                    )}
                  </p>
                  {ordersReady &&
                    (!settled.length ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">这张盘口没有已结算的仓位</p>
                    ) : (
                      <div className="mt-1.5 space-y-1.5">
                        {settled.map((p) => (
                          <PositionRow key={p.asset} p={p} settled />
                        ))}
                      </div>
                    ))}
                </div>
              </div>
            </div>

            {/* 右：余额 + 表单 / 确认 / 结果 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-border bg-card p-2.5">
                <span className="text-xs text-muted-foreground">可用余额</span>
                <span className="font-mono text-sm font-bold tnum text-foreground">
                  {usdc.isLoading || proxy.isLoading ? '读取中…' : balance != null ? `$${balance.toFixed(2)}` : '—'}
                </span>
              </div>

              <div className="rounded-lg border border-border bg-card p-3">
                <OrderForm
                  // key 让切侧时整个表单重挂：限价初始值是 useState 只算一次的，
                  // 不重挂就会把 Over 的限价留在 Under 上（两侧是互补价）
                  key={`${tokenId}:${tick}`}
                  outcomeName={sideName}
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
                  // 表单里点「买入/卖出」直接下单，不再过确认面板。
                  // 表单已展示单价/份额/本金/手续费/合计，够看清这笔要花多少了。
                  onSubmit={(v) => {
                    setOutcome(null)
                    setFatal(null)
                    setNotice(null)
                    void doPlace(v)
                  }}
                />
              </div>

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

            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 一条仓位。
 *
 * 显示的是**这一侧**的仓位 —— 一张盘口两侧（Over/Under）各有自己的 token，两侧都可能
 * 有仓位，所以 `outcome` 必须显示出来，否则两行长得一样分不清是哪边。
 *
 * 盈亏按方向着色，`settled` 时取**已实现**盈亏而不是浮动盈亏：仓位已经不在场上了，
 * 浮动盈亏对它没有意义（结算后 curPrice 会被推到 0 或 1，拿它算出来的浮盈是假的）。
 */
function PositionRow({ p, settled }: { p: PolyPosition; settled?: boolean }) {
  const pnl = settled ? p.realizedPnl : p.cashPnl
  return (
    <div className="rounded border border-border bg-background px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-foreground">
          {settled && (
            <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {p.redeemable ? '已结算' : '已平仓'}
            </span>
          )}
          <span className="font-medium">{p.outcome || '—'}</span>
          <span className="ml-1.5 font-mono tnum text-muted-foreground">{p.size} 份</span>
        </span>
        <span
          className={cn(
            'shrink-0 font-mono tnum text-[11px] font-semibold',
            pnl > 0 ? 'text-success' : pnl < 0 ? 'text-error' : 'text-muted-foreground',
          )}
        >
          {pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)}
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[10px] tnum text-muted-foreground">
        均价 {p.avgPrice.toFixed(3)}
        {!settled && ` · 现价 ${p.curPrice.toFixed(3)} · 市值 $${p.currentValue.toFixed(2)}`}
        {!settled && p.percentPnl !== 0 && ` · ${p.percentPnl > 0 ? '+' : '−'}${Math.abs(p.percentPnl).toFixed(1)}%`}
      </p>
    </div>
  )
}

/**
 * 成交时间。
 *
 * ⚠️ data-api 的 `timestamp` 是**秒**，不是毫秒 —— 直接喂 `new Date()` 会得到 1970 年。
 * 只显示到分钟：秒对「我什么时候买的」没有意义。
 */
function formatTradeTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  const d = new Date(sec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
