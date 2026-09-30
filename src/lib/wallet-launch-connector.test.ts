import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { walletConnect } from 'wagmi/connectors/walletConnect'
import { withAndroidWalletLaunch } from './wallet-launch-connector'

type Factory = ReturnType<typeof walletConnect>
const mocks = vi.hoisted(() => ({ install: vi.fn() }))
vi.mock('./android-wallet-launch', () => ({ installAndroidWalletLaunch: mocks.install }))

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('WalletConnect Android 唤起安装时机', () => {
  it.each(['iPhone', 'Windows NT 10.0'])('%s 保持原连接器，不加载 Android 适配', (userAgent) => {
    vi.stubGlobal('navigator', { userAgent })
    vi.stubGlobal('window', {})
    const factory = vi.fn() as unknown as Factory
    expect(withAndroidWalletLaunch(factory)).toBe(factory)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('无浏览器环境保持原连接器', () => {
    vi.stubGlobal('window', undefined)
    const factory = vi.fn() as unknown as Factory
    expect(withAndroidWalletLaunch(factory)).toBe(factory)
  })

  it('获取 provider 前安装，并保留 this、参数和 provider 返回值', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Android' })
    vi.stubGlobal('window', {})
    const provider = { request: vi.fn() }
    const getProvider = vi.fn(async function (this: unknown, _parameters?: unknown) {
      expect(mocks.install).toHaveBeenCalled()
      return provider
    })
    const factory = vi.fn(() => ({ id: 'walletConnect', getProvider })) as unknown as Factory
    const config = {} as Parameters<Factory>[0]
    const connector = withAndroidWalletLaunch(factory)(config)
    expect(mocks.install).not.toHaveBeenCalled()
    expect(await connector.getProvider({ chainId: 137 })).toBe(provider)
    expect(getProvider).toHaveBeenCalledWith({ chainId: 137 })
    expect(getProvider.mock.contexts[0]).toBe(connector)
    expect(factory).toHaveBeenCalledWith(config)
  })
})
