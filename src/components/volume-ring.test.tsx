import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { VolumeRing } from './volume-ring'

const render = (own: number | null, opposite: number | null, max = 100) =>
  renderToStaticMarkup(<svg><VolumeRing own={own} opposite={opposite} max={max} /></svg>)

describe('盘口水位外圈', () => {
  it('两侧从底部出发，正向走左侧、反向走右侧', () => {
    const html = render(50, 100)
    expect(html).toMatch(/M -2 83\.[\d]+ A 84 84 0 0 1 -2 -83\./)
    expect(html).toMatch(/M 2 83\.[\d]+ A 84 84 0 0 0 2 -83\./)
    expect(html).toContain('stroke="var(--pm-state-success)"')
    expect(html).toContain('stroke="var(--pm-state-error)"')
    expect(html).toContain('stroke-dasharray="50 100"')
    expect(html).toContain('stroke-dasharray="100 100"')
  })

  it('零或缺失不画有色弧，不把未知伪装成成交', () => {
    const html = render(0, null)
    expect(html.match(/<path\b/g)).toHaveLength(2)
    expect(html).not.toContain('stroke-dasharray')
    expect(html).toContain('—')
  })

  it('无效数值不产生 NaN 路径，比例最大到半圈', () => {
    expect(render(200, -1)).toContain('stroke-dasharray="100 100"')
    expect(render(Number.NaN, Infinity)).not.toContain('stroke-dasharray')
    expect(render(10, 20, 0)).not.toContain('stroke-dasharray')
  })
})
