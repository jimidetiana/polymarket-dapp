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

/** Gamma 的 tag_id=1 是体育大类，再按 tags.slug 筛出足球 */
const SPORTS_TAG_ID = 1

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

async function gammaGet<T>(path: string, params: Record<string, string | number | boolean>): Promise<T> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
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
 * 拉未结束的足球赛事。
 *
 * 时间窗用北京时区的「今天+明天」：足球赛程基本按亚洲时间展示，
 * 且晚场需要提前就能看到。与原项目取同一个窗口，免得两边看到的比赛不一样。
 */
export async function fetchSoccerEvents(opts: { limit?: number } = {}): Promise<GammaEvent[]> {
  const now = new Date()
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 16, 0, 0),
  )
  const end = new Date(start.getTime() + 48 * 60 * 60 * 1000)

  const events = await gammaGet<GammaEvent[]>('/events', {
    tag_id: SPORTS_TAG_ID,
    active: true,
    closed: false,
    end_date_min: start.toISOString(),
    end_date_max: end.toISOString(),
    limit: opts.limit ?? 100,
  })
  return (events ?? []).filter(isSoccer)
}

/**
 * 一场比赛（把 Polymarket 拆开的多个衍生赛事合回一场）。
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
  /** 合并后的全部盘口 */
  markets: GammaMarket[]
  /** 参与合并的子赛事标题，便于排查缺族 */
  sources: string[]
}

/** 去掉衍生后缀，得到基础比赛标题 */
function baseTitle(title?: string): string {
  return (title ?? '').split(/\s+[-–]\s+/)[0].trim()
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

    // 主赛事 = 标题里没有后缀那个（它带胜平负），找不到就用盘口最多的
    const primary =
      list.find((e) => baseTitle(e.title) === (e.title ?? '').trim()) ??
      [...list].sort((a, b) => (b.markets?.length ?? 0) - (a.markets?.length ?? 0))[0]

    const markets: GammaMarket[] = []
    const seen = new Set<string>()
    for (const e of list) {
      for (const m of e.markets ?? []) {
        // 同一盘口可能在多个 event 里重复出现，按 id 去重
        if (seen.has(String(m.id))) continue
        seen.add(String(m.id))
        if (m.closed) continue
        markets.push(m)
      }
    }

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
      markets,
      sources: list.map((e) => e.title ?? '').filter(Boolean),
    })
  }

  // 盘口多的排前面：那些才画得出完整的图
  return out.sort((a, b) => b.markets.length - a.markets.length)
}

/** 单个赛事详情（含 markets） */
export async function fetchEvent(id: string): Promise<GammaEvent> {
  const arr = await gammaGet<GammaEvent[] | GammaEvent>('/events', { id, limit: 1 })
  const evt = Array.isArray(arr) ? arr[0] : arr
  if (!evt) throw new GammaError(`赛事 ${id} 不存在或已下架`, false)
  return evt
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
