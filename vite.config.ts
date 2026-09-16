import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'


/**
 * 刻意**不装** vite-plugin-node-polyfills。
 *
 * @polymarket/clob-client 自己的 dependencies 里就带了整套 browserify shim
 * （crypto-browserify / stream-browserify / https-browserify / buffer / url），
 * 说明它本来就是为浏览器打包设计的。再叠一层 node polyfill 插件不但多余，
 * 还会把 elliptic 那条依赖链拉进来（6 个 low 漏洞，且官方修复方案是降级到
 * 破坏性版本）。
 *
 * 如果将来构建报 "xxx is not defined"（Buffer / process 之类），先确认是哪个
 * 包缺 shim，用 resolve.alias 单点补，不要整体上 polyfill 插件。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  define: {
    // 有些库（含 ethers 依赖链）会读 process.env.NODE_ENV
    'process.env': {},
  },
})
