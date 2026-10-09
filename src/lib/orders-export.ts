/**
 * 「我的订单」持仓 → 图片（PNG）。
 *
 * ## 为什么用 Canvas 2D 直接画，而不是 html2canvas / SVG 转图
 *
 *  - **零依赖**：项目里没有截图库，为一个导出按钮引一个（还都有各自的坑）不值当。
 *  - **中文可靠**：canvas 的 fillText 用系统字体渲染中文，稳。SVG 转 <img> 再转 canvas
 *    在字体可用性上飘忽，html2canvas 对 CJK 断行也常出错。
 *  - **不污染画布**：全程只画文字和色块，不往 canvas 里 drawImage 远端图（盘口缩略图在
 *    polymarket S3，跨域 drawImage 会 taint 掉 canvas，toBlob 直接抛）。设计感靠版式、
 *    配色（顶部品牌色渐变条）、字体层级来撑。
 *
 * 中英按**当前界面语言**走（tr / localize*）：中文导出中文、队名尽量译成中文
 * （localizeMarketTitle 全文扫词典，词典里没有的才留英文）。
 *
 * 价格两种口径都给：**百分比**（= 均价 ×100，即隐含概率）和**欧赔**（十进制赔率 = 1/均价）。
 * 花费 = 份额 × 均价（建仓成本）。
 *
 * ⚠️ 这里的「均价」是**含入场手续费**的价（见 positions.grossAvgPriceOf），由页面层算好
 * 传进来。所以三列都是真实成本口径：费不进价格，推出的赔率会比实际能拿到的高。
 *
 * ⚠️ 时间：持仓接口没有时间戳（一个仓位是多笔成交的汇总），所以「时间」取该 token
 * **最后一笔买入**的成交时间，由调用方从成交明细算好传进来（meta.timeByAsset）。
 */
import { tr, zonedTimeParts } from './i18n'
import { siteDisplayUrl } from './site'

/**
 * 一条已**本地化好**的持仓行（比赛 / 盘口 / 选择都由调用方按当前语言译好传进来）。
 * 导出只管排版，不碰词典 —— 「谁对谁」要靠 Gamma 赛事标题解析，那是页面层的事。
 */
export type ExportRow = {
  /** 比赛：本地化后的「甲 vs 乙」。同一场的多行会并到一组，组头显示一次 */
  match: string
  /** 盘口玩法：本地化后的「胜平负 / 总进球 / 让球…」 */
  market: string
  /** 选择：本地化后的「埃弗顿 / 大 2.5 / 否…」 */
  pick: string
  /** 最近一次买入的秒级时间戳；没有则不显示 */
  timeSec?: number
  /**
   * 建仓均价 0~1，**含入场手续费**（见 positions.grossAvgPriceOf）—— 百分比、欧赔、
   * 花费三列都由它算。用含费价是因为它才是真实成本：手续费不进价格，推出的赔率
   * 就比实际能拿到的高，等于把赔率说好看了。
   */
  avgPrice: number
  /** 这部分份额的入场手续费（美元），已计入 avgPrice，页脚单独报一次 */
  feeUsd: number
  /** 持有份额 */
  size: number
}

/** 逻辑像素；最终按 SCALE 放大到物理像素，保证在高清屏和放大看时都清晰 */
const SCALE = 2
const W = 940
const CARD_MARGIN = 20
const INNER_PAD = 26

/**
 * 列宽，和为内容区宽度 848（= W - 2*CARD_MARGIN - 2*INNER_PAD）。
 * 比赛不占列 —— 它是每组上方的整行标题（谁对谁，合并显示一次）；行里从「盘口」列起。
 */
const COL = { market: 168, pick: 200, time: 130, price: 138, shares: 78, cost: 134 }

const FONT_SANS =
  '-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, "Segoe UI", Roboto, sans-serif'
const FONT_MONO = '"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace'

/** 门户网址，印在页脚水印处。换域名只改 lib/site.ts 一处 */
const SITE_URL = siteDisplayUrl()

/** 配色与 index.css 的 Apple 令牌一致 */
const C = {
  pageBg: '#eef0f3',
  card: '#ffffff',
  ink: '#1d1d1f',
  muted: '#6e6e73',
  faint: '#9a9aa0',
  border: '#e5e5ea',
  primary: '#007aff',
  primaryDark: '#0a5bd0',
  primaryTint: 'rgba(0,122,255,0.10)',
  matchBand: 'rgba(0,122,255,0.06)',
  onBrand: '#ffffff',
  onBrandDim: 'rgba(255,255,255,0.82)',
}

// PLACEHOLDER

// ── 小工具 ───────────────────────────────────────────────

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 单行截断，超宽补省略号 */
function fitLine(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1)
  return s + '…'
}

/** 均价 → 百分比（即隐含概率）。0.45 → "45.0%" */
export function pct(price: number): string {
  return `${(price * 100).toFixed(1)}%`
}
/** 均价 → 欧赔（十进制赔率 = 1 / 价格）。0.45 → "2.22"，0 价无意义返回 "—" */
export function euroOdds(price: number): string {
  return price > 0 ? (1 / price).toFixed(2) : '—'
}
/** 秒级时间戳 → "YYYY-MM-DD HH:mm"（按界面语言的时区，见 i18n.displayTimeZone）；无效返回 "—"。画布导出与界面持仓板复用同一口径。 */
export function positionTimeText(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '—'
  const t = zonedTimeParts(new Date(sec * 1000))
  return `${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}`
}
function nowTime(d: Date): string {
  const t = zonedTimeParts(d)
  return `${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}`
}
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}
/** 英文单复数：plural(1,'match','matches') → "1 match"（中文不区分，不用它） */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// BODY

/** 一个盘口行（已中文化） */
type Item = {
  market: string
  pick: string
  time: string
  price: string
  shares: string
  cost: string
  amount: number
  sizeNum: number
}
/** 同一场比赛的一组盘口 */
type Group = { match: string; items: Item[] }

/** 一组同场比赛的行（泛型：画布用格式化后的 Item，界面持仓板用原始 ExportRow）。 */
export type MatchGroup<T> = { match: string; items: T[] }

/**
 * 按「比赛（谁对谁）」把行分组，保持首次出现的顺序；同一场的多个盘口并到一组。
 * 画布导出与界面持仓板共用**同一条归组规则**（键、无名场兜底名、顺序），
 * 两处才不会各自漂移成不同的分组。
 */
export function groupByMatch<T>(rows: T[], getMatch: (r: T) => string): MatchGroup<T>[] {
  const groups: MatchGroup<T>[] = []
  const byKey = new Map<string, MatchGroup<T>>()
  for (const r of rows) {
    const name = getMatch(r)
    const key = name || '—'
    let g = byKey.get(key)
    if (!g) {
      g = { match: name || tr('未知比赛', 'Unknown match'), items: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    g.items.push(r)
  }
  return groups
}

const HEAD_H = 76
const TABLE_HEAD_H = 30
const MATCH_H = 38
const ROW_H = 40
const FOOT_H = 62

/**
 * 把选中的持仓画成 PNG，返回 Blob。
 *
 * 先用离屏 ctx 量文字、把标题折行定行高，得出总高度再建真正的画布 —— 行高随折行变化。
 */
export async function exportPositionsImage(
  rows: ExportRow[],
  meta: { account: string; now?: Date },
): Promise<Blob> {
  const now = meta.now ?? new Date()

  // 按「比赛（谁对谁）」分组：同一场的多个盘口并到一组，比赛名只在组头显示一次。
  // 归组规则抽到 groupByMatch 与界面持仓板共用；这里只负责把每行格式化成绘制用的 Item。
  const groups: Group[] = groupByMatch(rows, (r) => r.match).map((g) => ({
    match: g.match,
    items: g.items.map((r) => ({
      market: r.market || '—',
      pick: r.pick || '—',
      time: positionTimeText(r.timeSec),
      price: `${pct(r.avgPrice)} · ${euroOdds(r.avgPrice)}`,
      shares: trimNum(r.size),
      cost: `$${(r.size * r.avgPrice).toFixed(2)}`,
      amount: r.size * r.avgPrice,
      sizeNum: r.size,
    })),
  }))

  // 总成本已含手续费（avgPrice 是含费价），所以手续费不再加进合计，只在页脚另报一次，
  // 让人看得出「这里面有多少是费」—— 不然含费与不含费的两个数字看起来没有区别。
  const totalFee = rows.reduce((s, r) => s + (Number.isFinite(r.feeUsd) ? r.feeUsd : 0), 0)
  const totalItems = groups.reduce((s, g) => s + g.items.length, 0)
  const bodyH = groups.reduce((s, g) => s + MATCH_H + g.items.length * ROW_H, 0)
  const cardH = HEAD_H + TABLE_HEAD_H + bodyH + FOOT_H
  const H = CARD_MARGIN * 2 + cardH

  const canvas = document.createElement('canvas')
  canvas.width = W * SCALE
  canvas.height = H * SCALE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')
  ctx.scale(SCALE, SCALE)
  ctx.textBaseline = 'alphabetic'

  // 页底
  ctx.fillStyle = C.pageBg
  ctx.fillRect(0, 0, W, H)

  // 卡片外框 + 柔和阴影（阴影只在这一笔画，之后 clip 掉）
  const cardX = CARD_MARGIN
  const cardW = W - CARD_MARGIN * 2
  const top = CARD_MARGIN
  ctx.save()
  ctx.shadowColor = 'rgba(20,20,40,0.10)'
  ctx.shadowBlur = 28
  ctx.shadowOffsetY = 8
  ctx.fillStyle = C.card
  roundRect(ctx, cardX, top, cardW, cardH, 18)
  ctx.fill()
  ctx.restore()

  // 之后所有内容都裁进卡片圆角内（顶部渐变条、末行斑马纹都不会溢出圆角）
  ctx.save()
  roundRect(ctx, cardX, top, cardW, cardH, 18)
  ctx.clip()

  const x0 = cardX + INNER_PAD
  const contentW = cardW - INNER_PAD * 2

  // ── 顶部品牌渐变条 ──
  const grad = ctx.createLinearGradient(cardX, top, cardX + cardW, top + HEAD_H)
  grad.addColorStop(0, C.primary)
  grad.addColorStop(1, C.primaryDark)
  ctx.fillStyle = grad
  ctx.fillRect(cardX, top, cardW, HEAD_H)

  ctx.fillStyle = C.onBrand
  ctx.font = `700 21px ${FONT_SANS}`
  ctx.fillText('PolySoccer', x0, top + 34)
  ctx.fillStyle = C.onBrandDim
  ctx.font = `500 11px ${FONT_SANS}`
  ctx.fillText(tr('足球盘口交易门户', 'Soccer markets portal'), x0, top + 54)

  ctx.fillStyle = C.onBrand
  ctx.font = `600 16px ${FONT_SANS}`
  ctx.textAlign = 'right'
  ctx.fillText(tr('我的持仓', 'My Positions'), x0 + contentW, top + 32)
  ctx.fillStyle = C.onBrandDim
  ctx.font = `400 10px ${FONT_MONO}`
  ctx.fillText(`${meta.account}`, x0 + contentW, top + 50)
  ctx.fillText(nowTime(now), x0 + contentW, top + 64)
  ctx.textAlign = 'left'

  // BODY2

  // 列 x 位置（行从「盘口」列起，比赛不占列 —— 它是每组上方的整行标题）
  const cx = {
    market: x0,
    pick: x0 + COL.market,
    time: x0 + COL.market + COL.pick,
    price: x0 + COL.market + COL.pick + COL.time,
    shares: x0 + COL.market + COL.pick + COL.time + COL.price,
    cost: x0 + COL.market + COL.pick + COL.time + COL.price + COL.shares,
  }
  const rightShares = cx.shares + COL.shares - 6
  const rightCost = cx.cost + COL.cost

  // ── 列表头（无底色，只留一条分隔线）──
  let y = top + HEAD_H
  ctx.fillStyle = C.faint
  ctx.font = `600 10px ${FONT_SANS}`
  const th = y + 20
  ctx.fillText(tr('盘口', 'MARKET'), cx.market, th)
  ctx.fillText(tr('选择', 'PICK'), cx.pick, th)
  ctx.fillText(tr('时间', 'TIME'), cx.time, th)
  ctx.fillText(tr('均价 · 欧赔', 'AVG · ODDS'), cx.price, th)
  ctx.textAlign = 'right'
  ctx.fillText(tr('份额', 'SHARES'), rightShares, th)
  ctx.fillText(tr('花费', 'COST'), rightCost, th)
  ctx.textAlign = 'left'
  ctx.fillStyle = C.border
  ctx.fillRect(x0, y + TABLE_HEAD_H - 1, contentW, 1)

  // ── 各比赛分组 ──
  y += TABLE_HEAD_H
  let totalShares = 0
  let totalCost = 0
  groups.forEach((g) => {
    // 比赛组头：整行浅蓝底 + 左侧主色竖条，比赛名（谁对谁）合并显示一次
    ctx.fillStyle = C.matchBand
    ctx.fillRect(x0 - INNER_PAD + 6, y, contentW + (INNER_PAD - 6) * 2, MATCH_H)
    ctx.fillStyle = C.primary
    ctx.fillRect(x0 - INNER_PAD + 6, y, 3, MATCH_H)
    const bandMid = y + MATCH_H / 2 + 4
    ctx.fillStyle = C.ink
    ctx.font = `700 14px ${FONT_SANS}`
    ctx.fillText(fitLine(ctx, g.match, contentW - 120), cx.market, bandMid)
    ctx.textAlign = 'right'
    ctx.fillStyle = C.muted
    ctx.font = `500 11px ${FONT_SANS}`
    ctx.fillText(tr(`${g.items.length} 个盘口`, plural(g.items.length, 'market', 'markets')), rightCost, bandMid)
    ctx.textAlign = 'left'
    y += MATCH_H

    g.items.forEach((it) => {
      const midY = y + ROW_H / 2

      // 盘口（中文市场类型）
      ctx.fillStyle = C.ink
      ctx.font = `600 12px ${FONT_SANS}`
      ctx.fillText(fitLine(ctx, it.market, COL.market - 8), cx.market, midY + 4)

      // 选择：结果做成一枚淡蓝药丸
      ctx.font = `600 12px ${FONT_SANS}`
      const pickText = fitLine(ctx, it.pick, COL.pick - 24)
      const chipW = Math.min(ctx.measureText(pickText).width + 18, COL.pick - 6)
      ctx.fillStyle = C.primaryTint
      roundRect(ctx, cx.pick, midY - 10, chipW, 21, 7)
      ctx.fill()
      ctx.fillStyle = C.primary
      ctx.fillText(pickText, cx.pick + 9, midY + 4)

      // 时间
      ctx.fillStyle = C.muted
      ctx.font = `400 11px ${FONT_MONO}`
      ctx.fillText(fitLine(ctx, it.time, COL.time - 6), cx.time, midY + 4)

      // 均价 · 欧赔
      ctx.fillStyle = C.ink
      ctx.font = `500 12px ${FONT_MONO}`
      ctx.fillText(it.price, cx.price, midY + 4)

      // 份额（右对齐）
      ctx.textAlign = 'right'
      ctx.fillText(fitLine(ctx, it.shares, COL.shares - 4), rightShares, midY + 4)

      // 花费（右对齐，加重）
      ctx.font = `700 12px ${FONT_MONO}`
      ctx.fillText(it.cost, rightCost, midY + 4)
      ctx.textAlign = 'left'

      // 盘口之间的细分隔线（组内每行之下都画，组头会盖住上一组的最后一条）
      ctx.fillStyle = C.border
      ctx.fillRect(cx.market, y + ROW_H - 0.5, contentW, 0.5)

      totalShares += it.sizeNum
      totalCost += it.amount
      y += ROW_H
    })
  })

  // ── 页脚合计 ──
  ctx.fillStyle = C.ink
  ctx.fillRect(x0, y, contentW, 1.5)
  const footY = y + 24
  ctx.fillStyle = C.muted
  ctx.font = `500 12px ${FONT_SANS}`
  ctx.fillText(
    tr(
      `${groups.length} 场比赛 · ${totalItems} 个盘口 · 总份额 ${trimNum(totalShares)} · 含手续费 $${totalFee.toFixed(2)}`,
      `${plural(groups.length, 'match', 'matches')} · ${plural(totalItems, 'market', 'markets')} · ${trimNum(totalShares)} shares · incl. $${totalFee.toFixed(2)} fees`,
    ),
    cx.market,
    footY,
  )
  ctx.textAlign = 'right'
  ctx.fillStyle = C.muted
  ctx.font = `500 11px ${FONT_SANS}`
  ctx.fillText(tr('总成本', 'Total cost'), rightCost - 104, footY)
  ctx.fillStyle = C.primary
  ctx.font = `700 16px ${FONT_MONO}`
  ctx.fillText(`$${totalCost.toFixed(2)}`, rightCost, footY + 1)
  ctx.textAlign = 'left'

  // 门户网址水印：页脚底部居中，淡一档
  ctx.textAlign = 'center'
  ctx.fillStyle = C.faint
  ctx.font = `400 11px ${FONT_MONO}`
  ctx.fillText(SITE_URL, x0 + contentW / 2, y + FOOT_H - 14)
  ctx.textAlign = 'left'

  ctx.restore() // 解除卡片裁剪

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), 'image/png')
  })
}

/** 触发浏览器下载。文件名带时间戳，避免多次导出互相覆盖。 */
export function downloadImage(blob: Blob, now = new Date()): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `polysoccer-positions-${stamp(now)}.png`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 可能让某些浏览器还没取到 blob，挪到下一轮事件循环
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
