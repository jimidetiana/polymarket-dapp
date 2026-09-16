import { http, createConfig } from 'wagmi'
import { polygon } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

/**
 * 钱包配置。
 *
 * 链选 Polygon 而不是 Ethereum：Polymarket CLOB 跑在 Polygon 上
 * （USDC.e / 条件代币都在那边）。连错链下单会静默失败或烧 gas。
 *
 * 连接器只装 injected（MetaMask / Rabby 等浏览器扩展）。WalletConnect
 * 要项目 ID，等真有移动端用户再加，现在加只会多一个空按钮。
 */
export const wagmiConfig = createConfig({
  chains: [polygon],
  connectors: [injected()],
  transports: {
    [polygon.id]: http(),
  },
})
