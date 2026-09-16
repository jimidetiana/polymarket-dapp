/**
 * 三块布局：关系图（主）+ 钱包 + 订单。
 *
 * 关系图占绝对主位，钱包和订单收在右侧窄栏 —— 核心是那张图，
 * 交易是图上的动作，不是独立页面。
 *
 * 数据链路全在浏览器里：Gamma API → 合并衍生赛事 → buildMarketGraph
 * → resolveTemplate → 画布。没有后端，没有库。
 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { ConnectWallet, WalletPanel, Panel } from './components/connect-wallet'
import { MarketGraphCanvas } from './components/market-graph-canvas'
import { useSoccerMatches, useMarketGraph, TEMPLATE_EDGES } from './lib/use-graph'
import { PRICE_MODE_LABEL, type PriceMode } from './lib/odds'
import { translateLeague } from './lib/dict'
import type { GraphSlot } from './types/market-graph'

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
  const [picked, setPicked] = useState<GraphSlot | null>(null)

  // 首次拿到列表时自动选盘口最多的那场（列表已按盘口数排序）
  useEffect(() => {
    if (matchId == null && matches.length > 0) setMatchId(matches[0].id)
  }, [matches, matchId])

  const match = matches.find((m) => m.id === matchId) ?? null
  const { graph, slots, goals, prevPrices } = useMarketGraph(match)

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
          <select
            value={matchId ?? ''}
            onChange={(e) => {
              setMatchId(e.target.value || null)
              setSelectedKey(null)
              setPicked(null)
            }}
            className="max-w-[150px] truncate rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground sm:max-w-[420px]"
          >
            {matches.length === 0 && <option value="">（无比赛）</option>}
            {matches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}（{m.markets.length} 盘口）
              </option>
            ))}
          </select>

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
              onBuy={setPicked}
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
              </div>
              <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
                价格是 Gamma 快照（上一次成交价），不是可成交的买卖盘。
                画布上标了「快照」的节点即为此。
              </p>
            </Panel>
          )}

          <WalletPanel />

          <Panel title="订单">
            {picked ? (
              <div className="space-y-1.5 text-xs">
                <KV k="盘口" v={picked.label} />
                <KV k="方向" v={picked.sideName ?? '—'} />
                <KV k="盘口 id" v={picked.marketId ?? '—'} />
                <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
                  下单链路（CLOB 签名 + USDC.e 授权）还没接。签名要用 EOA，
                  资金走代理钱包，signatureType 必须是 POLY_1271。
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">点图上的节点选盘口。</p>
            )}
          </Panel>
        </aside>
      </main>
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
