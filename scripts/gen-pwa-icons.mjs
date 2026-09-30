/**
 * 从 public/favicon.svg 生成 PWA 图标。
 *
 * 为什么要生成 PNG：manifest 里的 SVG 图标只有 Chrome/Android 桌面认，
 * iOS「添加到主屏」几乎只认 apple-touch-icon（PNG），Android 的自适应图标
 * 也偏好 PNG maskable。所以从同一个 logo 光栅出几档 PNG，各端才都能显示。
 *
 * logo 本身是 48×46 的紫色标志（近似方形），放到白底方形画布居中：
 *  - 普通图标留 ~38% 边距，标志占 62%，白底与 App 的浅色主题一致；
 *  - maskable 留更大安全区（标志占 52%），启动器裁成圆/圆角方时不切到标志。
 * apple-touch-icon 用普通版：iOS 只做圆角，不做遮罩，白底居中即可。
 *
 * SVG 用高 density 光栅再缩小，避免按 48px 原生分辨率放大糊掉。
 */
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const svg = readFileSync(root + 'public/favicon.svg')
const BG = { r: 255, g: 255, b: 255, alpha: 1 } // 白底，与卡片一致

/** 把 logo 缩到 box×box（保持比例、透明留白），再居中合成到 size×size 白底 */
async function make(size, fraction, out) {
  const box = Math.round(size * fraction)
  const logo = await sharp(svg, { density: 1200 })
    .resize(box, box, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const off = Math.round((size - box) / 2)
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, top: off, left: off }])
    .png()
    .toFile(root + 'public/' + out)
  console.log('wrote public/' + out, `(${size}px, logo ${box}px)`)
}

await make(192, 0.62, 'pwa-192x192.png')
await make(512, 0.62, 'pwa-512x512.png')
await make(512, 0.52, 'pwa-maskable-512x512.png')
await make(180, 0.62, 'apple-touch-icon.png')
