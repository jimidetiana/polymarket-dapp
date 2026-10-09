#!/usr/bin/env node
/**
 * 生成 PWA / iOS 全套图标。
 *
 * ## 为什么要自己写，而不是装个库
 *
 * 只需要画「圆角方块 + 折线」这么两样东西，却要为此引入 sharp（带原生二进制，
 * Windows 上装起来最容易出问题）或 resvg（Rust 编译）。这里用 Node 内置的 zlib
 * 手写 PNG 编码 —— 零依赖、零安装、任何机器上都能跑，代价是多了下面那几十行
 * 编码代码，那点代码是死的，不会变质。
 *
 * ## 几何只在 SVG 里定义一次
 *
 * 折线的坐标、颜色、线宽都从 public/favicon.svg 里**读出来解析**，不在这里
 * 重写一份。两份几何副本的结局一定是改了一个忘了另一个，然后标签页图标和
 * 主屏图标长得不一样，而且没人会发现。改样式请改 favicon.svg。
 *
 * ## maskable 与其余几个的区别
 *
 * Android 的自适应图标会把图案裁成圆形/方形/水滴形，只保证中间 80% 直径的
 * 圆内可见。所以那份必须把图形缩进安全区，否则系统裁切时会切掉折线的拐角。
 * 其余几个按满幅画。见 SAFE_SCALE。
 *
 * 用法：node scripts/icons/generate-icons.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SVG_PATH = resolve(ROOT, 'public/favicon.svg')

// ── 从 favicon.svg 解析几何 ────────────────────────────────────────
const svg = readFileSync(SVG_PATH, 'utf8')

function attr(block, name) {
  const m = block.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`))
  if (!m) throw new Error(`favicon.svg 里找不到属性 ${name} —— 改过样式？同步更新本脚本`)
  return m[1]
}

const bgBlock = svg.match(/<rect[^>]*\/>/)?.[0]
const lineBlock = svg.match(/<path[^>]*\/>/)?.[0]
if (!bgBlock || !lineBlock) throw new Error('favicon.svg 结构变了，解析不到 <rect> 或 <path>')

const BG = attr(bgBlock, 'fill')
const RADIUS = Number(attr(bgBlock, 'rx'))
const STROKE = attr(lineBlock, 'stroke')
const STROKE_W = Number(attr(lineBlock, 'stroke-width'))
const POINTS = attr(lineBlock, 'd')
  .trim()
  .split(/\s*L\s*|\s*M\s*/)
  .filter(Boolean)
  .map((p) => p.trim().split(/\s+/).map(Number))
  .map(([x, y]) => ({ x, y }))

/** viewBox 边长（几何都按 0..100 定义）—— 从 SVG 读，不在这里写死 */
const VB = Number(
  (svg.match(/viewBox\s*=\s*"[\d.\s-]*?\s([\d.]+)\s*"/)?.[1]) ??
    (() => {
      throw new Error('favicon.svg 里读不到 viewBox 边长')
    })(),
)

// ── 颜色 ──────────────────────────────────────────────────────────
function parseColor(c) {
  const hex = c.replace('#', '')
  const full = hex.length === 3 ? hex.split('').map((ch) => ch + ch).join('') : hex
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

const [BR, BG_, BB] = parseColor(BG)
const [LR, LG, LB] = parseColor(STROKE)

// ── 画布：RGBA → 预乘后编码为 8 位 RGBA PNG ────────────────────────
/**
 * 一块画布只存两个通道：覆盖度（alpha）与「是不是线」。
 * 背景色和线色最后再合成 —— 这样抗锯齿只需要在一个标量上做，
 * 不必对三个颜色通道各算一遍混合。
 *
 * @param size  输出边长（像素）
 * @param opts  { bleed, lineScale } —— 见 TARGETS 上方的说明
 */
function draw(size, { bleed, lineScale }) {
  const px = new Float32Array(size * size) // 0..1 覆盖度
  const isLine = new Uint8Array(size * size)
  const s = size / VB

  // 折线的缩放与居中偏移。偏移只在**不铺满**时才需要 ——
  // bleed 时线本来就该落在原位（安全区靠 lineScale 自己保证）。
  const off = ((1 - lineScale) * VB) / 2
  const toPx = (p) => ({
    x: (p.x * lineScale + off) * s,
    y: (p.y * lineScale + off) * s,
  })
  const pts = POINTS.map(toPx)
  const half = (STROKE_W * lineScale * s) / 2

  // 底色
  if (bleed) {
    // 整张铺满，不裁圆角 —— 形状由 Android 启动器决定
    px.fill(1)
  } else {
    // 圆角方块：边缘用 1px 过渡做抗锯齿
    const r = RADIUS * s
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        px[y * size + x] = clamp01(0.5 - roundedRectSDF(x + 0.5, y + 0.5, size, r))
      }
    }
  }

  // 折线：逐段画，每段是带宽度的胶囊，等价于 SVG 里 stroke-linecap:round 的直线段
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - half - 2))
    const maxX = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x) + half + 2))
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - half - 2))
    const maxY = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y) + half + 2))
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d = capsuleSDF(x + 0.5, y + 0.5, a, b, half)
        const cov = clamp01(0.5 - d)
        if (cov > 0) {
          const idx = y * size + x
          isLine[idx] = 1
          // 线覆盖度不能超过方块本身的覆盖度
          px[idx] = Math.max(px[idx], cov)
        }
      }
    }
  }

  // 首尾各补一次圆头：胶囊的端点本来就是半圆，但每段的包围盒只到 A/B 之间，
  // 首尾那半个圆超出了段的包围盒之外一像素左右，靠 SDF 拿不回来。补这一下，
  // 两端才是 stroke-linecap:round 该有的圆头（4 个点都要圆，不是只有拐角）。
  stampDot(px, isLine, pts[0], half, size)
  stampDot(px, isLine, pts[pts.length - 1], half, size)

  // 合成 RGBA
  const out = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const cov = px[i]
    if (cov <= 0) continue
    const line = isLine[i]
    out[i * 4] = line ? LR : BR
    out[i * 4 + 1] = line ? LG : BG_
    out[i * 4 + 2] = line ? LB : BB
    out[i * 4 + 3] = Math.round(cov * 255)
  }
  return out
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 在某个点上盖一个圆点（stroke-linecap:round 的收尾/起点） */
function stampDot(px, isLine, c, r, size) {
  const minX = Math.max(0, Math.floor(c.x - r - 2))
  const maxX = Math.min(size - 1, Math.ceil(c.x + r + 2))
  const minY = Math.max(0, Math.floor(c.y - r - 2))
  const maxY = Math.min(size - 1, Math.ceil(c.y + r + 2))
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) - r
      const cov = clamp01(0.5 - d)
      if (cov > 0) {
        const idx = y * size + x
        isLine[idx] = 1
        px[idx] = Math.max(px[idx], cov)
      }
    }
  }
}

/** 圆角矩形有符号距离：<0 在里面 */
function roundedRectSDF(x, y, size, r) {
  const half = size / 2
  const dx = Math.abs(x - half) - (half - r)
  const dy = Math.abs(y - half) - (half - r)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - r
}

/** 点到线段的距离，再减去半径 → 胶囊的有符号距离 */
function capsuleSDF(x, y, a, b, r) {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = x - a.x
  const apy = y - a.y
  const len2 = abx * abx + aby * aby
  const t = len2 === 0 ? 0 : clamp01((apx * abx + apy * aby) / len2)
  const dx = apx - abx * t
  const dy = apy - aby * t
  return Math.hypot(dx, dy) - r
}

// ── PNG 编码（8 位 RGBA，无依赖）────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10..12 = compression/filter/interlace = 0

  // 每行前面加一个过滤器字节（0 = None）。这里不做行间预测：
  // 图标面积小、形状简单，压缩率差异可以忽略，不值得加复杂度。
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    )
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 目标清单 ──────────────────────────────────────────────────────
/**
 * 画布尺寸与两种画法。
 *
 * - `bleed: false` —— 圆角方块 + 满幅折线。浏览器标签页、iOS 主屏、PWA 普通图标
 *   都走这个：方块本身就是图标的边界，圆角是设计的一部分。
 * - `bleed: true` —— **整张画布铺满纯底色**，形状交给系统裁。这是 Android
 *   自适应图标（maskable）的规矩。
 *
 * ## maskable 为什么不能沿用圆角方块
 *
 * 曾经的做法是把整个圆角方块缩到 0.68 塞进安全区，结果是四周留出一圈透明，
 * 装到安卓主屏上变成「一小块蓝方飘在启动器背景上」，而且各家启动器的底色
 * 不一样，看着像图标破了。正确做法是底色铺满、**只把前景（白线）缩进安全区**。
 *
 * ## lineScale 为什么是 0.9
 *
 * Android 只保证中间 **80% 直径的圆**内可见 —— 也就是半径 40（viewBox 是 100）。
 * 折线各个顶点到画布中心的距离：端点 (24,70) 是 32.8、(78,28) 是 35.6，
 * 拐点 (42,48) 是 8.2、(58,60) 是 12.8。真正顶到边界的是**顶点的外沿**，
 * 即顶点距离再加上描边半宽 4.75 —— 最大是 (78,28) 的 35.6 + 4.75 = 40.35，
 * 刚好压过 40 一点。
 *
 * 所以理论最小内缩比是 40 / 40.35 ≈ 0.991，取 0.9 是**故意留余量**：
 * 各家启动器对安全区的实际裁切并不统一（有的按圆形、有的按方圆角、
 * 有的更激进），把图形缩到 37.1 留出 2.9 个单位的缓冲，比卡在边界上稳。
 * 代价只是图标看起来小一点点，比边缘被啃掉强。
 */
const TARGETS = [
  { file: 'apple-touch-icon.png', size: 180, bleed: false, lineScale: 1 },
  { file: 'pwa-192x192.png', size: 192, bleed: false, lineScale: 1 },
  { file: 'pwa-512x512.png', size: 512, bleed: false, lineScale: 1 },
  { file: 'pwa-maskable-512x512.png', size: 512, bleed: true, lineScale: 0.9 },
]

for (const t of TARGETS) {
  const png = encodePng(draw(t.size, t), t.size)
  writeFileSync(resolve(ROOT, 'public', t.file), png)
  console.log(`${t.file.padEnd(28)} ${t.size}×${t.size}  ${(png.length / 1024).toFixed(1)} kB`)
}
console.log('\n几何与颜色来自 public/favicon.svg —— 改样式改那里，再跑一次本脚本。')
