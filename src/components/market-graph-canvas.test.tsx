import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildMarketGraph } from '../graph/graph'
import { resolveTemplate, TEMPLATE_EDGES } from '../graph/template'
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
