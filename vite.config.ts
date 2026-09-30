import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

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
  plugins: [
    react(),
    tailwindcss(),
    /**
     * PWA：让手机能「添加到主屏」，有独立图标、全屏启动、离线壳。
     *
     * ## registerType: 'autoUpdate' —— 与现有部署零冲突
     *
     * 新版 Service Worker 一到就接管，用户下次打开自动是最新的，不弹升级提示。
     * 这正契合「一次 npm run deploy，web 和已装到主屏的 PWA 一起更新」——
     * PWA 不引入第二条维护线。
     *
     * ## 只预缓存构建产物，不碰任何 API
     *
     * globPatterns 里全是本地打包出来的静态资源（JS/CSS/HTML/图标/字体）。
     * 盘口价格、战绩这些是**跨域** fetch（gamma / clob / 薄后端 /api），
     * 这里不配 runtimeCaching，所以它们照常直连网络，绝不会被缓存成旧数据 ——
     * 离线只兜住「壳」，动态数据仍要联网，这对一个下注应用是必须的。
     *
     * navigateFallbackDenylist 把 /api 排除在 SPA 回退之外：/api 是后端端点，
     * 不能在离线时被回退成 index.html。
     *
     * ## maximumFileSizeToCacheInBytes 调高
     *
     * @polymarket/client(SDK) 那个 lazy chunk 约 300 kB，加上 viem/wagmi 的
     * vendor 块，可能超过 Workbox 默认 2 MiB 上限而被踢出预缓存（只是告警，
     * 但会让首屏那几个大块无法离线）。放宽到 5 MiB 覆盖住。
     *
     * ## devOptions.enabled: false
     *
     * 开发期不注册 SW —— 免得缓存把热更新盖掉，调试时对着旧资源发懵。
     * SW 只在 build 产物里生效。
     */
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'PolySoccer',
        short_name: 'PolySoccer',
        description: 'Polymarket 足球盘口下单与战绩',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // 浅色主题：底色与 App 的 --color-background 一致，启动闪屏不跳色
        background_color: '#f5f5f7',
        theme_color: '#f5f5f7',
        categories: ['sports', 'finance'],
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
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
    // Vite 会校验请求 Host 头，用主机名（如 Tailscale MagicDNS / .ts.net）访问会被
    // "Blocked request. This host is not allowed." 拦掉。开发期放开所有 host。
    allowedHosts: true,
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
