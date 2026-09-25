import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * 不装 node polyfill 插件。
 *
 * 下单走 `@polymarket/client`（CLOB V2 的 TS 客户端）——它是**为浏览器设计**的，
 * 只 import viem/ox/ky/zod 这类，没有 node 内建依赖（`process` 只在它单独的
 * `./node` 子路径里，我们不碰）。所以 vite 能直接打出浏览器包，不需要 polyfill。
 * （曾短暂改用经典 clob-client v4 + ethers v5 那套需要 polyfill，但那是旧交易所的栈，
 * 已放弃——当前是 V2 + pUSD。）
 *
 * 若将来构建报 "xxx is not defined"（Buffer/process 之类），先确认哪个包缺 shim，
 * 用 resolve.alias 单点补，别整体上 polyfill 插件。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  // 开发期把 /api 代理到薄后端（server/sign-server.mjs，默认 8787）：
  // builder 归因 / 免 gas 部署的远程签名端点 /api/polymarket/sign 由它提供，
  // builder 密钥只在后端 env。生产环境需另行部署该后端并把 /api 指过去。
  server: {
    // 监听所有网卡（0.0.0.0），允许局域网/远程通过本机 IP 访问 5173
    host: true,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.SIGN_SERVER_PORT || 8787}`,
        changeOrigin: true,
      },
    },
  },
  define: {
    // 有些库会读 process.env.NODE_ENV
    'process.env': {},
  },
})
