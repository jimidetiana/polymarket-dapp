import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { applyLivePrices, buildMarketGraph } from '../graph/graph'
import { isOuterSlot, resolveTemplate, TEMPLATE_EDGES } from '../graph/template'
import { compositeEdges } from '../graph/composite'
import { setLang } from '../lib/i18n'
import { MarketGraphCanvas } from './market-graph-canvas'

const graph = buildMarketGraph({ id: 'test', homeTeamEn: 'Home FC', awayTeamEn: 'Away FC' }, [])
const goals = { total: null, home: null, away: null }

function render() {
  return renderToStaticMarkup(
    <MarketGraphCanvas
      graph={graph}
      slots={resolveTemplate(graph, goals)}
      templateEdges={TEMPLATE_EDGES}
      goals={goals}
      priceMode="prob"
      prevPrices={{}}
      selectedKey={null}
      onSelect={vi.fn()}
    />,
  )
}

afterEach(() => setLang('zh'))

describe('盘口默认折叠', () => {
  it('默认只画 33 个节点和可见连线，展示更多按钮处于折叠态', () => {
    const html = render()
    expect(html.match(/<circle\b/g)).toHaveLength(33)
    expect(html.match(/<line\b/g)).toHaveLength(33)
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>展示更多<\/button>/)
    expect(html).toContain('总进球 6.5')
    expect(html).not.toContain('总进球 7.5')
    expect(html).not.toContain('总进球 8.5')
    for (const team of ['主队', '客队']) {
      expect(html).toContain(`${team}总进球 3.5`)
      expect(html).not.toContain(`${team}总进球 4.5`)
      expect(html).not.toContain(`${team}总进球 5.5`)
      for (const sign of ['+', '-']) {
        expect(html).toContain(`${team} ${sign}3.5`)
        expect(html).not.toContain(`${team} ${sign}4.5`)
        expect(html).not.toContain(`${team} ${sign}5.5`)
      }
    }
  })

  it('英文界面使用对应按钮和盘口标签', () => {
    setLang('en')
    const html = render()
    expect(html).toContain('Show more')
    expect(html).toContain('O/U 6.5')
    expect(html).not.toContain('O/U 7.5')
    expect(html).not.toContain('O/U 8.5')
  })
})

describe('触摸手势', () => {
  it('容器 touch-action 恒为 none，不把双指手势让给浏览器', () => {
    // 改回 pan-y 会让浏览器在手势**开始时**就把双指捏合判成「缩放整页」，
    // 我们这边只收到 pointercancel —— 捏合放大失效，还会触发白屏那条路径
    // （手指抬起后 setView 的更新函数才跑，那时 pinch 已被置空）。
    // 这个布局里页面不滚（h-dvh + main/容器 overflow-hidden），
    // 让出纵向滚动没有任何收益。
    expect(render()).toContain('touch-action:none')
  })
})

describe('合成盘口的刻度层', () => {
  const priced = (asks: Record<string, number>) => {
    const markets = [
      {
        id: '1',
        questionEn: 'Will Home FC win on 2026-08-30?',
        outcomes: ['Yes', 'No'],
        clobTokenIds: ['mlYes', 'mlNo'],
        volume: 1000,
      },
      {
        id: '2',
        questionEn: 'Spread: Home FC (-1.5)',
        line: -1.5,
        outcomes: ['Home FC', 'Away FC'],
        clobTokenIds: ['sp15Home', 'sp15Away'],
        volume: 1000,
      },
      {
        id: '3',
        questionEn: 'Spread: Home FC (-2.5)',
        line: -2.5,
        outcomes: ['Home FC', 'Away FC'],
        clobTokenIds: ['sp25Home', 'sp25Away'],
        volume: 1000,
      },
    ]
    const g0 = buildMarketGraph({ id: 'test', homeTeamEn: 'Home FC', awayTeamEn: 'Away FC' }, markets)
    const first = resolveTemplate(g0, goals)
    const quotes: Record<string, { bid: number | null; ask: number | null }> = {}
    for (const s of first) {
      if (!s.tokenId) continue
      quotes[s.tokenId] = { bid: null, ask: asks[s.key] ?? null }
    }
    return applyLivePrices(g0, quotes)
  }

  const renderPriced = (asks: Record<string, number>) => {
    const g = priced(asks)
    return renderToStaticMarkup(
      <MarketGraphCanvas
        graph={g}
        slots={resolveTemplate(g, goals)}
        templateEdges={TEMPLATE_EDGES}
        goals={goals}
        priceMode="prob"
        prevPrices={{}}
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    )
  }

  it('静止时不画任何刻度：命中层是透明的，标签一个字都不出现', () => {
    const html = renderPriced({ ml_home: 0.5, 'sp_home_-1.5': 0.25 })
    expect(html).toContain('stroke="transparent"')
    // 没有悬停就没有标签 —— 静止的画布与加这个功能之前完全一样
    expect(html).not.toContain('两腿都赢')
    expect(html).not.toContain('缺卖价')
  })

  it('命中线只画在可合成的边上，数量与判据一致', () => {
    const g = priced({})
    const slots = resolveTemplate(g, goals)
    const expected = compositeEdges(
      slots.filter((s) => !isOuterSlot(s)),
      TEMPLATE_EDGES,
    ).length
    const html = renderToStaticMarkup(
      <MarketGraphCanvas
        graph={g}
        slots={slots}
        templateEdges={TEMPLATE_EDGES}
        goals={goals}
        priceMode="prob"
        prevPrices={{}}
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    )
    expect(expected).toBeGreaterThan(0)
    // 只数 <line>：节点也有 stroke="transparent"（绑了盘口但没选中时就是透明描边）
    expect(html.match(/<line\b[^>]*stroke="transparent"/g)).toHaveLength(expected)
  })
})
