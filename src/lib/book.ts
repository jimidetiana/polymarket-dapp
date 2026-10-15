/**
 * CLOB 盘口状态的纯逻辑。
 *
 * 抽出来是为了能测：WS 消息有三种形态、字段各不相同，且其中两种**不带挂单量**，
 * 处理规则是这套东西里最容易出错的部分（原项目历史数据里 best_bid_size 只有
 * 10.7% 有值，就是这里没处理好的后果）。副作用（连接、重连、心跳）留在 clob-ws.ts。
 *
 * ## 三类消息
 *
 *   1. 初始快照   —— 无 event_type，有 asset_id + bids/asks（订阅时 initial_dump 触发）
 *   2. book       —— event_type='book'，全量重发，带 size
 *   3. best_bid_ask / price_change —— 只带价格，**不带 size**
 *
 * 第 3 类是坑：若直接用 null 覆盖 size，会把 book 刚带来的量冲掉。
 * 所以价位没变时沿用上一次的量，价位一变才作废（见 mergeQuote）。
 */

/** 一档：[价格, 数量] */
export type Level = [number, number]

export type Quote = {
  bid: number | null
  ask: number | null
  bidSize: number | null
  askSize: number | null
  /** 最近一次更新的时间戳（ms）。用来判断报价是否已经过期 */
  at: number
}

export const EMPTY_QUOTE: Quote = {
  bid: null,
  ask: null,
  bidSize: null,
  askSize: null,
  at: 0,
}

/**
 * 把一侧盘口整理成排好序的档位。
 *
 * CLOB 返回的 bids/asks **顺序不保证**，必须显式排序：买方由高到低、
 * 卖方由低到高。少了这一步，"最优价"可能取到中间某一档。
 *
 * size<=0 的档要丢掉：那是已经被吃掉但还没清理的残留，不是可成交量。
 */
export function sortLevels(raw: unknown, side: 'bids' | 'asks', n = 5): Level[] {
  const arr = Array.isArray((raw as Record<string, unknown>)?.[side])
    ? ((raw as Record<string, unknown>)[side] as unknown[])
    : []
  const out: Level[] = []
  for (const lv of arr) {
    const o = lv as { price?: unknown; size?: unknown }
    const p = Number(o?.price)
    const s = Number(o?.size)
    if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue
    out.push([p, s])
  }
  out.sort((a, b) => (side === 'bids' ? b[0] - a[0] : a[0] - b[0]))
  return out.slice(0, n)
}

/** 全量快照（初始 dump 或 book 事件）→ Quote */
export function quoteFromBook(msg: unknown, now = Date.now()): Quote {
  const bids = sortLevels(msg, 'bids', 1)
  const asks = sortLevels(msg, 'asks', 1)
  return {
    bid: bids.length ? bids[0][0] : null,
    ask: asks.length ? asks[0][0] : null,
    bidSize: bids.length ? bids[0][1] : null,
    askSize: asks.length ? asks[0][1] : null,
    at: now,
  }
}

/**
 * 增量消息（best_bid_ask / price_change）→ 合并进已有 Quote。
 *
 * ⚠️ **`price_change` 的条目里 `price` 是「变动的那个档位的价」，不是最优价。**
 * 条目长这样（Polymarket market channel）：
 *
 *   { asset_id, price: "0.30", side: "BUY", size: "100",
 *     best_bid: "0.49", best_ask: "0.51" }
 *
 * 有人在一个**远档**（0.30）加单，`price` 就是 0.30 —— 拿它当买一，图上的价格会
 * 从 0.49 瞬跳到 0.30 再跳回来。这正是「盘口图上的价疯狂波动、点进去那本盘却很稳」
 * 的原因（点进去走的是 REST 全量拉，不经过这里）。
 *
 * 所以**有 best_bid / best_ask 就只信它们，绝不用档位价覆盖**。两者都缺时才退回
 * 档位价（老版消息形态没有 best_* 字段，那种情况档位价是唯一能用的信息）。
 *
 * size 的处理是**价位不变则继承**：价格没动说明还是同一档挂单，上次的量仍是当前
 * 已知的最好估计；价格动了就说明换了一档，旧的量不再适用，置 null 等下一次 book 补。
 */
export function mergeQuote(prev: Quote | undefined, msg: unknown, now = Date.now()): Quote {
  const base = prev ?? EMPTY_QUOTE
  const o = msg as Record<string, unknown>

  let bid = base.bid
  let ask = base.ask

  // 形态 A：best_bid_ask 事件，或 price_change 条目里自带的 best_bid / best_ask。
  // 后者才是权威值 —— 见顶部说明
  const bb = num(o.best_bid ?? o.bestBid)
  const ba = num(o.best_ask ?? o.bestAsk)
  if (bb != null) bid = bb
  if (ba != null) ask = ba

  // 形态 B：只带档位价的形态（best_* 缺失时才是唯一信息）。**不能无条件执行** ——
  // 那会用一个远档的价盖掉 A 拿到的真买一卖一
  if (bb == null && ba == null) {
    const side = String(o.side ?? '').toLowerCase()
    const p = num(o.price)
    if (p != null && (side === 'buy' || side === 'bid')) bid = p
    if (p != null && (side === 'sell' || side === 'ask')) ask = p
  }

  return {
    bid,
    ask,
    // 价位不变才继承量
    bidSize: bid === base.bid ? base.bidSize : null,
    askSize: ask === base.ask ? base.askSize : null,
    at: now,
  }
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 这份报价是否**可成交**。
 *
 * 与原项目 judgeBook 同口径。四条都不是吹毛求疵：
 *  - 缺任一侧：单边盘挂不出去
 *  - ask>=1：结算把赢家推到 1.0，此时"有 ask"是假的可成交
 *  - bid<=0：同理，输家被推到 0
 *  - ask<=bid：交叉/锁盘是脏数据
 *
 * 点差宽窄**不在这里判**：那是策略问题（愿不愿意吃这个价），
 * 而这个函数只回答"这是不是一个真实的双边盘"。
 */
export function isTradable(q: Quote | undefined): boolean {
  if (!q || q.bid == null || q.ask == null) return false
  if (q.ask >= 1 || q.bid <= 0) return false
  return q.ask > q.bid
}

/** 中价。两侧都有才算，否则退回单侧 —— 缺侧不拿另一侧顶替 */
export function midOf(q: Quote | undefined): number | null {
  if (!q) return null
  if (q.bid != null && q.ask != null) return (q.bid + q.ask) / 2
  return q.ask ?? q.bid ?? null
}

/**
 * 把内部 Quote 表转成 applyLivePrices 需要的形状。
 *
 * applyLivePrices 只认 {bid, ask}，且会把 quoted 置 true —— 所以**只传可成交的**。
 * 把单边或交叉盘也传进去，会让画布把脏数据标成"可成交"，比显示快照价更糟：
 * 快照价至少诚实地标着"快照"。
 */
export function toLiveQuotes(
  book: ReadonlyMap<string, Quote>,
): Record<string, { bid: number | null; ask: number | null }> {
  const out: Record<string, { bid: number | null; ask: number | null }> = {}
  for (const [tokenId, q] of book) {
    if (!isTradable(q)) continue
    out[tokenId] = { bid: q.bid, ask: q.ask }
  }
  return out
}
