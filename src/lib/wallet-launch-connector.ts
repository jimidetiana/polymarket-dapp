import type { walletConnect } from 'wagmi/connectors/walletConnect'

export function withAndroidWalletLaunch(factory: ReturnType<typeof walletConnect>): ReturnType<typeof walletConnect> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !/Android/i.test(navigator.userAgent)) {
    return factory
  }

  return (config) => {
    const connector = factory(config)
    const getProvider = connector.getProvider
    return {
      ...connector,
      async getProvider(...args) {
        // 在恢复会话或显示钱包列表前安装，避免首次连接与签名使用不同的唤起路径。
        const { installAndroidWalletLaunch } = await import('./android-wallet-launch')
        installAndroidWalletLaunch()
        return getProvider.apply(this, args)
      },
    }
  }
}
