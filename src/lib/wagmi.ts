import { http, createConfig } from 'wagmi'
import { polygon } from 'wagmi/chains'
import { injected } from 'wagmi/connectors/injected'
import { walletConnect } from 'wagmi/connectors/walletConnect'
import { withAndroidWalletLaunch } from './wallet-launch-connector'

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim()
const origin = typeof window === 'undefined'
  ? 'https://polysoccer.zhangsanfengzhsh.workers.dev'
  : window.location.origin
const isAndroidPwa = typeof window !== 'undefined'
  && typeof navigator !== 'undefined'
  && /Android/i.test(navigator.userAgent)
  && window.matchMedia?.('(display-mode: standalone)')?.matches === true

/**
 * Polygon 上的钱包连接：扩展 / 钱包内置浏览器走 injected，普通手机浏览器
 * 和 PWA 走 WalletConnect。Project ID 是公开标识；没有配置时只保留注入连接，
 * 不用空 ID 初始化一个必失败的远程连接器。
 */
export const wagmiConfig = createConfig({
  chains: [polygon],
  connectors: [
    injected(),
    ...(projectId ? [withAndroidWalletLaunch(walletConnect({
      projectId,
      showQrModal: true,
      metadata: {
        name: 'PolySoccer',
        description: 'Polymarket 足球盘口下单与战绩',
        url: origin,
        icons: [`${origin}/pwa-192x192.png`],
        // 返回地址落在 PWA 的 scope/start_url 内，是否回跳仍由钱包与系统决定。
        // 不给桌面扫码会话加回跳，也不伪造 PWA 并未注册的 native scheme / Link Mode。
        ...(isAndroidPwa ? { redirect: { universal: `${origin}/` } } : {}),
      },
    }))] : []),
  ],
  transports: {
    [polygon.id]: http(),
  },
})
