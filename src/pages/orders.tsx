/**
 * 「我的订单」页 —— 一处看全账户已买入的仓位与成交明细。
 *
 * ## 与下单弹窗里那段「我的订单」的分工
 *
 * 弹窗里那段只看**当前这张盘口**（按 conditionId 查），要先点开某场比赛的某个节点才看得到。
 * 这一页把**整个账户**摊开：顶部一排汇总（持仓市值 / 浮盈 / 已实现），下面持仓、成交、完结
 * 各一段。数据同样走公开 REST（lib/positions.ts，免鉴权、不弹签名、**不碰 SDK**），所以这一页
 * 留在主包里、连上钱包就能看，不必像下单弹窗那样 lazy 加载（见 lib/use-positions.ts 顶部）。
 *
 * ## 不含「挂单（未成交委托）」
 *
 * 那份数据公开接口没有，只有 CLOB 的鉴权接口有，读它要先建 SecureClient（弹签名、还要
 * 本地签名服务在跑）。撤单/查挂单仍留在下单弹窗里按需点开。这一页只答「我已经买了什么、
 * 成交了什么」，全部是**已执行**的事实。
 *
 * 行的样式与弹窗共用 components/position-views，这里开 showTitle —— 账户级列表混着多张盘口，
 * 得摆出缩略图、中文标题和结果标签，否则只剩一串数字看不出买的是啥。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { setLang, tr, useLang } from '../lib/i18n'
import { useProxyWallet } from '../lib/use-wallet'
import { useAccountOrders } from '../lib/use-positions'
import { usePositionMarketIndex } from '../lib/use-graph'
import { grossAvgPriceOf, positionKind, type PolyPosition } from '../lib/positions'
import { localizeMarketTitle, localizeMarketType, localizeOutcome, localizePick, localizeSportsMarket, splitMatchMarket } from '../lib/dict'
import { PositionRow, TradeRow } from '../components/position-views'
import { PositionsBoard } from '../components/positions-board'
import { shortAddr } from '../components/connect-wallet'
import { exportPositionsImage, downloadImage, type ExportRow } from '../lib/orders-export'
import { marketHref } from '../lib/market-link'
import { cn } from '../lib/utils'

/** 一个持仓在勾选集里的键，与列表 key 同源 */
const posKey = (p: PolyPosition) => `${p.asset}:${p.conditionId}`

export default function OrdersPage() {
  const lang = useLang()
  const { proxyAddr, isLoading: proxyLoading } = useProxyWallet()
  const orders = useAccountOrders(true)

  /**
   * 分成「持仓」和「完结」两堆 + 一排汇总。分类规则在 lib/positions.ts 的 positionKind
   * 里（有测试钉着）：`redeemable` 或份额已清零算完结。**判据不在这里自己写** —— 那个
   * 「份额清零」不能用 `> 0`，实测卖光后会留 1e-9 这种浮点残渣。
   *
   * 持仓按市值从大到小排；汇总的已实现盈亏跨**全部**行取和（持仓也可能有已实现的部分）。
   */
  const { held, settled, value, unrealized, realized } = useMemo(() => {
    const open: PolyPosition[] = []
    const done: PolyPosition[] = []
    let value = 0
    let unrealized = 0
    let realized = 0
    for (const p of orders.positions) {
      realized += p.realizedPnl
      if (positionKind(p) === 'open') {
        open.push(p)
        value += p.currentValue
        unrealized += p.cashPnl
      } else {
        done.push(p)
      }
    }
    open.sort((a, b) => b.currentValue - a.currentValue)
    return { held: open, settled: done, value, unrealized, realized }
  }, [orders.positions])

  /**
   * 导出用的勾选集，作用在**持仓**上（导出的是持仓情况，不是成交流水）。默认首批持仓到手时
   * 全选（多数场景「全都要」，省一次全选点击），之后不再自动覆盖 —— 否则每次列表重取都把
   * 用户的勾选清掉。用 ref 记「初始化过没」。
   */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const inited = useRef(false)
  useEffect(() => {
    if (inited.current || held.length === 0) return
    inited.current = true
    setSelected(new Set(held.map(posKey)))
  }, [held])

  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState<string | null>(null)

  const selectedCount = useMemo(
    () => held.reduce((n, p) => (selected.has(posKey(p)) ? n + 1 : n), 0),
    [held, selected],
  )
  const allSelected = held.length > 0 && selectedCount === held.length

  function toggleOne(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(held.map(posKey)))
  }

  /**
   * 每个持仓「最近一次买入的时间」。持仓接口本身没有时间戳（一个仓位是多笔成交的汇总），
   * 所以从成交明细里按 token（asset）取**最后一笔 BUY** 的时间当作它的具体时间；没有 BUY
   * 记录就退到该 token 最后一笔任意成交。导出的时间列用它。
   */
  const timeByAsset = useMemo(() => {
    const buy = new Map<string, number>()
    const any = new Map<string, number>()
    for (const t of orders.trades) {
      if (t.timestamp > (any.get(t.asset) ?? 0)) any.set(t.asset, t.timestamp)
      if (t.side === 'BUY' && t.timestamp > (buy.get(t.asset) ?? 0)) buy.set(t.asset, t.timestamp)
    }
    const out = new Map<string, number>()
    for (const [asset, ts] of any) out.set(asset, buy.get(asset) ?? ts)
    return out
  }, [orders.trades])

  /**
   * tokenId → 盘口信息（比赛「A vs B」/ 玩法 / 结果标签）。持仓数据本身拿不到「谁对谁」，
   * 从 Gamma 按持仓所属赛事 id 拉回来补上（见 usePositionMarketIndex）。
   */
  const eventIds = useMemo(() => {
    const s = new Set<string>()
    for (const p of orders.positions) if (p.eventId) s.add(String(p.eventId))
    return s
  }, [orders.positions])
  const marketIndex = usePositionMarketIndex(eventIds)

  /**
   * 一个持仓 → 一行导出数据。优先用 Gamma 索引把比赛、盘口玩法、选择摆清楚；索引里没有
   * （非足球盘、或赛事已下架）就退回从持仓标题解析，保证仍能导出。
   */
  function toExportRow(p: PolyPosition): ExportRow {
    // 价格一律用**含费**均价（grossAvgPriceOf）：手续费不摊进单价，推出的欧赔就比实际
    // 能拿到的高一截，等于把赔率说好看了。费额单独带出来，页脚另报一次。
    const avgPrice = grossAvgPriceOf(p)
    const feeUsd = p.entryFeesUsdc
    const info = marketIndex.get(p.asset)
    if (info) {
      return {
        match: localizeMarketTitle(info.match) || info.match || tr('未知比赛', 'Unknown match'),
        market: localizeSportsMarket(info.sportsType, info.suffix),
        pick: localizePick({ outcome: p.outcome, groupItemTitle: info.groupItemTitle, line: info.line, sportsType: info.sportsType }),
        timeSec: timeByAsset.get(p.asset),
        avgPrice,
        feeUsd,
        size: p.size,
      }
    }
    const parts = splitMatchMarket(p.title)
    return {
      match: localizeMarketTitle(parts.match) || parts.match || p.title || tr('未知比赛', 'Unknown match'),
      market: localizeMarketType(parts.market, p.outcome),
      pick: localizeOutcome(p.outcome) || '—',
      timeSec: timeByAsset.get(p.asset),
      avgPrice,
      feeUsd,
      size: p.size,
    }
  }

  async function doExport() {
    const chosen = held.filter((p) => selected.has(posKey(p)))
    if (chosen.length === 0) return
    setExporting(true)
    setExportErr(null)
    try {
      const now = new Date()
      const blob = await exportPositionsImage(chosen.map(toExportRow), { account: proxyAddr ?? '', now })
      downloadImage(blob, now)
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }

  /**
   * 持仓板要画的行：一行持仓配上它的勾选键。用与导出**同一个** toExportRow 造行，界面才和
   * 导出图片对得上。不 memo —— toExportRow 依赖 marketIndex / timeByAsset / 当前语言，值一变
   * 就得重算，列表本身也不长，直接算最省心（lang 变时组件已因 useLang 重渲染，会带上新译名）。
   */
  const boardRows = held.map((p) => ({ key: posKey(p), row: toExportRow(p), href: marketHref(p) }))

  const connected = !!proxyAddr
  const showData = connected && !orders.error && !orders.loading

  return (
    <div className="min-h-dvh bg-background text-foreground">
      {/* 顶栏：回图 + 标题 + 语言 + 刷新。独立路由没有 App 的那条顶栏，自带一个。
          栏本身铺满视口(sticky 背景连成一条),内容收到与正文同宽的 max-w-4xl 里居中,两边留白对齐。 */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
          <a
            href="#/"
            className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground/80 hover:bg-muted"
          >
            {tr('← 返回', '← Back')}
          </a>
          <h1 className="truncate text-base font-semibold tracking-tight text-primary">
            {tr('我的订单', 'My orders')}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground/80 hover:bg-muted"
          >
            {lang === 'en' ? '中文' : 'EN'}
          </button>
          <button
            type="button"
            onClick={orders.refresh}
            disabled={!connected || orders.loading}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground/80 hover:bg-muted disabled:opacity-50"
          >
            {orders.loading ? tr('刷新中…', 'Refreshing…') : tr('刷新', 'Refresh')}
          </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-3 py-4 sm:px-6">
        {!connected ? (
          <Empty>
            {proxyLoading
              ? tr('正在读取账户…', 'Loading account…')
              : tr('先在主页面右上角连接钱包，再来看订单。', 'Connect your wallet (top right on the main page) to see your orders.')}
          </Empty>
        ) : orders.error ? (
          <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-[11px] leading-snug text-warning">
            {tr('读不到订单：', "Couldn't load orders: ")}
            {orders.error}
          </div>
        ) : orders.loading ? (
          <Empty>{tr('读取中…', 'Loading…')}</Empty>
        ) : (
          <>
            {/* 汇总一排：持仓市值 / 浮动盈亏 / 已实现盈亏 */}
            <div className="grid grid-cols-3 gap-2">
              <Stat label={tr('持仓市值', 'Value')} value={`$${value.toFixed(2)}`} />
              <Stat label={tr('浮动盈亏', 'Unrealized')} value={signed(unrealized)} tone={tone(unrealized)} />
              <Stat label={tr('已实现', 'Realized')} value={signed(realized)} tone={tone(realized)} />
            </div>
            {/* 查询用的地址。「成交了却查不到」常常是查错了地址（见 use-positions 里那段
                诊断），摆出来让人自己比对钱包连的是不是这个账户 */}
            <p className="mt-2 truncate text-right font-mono text-[10px] text-muted-foreground">
              {tr('账户', 'Account')} {shortAddr(proxyAddr)}
            </p>
          </>
        )}

        {showData && (
          <div className="mt-4 space-y-5">
            {/* ── 持仓（已买入、还在场上）── 每行可勾选，导出成图片（见 lib/orders-export）。 */}
            <Section
              title={tr('持仓', 'Positions')}
              hint={tr('已买入', 'held')}
              count={held.length}
              action={
                held.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={toggleAll}
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {allSelected ? tr('取消全选', 'Clear') : tr('全选', 'All')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void doExport()}
                      disabled={selectedCount === 0 || exporting}
                      className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {exporting
                        ? tr('导出中…', 'Exporting…')
                        : tr(`导出图片 (${selectedCount})`, `Export image (${selectedCount})`)}
                    </button>
                  </div>
                )
              }
            >
              {held.length === 0 ? (
                <Empty>{tr('还没有持仓', 'No positions yet')}</Empty>
              ) : (
                <PositionsBoard
                  rows={boardRows}
                  account={shortAddr(proxyAddr)}
                  selected={selected}
                  onToggle={toggleOne}
                />
              )}
              {exportErr && (
                <p className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
                  {tr('导出失败：', 'Export failed: ')}
                  {exportErr}
                </p>
              )}
            </Section>

            {/* ── 成交（明细，新的在前）── 单独一段、不并进「完结」：成交是「这笔单成交了」
                这个事实，与「盘口有没有结算/平掉」是两件事 —— 比赛还没开哨买入，成交马上就有。 */}
            <Section title={tr('成交', 'Trades')} hint={tr('明细', 'fills')} count={orders.trades.length}>
              {orders.trades.length === 0 ? (
                <Empty>{tr('还没有成交记录', 'No trades yet')}</Empty>
              ) : (
                <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {orders.trades.map((t) => (
                    <a key={`${t.transactionHash}:${t.asset}:${t.timestamp}`} href={marketHref(t)} className="block hover:bg-muted/50 focus-visible:outline-primary">
                      <TradeRow t={t} showTitle />
                    </a>
                  ))}
                </div>
              )}
            </Section>

            {/* ── 完结（已结算 / 已平仓）── 只有仓位，成交明细在上面的「成交」里 */}
            <Section title={tr('完结', 'Closed')} hint={tr('已结算 / 已平仓', 'settled / exited')} count={settled.length}>
              {settled.length === 0 ? (
                <Empty>{tr('没有已完结的仓位', 'No closed positions')}</Empty>
              ) : (
                <div className="space-y-2">
                  {settled.map((p) => (
                    <a key={`${p.asset}:${p.conditionId}`} href={marketHref(p)} className="block rounded-xl hover:opacity-80 focus-visible:outline-primary">
                      <PositionRow p={p} settled showTitle />
                    </a>
                  ))}
                </div>
              )}
            </Section>
          </div>
        )}
      </main>
    </div>
  )
}

/** 汇总小卡 */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-xl border border-border bg-card px-2.5 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-0.5 font-mono tnum text-sm font-semibold',
          tone === 'up' ? 'text-success' : tone === 'down' ? 'text-error' : 'text-foreground',
        )}
      >
        {value}
      </p>
    </div>
  )
}

/** 一段带计数徽标的分区标题 + 内容。`action` 放在标题行右侧（如成交段的导出按钮） */
function Section({
  title,
  hint,
  count,
  action,
  children,
}: {
  title: string
  hint: string
  count: number
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <span className="text-[11px] text-muted-foreground">{hint}</span>
          {count > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {count}
            </span>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-[11px] text-muted-foreground">
      {children}
    </p>
  )
}

/** `+$8.40` / `−$1.20`，0 不带符号 */
function signed(v: number): string {
  if (v === 0) return '$0.00'
  return `${v > 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`
}

function tone(v: number): 'up' | 'down' | undefined {
  return v > 0 ? 'up' : v < 0 ? 'down' : undefined
}
