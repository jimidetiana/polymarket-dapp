import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from './lib/wagmi'
import './index.css'
import App from './App.tsx'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
