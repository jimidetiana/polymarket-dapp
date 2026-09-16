/**
 * 三块布局：关系图（主）+ 钱包 + 订单。
 *
 * 关系图占绝对主位，钱包和订单收在右侧窄栏 —— 核心是那张图，
 * 交易是图上的动作，不是独立页面。
 *
 * 数据链路全在浏览器里：Gamma API → 合并衍生赛事 → buildMarketGraph
 * → resolveTemplate → 画布。没有后端，没有库。
 */
import { useEffect, useState } from 'react'
import { ConnectWallet, WalletPanel, Panel } from './components/connect-wallet'
import { MarketGraphCanvas } from './components/market-graph-canvas'
import { useSoccerMatches, useMarketGraph, TEMPLATE_EDGES } from './lib/use-graph'
import { PRICE_MODE_LABEL, type PriceMode } from './lib/odds'
import type { GraphSlot } from './types/market-graph'

export default function App() {
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
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">盘口网状图</h1>
          <p className="text-[11px] text-muted-foreground">
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
            className="max-w-[420px] truncate rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground"
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

          <ConnectWallet />
        </div>
      </header>

      <main className="flex gap-3 p-3">
        {/* 左：关系图 */}
        <section className="min-h-[70vh] min-w-0 flex-1 overflow-auto rounded-lg border border-border bg-card">
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
        <aside className="flex w-72 shrink-0 flex-col gap-3">
          {match && graph && (
            <Panel title="本场">
              <div className="space-y-1.5 text-xs">
                <KV k="联赛" v={match.league ?? '—'} />
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
    <div className="flex h-full min-h-[70vh] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
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
