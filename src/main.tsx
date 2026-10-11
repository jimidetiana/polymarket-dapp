import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from './lib/wagmi'
import './index.css'
import App from './App.tsx'
import { WalletWaitOverlay } from './components/wallet-wait-overlay'

/**
 * wagmi 需要 react-query 做缓存与请求去重。
 *
 * refetchOnWindowFocus 关掉：盘口价格走 WS 推送，不靠轮询；
 * 切回标签页时重拉一遍只会浪费请求，还可能把正在填的表单数据刷掉。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
})

/**
 * 摘掉 index.html 里的静态兜底文案。
 *
 * 那段文本是给爬虫 / 钱包页面检测 / 人工复核读的**静态 HTML**（见 index.html 注释），
 * 一旦 React 挂载成功它就没有存在意义了 —— 留着会在页面上和真实界面重复一份。
 * 它不在 #root 里，React 不会自动接管，所以手动删。
 */
document.getElementById('static-fallback')?.remove()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
        {/* 等待钱包的全局浮层：挂在路由之外一份，连接 / 切链 / 下单签名都共用它。
            放在这里（而不是某个页面里）是因为下单在盘口弹窗、撤单在订单页，两条路径都要它。 */}
        <WalletWaitOverlay />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
