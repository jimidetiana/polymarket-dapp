/**
 * 页面上显示的那些盘口 → JSON 文件（画布右上角的「导出盘口」按钮）。
 *
 * 带三层：比赛信息 → 每个盘口的基本信息 → 每侧**前 3 档**挂单。
 *
 * ## 导的是「当前页面」，不是整场比赛
 *
 * 一场比赛实测有 152 个盘口（504 个 market 合并后）、304 个 token，全导是 677 KB
 * 的文件 —— 打开就划不到底，想看的那几个盘口反而找不着。而画布一屏本来也只画得下
 * 其中一部分（外圈的远线要点「展示更多」才出来，后续还会做成分页切换）。
 *
 * 所以导出跟着**页面此刻显示了什么**走：调用方传 `nodeIds`（画布的 visibleNodeIds），
 * 这里只导那些。翻到下一页再导一份，文件就按页分好了。
 *
 * 代价是单份文件不完整，所以 `scope.markets / ofTotal` 一定要报数（见 BookExport.scope）：
 * 少了哪些盘口在文件里是看不出来的。
 *
 * ## 每侧只留 3 档
 *
 * 见下面 LEVELS 的说明。全深度那 3776 档里，绝大部分是没人会按那个价交易的远档。
 *
 * ## 三层数据，所以是 JSON
 *
 *  - **画不成图**（持仓那份 PNG 的路子，见 lib/orders-export）—— 一屏放不下，
 *    放下了也没法筛、没法算。
 *  - **压不平成 CSV** —— 三层嵌套压成「一行一档」，比赛和盘口两层只能靠重复列硬塞。
 *
 * JSON 原样保留层级，字段不丢，拿去喂脚本或再加工都是现成的。
 *
 * ## 深度要现拉，不能用画布手里那份
 *
 * 画布的报价来自 CLOB 的 WS（lib/clob-ws），那条流只给**买一/卖一**
 * （best_bid_ask 连量都不给，见 lib/book.ts 顶部），而导出要的是前几档。
 * 所以导出时按 token 重新拉一遍 `/books`，不复用画布的 Quote 表。
 *
 * ## 为什么用裸 fetch，不走 SDK
 *
 * `/books` 是公开接口、CORS 全开（实测 `Access-Control-Allow-Origin: *`），一个
 * POST 就能拿回 300 个 token 的全深度（0.6s）。而 SDK 的 `fetchOrderBooks` 要牵
 * `@polymarket/client` 进依赖图 —— 那 300 kB 是整个项目一直在躲的东西（见
 * lib/clob-client.ts 顶部、App.tsx 里 lazy 的 OrderDialog）。导出按钮画在主包里的
 * 画布上，不该为一次点击把 SDK 拉进首屏。所以这里和 lib/gamma.ts 一样：公开接口自己 fetch。
 */
import { tr } from './i18n'
import { BRAND, siteOrigin } from './site'
import type { MarketGraph, GraphNode } from '../graph/types'

const CLOB_BASE = 'https://clob.polymarket.com'

/**
 * 一次 POST 问多少个 token。
 *
 * 实测 304 个一次就能回（0.6s），所以 100 这个分批值不是为了绕开已知上限，而是给
 * 更大的比赛留一道保险：分批只是多发一两个并行请求，而不是赌一个未知的请求体上限。
 *
 * 按页导出之后单次通常只有十几到几十个 token，一批就够，这个值基本用不上。
 */
const CHUNK = 100

/**
 * 每侧导出几档挂单。
 *
 * 取 3 档是因为这份文件是**给人看的**：前三档已经覆盖了「现在什么价能成交、够不够量」
 * 这个判断，再往下是越来越挂不到的远档（实测一场比赛全深度 3776 档、677 KB，翻到
 * 第 8 档时价格已经偏离买一卖一十几个点，没人按那个价交易）。
 *
 * 档数是**截断而不是筛选**：`totals` 跟着只统计这 3 档，`levelsPerSide` 在文件里标明
 * 截断值 —— 不标的话，读文件的人会把「前三档的量」当成「盘口全部的量」。
 */
const LEVELS = 3

// ── 导出文件的形状 ──────────────────────────────────────

/** 一档挂单。`notional` = 价 × 量，省得读的人自己乘一遍 */
export type ExportLevel = {
  price: number
  size: number
  notional: number
}

/**
 * 一侧（Yes / No / Over / Under / 某队）的挂单明细。
 *
 * `bids` 由高到低、`asks` 由低到高 —— 两边的**第一项都是最优价**。CLOB 原样返回的
 * 顺序是反的（bids 从低到高、asks 从高到低），不重排的话读文件的人会把最差价
 * 当成最优价，这是 lib/use-clob 的 useOrderBook 已经踩过的同一个坑。
 */
export type ExportSide = {
  name: string
  tokenId: string
  /** 买一 / 卖一，由下面的档位算出来，**不是** WS 那份可能过期的报价 */
  bestBid: number | null
  bestAsk: number | null
  /** 卖一 − 买一；缺一侧就是 null（单边盘不拿另一侧顶替，见 lib/book.ts 的 midOf） */
  spread: number | null
  mid: number | null
  /** CLOB 报的最近成交价。没有成交过就是 null */
  lastTradePrice: number | null
  /** 最优的前几档（档数见根上的 `levelsPerSide`），不是全深度 */
  bids: ExportLevel[]
  asks: ExportLevel[]
  /**
   * 份额与金额合计，**只统计上面那几档**（不是整本盘口）。
   *
   * 口径跟着档位走而不是取全深度：两个数摆在一起而分母不同，会让人拿「3 档的价」
   * 配「整本的量」去估能成交多少。要整本的量就把 levelsPerSide 调大。
   */
  totals: { bidSize: number; bidNotional: number; askSize: number; askNotional: number }
  /**
   * true = 这个 token 的盘口**没拉到**（接口没返回它，或那一批请求失败）。
   *
   * 和「拉到了但一张挂单都没有」要分开：赛前盘口空着是常态（见 OrderBook 的空态文案），
   * 而没拉到是我们这边的缺口。两者都给空数组，不标出来就分不出。
   */
  missing: boolean
}

/** 一个盘口（Polymarket 的一张 market，含两侧 token） */
export type ExportMarket = {
  /** 节点短标签，如「全场 2.5」「主胜」「2-1」 */
  label: string
  /** 盘口问句。中文界面下是译过的，译不动就留英文原句 */
  question: string
  questionEn: string
  marketId: string
  /** 查持仓/成交只认它，见 lib/positions.ts 顶部 */
  conditionId: string | null
  /** 玩法分类（period × metric × subject × family × line，见 graph/types.ts） */
  kind: {
    family: string
    period: string
    metric: string
    subject: string
    line: number | null
  }
  volume: number
  liquidity: number
  /** 报价精度。**每个盘口各自不同**，见 lib/tick.ts */
  tickSize: string | null
  minOrderSize: number | null
  /** neg-risk 盘口（多选盘），下单授权要多补一把，见 lib/clob-client.ts */
  negRisk: boolean | null
  sides: ExportSide[]
}

/** 导出文件的根 */
export type BookExport = {
  /** 导出时刻（ISO）。盘口是逐秒变的，没有这个时间整份文件就不可复核 */
  exportedAt: string
  /**
   * 每侧导出了几档（当前是 3）。`sides[].bids/asks` 与 `totals` 都按它截断 ——
   * 标出来，读文件的人才不会把「前 3 档的量」当成整本盘口的量。
   */
  levelsPerSide: number
  /**
   * 这份文件导的是**当前页面上显示的那些盘口**，不是这场比赛的全部。
   *
   * `markets` / `ofTotal` 一起说明「导了几个、这场一共几个」 —— 页面还没显示完的
   * 盘口（后续做成分页切换）不在文件里，而少了哪些在文件里是看不出来的，所以要报数。
   */
  scope: { markets: number; ofTotal: number }
  source: { portal: string; url: string; api: string }
  match: {
    title: string
    /** 队名按当前界面语言（中文界面下是译名，查不到词典就是英文原名） */
    homeTeam: string
    awayTeam: string
    /** 英文原名。文件名用它，中英导出才同名；也是对回 Polymarket 的那把钥匙 */
    homeTeamEn: string
    awayTeamEn: string
    league: string | null
    /** 开赛时间（ISO）。Gamma 的 endDate 就是开赛时刻，见 lib/utils.formatKickoff */
    kickoff: string | null
    eventId: string
    /** 组成这场比赛的全部子赛事 id —— 盘口是按它们拉的，见 lib/gamma.mergeIntoMatches */
    eventIds: string[]
    /** 这场比赛**一共**有多少个盘口。导出了几个看 `scope.markets` */
    markets: number
  }
  stats: {
    markets: number
    tokens: number
    /** 有挂单的 token 数 */
    withDepth: number
    /** 没拉到盘口的 token 数。>0 说明这份文件不全 */
    missing: number
    levels: number
  }
  markets: ExportMarket[]
}

// ── 拉盘口深度 ──────────────────────────────────────────

/** CLOB `/books` 回的一本盘口（只列用得上的字段，蛇形命名是接口原样） */
export type RawBook = {
  asset_id?: unknown
  bids?: unknown
  asks?: unknown
  tick_size?: unknown
  min_order_size?: unknown
  neg_risk?: unknown
  last_trade_price?: unknown
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 收到六位小数。tick 最细 0.0001，六位既够又不会留浮点尾巴 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/**
 * 一侧的原始档位 → 排好序并**截到前 n 档**的 ExportLevel[]。
 *
 * `size<=0` 的档要丢：那是被吃掉还没清理的残留，不是可成交量（与 lib/book.sortLevels
 * 同一条规则）。排序方向由 side 定，见 ExportSide.bids 的说明。
 *
 * ⚠️ **必须先排序再截断**。CLOB 原样返回的顺序是反的（bids 从低到高），照原序取前 3 条
 * 会得到**最差的三档** —— 而那三个数看起来和最优三档一样合理，在文件里分辨不出来。
 */
export function toLevels(raw: unknown, side: 'bids' | 'asks', n = LEVELS): ExportLevel[] {
  const arr = Array.isArray(raw) ? raw : []
  const out: ExportLevel[] = []
  for (const lv of arr) {
    const o = lv as { price?: unknown; size?: unknown }
    const price = num(o?.price)
    const size = num(o?.size)
    if (price == null || size == null || size <= 0) continue
    // 金额按分四舍五入：price×size 的浮点尾巴（0.55×120.5 这种）不该印进文件
    out.push({ price, size, notional: Math.round(price * size * 100) / 100 })
  }
  out.sort((a, b) => (side === 'bids' ? b.price - a.price : a.price - b.price))
  return out.slice(0, n)
}

/** 一本原始盘口 + 侧名 → ExportSide。`levels` = 每侧导出几档 */
export function toExportSide(
  name: string,
  tokenId: string,
  raw: RawBook | undefined,
  levels = LEVELS,
): ExportSide {
  const bids = toLevels(raw?.bids, 'bids', levels)
  const asks = toLevels(raw?.asks, 'asks', levels)
  const bestBid = bids.length ? bids[0].price : null
  const bestAsk = asks.length ? asks[0].price : null
  const sum = (ls: ExportLevel[], k: 'size' | 'notional') =>
    Math.round(ls.reduce((s, l) => s + l[k], 0) * 100) / 100
  return {
    name,
    tokenId,
    bestBid,
    bestAsk,
    // 两侧都有才算点差与中价，缺一侧就是 null。
    //
    // ⚠️ 这里**有意不同于** lib/book.midOf —— 那个函数缺侧时退回单侧（`q.ask ?? q.bid`），
    // 因为画布要在节点上显示一个数、宁可显示单侧价也不显示空。而导出是数据文件：
    // 把单侧价叫「mid」，读文件的人会拿它当中间价去算点差和偏离，而那个数根本不是
    // 中间价。文件里 null 是诚实的，单侧价是悄悄错的。
    //
    // 两个数都按 1e-6 收口：它们是减/除出来的，不收口会把 0.07500000000000001
    // 这种浮点尾巴印进文件（tick 最细也只有 0.0001，六位足够）。
    spread: bestBid != null && bestAsk != null ? round6(bestAsk - bestBid) : null,
    mid: bestBid != null && bestAsk != null ? round6((bestBid + bestAsk) / 2) : null,
    lastTradePrice: num(raw?.last_trade_price),
    bids,
    asks,
    totals: {
      bidSize: sum(bids, 'size'),
      bidNotional: sum(bids, 'notional'),
      askSize: sum(asks, 'size'),
      askNotional: sum(asks, 'notional'),
    },
    missing: raw == null,
  }
}

/** 把数组切成每 n 个一批 */
function chunk<T>(arr: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/**
 * 按 token 批量拉盘口深度，返回 `tokenId → 原始盘口`。
 *
 * 按 asset_id 建索引而不是按请求顺序对位：接口不保证顺序，也不保证每个 token 都有
 * 一条（没挂过单的 token 可能直接缺）。按顺序对位一旦错位，整份导出的价量会系统性
 * 错配 —— 那种错在文件里看不出来。
 *
 * 用 allSettled 而不是 all：某一批失败只让那批的 token 标成 missing（统计里会报数），
 * 其余照常导出。**全批都失败才抛** —— 那时拿不到任何深度，导出的就只是一张空壳，
 * 不如直接报错。
 */
export async function fetchBooks(tokenIds: readonly string[]): Promise<Map<string, RawBook>> {
  const ids = [...new Set(tokenIds.filter(Boolean))]
  const out = new Map<string, RawBook>()
  if (ids.length === 0) return out

  const batches = chunk(ids, CHUNK)
  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const res = await fetch(`${CLOB_BASE}/books`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch.map((t) => ({ token_id: t }))),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as RawBook[]
    }),
  )

  const failed: string[] = []
  for (const r of results) {
    if (r.status === 'rejected') {
      failed.push(r.reason instanceof Error ? r.reason.message : String(r.reason))
      continue
    }
    for (const b of Array.isArray(r.value) ? r.value : []) {
      const id = b?.asset_id == null ? '' : String(b.asset_id)
      if (id) out.set(id, b)
    }
  }

  if (out.size === 0) {
    throw new Error(
      tr(
        `拉不到盘口深度（${failed[0] ?? '接口没有返回数据'}）。确认浏览器能打开 polymarket.com —— 某些网络需要代理或 VPN。`,
        `Couldn't load order books (${failed[0] ?? 'the API returned no data'}). Check that polymarket.com opens in this browser — some networks need a proxy or VPN.`,
      ),
    )
  }
  if (failed.length > 0) {
    console.warn(`[book-export] ${failed.length}/${batches.length} 批盘口没拉到：${failed.join('; ')}`)
  }
  return out
}

// ── 组装 ────────────────────────────────────────────────

/**
 * 要导出的那些节点。
 *
 * `nodeIds` 给了就只留这些（**顺序按图走**，不按传进来的顺序 —— 那是画布的布局顺序，
 * 不是盘口的逻辑顺序）；不给就是图上全部。
 */
export function nodesToExport(graph: MarketGraph, nodeIds?: ReadonlySet<string>): GraphNode[] {
  if (!nodeIds) return graph.nodes
  return graph.nodes.filter((n) => nodeIds.has(n.id))
}

/** 这些节点上的全部 token（每一侧各有自己的 tokenId，两侧都要） */
export function tokensOf(nodes: readonly GraphNode[]): string[] {
  const set = new Set<string>()
  for (const n of nodes) for (const s of n.sides) if (s.tokenId) set.add(s.tokenId)
  return [...set]
}

/** 一个节点 + 已拉到的盘口 → 一个导出盘口 */
function toExportMarket(
  n: GraphNode,
  books: ReadonlyMap<string, RawBook>,
  levels: number,
): ExportMarket {
  const sides = n.sides
    .filter((s) => s.tokenId)
    .map((s) => toExportSide(s.name, s.tokenId as string, books.get(s.tokenId as string), levels))
  // tick / 最小份额 / neg-risk 是**盘口级**属性（两侧必然相同），接口却是按 token 给的，
  // 所以从任一拿到的那侧取一次，摆在盘口上而不是两侧各挂一份。
  const meta = n.sides.map((s) => (s.tokenId ? books.get(s.tokenId) : undefined)).find(Boolean)
  return {
    label: n.desc.label,
    question: n.questionZh || n.questionEn,
    questionEn: n.questionEn,
    marketId: n.marketId,
    conditionId: n.conditionId,
    kind: {
      family: n.desc.family,
      period: n.desc.period,
      metric: n.desc.metric,
      subject: n.desc.subject,
      line: n.desc.line,
    },
    volume: n.volume,
    liquidity: n.liquidity,
    tickSize: meta?.tick_size == null ? null : String(meta.tick_size),
    minOrderSize: num(meta?.min_order_size),
    negRisk: typeof meta?.neg_risk === 'boolean' ? meta.neg_risk : null,
    sides,
  }
}

/**
 * 图 + 盘口深度 → 导出对象。纯函数，可测。
 *
 * 导的是 `nodeIds` 指定的那些盘口 —— 调用方传的是**画布此刻显示的**那一批
 * （见 components/export-book-button）。不传则导全图。
 *
 * 不论导了几个，`match.markets` 始终是这场比赛的盘口总数，与 `scope.markets`
 * 对照着看「导了几个 / 一共几个」。
 *
 * @param nodeIds 要导出的节点 id 集合。不给 = 全图
 * @param eventIds 组成这场比赛的子赛事 id（match.eventIds）。不传就只记主赛事 id
 * @param levels 每侧导出几档，默认 3
 */
export function buildBookExport(
  graph: MarketGraph,
  books: ReadonlyMap<string, RawBook>,
  meta: {
    nodeIds?: ReadonlySet<string>
    eventIds?: readonly string[]
    levels?: number
    now?: Date
  } = {},
): BookExport {
  const now = meta.now ?? new Date()
  const levels = meta.levels ?? LEVELS
  const markets = nodesToExport(graph, meta.nodeIds).map((n) => toExportMarket(n, books, levels))

  let tokens = 0
  let withDepth = 0
  let missing = 0
  let levelCount = 0
  for (const m of markets) {
    for (const s of m.sides) {
      tokens++
      if (s.missing) missing++
      else if (s.bids.length || s.asks.length) withDepth++
      levelCount += s.bids.length + s.asks.length
    }
  }

  return {
    exportedAt: now.toISOString(),
    levelsPerSide: levels,
    scope: { markets: markets.length, ofTotal: graph.nodes.length },
    source: { portal: BRAND, url: siteOrigin(), api: CLOB_BASE },
    match: {
      title: graph.title,
      homeTeam: graph.homeTeamZh || graph.homeTeamEn,
      awayTeam: graph.awayTeamZh || graph.awayTeamEn,
      homeTeamEn: graph.homeTeamEn,
      awayTeamEn: graph.awayTeamEn,
      league: graph.league,
      kickoff: graph.endTime,
      eventId: graph.eventId,
      eventIds: [...(meta.eventIds ?? [graph.eventId])],
      // 这场比赛的盘口**总数**（含页面上还没显示的）。导了几个看 scope.markets
      markets: graph.nodes.length,
    },
    stats: { markets: markets.length, tokens, withDepth, missing, levels: levelCount },
    markets,
  }
}

/**
 * 导出的入口：拉深度 → 组装 → 下载。
 *
 * 只做这三件事，所以它和界面无关（按钮只管 loading 和报错文案）。
 */
export async function exportMatchBook(
  graph: MarketGraph,
  meta: {
    nodeIds?: ReadonlySet<string>
    eventIds?: readonly string[]
    levels?: number
    now?: Date
  } = {},
): Promise<BookExport> {
  // 只拉要导出的那些盘口的 token —— 页面上没显示的盘口不该白拉一趟（之前导全图时
  // 一场比赛是 304 个 token，按页导就只有十几个）
  const books = await fetchBooks(tokensOf(nodesToExport(graph, meta.nodeIds)))
  const data = buildBookExport(graph, books, meta)
  downloadJson(data, meta.now ?? new Date())
  return data
}

// ── 下载 ────────────────────────────────────────────────

/**
 * 文件名用的队名片段。
 *
 * 只留 ASCII 字母数字（**不是** `\p{L}`）：文件名跟着界面语言变成中文的话，同一场
 * 比赛在中英两种语言下导出的文件对不上，而且中文名在某些系统/工具链里仍会被转义成
 * 一串 %E5%9F%83。所以队名取英文原名（graph.homeTeamEn 恒有值），中英导出同名。
 */
function slug(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 24) || 'match'
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** 导出文件名。带比赛与时间戳，多次导出不互相覆盖 */
export function exportFileName(data: BookExport, now: Date): string {
  const name = slug(`${data.match.homeTeamEn}-vs-${data.match.awayTeamEn}`)
  return `polysoccer-book-${name}-${stamp(now)}.json`
}

/** 触发浏览器下载。缩进 2 格 —— 这份文件是要给人打开看的 */
export function downloadJson(data: BookExport, now = new Date()): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = exportFileName(data, now)
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 可能让某些浏览器还没取到 blob，挪到下一轮事件循环（同 orders-export）
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
