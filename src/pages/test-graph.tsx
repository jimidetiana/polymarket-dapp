/**
 * 关系图测试页。
 *
 * 不依赖 Gamma API 和 WebSocket，直接用固定模板 + 模拟数据渲染画布，
 * 方便调试配色、布局、选中态、已打出态、快照态等视觉效果。
 *
 * 访问 #/test 即可打开。生产构建不会自动暴露入口，但文件本身会打包
 * （Vite 不会按路由拆代码），所以正式上线前如果担心，可以把 App.tsx
 * 里那条路由注释掉。
 */
import { useMemo, useState } from 'react'
import { MarketGraphCanvas } from '@/components/market-graph-canvas'
import { PALETTES, type TeamPaletteKey } from '@/lib/palette'
import { TEMPLATE_EDGES } from '@/lib/use-graph'
import { resolveTemplate, TEMPLATE_SLOTS } from '@/graph/template'
import type { MarketDescriptor, GraphNode, GraphSide, GoalImpact } from '@/graph/types'
import type { MarketGraph, GraphGoalCounts } from '@/types/market-graph'
import type { ResolvedSlot } from '@/graph/template'
import { PRICE_MODE_LABEL, type PriceMode } from '@/lib/odds'

const HOME_EN = 'Arsenal'
const AWAY_EN = 'Chelsea'
const HOME_ZH = '阿森纳'
const AWAY_ZH = '切尔西'

function buildMockGraph(): MarketGraph {
  const nodes: GraphNode[] = []

  for (const slot of TEMPLATE_SLOTS) {
    if (slot.kind !== 'market' || !slot.bind) continue

    const bind = slot.bind
    const desc: MarketDescriptor = {
      family: bind.family,
      period: bind.period,
      metric: bind.family === 'ou' ? 'goals' : 'result',
      subject: bind.subject ?? 'match',
      line: bind.line ?? null,
      homeLine:
        bind.family === 'spread' && bind.line != null
          ? bind.subject === 'away'
            ? -bind.line
            : bind.line
          : null,
      score: null,
      player: null,
      role: bind.role ?? null,
      label: slot.label,
      goalSensitive: true,
    }

    const quoted = Math.random() > 0.2
    const basePrice = 0.3 + Math.random() * 0.4
    const bid = quoted ? Math.max(0.01, basePrice - 0.015) : null
    const ask = quoted ? Math.min(0.99, basePrice + 0.015) : null
    const price = bid != null && ask != null ? (bid + ask) / 2 : basePrice

    let sides: GraphSide[]
    let primarySide: string

    if (bind.family === 'ou') {
      sides = [{ name: 'Over', tokenId: `token-${slot.key}`, price, bid, ask, quoted }]
      primarySide = 'Over'
    } else if (bind.family === 'moneyline') {
      sides = [{ name: 'Yes', tokenId: `token-${slot.key}`, price, bid, ask, quoted }]
      primarySide = 'Yes'
    } else {
      const sideName = bind.side === 'home' ? HOME_EN : AWAY_EN
      sides = [{ name: sideName, tokenId: `token-${slot.key}`, price, bid, ask, quoted }]
      primarySide = sideName
    }

    const impact: GoalImpact = {
      homeGoal: Math.random() > 0.5 ? 'up' : 'down',
      awayGoal: Math.random() > 0.5 ? 'up' : 'down',
      magnitude: 0.05 + Math.random() * 0.25,
      deltaHome: Math.random() * 0.1,
      deltaAway: -Math.random() * 0.1,
      modelled: Math.random() > 0.3,
    }

    nodes.push({
      id: `node-${slot.key}`,
      marketId: `market-${slot.key}`,
      conditionId: `0xcid-${slot.key}`,
      desc,
      questionEn: `${slot.label} · ${HOME_EN} vs ${AWAY_EN}`,
      questionZh: `${slot.label} · ${HOME_ZH} vs ${AWAY_ZH}`,
      volume: 8000 + Math.floor(Math.random() * 40000),
      liquidity: 3000 + Math.floor(Math.random() * 20000),
      sides,
      primarySide,
      impact,
      emphasis: Math.random() > 0.6 ? 'major' : 'minor',
      column: bind.family,
      row: 0,
    })
  }

  return {
    eventId: 'mock-event',
    homeTeamEn: HOME_EN,
    awayTeamEn: AWAY_EN,
    homeTeamZh: HOME_ZH,
    awayTeamZh: AWAY_ZH,
    title: '测试赛：阿森纳 vs 切尔西',
    league: '英超',
    endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    lambdaTotal: 2.5,
    lambdaHome: 1.3,
    lambdaAway: 1.2,
    nodes,
    edges: [],
    groups: [],
    columns: [],
    stats: {
      markets: nodes.length,
      withVolume: nodes.length,
      goalSensitive: nodes.length,
      edges: 0,
      violations: 0,
    },
  }
}

function buildMockSlots(graph: MarketGraph): ResolvedSlot[] {
  const goals: GraphGoalCounts = { total: 3, home: 2, away: 1 }
  return resolveTemplate(graph, goals)
}

export default function TestGraphPage() {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [priceMode, setPriceMode] = useState<PriceMode>('prob')
  const [palette, setPalette] = useState<TeamPaletteKey>('amberIndigo')

  const graph = useMemo(buildMockGraph, [])
  const slots = useMemo(() => buildMockSlots(graph), [graph])
  const prevPrices = useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of slots) {
      if (s.price != null) out[s.key] = Math.max(0.01, s.price - 0.02)
    }
    return out
  }, [slots])

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold tracking-tight text-primary">关系图测试</h1>
          <span className="text-xs text-muted-foreground">模拟数据 · 仅用于调试配色与布局</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1 sm:flex">
            {(Object.keys(PALETTES) as TeamPaletteKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setPalette(key)}
                className={`rounded-md px-2 py-1 text-xs transition-colors ${
                  palette === key
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                title={PALETTES[key].name}
              >
                {PALETTES[key].name}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPriceMode(priceMode === 'prob' ? 'odds' : 'prob')}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-foreground hover:bg-muted"
          >
            {PRICE_MODE_LABEL[priceMode]}
          </button>
          <a
            href="#/"
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            返回
          </a>
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1 p-3">
        <section className="flex flex-1 rounded-xl border border-border bg-card shadow-sm">
          <MarketGraphCanvas
            graph={graph}
            slots={slots}
            templateEdges={TEMPLATE_EDGES}
            goals={{ total: 3, home: 2, away: 1 }}
            priceMode={priceMode}
            prevPrices={prevPrices}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            onBuy={(s) => console.log('点击下单', s.label, s.sideName)}
            palette={palette}
          />
        </section>
      </main>
    </div>
  )
}
