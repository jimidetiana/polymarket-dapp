/**
 * Gamma API 客户端（浏览器直连，无后端）。
 *
 * ## 为什么可以直连
 *
 * 实测 `access-control-allow-origin: *` —— Gamma 是公开只读接口，CORS 全开。
 * 所以关系图的结构数据不需要自己的服务器。
 *
 * 但**网络可达性是另一回事**：某些网络到 polymarket.com 不通，需要系统级代理
 * 或 VPN。浏览器用不了 HTTPS_PROXY 环境变量，所以这种情况下用户自己得先能
 * 访问 polymarket.com。请求失败时要把这一点说清楚，而不是只报「加载失败」。
 *
 * ## 与原项目的差别
 *
 * 原项目把 Gamma 数据落到 MySQL（soccer_events / soccer_markets）再由后端
 * 组装，好处是能留时间序列（回放、违约历史、λ 曲线）。dapp 直接现拉现算，
 * 拿到的是**当刻快照** —— 回放和历史暂时没有，这是「无后端」的取舍。
 */

import { leagueCodeFromImage } from './dict'

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

/**
 * 直接让 Gamma 按足球 tag 筛（`tag_slug=soccer`），不再拉整个体育大类。
 *
 * 实测（2026-09-22，同一 48h 窗口）：`tag_id=1` 的第一页 100 个事件里 81 个
 * 是足球；`tag_slug=soccer` 的第一页 100/100 全是足球。
 * `tag_id=19`（老的足球 id）已经返回空，不要用 id。
 */
const SOCCER_TAG_SLUG = 'soccer'

/** Gamma 单页上限。实测 `limit=500` 仍只回 100 条，所以翻页不可避免 */
const PAGE_SIZE = 100

/**
 * 兜底：48h 内的足球赛事再多也不该超过这么多页（实测 3 页）。
 * 超过说明接口回了个怪总数，报错比照着它拉 2000 页好。
 */
const MAX_PAGES = 20

export type GammaTag = { id?: string; slug?: string; label?: string }

export type GammaMarket = {
  id: string
  question?: string
  /** JSON 字符串数组，如 '["Yes","No"]' */
  outcomes?: string
  /** JSON 字符串数组 */
  outcomePrices?: string
  /** JSON 字符串数组 */
  clobTokenIds?: string
  volume?: string | number
  liquidity?: string | number
  /** 让球/大小球的线值 */
  line?: string | number | null
  active?: boolean
  closed?: boolean
  /** 该盘口的最小报价单位。注意这是**每个盘口各自**的 */
  orderPriceMinTickSize?: string | number
}

export type GammaEvent = {
  id: string
  title?: string
  slug?: string
  endDate?: string
  startDate?: string
  tags?: GammaTag[]
  markets?: GammaMarket[]
  volume?: string | number
  liquidity?: string | number
  /**
   * 赛事图。对足球对阵盘来说这是**联赛徽标**
   * （.../soccer-leagues/<code>.png），不是球队图——实测同一赛事下
   * 所有盘口的 image 去重后只有 1 种，它不区分球队。
   *
   * 联赛代码就从这个路径反解，比 tag 可靠得多：857 场里 soccer-* tag
   * 命中 0 次，图片路径命中 184 次。
   */
  image?: string
  icon?: string
}

/**
 * Gamma 把数组字段存成 JSON **字符串**（不是真数组）。
 * 直接当数组用会得到逐字符遍历，这个坑很容易踩。
 */
function parseJsonArray<T = string>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

export class GammaError extends Error {
  /**
   * true = 看起来是网络不可达（而不是接口返回错误）。
   *
   * 写成普通字段而不是构造器参数属性：tsconfig 开了 erasableSyntaxOnly，
   * 参数属性需要运行时代码生成，不属于「可擦除」语法。
   */
  readonly likelyNetwork: boolean

  constructor(message: string, likelyNetwork: boolean) {
    super(message)
    this.name = 'GammaError'
    this.likelyNetwork = likelyNetwork
  }
}

type GammaParam = string | number | boolean | readonly (string | number)[]

/**
 * 数组参数按**重复键**编码：`id=1&id=2&id=3`。
 *
 * 这是官方 SDK 对 Gamma 的编码方式（`toSnakeCaseSearchParams` 对数组逐项
 * `append`）。**不能用逗号拼** `id=1,2,3` —— 那是 SDK 里另一套、给 CLOB/data
 * 接口用的；Gamma 校验 `id` 是整数，看到 "1,2,3" 直接回 422。
 */
async function gammaGet<T>(path: string, params: Record<string, GammaParam>): Promise<T> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) qs.append(k, String(item))
    else qs.set(k, String(v))
  }
  const url = `${GAMMA_BASE}${path}?${qs}`
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    // fetch 抛异常基本只有网络层问题（DNS / 连接被拒 / 被墙）
    throw new GammaError(
      `连不上 Polymarket（${e instanceof Error ? e.message : String(e)}）。` +
        `请确认浏览器能打开 polymarket.com——某些网络需要代理或 VPN。`,
      true,
    )
  }
  if (!res.ok) throw new GammaError(`Gamma 返回 HTTP ${res.status}`, false)
  return (await res.json()) as T
}

/** 只保留足球（association football）。口径与原项目 fetcher.ts 一致 */
function isSoccer(evt: GammaEvent): boolean {
  return (evt.tags ?? []).some((t) => {
    const slug = t.slug ?? ''
    return (
      slug === 'soccer' ||
      (slug.startsWith('soccer-') && !slug.includes('transfer')) ||
      slug === 'intlpt-soccer'
    )
  })
}

/**
 * 拉未结束的足球赛事 —— **只拉赛事本身，不带盘口**。
 *
 * 时间窗用北京时区的「今天+明天」：足球赛程基本按亚洲时间展示，
 * 且晚场需要提前就能看到。与原项目取同一个窗口，免得两边看到的比赛不一样。
 *
 * ## 为什么不带盘口
 *
 * 实测（2026-09-22）一页 100 个赛事带盘口是 4 MB，光盘口的 description 一项
 * 就占一半；而列表页只用得上标题、时间、联赛图、成交额。`include_markets=false`
 * 让同一页缩到 470 KB。盘口在选中某场比赛时再按 id 单独拉（fetchMatchMarkets），
 * 一场 300 KB 上下 —— 首屏从 21 MB 降到 2 MB 以内。Gamma 不认 `fields=`
 * 之类的字段裁剪参数，这是唯一能用的开关。
 *
 * ## 为什么先问总数
 *
 * `/events/pagination` 比 `/events` 多回一个 totalResults。有了总数，各页可以
 * **并行**拉，也不必靠「某页不满」来判断结束 —— 那种判断在总数缺失时会静默
 * 少拉。**不翻页会让比赛数量静默变少**：界面上完全看不出少了，只会奇怪
 * 「怎么才 11 场」。这类少数据的 bug 比报错难查得多，所以总数拿不到直接抛。
 *
 * 中途某一页失败**直接抛**（Promise.all 的语义），不做「拿到多少算多少」：
 * 那等于把静默截断又做了一遍，只是换了个地方。宁可报错让人看见。
 *
 * 拿回来仍过一遍 `isSoccer`：服务端按 tag 筛与客户端按 tag 判是同一条规则，
 * 正常情况下一个都筛不掉；留着是防 Gamma 哪天把 slug 的语义改宽。
 */
export async function fetchSoccerEvents(): Promise<GammaEvent[]> {
  const now = new Date()
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 16, 0, 0),
  )
  const end = new Date(start.getTime() + 48 * 60 * 60 * 1000)

  const params = {
    tag_slug: SOCCER_TAG_SLUG,
    active: true,
    closed: false,
    end_date_min: start.toISOString(),
    end_date_max: end.toISOString(),
    include_markets: false,
    limit: PAGE_SIZE,
  }

  const t0 = performance.now()
  // limit=1 只回 1 条，几 KB —— 这一趟只为拿 totalResults
  const head = await gammaGet<{ pagination?: { totalResults?: unknown } }>('/events/pagination', {
    ...params,
    limit: 1,
  })
  const total = head.pagination?.totalResults
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    throw new GammaError('Gamma 没有返回赛事总数，无法确认能否拉全', false)
  }
  const pages = Math.ceil(total / PAGE_SIZE)
  if (pages > MAX_PAGES) throw new GammaError(`足球赛事多达 ${total} 个，超出预期，先不拉`, false)

  const batches = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      // Gamma 的游标是「已经取到多少条」，不是页码
      gammaGet<GammaEvent[]>('/events', { ...params, offset: i * PAGE_SIZE }),
    ),
  )
  const events: GammaEvent[] = []
  for (const b of batches) {
    if (!Array.isArray(b)) throw new GammaError('Gamma 返回的赛事列表不是数组', false)
    events.push(...b)
  }
  const soccer = events.filter(isSoccer)

  // 目标三「先测量」的探针：这是首屏最重的一次拉取，页数和耗时要看得见。
  // 两个数正常应相等；前者明显小说明 isSoccer 在客户端筛掉了东西，去查 tags
  if (import.meta.env.DEV) {
    console.debug(
      `[gamma] 足球赛事 ${soccer.length}/${total} 个 · ${pages} 页并行 · ${Math.round(performance.now() - t0)}ms`,
    )
  }

  return soccer
}

/**
 * 一场比赛（把 Polymarket 拆开的多个衍生赛事合回一场）。
 *
 * **不带盘口**：列表是不带 markets 拉的（见 fetchSoccerEvents），盘口按
 * `eventIds` 在选中时另拉（fetchMatchMarkets）。
 */
export type SoccerMatch = {
  /** 用主赛事（无后缀那个）的 id，没有就用第一个 */
  id: string
  /** 基础标题，如 "Everton FC vs. Wolverhampton Wanderers FC" */
  title: string
  home: string
  away: string
  /**
   * 联赛代码，如 col1 / enl。从 event.image 路径反解 —— tag 里几乎拿不到
   * （实测 857 场 soccer-* tag 命中 0 次，图片路径命中 184 次）。
   * 中文名由 lib/dict 的 translateLeague 查，不在这里翻。
   */
  leagueCode: string | null
  /** 联赛徽标 URL。Gamma 直接给，不用自己存 */
  leagueIcon: string | null
  endDate: string | null
  /** 组成这场比赛的全部子赛事 id，盘口按它们拉 */
  eventIds: string[]
  /** 参与合并的子赛事标题，便于排查缺族 */
  sources: string[]
  /**
   * 各子赛事 volume 之和。**一个都没给时是 null 而不是 0**：盘口真的零成交，
   * 和接口没给这个字段，是两件不同的事。lib/utils 的 formatVolume 对 null
   * 显示「—」、对 0 显示「$0」，这里把两者分开，那个区分才有意义。
   */
  volume: number | null
}

/** 去掉衍生后缀，得到基础比赛标题 */
function baseTitle(title?: string): string {
  return (title ?? '').split(/\s+[-–]\s+/)[0].trim()
}

function sumVolume(events: readonly GammaEvent[]): number | null {
  let total = 0
  let seen = false
  for (const e of events) {
    const raw = e.volume
    if (raw === null || raw === undefined || raw === '') continue
    const v = Number(raw)
    if (!Number.isFinite(v)) continue
    total += v
    seen = true
  }
  return seen ? total : null
}

/**
 * 按基础标题把衍生赛事合并成「一场比赛」。
 *
 * ## 为什么必须合并
 *
 * Polymarket 把一场比赛的盘口族拆成**多个独立 event**：
 *   Everton vs Wolves                      → 胜平负 3 个盘口
 *   Everton vs Wolves - Halftime Result    → 半场 3 个
 *   Everton vs Wolves - Exact Score        → 准确比分 17 个
 *   Everton vs Wolves - Total Corners      → 角球 23 个
 *   Everton vs Wolves - More Markets       → 其余 33 个（含大小球）
 *   …
 * 实测一场合计 85 个盘口、分散在 7 个 event 里。
 *
 * 关系图要的是**跨族的约束关系**（大小球梯子 ⟹ 胜平负划分 ⟹ 准确比分），
 * 所以不合并就等于没有图 —— 只会看到孤立的一族。
 *
 * 队名从基础标题拆，而不是从各子赛事标题 —— 后者带后缀，
 * 拆出来的客队名会是 "Wolverhampton Wanderers FC - Exact Score"。
 */
export function mergeIntoMatches(events: GammaEvent[]): SoccerMatch[] {
  const groups = new Map<string, GammaEvent[]>()
  for (const e of events) {
    const base = baseTitle(e.title)
    if (!base) continue
    const list = groups.get(base)
    if (list) list.push(e)
    else groups.set(base, [e])
  }

  const out: SoccerMatch[] = []
  for (const [base, list] of groups) {
    const teams = splitTeams(base)
    // 拆不出队名就整场丢掉：拓扑推导要靠队名判断让球方向，
    // 猜错方向会让让球盘连到反的一侧，比不显示更糟
    if (!teams) continue

    // 主赛事 = 标题里没有后缀那个（它带胜平负），找不到就用第一个
    const primary = list.find((e) => baseTitle(e.title) === (e.title ?? '').trim()) ?? list[0]

    // 联赛代码从图片路径反解，且**在整组里找**而不是只看主赛事：
    // 衍生赛事（- Exact Score 之类）常常有联赛徽标而主赛事没有。
    let leagueIcon: string | null = null
    let leagueCode: string | null = null
    for (const e of list) {
      const url = e.image ?? e.icon ?? null
      const code = leagueCodeFromImage(url)
      if (code) {
        leagueCode = code
        leagueIcon = url
        break
      }
    }

    out.push({
      id: String(primary.id),
      title: base,
      home: teams.home,
      away: teams.away,
      leagueCode,
      leagueIcon,
      endDate: primary.endDate ?? null,
      eventIds: list.map((e) => String(e.id)),
      sources: list.map((e) => e.title ?? '').filter(Boolean),
      volume: sumVolume(list),
    })
  }

  // 子赛事多的排前面：盘口族多，图才画得完整（列表里没有盘口数，子赛事数是
  // 它最近的代理 —— 一族一个 event）。同样多的按成交额。
  return out.sort(
    (a, b) => b.eventIds.length - a.eventIds.length || (b.volume ?? -1) - (a.volume ?? -1),
  )
}

/** 把几个子赛事的盘口合成一份：按 id 去重，跳过已结束的 */
export function mergeMarkets(events: readonly GammaEvent[]): GammaMarket[] {
  const out: GammaMarket[] = []
  const seen = new Set<string>()
  for (const e of events) {
    for (const m of e.markets ?? []) {
      // 同一盘口可能在多个 event 里重复出现，按 id 去重
      if (seen.has(String(m.id))) continue
      seen.add(String(m.id))
      if (m.closed) continue
      out.push(m)
    }
  }
  return out
}

/**
 * 一场比赛的全部盘口：按子赛事 id 一次拉回再合并。
 *
 * 多个 id 交给 gammaGet 按重复键编码（见那里的说明）。不带时间窗和
 * active/closed：id 已经是精确定位，再加筛选只会在比赛刚结束的边界上把它
 * 筛没；已结束的盘口由 mergeMarkets 跳过。
 *
 * 少了子赛事只警告不抛：按 id 查不到多半是那个 event 被下架了，属于正常
 * 状态而不是传输失败。缺一族的图照样能画，控制台留一行给排查用。
 */
export async function fetchMatchMarkets(eventIds: readonly string[]): Promise<GammaMarket[]> {
  if (eventIds.length === 0) return []
  const events = await gammaGet<GammaEvent[]>('/events', { id: eventIds, limit: PAGE_SIZE })
  if (!Array.isArray(events)) throw new GammaError('Gamma 返回的赛事列表不是数组', false)
  if (events.length < eventIds.length) {
    const got = new Set(events.map((e) => String(e.id)))
    console.warn(`[gamma] 子赛事缺了 ${eventIds.filter((id) => !got.has(id)).join(', ')}，这几族盘口不在图上`)
  }
  return mergeMarkets(events)
}

/**
 * 从赛事标题里拆主客队。
 *
 * Polymarket 的足球赛事标题形如 "Chelsea vs. Barcelona"。
 * 拆不出来就返回 null —— 拓扑推导需要队名来判断让球方向，
 * 猜错方向会让整张图的让球盘连错（原项目注释里明确警告过这一点）。
 */
export function splitTeams(title?: string): { home: string; away: string } | null {
  if (!title) return null
  const m = title.match(/^(.+?)\s+vs\.?\s+(.+?)$/i)
  if (!m) return null
  const home = m[1].trim()
  // 去掉衍生盘的后缀，如 "Barcelona - Total Goals"
  const away = m[2].split(/\s+[-–]\s+/)[0].trim()
  if (!home || !away) return null
  return { home, away }
}

/** Gamma 的 market → buildMarketGraph 需要的输入形状 */
export function toGraphMarketInput(m: GammaMarket) {
  return {
    id: String(m.id),
    questionEn: m.question ?? '',
    questionZh: null,
    line: m.line ?? null,
    outcomes: parseJsonArray<string>(m.outcomes),
    clobTokenIds: parseJsonArray<string>(m.clobTokenIds),
    outcomePrices: parseJsonArray<string>(m.outcomePrices),
    volume: m.volume ?? null,
    liquidity: m.liquidity ?? null,
  }
}

/**
 * 盘口的两个 CLOB token id。
 *
 * Gamma 把它存成 JSON **字符串**（同 parseJsonArray 的注释），直接当数组用
 * 会逐字符遍历 —— 下单时会把 "[" 当成 tokenId 发出去。
 */
export function clobTokenIdsOf(m: GammaMarket): string[] {
  return parseJsonArray<string>(m.clobTokenIds)
}

/**
 * 每个盘口自己的 tick size。
 *
 * Gamma 在 market 上直接给了 `orderPriceMinTickSize`，所以常规路径不必再
 * 调 CLOB 的 getTickSize()——少一次网络往返。取不到时返回 null，
 * 由调用方决定是兜底还是去问 CLOB。
 *
 * 实测足球盘口：多数是 0.01，少数 0.001，**同一场比赛的不同盘口可以不同**。
 */
export function tickOf(m: GammaMarket): string | null {
  const t = m.orderPriceMinTickSize
  if (t == null) return null
  const s = String(t)
  return ['0.1', '0.01', '0.001', '0.0001'].includes(s) ? s : null
}
