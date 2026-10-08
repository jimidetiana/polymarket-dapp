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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '../lib/utils'
import { tr } from '../lib/i18n'
import { OrderForm } from './order-form'
import { OrderBook } from './order-book'
import { DEFAULT_TICK, formatTickPrice, TICK_SIZES, toSteps, type TickSize } from '../lib/tick'
import { PUSD_DECIMALS } from '../lib/money'
import {
  useBuilderFeeRates,
  useClob,
  useCollateralBalance,
  useOrderBook,
  usePolymarketFee,
  useProxyWallet,
  useRewardConfig,
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
import { PositionRow, TradeRow } from './position-views'
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
  const polymarketFee = usePolymarketFee(conditionId)
  const rewardConfig = useRewardConfig(conditionId)
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
  /** 挂单那份快照是什么时候取的。摆出来让人知道自己在看多久以前的数据 */
  const [mineAt, setMineAt] = useState<number | null>(null)
  /**
   * 「页面上这份挂单与交易所不一致」的告警。
   *
   * 与 fatal / notice 分开，因为它既不是错误也不是成功，而是**数据可信度**的警告 ——
   * 用户最该据它去核对持仓再决定要不要下单。实测过的那个坑就是它要防的：撤单显示
   * 成功、其实早已成交，用户以为没买到又买一次。
   */
  const [staleWarning, setStaleWarning] = useState<string | null>(null)

  /**
   * 给轮询用的镜像。轮询回调要读「上一份挂单」来对账，但不能把 mine 放进它的依赖 ——
   * 那样每刷一次就重建一次定时器。phase 同理（轮询要跳过下单/撤单进行中的时刻）。
   */
  const mineRef = useRef<OpenOrderRow[] | null>(null)
  const phaseRef = useRef(phase)
  const busyRef = useRef(false)
  mineRef.current = mine
  phaseRef.current = phase

  /**
   * 对账发现差异 / 撤单没撤掉时，把持仓、成交、余额一并刷掉。
   *
   * 这几段正是用户要去核对「到底买到没买到」的地方。只弹一句告警却让下面还摆着
   * 下单前那份持仓，等于把人推回去做同一个错误判断。
   */
  function refreshFills() {
    orders.refresh()
    usdc.refresh()
    void queryClient.invalidateQueries({ queryKey: ['positions'] })
  }

  /**
   * 重查挂单，**以交易所返回的那份为准**覆盖界面，并把与上一份的差异报出来。
   *
   * `silent` 给自动轮询用：不动 phase（否则按钮会每隔几秒闪一下禁用）、也不把网络抖动
   * 报成错误 —— 自动刷新失败下一轮会补上，而把它弹成红字只会制造噪音。手动点刷新则
   * 相反：那是用户明确要一个答案，失败必须说。
   *
   * `busyRef` 挡并发：手动刷新和自动轮询可能撞在一起，两趟请求回来的先后无法保证，
   * 晚回的那趟会把早回的覆盖掉 —— 而「覆盖成旧的那份」正是这次要修的病。
   *
   * 不用 useCallback：`clob` 每次渲染都是新对象，memo 不住（定时器那边改走 ref 了，
   * 见下面那段注释），留着 useCallback 只是假装稳定、还得给依赖加例外。
   */
  async function refreshMine(opts?: { silent?: boolean }) {
    const silent = opts?.silent === true
    if (!clob.readiness.ready) return
    if (busyRef.current) return
    busyRef.current = true
    if (!silent) {
      setPhase('listing')
      setFatal(null)
    }
    try {
      const r = await clob.listMine(mineRef.current ?? undefined)
      mineRef.current = r.orders
      setMine(r.orders)
      setMineAt(Date.now())
      setStaleWarning(r.warning)
      if (r.warning) refreshFills()
    } catch (e) {
      if (!silent) setFatal(explainError(e))
    } finally {
      busyRef.current = false
      if (!silent) setPhase('idle')
    }
  }

  /**
   * 挂单面板开着时每 8 秒自动重查一次。
   *
   * 挂单在交易所那边随时会成交，而这个面板原来只在点开的那一刻查一次 —— 面板开着
   * 看上去是「实时的未成交委托」，实际是一张越来越旧的快照。用户据它点撤单，就撞上
   * 「撤的是一笔已经成交的单」。所以只要它开着就跟着刷，关掉就停（不白费鉴权请求）。
   *
   * 下单 / 撤单进行中的那一瞬跳过：那两条路径自己会把列表换成最新的，这里插一脚
   * 只会和它们抢着写同一份状态。
   *
   * ⚠️ **定时器的依赖里不能有 `refreshMine`。** `useClob()` 每次渲染都返回一个新对象，
   * 所以 `refreshMine` 的身份每渲染一变；把它放进依赖，这个 effect 就会跟着重建，
   * 而盘口深度每 5 秒轮询一次、每次都触发重渲染 —— 于是 8 秒的定时器在**每次都被
   * 提前清掉，一次也不会触发**，自动刷新静默失效（而它正是这次要修的东西）。
   * 所以改成走 ref 读最新那一份，依赖只留真正该重建定时器的两个布尔。
   */
  const refreshMineRef = useRef(refreshMine)
  refreshMineRef.current = refreshMine
  const panelOpen = mine !== null
  const canQuery = clob.readiness.ready
  useEffect(() => {
    if (!panelOpen || !canQuery) return
    const id = window.setInterval(() => {
      if (phaseRef.current !== 'idle') return
      void refreshMineRef.current({ silent: true })
    }, 8000)
    return () => window.clearInterval(id)
  }, [panelOpen, canQuery])

  /**
   * 成交后「多久能看到新数据」是不定的：左侧的持仓 / 成交要等 data-api 索引完，
   * 右上角的余额要等链上结算完，两者都是**秒级且不定长**的延迟。所以**单次**重拉
   * （哪怕隔 5 秒补一发）经常赶在索引之前 —— 重拉回来的还是下单前那份，表现正是
   * 用户说的「下完单弹窗开着，左侧持仓 / 成交不动，非得刷新页面重开才有」。
   *
   * 改成下单成功后开一小段**轮询窗口**：每 3 秒重拉一次，约 30 秒后自停，覆盖住这段
   * 延迟。定时器句柄存在 ref 里，关窗（卸载）时清掉，避免泄漏；下一笔开始前也先清掉
   * 上一笔的，免得叠加。
   */
  const burstRef = useRef<{ timer?: number; stopper?: number }>({})
  const stopRefreshBurst = useCallback(() => {
    if (burstRef.current.timer != null) window.clearInterval(burstRef.current.timer)
    if (burstRef.current.stopper != null) window.clearTimeout(burstRef.current.stopper)
    burstRef.current = {}
  }, [])
  useEffect(() => stopRefreshBurst, [stopRefreshBurst])

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
      ? tr('上一笔还在处理中…', 'Previous order still processing…')
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
        setMine(null) // 挂单列表已过期，下次点开重拉
        // 持仓 / 成交 / 余额都在成交后才变，但索引与结算有秒级不定长延迟（见
        // stopRefreshBurst 上方注释）。开一小段轮询窗口把这段延迟覆盖住 ——
        // 单次重拉常常赶在数据可见之前。
        stopRefreshBurst() // 上一笔可能还在轮询，先清掉再重开
        const pull = () => {
          void depth.refresh()
          // 本盘口的持仓 / 成交（useMarketOrders）。它 staleTime 30 秒，而这一段在
          // 弹窗里是开着的，不主动刷就一直停在下单之前那份。
          orders.refresh()
          // 可用余额走 wagmi 的 useReadContract，默认不会自己重读，同样得手动刷。
          usdc.refresh()
          // 画布 / 比赛列表上的持仓角标走另一个 query（usePositions 的 ['positions']），
          // 一并作废，让刚成交的那张盘口马上出现角标。
          void queryClient.invalidateQueries({ queryKey: ['positions'] })
        }
        pull() // 先立刻拉一发（少数情况下数据已就绪）
        burstRef.current.timer = window.setInterval(pull, 3000)
        burstRef.current.stopper = window.setTimeout(stopRefreshBurst, 30000)
      }
    } catch (e) {
      setFatal(explainError(e))
    } finally {
      setPhase('idle')
    }
  }

  /** 点标题行：开着就收起，收起就点开并查一次 */
  async function loadMine() {
    if (mine) {
      setMine(null)
      mineRef.current = null
      setMineAt(null)
      setStaleWarning(null)
      return
    }
    await refreshMine()
  }

  /**
   * 撤单。**以交易所的回答为准**，不再本地删行了事。
   *
   * 三条路分开处理，因为它们对用户的含义完全不同：
   *  - 确认撤掉了 → 绿色成功，列表换成交易所那份新的
   *  - 交易所说撤不掉（最常见就是「已经成交了」）→ **警告色**，并刷持仓/成交/余额，
   *    让人当场看到自己其实已经买到了。原来这里显示的是绿色的「已提交撤销请求」，
   *    用户因此以为没买到、又买一次。
   *  - 回执没确认 → 同样当作「不确定」报警告，不假装成功
   *
   * 不管哪条路，列表都用重查回来的那份覆盖。
   */
  async function doCancel(id: string) {
    setPhase('cancelling')
    setFatal(null)
    setNotice(null)
    setStaleWarning(null)
    try {
      const r = await clob.cancel(id, mineRef.current ?? undefined)
      mineRef.current = r.orders
      setMine(r.orders)
      setMineAt(Date.now())
      if (r.outcome.confirmed === 'cancelled') {
        setNotice(r.outcome.message)
        setStaleWarning(r.warning)
        if (r.warning) refreshFills()
      } else {
        // 撤不掉 / 没确认：把回执那句和对账告警并成一条警告显示，并刷下面几段
        setStaleWarning([r.outcome.message, r.warning].filter(Boolean).join('\n'))
        refreshFills()
      }
    } catch (e) {
      // 撤单抛异常时，列表的真实状态是**未知**的 —— 这笔可能撤掉了，也可能没有。
      // 所以除了报错，还要重查一遍，不让界面停在那份过期快照上。
      setFatal(explainError(e))
      void refreshMine({ silent: true })
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
              <p className="truncate text-sm font-semibold text-foreground">{tr('下单', 'Trade')} · {sideName}</p>
              <p className="truncate text-[10px] text-muted-foreground">{eventTitle}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              aria-label={tr('关闭', 'Close')}
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
                <p className="text-[10px] text-muted-foreground">{tr('已选盘口', 'Selected market')}</p>
                <p className="text-sm font-medium text-foreground">{marketLabel}</p>
                <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                  {marketQuestion}
                </p>

                {/* 买哪一侧。两侧是互补 token，切过去价格会跳到另一边，
                    这是对的，不是刷新错乱。 */}
                {sides.length > 1 && (
                  <div className="mt-2.5">
                    <p className="mb-1 text-[10px] text-muted-foreground">{tr('买哪一侧', 'Side')}</p>
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
                  <span className="text-xs font-medium text-foreground">{tr('我的订单', 'My orders')}</span>
                  <span className="text-[10px] text-muted-foreground">{tr('本盘口', 'This market')}</span>
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
                      {tr('持仓中', 'Open orders')}
                      <span className="ml-1 text-muted-foreground">{tr('（挂单，未成交）', '(unfilled)')}</span>
                      {mine && (
                        <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                          {mine.length}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {phase === 'listing'
                        ? tr('读取中…', 'Loading…')
                        : mine
                          ? tr('收起', 'Hide')
                          : tr('点开（需签名一次）', 'Show (needs one signature)')}
                    </span>
                  </button>

                  {/* 快照时间 + 手动刷新。挂单随时会成交，所以要让人看见自己在看
                      多久以前的数据 —— 「刚刚」和「30 秒前」对该不该直接点撤单
                      是两种判断。自动每 8 秒刷一次（见 refreshMine 上方），这个
                      按钮给「现在就要一个准数」的时刻。 */}
                  {mine && (
                    <div className="flex items-center justify-between gap-2 border-t border-border px-2.5 py-1.5">
                      <span className="text-[10px] text-muted-foreground">
                        {tr('交易所数据 · ', 'From exchange · ')}
                        {mineAt ? <Ago at={mineAt} /> : '—'}
                        {tr('（每 8 秒自动刷新）', ' (auto-refresh every 8s)')}
                      </span>
                      <button
                        type="button"
                        onClick={() => void refreshMine()}
                        disabled={phase !== 'idle'}
                        className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground/80 hover:bg-muted disabled:opacity-50"
                      >
                        {phase === 'listing' ? tr('刷新中…', 'Refreshing…') : tr('刷新', 'Refresh')}
                      </button>
                    </div>
                  )}

                  {/* 挂单数据与交易所不一致 —— 必须显眼，这是「别重复买入」的唯一提示。
                      whitespace-pre-line：撤单回执那句与对账告警是用 \n 并起来的。 */}
                  {staleWarning && (
                    <p className="whitespace-pre-line border-t border-warning/30 bg-warning/10 px-2.5 py-2 text-[10px] leading-snug text-warning">
                      ⚠ {staleWarning}
                    </p>
                  )}

                  {mine &&
                    (!mine.length ? (
                      <p className="px-2.5 pb-2 text-[10px] text-muted-foreground">{tr('没有未成交的挂单', 'No open orders')}</p>
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
                                  {o.side === 'BUY' ? tr('买', 'Buy') : tr('卖', 'Sell')}
                                </span>
                                <span className="font-mono tnum">
                                  {formatTickPrice(Number(o.price), tick)}
                                </span>
                                <span className="ml-1.5 font-mono tnum text-muted-foreground">
                                  {o.sizeMatched}/{o.originalSize}
                                </span>
                              </p>
                              <p className="truncate font-mono text-[10px] text-muted-foreground">
                                {o.assetId === tokenId ? tr('本盘口', 'This market') : `${o.assetId.slice(0, 10)}…`} ·{' '}
                                {o.orderType}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => void doCancel(o.id)}
                              disabled={phase !== 'idle'}
                              className="shrink-0 rounded border border-error/30 bg-error/10 px-1.5 py-0.5 text-[10px] font-medium text-error hover:bg-error/20 disabled:opacity-50"
                            >
                              {tr('撤单', 'Cancel')}
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
                    {tr('读取中…', 'Loading…')}
                  </p>
                ) : orders.error ? (
                  <p className="border-b border-border px-2.5 py-2 text-[10px] text-warning">
                    {tr('读不到持仓与成交：', "Couldn't load positions and trades: ")}{orders.error}
                  </p>
                ) : null}

                {/* ── 持仓（已买入）── */}
                <div className="border-b border-border px-2.5 py-2">
                  <p className="text-[11px] font-medium text-foreground">
                    {tr('持仓', 'Positions')}
                    <span className="ml-1 text-muted-foreground">{tr('（已买入）', '(held)')}</span>
                    {held.length > 0 && (
                      <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                        {held.length}
                      </span>
                    )}
                  </p>
                  {ordersReady &&
                    (!held.length ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">{tr('这张盘口没有持仓', 'No positions in this market')}</p>
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
                    {tr('成交', 'Trades')}
                    <span className="ml-1 text-muted-foreground">{tr('（明细）', '(fills)')}</span>
                    {orders.trades.length > 0 && (
                      <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                        {orders.trades.length}
                      </span>
                    )}
                  </p>
                  {ordersReady &&
                    (!orders.trades.length ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">{tr('这张盘口没有成交记录', 'No trades in this market')}</p>
                    ) : (
                      <div className="mt-1.5 max-h-40 divide-y divide-border overflow-y-auto rounded border border-border">
                        {orders.trades.map((t) => (
                          <TradeRow key={`${t.transactionHash}:${t.asset}:${t.timestamp}`} t={t} />
                        ))}
                      </div>
                    ))}
                </div>

                {/* ── 完结（已结算 / 已平仓）── 只有仓位，成交明细在上面的「成交」里 */}
                <div className="px-2.5 py-2">
                  <p className="text-[11px] font-medium text-foreground">
                    {tr('完结', 'Closed')}
                    <span className="ml-1 text-muted-foreground">{tr('（已结算 / 已平仓）', '(settled / exited)')}</span>
                    {settled.length > 0 && (
                      <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                        {settled.length}
                      </span>
                    )}
                  </p>
                  {ordersReady &&
                    (!settled.length ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">{tr('这张盘口没有已结算的仓位', 'No closed positions in this market')}</p>
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
                <span className="text-xs text-muted-foreground">{tr('可用余额', 'Available')}</span>
                <span className="font-mono text-sm font-bold tnum text-foreground">
                  {usdc.isLoading || proxy.isLoading ? tr('读取中…', 'Loading…') : balance != null ? `$${balance.toFixed(2)}` : '—'}
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
                  polymarketFee={polymarketFee}
                  rewardConfig={rewardConfig}
                  bookLevels={depth.book ? { bids: depth.book.bids, asks: depth.book.asks } : null}
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
                      {tr('已提交', 'Submitted')} · {outcome.order.status}
                      {outcome.order.status === 'matched' && tr('（已成交）', ' (filled)')}
                    </p>
                    <p className="mt-0.5 font-mono">{tr('订单号', 'Order ID')} {outcome.order.orderId}</p>
                    <p className="mt-0.5 font-mono">
                      {tr('付出', 'Paid')} {outcome.order.makingAmount} · {tr('得到', 'Received')} {outcome.order.takingAmount}
                    </p>
                    {outcome.order.status !== 'matched' && (
                      <p className="mt-1 text-success/80">
                        {tr('挂单中（未成交），可以在下面「我的挂单」里撤。', 'Resting (unfilled) — you can cancel it under "Open orders".')}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="rounded-md border border-error/30 bg-error/10 px-2.5 py-2 text-[11px] leading-snug text-error">
                    <p className="font-semibold">{tr('交易所拒单', 'Rejected by exchange')}</p>
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
 * 「N 秒前」，每秒自己走一格。
 *
 * 为什么要自己走：这一行是**数据新旧**的指示，而指示本身停住就成了误导 —— 一个写死的
 * 「3 秒前」挂在那里不动，比不写更糟。挂单面板只在开着时渲染它，所以这个计时器跟着
 * 面板一起生灭。
 */
function Ago({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 2) return <>{tr('刚刚', 'just now')}</>
  if (sec < 60) return <>{tr(`${sec} 秒前`, `${sec}s ago`)}</>
  const min = Math.floor(sec / 60)
  return <>{tr(`${min} 分钟前`, `${min}m ago`)}</>
}
