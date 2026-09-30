import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connector } from 'wagmi'
import { setLang } from './i18n'
import { explainConnectError, pickable } from './wallet-connect'

function connector(id: string, type = 'injected', provider: unknown = {}): Connector {
  return { id, uid: id, type, name: id, getProvider: vi.fn(async () => provider) } as unknown as Connector
}

afterEach(() => setLang('zh'))

describe('可用钱包筛选', () => {
  it('手机没有注入 Provider 时不留下一个必失败的 injected 按钮', async () => {
    const injected = connector('injected')
    vi.mocked(injected.getProvider).mockResolvedValue(undefined)
    expect(await pickable([injected])).toEqual([])
  })

  it('手机保留 WalletConnect，不为了显示按钮初始化其 Provider', async () => {
    const injected = connector('injected', 'injected', null)
    const mobile = connector('walletConnect', 'walletConnect')
    expect(await pickable([injected, mobile])).toEqual([mobile])
    expect(mobile.getProvider).not.toHaveBeenCalled()
  })

  it('没有 EIP-6963 广播时，WalletConnect 不应挤掉通用 injected', async () => {
    const injected = connector('injected')
    const mobile = connector('walletConnect', 'walletConnect')
    expect(await pickable([injected, mobile])).toEqual([injected, mobile])
  })

  it('多个真实扩展保留选择权，只去掉重复的通用 injected', async () => {
    const injected = connector('injected')
    const metamask = connector('io.metamask')
    const binance = connector('com.binance.wallet')
    const mobile = connector('walletConnect', 'walletConnect')
    expect(await pickable([injected, mobile, metamask, binance])).toEqual([mobile, metamask, binance])
  })

  it('不可用的具名扩展不能挤掉仍可用的老式注入钱包', async () => {
    const injected = connector('injected')
    const missing = connector('io.metamask', 'injected', null)
    expect(await pickable([injected, missing])).toEqual([injected])
  })

  it('Provider getter 抛错时降级，不影响其他钱包', async () => {
    const broken = connector('injected')
    vi.mocked(broken.getProvider).mockImplementation(() => { throw new Error('getter failed') })
    const binance = connector('com.binance.wallet')
    const mobile = connector('walletConnect', 'walletConnect')
    expect(await pickable([broken, binance, mobile])).toEqual([binance, mobile])
  })

  it('getProvider 异步拒绝时同样不会使检测失败', async () => {
    const broken = connector('injected')
    vi.mocked(broken.getProvider).mockRejectedValue(new Error('unavailable'))
    expect(await pickable([broken])).toEqual([])
  })

  it('没有连接器时返回空列表；不改动输入数组', async () => {
    expect(await pickable([])).toEqual([])
    const injected = connector('injected')
    const binance = connector('com.binance.wallet')
    const input = Object.freeze([injected, binance])
    expect(await pickable(input)).toEqual([binance])
    expect(input).toEqual([injected, binance])
  })
})

describe('连接错误提示', () => {
  it('原始 Provider not found 错误说明手机连接方式', () => {
    const text = explainConnectError(new Error('Provider not found. Version: @wagmi/core@3.6.5'))
    expect(text).toContain('WalletConnect')
    expect(text).toContain('币安钱包 / MetaMask')
    expect(text).toContain('内置浏览器')
    expect(text).not.toContain('@wagmi/core')
  })

  it('跨 realm 的嵌套错误也能按 ProviderNotFoundError 名称识别', () => {
    expect(explainConnectError({ message: 'Failed to connect.', cause: { name: 'ProviderNotFoundError' } }))
      .toContain('当前浏览器没有注入钱包')
  })

  it('待处理请求不再把所有钱包都叫 MetaMask', () => {
    const text = explainConnectError({ message: 'Failed to connect.', cause: { code: -32002 } })
    expect(text).toContain('确认或取消')
    expect(text).not.toContain('MetaMask')
  })

  it('保留用户拒绝连接的提示', () => {
    expect(explainConnectError({ cause: { message: 'User rejected the request' } }))
      .toBe('你在钱包里拒绝了这次连接。')
  })

  it('未知错误保留最里层报文，循环 cause 不会卡住', () => {
    expect(explainConnectError({ message: 'Failed to connect.', cause: { message: 'Relay unavailable' } }))
      .toBe('Relay unavailable')
    const cyclic: { message: string; cause?: unknown } = { message: 'cycle' }
    cyclic.cause = cyclic
    expect(explainConnectError(cyclic)).toBe('cycle')
    expect(explainConnectError(undefined)).toBe('连接失败')
  })

  it('英文提示同样解释 Provider 缺失及待处理请求', () => {
    setLang('en')
    expect(explainConnectError('Provider not found.')).toContain('in-app browser')
    expect(explainConnectError({ code: '-32002' })).toContain('Your wallet')
  })
})
