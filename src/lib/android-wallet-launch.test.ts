import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const metamask = {
  name: 'MetaMask',
  mobile_link: 'https://metamask.app.link',
  play_store: 'https://play.google.com/store/apps/details?id=io.metamask',
}
const trust = {
  name: 'Trust Wallet',
  mobile_link: 'trust://',
  play_store: 'https://play.google.com/store/apps/details?id=com.wallet.crypto.trustapp',
}
const sdk = vi.hoisted(() => ({
  state: { recentWallet: undefined as typeof metamask | undefined },
  getRecentWallets: vi.fn(),
  getWalletConnectDeepLink: vi.fn(),
}))
vi.mock('@reown/appkit-controllers', () => ({
  ConnectionController: { state: sdk.state },
  StorageUtil: sdk,
}))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  sdk.state.recentWallet = undefined
  sdk.getRecentWallets.mockReturnValue([])
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15)' })
})
afterEach(() => vi.unstubAllGlobals())

const signing = 'https://metamask.app.link/wc?requestId=123&sessionTopic=abc'
const pairing = 'https://metamask.app.link/wc?uri=wc%3Aabc%402%3Frelay-protocol%3Dirn%26symKey%3Ddef'

describe('Android 指定钱包应用的 Intent', () => {
  it('连接 URI 保持原样，仅增加所选钱包包名', async () => {
    const { androidWalletIntent } = await import('./android-wallet-launch')
    expect(androidWalletIntent(pairing, [metamask])).toBe(
      `intent://${pairing.slice('https://'.length)}#Intent;scheme=https;package=io.metamask;end`,
    )
  })

  it('钱包类型来自元数据，而不是写死 MetaMask', async () => {
    const { androidWalletIntent } = await import('./android-wallet-launch')
    expect(androidWalletIntent('trust://wc?requestId=123&sessionTopic=abc', [trust])).toBe(
      'intent://wc?requestId=123&sessionTopic=abc#Intent;scheme=trust;package=com.wallet.crypto.trustapp;end',
    )
  })

  it.each([
    'https://metamask.app.link/',
    'https://metamask.app.link/wc?requestId=123',
    'https://other.example/wc?requestId=123&sessionTopic=abc',
    'https://metamask.app.link/wc?uri=abc#Intent;package=other.app;end',
  ])('不改写非钱包请求或带 Intent 片段的链接：%s', async (href) => {
    const { androidWalletIntent } = await import('./android-wallet-launch')
    expect(androidWalletIntent(href, [metamask])).toBeUndefined()
  })

  it.each([null, '', 'https://example.com/?id=io.metamask', 'https://play.google.com/store/apps/details?id=io.metamask;end'])('不猜测缺失或不合法的应用包名：%s', async (play_store) => {
    const { androidWalletIntent } = await import('./android-wallet-launch')
    expect(androidWalletIntent(signing, [{ ...metamask, play_store }])).toBeUndefined()
  })
})

describe('SDK 首次连接和后续签名共用唤起入口', () => {
  it('首次连接只按本次选择的钱包，且只安装一次', async () => {
    const open = vi.fn(() => null)
    vi.stubGlobal('window', { open, location: { assign: vi.fn() } })
    sdk.state.recentWallet = metamask
    sdk.getRecentWallets.mockReturnValue([trust])
    const { installAndroidWalletLaunch } = await import('./android-wallet-launch')
    installAndroidWalletLaunch()
    const patched = window.open
    installAndroidWalletLaunch()
    expect(window.open).toBe(patched)
    expect(window.open(pairing, '_blank', 'noreferrer noopener')).toBeNull()
    expect(window.location.assign).toHaveBeenCalledExactlyOnceWith(
      `intent://${pairing.slice('https://'.length)}#Intent;scheme=https;package=io.metamask;end`,
    )
    expect(open).not.toHaveBeenCalled()
    expect(sdk.getRecentWallets).not.toHaveBeenCalled()
  })

  it('刷新后从 SDK 已连接钱包及历史元数据恢复签名目标', async () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open, location: { assign: vi.fn() } })
    sdk.getRecentWallets.mockReturnValue([trust, metamask])
    sdk.getWalletConnectDeepLink.mockReturnValue({ name: 'MetaMask', href: metamask.mobile_link })
    const { installAndroidWalletLaunch } = await import('./android-wallet-launch')
    installAndroidWalletLaunch()
    window.open(signing, '_blank')
    expect(window.location.assign).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(';package=io.metamask;end'))
    expect(open).not.toHaveBeenCalled()
  })

  it('换钱包后签名按当前会话，不按上一次的钱包；断开后不沿用历史记录', async () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open, location: { assign: vi.fn() } })
    sdk.state.recentWallet = metamask
    sdk.getRecentWallets.mockReturnValue([metamask, trust])
    sdk.getWalletConnectDeepLink.mockReturnValue({ name: 'Trust Wallet', href: trust.mobile_link })
    const { installAndroidWalletLaunch } = await import('./android-wallet-launch')
    installAndroidWalletLaunch()
    const href = 'trust://wc?requestId=123&sessionTopic=abc'
    window.open(href, '_self')
    expect(window.location.assign).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(';package=com.wallet.crypto.trustapp;end'))
    expect(open).not.toHaveBeenCalled()
    sdk.getWalletConnectDeepLink.mockReturnValue(undefined)
    window.open(href, '_self')
    expect(open).toHaveBeenLastCalledWith(href, '_self', undefined)
  })

  it('相同 deep link 的钱包仍按会话选择，不串到历史钱包包名', async () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open, location: { assign: vi.fn() } })
    sdk.state.recentWallet = { ...metamask, mobile_link: 'wallet://' }
    sdk.getRecentWallets.mockReturnValue([{ ...trust, mobile_link: 'wallet://' }])
    sdk.getWalletConnectDeepLink.mockReturnValue({ name: 'Trust Wallet', href: 'wallet://' })
    const { installAndroidWalletLaunch } = await import('./android-wallet-launch')
    installAndroidWalletLaunch()
    window.open('wallet://wc?requestId=123&sessionTopic=abc')
    expect(window.location.assign).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(';package=com.wallet.crypto.trustapp;end'))
    expect(open).not.toHaveBeenCalled()
  })

  it('普通网页和无法读取的旧记录保留原行为及返回值', async () => {
    const result = {} as Window
    const open = vi.fn(() => result)
    vi.stubGlobal('window', { open, location: { assign: vi.fn() } })
    sdk.getRecentWallets.mockImplementation(() => { throw new Error('blocked storage') })
    const { installAndroidWalletLaunch } = await import('./android-wallet-launch')
    installAndroidWalletLaunch()
    expect(window.open('https://example.com', '_blank', 'noopener')).toBe(result)
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener')
  })

  it('MetaMask 原生协议保持连接参数，使用当前页面直接导航', async () => {
    const open = vi.fn()
    const assign = vi.fn()
    vi.stubGlobal('window', { open, location: { assign } })
    sdk.state.recentWallet = { ...metamask, mobile_link: 'metamask://' }
    const { installAndroidWalletLaunch } = await import('./android-wallet-launch')
    installAndroidWalletLaunch()
    window.open('metamask://wc?uri=wc%3Aabc%402%3FsymKey%3Ddef', '_blank')
    expect(assign).toHaveBeenCalledExactlyOnceWith('intent://wc?uri=wc%3Aabc%402%3FsymKey%3Ddef#Intent;scheme=metamask;package=io.metamask;end')
    expect(open).not.toHaveBeenCalled()
  })

  it('缺少包名保留原打开方式，不发起直接导航', async () => {
    const open = vi.fn()
    const assign = vi.fn()
    vi.stubGlobal('window', { open, location: { assign } })
    sdk.state.recentWallet = { ...metamask, play_store: '' }
    const { installAndroidWalletLaunch } = await import('./android-wallet-launch')
    installAndroidWalletLaunch()
    window.open(pairing, '_blank', 'noopener')
    expect(open).toHaveBeenCalledWith(pairing, '_blank', 'noopener')
    expect(assign).not.toHaveBeenCalled()
  })

  it('直接导航失败不再重试另一条唤起路径', async () => {
    const error = new Error('navigation blocked')
    const open = vi.fn()
    const assign = vi.fn(() => { throw error })
    vi.stubGlobal('window', { open, location: { assign } })
    sdk.state.recentWallet = metamask
    const { installAndroidWalletLaunch } = await import('./android-wallet-launch')
    installAndroidWalletLaunch()
    expect(() => window.open(pairing)).toThrow(error)
    expect(assign).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['iPhone', 'Windows NT 10.0'])('%s 不安装 Android 跳转', async (userAgent) => {
    const open = vi.fn()
    vi.stubGlobal('navigator', { userAgent })
    vi.stubGlobal('window', { open, location: { assign: vi.fn() } })
    const { installAndroidWalletLaunch } = await import('./android-wallet-launch')
    installAndroidWalletLaunch()
    expect(window.open).toBe(open)
  })
})
