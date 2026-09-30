import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Connector } from 'wagmi'
import { setLang } from '../lib/i18n'
import { WalletPicker } from './connect-wallet'

function connector(id: string, type: string, name = id): Connector {
  return { id, uid: id, type, name } as Connector
}

const metamask = connector('io.metamask', 'injected', 'MetaMask')
const binance = connector('com.binance.wallet', 'injected', 'Binance Wallet')
const mobile = connector('walletConnect', 'walletConnect', 'WalletConnect')

function render(overrides: Partial<ComponentProps<typeof WalletPicker>> = {}) {
  return renderToStaticMarkup(
    <WalletPicker connectors={[]} isPending={false} error={null} onPick={vi.fn()} {...overrides} />,
  )
}

afterEach(() => setLang('zh'))

describe('钱包入口展示', () => {
  it('检测中禁用按钮，不提前展示 Injected', () => {
    const html = render({ connectors: null })
    expect(html).toContain('检测钱包…')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('Injected')
  })

  it('手机只有 WalletConnect 时直接给手机入口', () => {
    const html = render({ connectors: [mobile] })
    expect(html).toContain('连接手机钱包')
    expect(html).not.toContain('其他钱包')
    expect(html).not.toContain('disabled=""')
  })

  it('一个桌面扩展仍可直连，同时保留手机入口箭头', () => {
    const html = render({ connectors: [mobile, metamask] })
    expect(html).toContain('连接 MetaMask')
    expect(html).toContain('其他钱包 / 手机连接')
    expect(html.match(/<button /g)).toHaveLength(2)
  })

  it('老式注入钱包不再暴露 Injected 技术名称', () => {
    const html = render({ connectors: [connector('injected', 'injected', 'Injected'), mobile] })
    expect(html).toContain('连接钱包')
    expect(html).toContain('其他钱包 / 手机连接')
    expect(html).not.toContain('Injected')
  })

  it('多个扩展先选择，不默认连第一个钱包', () => {
    const html = render({ connectors: [metamask, binance, mobile] })
    expect(html).toContain('连接钱包')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('连接 MetaMask')
  })

  it('连接中禁用主按钮和其他钱包入口，避免重复请求', () => {
    const html = render({ connectors: [metamask, mobile], isPending: true })
    expect(html).toContain('连接中…')
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })

  it('缺少连接方式时保留说明入口，不链接到单个钱包下载页', () => {
    const html = render()
    expect(html).toContain('连接钱包')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('Injected')
  })

  it('英文手机入口和 Provider 错误提示可用', () => {
    setLang('en')
    const html = render({ connectors: [mobile], error: new Error('Provider not found.') })
    expect(html).toContain('Connect mobile wallet')
    expect(html).toContain('in-app browser')
    expect(html).not.toContain('Provider not found.')
  })
})
