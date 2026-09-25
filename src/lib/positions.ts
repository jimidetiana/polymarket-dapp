/**
 * 持仓与成交历史（Polymarket data-api，**免鉴权、浏览器直连**）。
 *
 * ## 为什么不用 listOpenOrders
 *
 * 弹窗里那个「我的挂单」走 `listOpenOrders`（lib/clob-client.ts），返回的是**还没成交
 * 的委托**——一笔单成交之后就从那个列表里消失了。拿它做「有没有持仓」的标记会漏掉
 * 全部真正持有的盘口，只标出挂着没成交的那些，正好把要表达的事情说反。
 *
 * 它还有第二个问题：走 SecureClient，要签一次名，且会把 `@polymarket/client`（约
 * 300 kB gzip）拉进依赖图。画布和比赛列表都在主包里，所以主包这条路上**只能**用本
 * 模块这种不碰 SDK 的读法（同 lib/use-wallet.ts 顶部那条约束）。
 *
 * ## CORS
 *
 * 实测 `access-control-allow-origin: *`，与 Gamma 同一条路，不需要后端代理。但网络
 * 可达性是另一回事（见 lib/gamma.ts 顶部）——连不上就没有标记，不做界面关卡。
 *
 * ## ⚠️ 过滤参数：只有两个真生效，另两个是**静默忽略**
 *
 * 实测（2026-09-26，curl 直连三个端点逐一验）：
 *
 *   - `market=<conditionId>`  **真过滤**（三个端点都验到 allSameCid=true）
 *   - `sizeThreshold=0`       **真生效**，不给会筛掉已清零/已结算的仓位
 *   - `asset=<tokenId>`       **被静默忽略** —— 传了照样返回全量
 *   - `closed=`               同样被静默忽略
 *
 * 另外 `takerOnly` 有一条**不在上面那次实测里**的事实，写在 `fetchMarketTrades`
 * 上：这个接口默认只回 taker 一侧的成交（maker 那侧被筛掉），所以那里显式传了
 * `takerOnly=false`。这一条的后果比上面任何一条都严重 —— 挂单成交的用户正是 maker。
 *
 * 第三条是这里最危险的一条：它不报错、不返回空，而是返回**别人家盘口的数据**，看起来
 * 完全像生效了。所以「查某一张盘口」只能用 conditionId，不能用 tokenId —— 这也是
 * conditionId 要从 Gamma 一路带到 ResolvedSlot 上的原因。
 */

const DATA_API_BASE = 'https://data-api.polymarket.com'

/**
 * 一页多少条。100 是 Gamma 那边实测的上限，这个接口没验过更大值能不能生效——
 * 猜大了若被服务端夹回 100，靠 offset 翻页仍然是对的，只是多几趟。
 */
const PAGE_SIZE = 100

/**
 * 翻页上限，纯兜底。
 *
 * ⚠️ **分页行为没验证过**（探测时 Bash 被限流打断）。这里按「拿满一页就继续、
 * 不满一页就停」实现，这是 offset 分页的常规语义；万一接口其实不认 offset，
 * 每页都会返回同一批，`seen` 去重后 `added === 0` 会让循环停下——不会变成死循环。
 */
const MAX_PAGES = 20

/** 一条持仓。字段按实测返回声明，只留用得上的 */
export type PolyPosition = {
  /** **就是 tokenId**，与槽位的 tokenId / CLOB 的 assetId 同一个值 */
  asset: string
  /** 盘口 id。按盘口精确查只能用它（见顶部） */
  conditionId: string
  /** 持有份额。实测带一长串小数尾巴（如 36190.7986） */
  size: number
  /** 建仓均价 */
  avgPrice: number
  /** 现价 */
  curPrice: number
  /** 当前市值 */
  currentValue: number
  /** 浮动盈亏（美元） */
  cashPnl: number
  /** 浮动盈亏（百分比） */
  percentPnl: number
  /** 已实现盈亏 */
  realizedPnl: number
  /** true = 已可赎回，也就是这张盘已经结算了 */
  redeemable: boolean
  /** 持有的是哪一侧，如 Yes / No / Over */
  outcome: string
  /** 赛事 id。比赛列表的标记靠它对到 match.eventIds */
  eventId: string
  title: string
}

/** 一条成交 */
export type PolyTrade = {
  asset: string
  conditionId: string
  side: string
  size: number
  price: number
  /** **秒**级 Unix 时间戳，不是毫秒 */
  timestamp: number
  outcome: string
  title: string
  transactionHash: string
}

/**
 * 份额是否算「还持有着」的阈值。
 *
 * 不用 `> 0`：实测 size 带一长串小数尾巴，一个卖光了的仓位可能留下 1e-9 这种残渣，
 * 按 `> 0` 判会把它标成「还持有」。这个量级的份额连最小下单量都不到（minOrderSize
 * 实测是 5），当 0 处理是安全的。
 */
const SIZE_EPSILON = 1e-6

export type PositionKind = 'open' | 'settled'

/**
 * 这条仓位是持有中还是已完结。
 *
 * 两条都算已完结：`redeemable`（盘口已结算，等着赎回）和份额已清零（卖光了，
 * 留着的是已实现盈亏）。前者钱还在仓位里，后者已经不在了 —— 但对「这张盘我还有没有
 * 在场上的仓位」这个问题，两者答案相同，所以合成一类。要区分的话看 redeemable。
 */
export function positionKind(p: PolyPosition): PositionKind {
  if (p.redeemable) return 'settled'
  return Math.abs(p.size) > SIZE_EPSILON ? 'open' : 'settled'
}

export type PositionIndex = {
  /** tokenId → 该 token 的仓位。画布按 slot.tokenId 查它 */
  byToken: ReadonlyMap<string, PolyPosition>
  /** 有仓位的赛事 id。比赛列表按 match.eventIds 查它 */
  eventIds: ReadonlySet<string>
}

export const EMPTY_POSITION_INDEX: PositionIndex = {
  byToken: new Map(),
  eventIds: new Set(),
}

/**
 * 把持仓表索引成两张查找表。
 *
 * 同一个 token 出现多条时保留**份额绝对值较大**的那条：正常不该发生，但真发生时
 * 「哪条更能代表这个仓位」的答案是份额大的那条，而不是碰巧排在后面的那条。
 *
 * eventIds 里**已完结的也算**：比赛列表要回答的是「这场比赛我参与过吗」，一场踢完了
 * 的比赛把标记撤掉，等于让人无从确认自己下过单。节点上的角标会区分两者。
 */
export function indexPositions(rows: readonly PolyPosition[]): PositionIndex {
  const byToken = new Map<string, PolyPosition>()
  const eventIds = new Set<string>()
  for (const p of rows) {
    if (!p?.asset) continue
    const prev = byToken.get(p.asset)
    if (!prev || Math.abs(p.size) > Math.abs(prev.size)) byToken.set(p.asset, p)
    if (p.eventId) eventIds.add(String(p.eventId))
  }
  return { byToken, eventIds }
}

/**
 * 这场比赛有没有仓位。
 *
 * 一场比赛由多个子赛事合并而来（见 lib/gamma.ts 的 mergeIntoMatches），所以任一
 * eventIds 命中即算有 —— 持仓可能在「- More Markets」那一族里，而那正是大小球所在。
 */
export function matchHasPosition(
  eventIdsOfMatch: readonly string[],
  withPositions: ReadonlySet<string>,
): boolean {
  if (withPositions.size === 0) return false
  return eventIdsOfMatch.some((id) => withPositions.has(String(id)))
}

// ── 拉取 ────────────────────────────────────────────────

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function toPosition(raw: unknown): PolyPosition | null {
  const o = raw as Record<string, unknown>
  const asset = o?.asset == null ? '' : String(o.asset)
  if (!asset) return null
  return {
    asset,
    conditionId: o.conditionId == null ? '' : String(o.conditionId),
    size: num(o.size),
    avgPrice: num(o.avgPrice),
    curPrice: num(o.curPrice),
    currentValue: num(o.currentValue),
    cashPnl: num(o.cashPnl),
    percentPnl: num(o.percentPnl),
    realizedPnl: num(o.realizedPnl),
    redeemable: Boolean(o.redeemable),
    outcome: o.outcome == null ? '' : String(o.outcome),
    eventId: o.eventId == null ? '' : String(o.eventId),
    title: o.title == null ? '' : String(o.title),
  }
}

function toTrade(raw: unknown): PolyTrade | null {
  const o = raw as Record<string, unknown>
  const asset = o?.asset == null ? '' : String(o.asset)
  if (!asset) return null
  return {
    asset,
    conditionId: o.conditionId == null ? '' : String(o.conditionId),
    side: o.side == null ? '' : String(o.side),
    size: num(o.size),
    price: num(o.price),
    timestamp: num(o.timestamp),
    outcome: o.outcome == null ? '' : String(o.outcome),
    title: o.title == null ? '' : String(o.title),
    transactionHash: o.transactionHash == null ? '' : String(o.transactionHash),
  }
}

async function get(path: string, params: Record<string, string | number>): Promise<unknown[]> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
  const res = await fetch(`${DATA_API_BASE}${path}?${qs}`)
  if (!res.ok) throw new Error(`data-api 返回 HTTP ${res.status}`)
  const data = await res.json()
  // 不是数组就当没有：这个接口正常返回裸数组，返回别的形状说明它变了，
  // 而猜一个新形状比返回空更容易把错误数据画到图上
  return Array.isArray(data) ? data : []
}

/**
 * 拉某个地址的全部持仓。
 *
 * `user` 必须是**代理钱包地址**（gamma public-profile 的 proxyWallet），不是签名地址 ——
 * 持仓和钱都在代理钱包上，传 EOA 会稳定返回空数组。这个错很难看出来：空数组和
 * 「确实没有持仓」长得一模一样（同 lib/proxy-wallet.ts 顶部那个 $0 余额的坑）。
 *
 * 带 `sizeThreshold=0` 才能拿到已清零/已结算的仓位（默认会被筛掉）。
 */
export async function fetchPositions(user: string): Promise<PolyPosition[]> {
  const out: PolyPosition[] = []
  const seen = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await get('/positions', {
      user,
      sizeThreshold: 0,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
    let added = 0
    for (const raw of rows) {
      const p = toPosition(raw)
      if (!p) continue
      // 按 token 去重：万一接口不认 offset，每页会是同一批，这里就是循环的出口
      const key = `${p.asset}:${p.conditionId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(p)
      added++
    }
    if (rows.length < PAGE_SIZE || added === 0) break
  }
  return out
}

/**
 * 某张盘口上的持仓。
 *
 * ⚠️ 按 `market=<conditionId>` 查，**不能**用 tokenId —— `asset=` 参数是静默忽略的
 * （见顶部）。一张盘口两侧都可能有仓位，所以返回的是数组而不是单条。
 */
export async function fetchMarketPositions(
  user: string,
  conditionId: string,
): Promise<PolyPosition[]> {
  const rows = await get('/positions', { user, market: conditionId, sizeThreshold: 0, limit: PAGE_SIZE })
  return rows.map(toPosition).filter((p): p is PolyPosition => p != null)
}

/**
 * 某张盘口上的成交明细，新的在前。
 *
 * ## ⚠️ 必须显式传 `takerOnly=false`
 *
 * 这个接口**默认只返回 taker 那一侧**（成交中主动吃单的一方），被吃掉的那一方
 * （maker）不返回。官方在 SDK 的 `listTrades` 上就是这么写的：
 * 「Only the taker side of each match is returned by default
 * (`takerOnly: false` includes maker rows)」。
 *
 * 对本项目这个默认值是致命的：下单面板主动引导用户挂**远离市场的限价单**
 * （确认面板写着「限价（挂单，可能不成交）」），那种单成交时用户是 **maker** ——
 * 按默认参数查，「已经成交的订单」一条都查不到，而界面上「没有成交」和
 * 「成交了但被过滤掉」长得一模一样。**这就是「下单成功却查不到已成交订单」的成因之一。**
 *
 * ⚠️ 参数名 `takerOnly` 是在 **v2** 数据接口的 schema 上确认的；v1 认不认没实测过。
 * 但不认的话是**静默忽略**（同 `asset=` 那条，见顶部），不会报错、不会返回错数据。
 */
export async function fetchMarketTrades(user: string, conditionId: string): Promise<PolyTrade[]> {
  const rows = await get('/trades', {
    user,
    market: conditionId,
    takerOnly: 'false',
    limit: PAGE_SIZE,
  })
  const out = rows.map(toTrade).filter((t): t is PolyTrade => t != null)
  return out.sort((a, b) => b.timestamp - a.timestamp)
}
