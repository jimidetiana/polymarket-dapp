import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  injected: vi.fn(() => ({ kind: 'injected' })),
  walletConnect: vi.fn((parameters: unknown) => ({ kind: 'walletConnect', parameters })),
  createConfig: vi.fn((config: unknown) => config),
}))

vi.mock('wagmi', () => ({ createConfig: mocks.createConfig, http: () => 'http' }))
vi.mock('wagmi/connectors/injected', () => ({ injected: mocks.injected }))
vi.mock('wagmi/connectors/walletConnect', () => ({ walletConnect: mocks.walletConnect }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('WalletConnect 配置', () => {
  it.each(['', '   '])('Project ID 为空（%j）时不初始化远程连接器', async (id) => {
    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', id)
    await import('./wagmi')
    expect(mocks.walletConnect).not.toHaveBeenCalled()
    expect(mocks.createConfig).toHaveBeenCalledWith(expect.objectContaining({
      connectors: [{ kind: 'injected' }],
      chains: [expect.objectContaining({ id: 137 })],
    }))
  })

  it.each([
    { name: '安卓 PWA', userAgent: 'Mozilla/5.0 (Linux; Android 15)', standalone: true, redirect: true },
    { name: '安卓浏览器标签页', userAgent: 'Mozilla/5.0 (Linux; Android 15)', standalone: false, redirect: false },
    { name: '桌面 PWA', userAgent: 'Mozilla/5.0 (Windows NT 10.0)', standalone: true, redirect: false },
    { name: 'iPhone PWA', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', standalone: true, redirect: false },
  ])('$name 的回跳元数据不会串到其他连接场景', async ({ userAgent, standalone, redirect }) => {
    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', 'test-project-id')
    vi.stubGlobal('navigator', { userAgent })
    vi.stubGlobal('window', {
      location: { origin: 'https://dapp.example' },
      matchMedia: vi.fn(() => ({ matches: standalone })),
    })
    await import('./wagmi')
    const options = mocks.walletConnect.mock.calls[0][0] as { metadata: { redirect?: unknown } }
    // 只给 PWA scope 内的 HTTPS 返回地址，不声明不存在的 native scheme 或 Link Mode。
    expect(options.metadata.redirect).toEqual(redirect ? { universal: 'https://dapp.example/' } : undefined)
  })

  it('没有 matchMedia 时保持原来的连接方式', async () => {
    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', 'test-project-id')
    vi.stubGlobal('navigator', { userAgent: 'Android' })
    vi.stubGlobal('window', { location: { origin: 'https://dapp.example' } })
    await import('./wagmi')
    const options = mocks.walletConnect.mock.calls[0][0] as { metadata: { redirect?: unknown } }
    expect(options.metadata.redirect).toBeUndefined()
  })

  it('使用配置的公开 ID 和当前站点 origin，保留 injected', async () => {
    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', ' test-project-id ')
    vi.stubGlobal('window', { location: { origin: 'https://dapp.example' } })
    await import('./wagmi')
    expect(mocks.walletConnect).toHaveBeenCalledWith({
      projectId: 'test-project-id',
      showQrModal: true,
      metadata: {
        name: 'PolySoccer',
        description: 'Polymarket 足球盘口下单与战绩',
        url: 'https://dapp.example',
        icons: ['https://dapp.example/pwa-192x192.png'],
      },
    })
    expect(mocks.createConfig).toHaveBeenCalledWith(expect.objectContaining({
      connectors: [expect.objectContaining({ kind: 'injected' }), expect.objectContaining({ kind: 'walletConnect' })],
    }))
  })
})
