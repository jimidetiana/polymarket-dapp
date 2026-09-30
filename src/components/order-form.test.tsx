import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLang } from '../lib/i18n'
import { OrderForm } from './order-form'

const props: ComponentProps<typeof OrderForm> = {
  outcomeName: 'Over',
  bestBid: 0.49,
  bestAsk: 0.5,
  fallbackPrice: 0.5,
  tick: '0.01',
  feeBps: 5,
  polymarketFee: { rate: 0.03, exponent: 1 },
  minShares: 200,
  submitting: false,
  onSubmit: vi.fn(),
}

function render(overrides: Partial<typeof props> = {}) {
  return renderToStaticMarkup(<OrderForm {...props} {...overrides} />)
}

afterEach(() => setLang('zh'))

describe('下单表单手续费明细', () => {
  it('区分 Polymarket 与本平台费用，合计与按钮均包含两项', () => {
    const html = render()
    expect(html).toContain('Polymarket 手续费（预估）')
    expect(html).toContain('$1.50')
    expect(html).toContain('本平台手续费（0.05%）')
    expect(html).toContain('$0.05')
    expect(html).toContain('预估合计（含手续费）')
    expect(html).toContain('买入 Over · $101.55')
    expect(html).not.toContain('实际扣款')
  })

  it('余额够本金与 builder 费、但不够 Polymarket 费时提示超额', () => {
    const html = render({ maxAmount: 101 })
    expect(html).toContain('超出可用余额 $101.00')
    expect(html).toContain('本金 $100.00 + 手续费 $1.55')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>买入 Over · \$101\.55<\/button>/)
  })

  it('零费率盘口仍单列 Polymarket 费用且不会套用体育兜底', () => {
    const html = render({ polymarketFee: { rate: 0, exponent: 1 } })
    expect(html).toContain('Polymarket 手续费（预估）')
    expect(html).toContain('$0.00')
    expect(html).toContain('买入 Over · $100.05')
  })

  it('小额费用不被按钮的两位小数吞掉', () => {
    const html = render({ bestAsk: 0.08, minShares: 5 })
    expect(html).toContain('$0.01104')
    expect(html).toContain('$0.0002')
    expect(html).toContain('买入 Over · $0.41124')
  })

  it('细 tick 的市价买按提交的美元金额计费，而非取整前份额', () => {
    const html = render({ bestAsk: 0.155, tick: '0.001', minShares: 5 })
    expect(html).toContain('$0.78')
    expect(html).toContain('$0.019773')
    expect(html).toContain('买入 Over · $0.800163')
  })

  it('英文也区分两项费用并标明预估', () => {
    setLang('en')
    const html = render()
    expect(html).toContain('Polymarket fee (est.)')
    expect(html).toContain('Our platform fee (0.05%)')
    expect(html).toContain('Est. total (incl. fees)')
  })
})
