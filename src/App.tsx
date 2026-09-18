/**
 * 三块布局：关系图（主）+ 钱包 + 订单。
 *
 * 关系图占绝对主位，钱包和订单收在右侧窄栏 —— 核心是那张图，
 * 交易是图上的动作，不是独立页面。
 *
 * 数据链路全在浏览器里：Gamma API → 合并衍生赛事 → buildMarketGraph
 * → resolveTemplate → 画布。没有后端，没有库。
 */
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { ConnectWallet, WalletPanel, Panel } from './components/connect-wallet'
import { MarketGraphCanvas } from './components/market-graph-canvas'
import { MatchPicker } from './components/match-picker'
/**
 * 下单弹窗按需加载。
 *
 * 它牵进 @polymarket/client（1929 个模块里的大头），静态 import 会把这整块
 * 打进首屏包。而「打开页面看一眼图」和「下单」是两件事 —— 第一眼不该为
 * 后者付 300 kB gzip 的代价。
 *
 * 用 lazy 而不是静态 import：静态 import 会让打包器无条件把模块拉进依赖图，
 * 与 DictAdmin 那里是同一个理由。
 *
 * 注意它是 `.then(m => ({ default: m.OrderDialog }))` 而不是直接 lazy(import(...))：
 * 那个模块是**具名导出**，React.lazy 只认 default。
 */
const OrderDialog = lazy(() =>
  import('./components/order-dialog').then((m) => ({ default: m.OrderDialog })),
)
import { useSoccerMatches, useMarketGraph, TEMPLATE_EDGES } from './lib/use-graph'
import { PRICE_MODE_LABEL, type PriceMode } from './lib/odds'
import { translateLeague } from './lib/dict'
import { formatTickPrice, DEFAULT_TICK } from './lib/tick'
import { cn } from './lib/utils'
import type { ConnState } from './lib/clob-ws'

/**
 * 词典维护页面，**只在开发时打包**。
 *
 * `import.meta.env.DEV` 是 Vite 的编译期常量：生产构建时它是字面量 false，
 * 整个分支被摇掉，dict-admin.tsx 及其依赖不会进产物。这不是运行时判断 ——
 * 运行时判断会把代码打进包里，只是不显示，那等于把维护后台发到线上。
 *
 * 用 lazy 而不是静态 import：静态 import 会让打包器无条件把模块拉进依赖图，
 * DEV 门就白设了。
 */
const DictAdmin = import.meta.env.DEV ? lazy(() => import('./pages/dict-admin')) : null

/** 当前 hash 路由。没上 react-router —— 只有两个页面，装路由库不值得 */
function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

export default function App() {
  const hash = useHash()

  if (DictAdmin && hash === '#/dict') {
    return (
      <Suspense
        fallback={
          <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
            加载中…
          </div>
        }
      >
        <DictAdmin />
      </Suspense>
    )
  }

  return <GraphPage />
}

function GraphPage() {
  const { matches, loading, error, network, reload } = useSoccerMatches()
  const [matchId, setMatchId] = useState<string | null>(null)
  const [priceMode, setPriceMode] = useState<PriceMode>('prob')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** 选中的盘口槽位 key。**关掉弹窗不清它** —— 侧栏还要显示这个盘口 */
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  /** 弹窗开关。与 pickedKey 分开：关掉弹窗不该丢掉「刚才看的是哪个盘口」 */
  const [orderOpen, setOrderOpen] = useState(false)

  // 首次拿到列表时自动选盘口最多的那场（列表已按盘口数排序）
  useEffect(() => {
    if (matchId == null && matches.length > 0) setMatchId(matches[0].id)
  }, [matches, matchId])

  const match = matches.find((m) => m.id === matchId) ?? null
  const { graph, slots, goals, prevPrices, wsState, quotedCount, book, tickByToken } =
    useMarketGraph(match)

  /**
   * 存的是**槽位的 key，不是槽位对象**。
   *
   * slots 每次报价变动都会重算（resolveTemplate 依赖 graph），对象引用每轮
   * 都是新的。存对象会让弹窗里的 target 在每次价格跳动后被判为「新的」，
   * 把用户正在填的表单重置掉。key 是稳定的。
   */
  const picked = useMemo(() => slots.find((s) => s.key === pickedKey) ?? null, [slots, pickedKey])

  /**
   * 同一张盘口的可下单侧，给弹窗做 Over/Under 切换。
   *
   * 按 nodeId 找兄弟槽位而不是存两侧 token：画布点的是「哪个节点、哪一侧」，
   * 换侧要重新取的是那一侧的 token 与报价 —— 只有 slots 拿得到全部两侧。
   */
  const pickedSides = useMemo(() => {
    if (!picked?.nodeId) return []
    return slots
      .filter((s) => s.nodeId === picked.nodeId && s.tokenId)
      .map((s) => ({ name: s.sideName ?? s.label, tokenId: s.tokenId as string }))
  }, [picked, slots])

  const pickedNode = useMemo(
    () => (picked?.nodeId ? (graph?.nodes.find((n) => n.id === picked.nodeId) ?? null) : null),
    [graph, picked],
  )

  return (
    // h-dvh + flex 列，而不是 min-h-screen：
    //  1. 画布要用 ResizeObserver 量到一个**确定的**高度才能算缩放。
    //     min-h-* 下的百分比高度解析成 auto，子元素的 h-full 会量到 0，
    //     contain 模式就永远算不出来。
    //  2. dvh 而不是 vh：手机浏览器的 100vh 不含地址栏，用 vh 会让底部
    //     被地址栏切掉一截，而被切掉的正好是侧栏面板。
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4 sm:py-2.5">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">盘口网状图</h1>
          {/* 副标题在窄屏藏掉：它是说明性文字，让位给比赛下拉和钱包按钮 */}
          <p className="hidden text-[11px] text-muted-foreground sm:block">
            结构关系与实时价格叠在一张图上，点节点直接下单
          </p>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <MatchPicker
            matches={matches}
            matchId={matchId}
            onPick={(id) => {
              setMatchId(id)
              setSelectedKey(null)
              setPickedKey(null)
              setOrderOpen(false)
            }}
          />

          <button
            type="button"
            onClick={() => setPriceMode(priceMode === 'prob' ? 'odds' : 'prob')}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground/80 hover:bg-muted"
          >
            {PRICE_MODE_LABEL[priceMode]}
          </button>

          {/* 词典入口只在开发时出现。与上面的 lazy 用同一个编译期常量，
              生产构建里这个 && 分支整体被摇掉，不会留下一个点不开的链接。 */}
          {import.meta.env.DEV && (
            <a
              href="#/dict"
              className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
            >
              词典
            </a>
          )}

          <ConnectWallet />
        </div>
      </header>

      {/* flex-1 + min-h-0：撑满 header 以下的高度，且允许子元素比内容矮。
          少了 min-h-0，flex 子项的默认 min-height:auto 会被内容顶高，
          高度重新变成不确定的，画布又量不到数。 */}
      {/*
        窄屏纵向堆叠、宽屏左右分栏。断点取 lg（1024px）而不是 sm：
        侧栏 288px + 画布至少要 ~600px 才画得开，两者相加已经接近 900px，
        在 sm/md 就分栏会把画布挤到比手机还窄。

        纵向堆叠时画布固定占 60dvh：画布必须拿到一个**确定的**高度才能算缩放，
        用 flex-1 在可滚动的纵向容器里会退化成内容高度（也就是 0）。
      */}
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:flex-row lg:overflow-hidden">
        {/* 关系图 */}
        <section className="flex h-[60dvh] min-h-0 min-w-0 shrink-0 rounded-lg border border-border bg-card lg:h-auto lg:flex-1 lg:shrink">
          {loading ? (
            <Centered>正在拉取比赛…</Centered>
          ) : error && matches.length === 0 ? (
            <Centered>
              <p className="text-sm text-warning">{error}</p>
              {network && (
                <p className="max-w-md text-center text-[11px] leading-relaxed text-muted-foreground">
                  浏览器连不上 gamma-api.polymarket.com。这个接口 CORS 是全开的，
                  连不上通常是网络层被拦 —— 确认能直接打开 polymarket.com。
                </p>
              )}
              <button
                type="button"
                onClick={reload}
                className="rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground/80 hover:bg-muted"
              >
                重试
              </button>
            </Centered>
          ) : graph ? (
            <MarketGraphCanvas
              graph={graph}
              slots={slots}
              templateEdges={TEMPLATE_EDGES}
              goals={goals}
              priceMode={priceMode}
              prevPrices={prevPrices}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              onBuy={(s) => {
                setPickedKey(s.key)
                setOrderOpen(true)
              }}
            />
          ) : (
            <Centered>选一场比赛</Centered>
          )}
        </section>

        {/* 右：比赛信息 + 钱包 + 订单 */}
        {/* 侧栏自己滚：窄窗口下三块面板会超过视口高度，
            让它独立滚动，不牵连画布的高度计算 */}
        {/* 窄屏时占满宽度并跟着 main 一起滚；宽屏时固定 288px 自己滚 */}
        <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-72 lg:overflow-y-auto">
          {match && graph && (
            <Panel title="本场">
              <div className="space-y-1.5 text-xs">
                <LeagueRow code={match.leagueCode} icon={match.leagueIcon} />
                <KV k="盘口" v={`${match.markets.length}（${match.sources.length} 个子赛事）`} />
                <KV k="节点 / 边" v={`${graph.nodes.length} / ${graph.edges.length}`} />
                <KV k="划分组" v={String(graph.groups.length)} />
                <KV
                  k="违约"
                  v={graph.stats.violations > 0 ? `${graph.stats.violations} 处` : '无'}
                />
                <QuoteRow wsState={wsState} quotedCount={quotedCount} />
              </div>
              <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
                {quotedCount > 0
                  ? '有实时报价的节点显示真实买卖盘，可用来下单；其余仍是 Gamma 快照（上一次成交价），画布上标着「快照」。'
                  : '当前全是 Gamma 快照（上一次成交价），不是可成交的买卖盘。赛前盘口常常没有挂单，这是正常的。'}
              </p>
            </Panel>
          )}

          <WalletPanel />

          <Panel title="订单">
            {pickedNode && picked ? (
              <div className="space-y-1.5 text-xs">
                <KV k="盘口" v={picked.label} />
                <KV k="方向" v={picked.sideName ?? '—'} />
                <KV
                  k="现价"
                  v={`${formatTickPrice(
                    picked.price,
                    tickByToken[picked.tokenId ?? ''] ?? DEFAULT_TICK,
                  )}${
                    tickByToken[picked.tokenId ?? ''] === '0.001' ? '（0.001 档）' : ''
                  }`}
                />
                <KV k="报价" v={picked.quoted ? '实时双边盘' : '快照（上一次成交价）'} />
                <button
                  type="button"
                  onClick={() => setOrderOpen(true)}
                  className="mt-1.5 w-full rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/20"
                >
                  {orderOpen ? '下单面板已打开' : '打开下单面板'}
                </button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">点图上绑了盘口的节点下单。</p>
            )}
          </Panel>
        </aside>
      </main>

      {/* 下单弹窗。挂在页面根上而不是节点 onClick 那一刻就地展开：
          弹窗要跨「换侧」存活，而 onBuy 只在点击瞬间给得出数据。
          换侧只改 pickedKey，剩下的（token、报价、tick）都由 slots 重新推出来。 */}
      {orderOpen && picked && picked.tokenId && pickedNode && graph && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 text-sm text-muted-foreground backdrop-blur-sm">
              正在加载下单面板…
            </div>
          }
        >
          <OrderDialog
            tokenId={picked.tokenId}
            sideName={picked.sideName ?? picked.label}
            marketLabel={picked.label}
            marketQuestion={pickedNode.questionZh || pickedNode.questionEn || pickedNode.desc.label}
            eventTitle={graph.title}
            sides={pickedSides}
            onSelectSide={(s) => {
              const hit = slots.find((x) => x.tokenId === s.tokenId)
              if (hit) setPickedKey(hit.key)
            }}
            tickByToken={tickByToken}
            quotes={book}
            onClose={() => setOrderOpen(false)}
          />
        </Suspense>
      )}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    // 不写 min-h-[70vh]：那会把 section 顶出确定高度，破坏画布的尺寸测量
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="truncate text-right font-mono text-foreground">{v}</span>
    </div>
  )
}

/**
 * 联赛一行：徽标 + 中文名。
 *
 * 徽标用 Gamma 给的 URL（event.image 指向 soccer-leagues/<code>.png），
 * 不自己存 —— 那是唯一免费可靠的图标来源。
 *
 * 代码查不到译名时显示「未知联赛」而不是显示代码本身：`col1` 对用户没有
 * 任何意义，而缺哪些代码由管理页面的缺失列表负责暴露。
 */
/**
 * 报价来源一行：实时 / 快照。
 *
 * 这一行是**能不能下单**的判据，不是装饰。只看画布上的 `quoted` 标记不够 ——
 * applyLivePrices 会就地改节点，标记一旦置 true 就不会退回，断线后画布仍显示
 * 「实时」而价格早已过期。所以真相在这里：WS 状态 + 拿到双边盘的 token 数。
 *
 * 赛前 0 实时是**正常**的，不是故障：那时盘口常常一张挂单都没有。
 * 所以 0 的时候不报红，只说明现在是快照。
 */
function QuoteRow({ wsState, quotedCount }: { wsState: ConnState; quotedCount: number }) {
  const live = quotedCount > 0
  const text = live
    ? `实时 ${quotedCount} 档`
    : wsState === 'open'
      ? '已连接，暂无挂单'
      : wsState === 'connecting'
        ? '连接中…'
        : '快照'
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">报价</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            live ? 'bg-success' : wsState === 'open' ? 'bg-warning' : 'bg-muted-foreground',
          )}
        />
        <span className="truncate text-right text-foreground">{text}</span>
      </span>
    </div>
  )
}

function LeagueRow({ code, icon }: { code: string | null; icon: string | null }) {
  const zh = translateLeague(code)
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">联赛</span>
      <span className="flex min-w-0 items-center gap-1.5">
        {icon && (
          <img
            src={icon}
            alt=""
            className="size-4 shrink-0 rounded-sm object-contain"
            // 图挂了就藏掉，不要显示破图占位符
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        )}
        <span className="truncate text-right text-foreground">
          {zh ?? (code ? '未知联赛' : '—')}
        </span>
      </span>
    </div>
  )
}
