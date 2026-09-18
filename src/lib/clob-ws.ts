/**
 * CLOB market WebSocket 客户端（浏览器版）。
 *
 * 纯逻辑在 book.ts，这里只管副作用：连接、订阅、心跳、重连。
 *
 * ## 与原项目的差别
 *
 * 原项目用 node 的 `ws` 包并挂代理 agent。浏览器用原生 WebSocket，
 * 既没有 agent 概念也读不到 HTTPS_PROXY —— 用户网络到 polymarket.com
 * 不通时，这里只会看到一次 onerror + onclose，拿不到原因。所以连不上时
 * 要把「可能是网络被拦」这件事说出来，而不是只显示「未连接」。
 *
 * ## 为什么要节流
 *
 * 一场比赛 85 个盘口、170 个 token，盘中每秒可能几十条消息。
 * 每条都触发 React 重渲染会把主线程占满（buildMarketGraph 是纯函数但不便宜：
 * 53 节点 62 边要重算 λ 和全部约束）。所以消息先攒进 Map，按固定间隔
 * 统一 flush 一次 —— 报价延迟最多一个间隔，换来渲染次数可控。
 */
import { mergeQuote, quoteFromBook, type Quote } from './book'

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

/** 心跳间隔。CLOB 要求客户端主动发 PING，否则约 60s 后被踢 */
const PING_MS = 10_000

/**
 * 重连退避。首次 1s，逐次翻倍到 30s 上限。
 *
 * 不用固定间隔：网络整段不通时固定 5s 会无限刷失败连接；
 * 而临时抖动又希望尽快恢复，所以从短开始。
 */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed'

export type BookListener = (book: ReadonlyMap<string, Quote>) => void
export type StateListener = (s: ConnState) => void

export type ClobWsOptions = {
  /** flush 间隔（ms）。默认 400 —— 比人眼能分辨的更新速度略快，又不至于压垮渲染 */
  flushMs?: number
  url?: string
}

/**
 * 订阅一批 token 的实时盘口。
 *
 * 返回一个句柄：`setTokens` 换订阅（切换比赛时用），`close` 彻底停掉。
 * 换订阅要重连 —— CLOB 的 market channel 不支持在已建立的连接上追加订阅，
 * 只能在 open 时一次性把 assets_ids 给全。
 */
export function createClobWs(opts: ClobWsOptions = {}) {
  const flushMs = opts.flushMs ?? 400
  const url = opts.url ?? WS_URL

  let ws: WebSocket | null = null
  let tokens: string[] = []
  let disposed = false
  let attempt = 0
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** 已知报价。key = tokenId */
  const book = new Map<string, Quote>()
  /** 自上次 flush 起有变动 —— 没变动就不通知，避免空转渲染 */
  let dirty = false

  const bookListeners = new Set<BookListener>()
  const stateListeners = new Set<StateListener>()
  let state: ConnState = 'idle'

  function setState(s: ConnState) {
    if (state === s) return
    state = s
    for (const fn of stateListeners) fn(s)
  }

  function clearTimers() {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function flush() {
    if (!dirty) return
    dirty = false
    for (const fn of bookListeners) fn(book)
  }

  /**
   * 消息分派。三类形态见 book.ts 的说明。
   *
   * 判定顺序有讲究：初始快照**没有** event_type，所以必须先认 event_type，
   * 剩下带 asset_id + bids/asks 的才当快照 —— 反过来会把 book 事件也吞进快照分支
   * （结果一样，但逻辑会看不出为什么两个分支都在）。
   */
  function onMessage(raw: string) {
    if (raw === 'PONG') return
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    // CLOB 有时把多条消息打成一个数组发过来
    const list = Array.isArray(msg) ? msg : [msg]
    const now = Date.now()

    for (const m of list) {
      const o = m as Record<string, unknown>
      const type = String(o.event_type ?? '')
      const assetId = typeof o.asset_id === 'string' ? o.asset_id : null

      if (type === 'book' && assetId) {
        book.set(assetId, quoteFromBook(o, now))
        dirty = true
        continue
      }

      if (type === 'best_bid_ask' && assetId) {
        book.set(assetId, mergeQuote(book.get(assetId), o, now))
        dirty = true
        continue
      }

      if (type === 'price_change' && Array.isArray(o.price_changes)) {
        for (const pc of o.price_changes as unknown[]) {
          const c = pc as Record<string, unknown>
          // price_change 的条目自带 asset_id；缺了就退回外层的
          const id = typeof c.asset_id === 'string' ? c.asset_id : assetId
          if (!id) continue
          book.set(id, mergeQuote(book.get(id), c, now))
          dirty = true
        }
        continue
      }

      // 初始快照：没有 event_type，但有 asset_id 和档位
      if (!type && assetId && (o.bids || o.asks)) {
        book.set(assetId, quoteFromBook(o, now))
        dirty = true
      }
    }
  }

  function connect() {
    if (disposed || tokens.length === 0) return
    setState('connecting')

    let sock: WebSocket
    try {
      sock = new WebSocket(url)
    } catch {
      // 构造就抛基本只有 URL 非法，重试也没意义
      setState('closed')
      return
    }
    ws = sock

    sock.onopen = () => {
      if (disposed) {
        sock.close()
        return
      }
      attempt = 0
      setState('open')
      // market channel 只能在 open 时一次性订阅，不支持增量追加
      sock.send(
        JSON.stringify({
          type: 'market',
          assets_ids: tokens,
          initial_dump: true,
          level: 2,
        }),
      )
      pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send('PING')
      }, PING_MS)
      flushTimer = setInterval(flush, flushMs)
    }

    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') onMessage(ev.data)
    }

    // onerror 在浏览器里拿不到原因（安全限制），真正的处理在 onclose
    sock.onerror = () => {}

    sock.onclose = () => {
      clearTimers()
      flush() // 把断线前攒下的最后一批交出去
      ws = null
      if (disposed) {
        setState('closed')
        return
      }
      setState('connecting')
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
      attempt += 1
      reconnectTimer = setTimeout(connect, delay)
    }
  }

  function hardClose() {
    clearTimers()
    const sock = ws
    ws = null
    if (sock) {
      // 先摘掉 onclose，否则关闭会触发重连
      sock.onclose = null
      sock.onmessage = null
      sock.onerror = null
      sock.onopen = null
      try {
        sock.close()
      } catch {
        /* 已经关了 */
      }
    }
  }

  return {
    /**
     * 换订阅。token 集合没变就什么都不做 —— 上层 useEffect 依赖数组难免重跑，
     * 每次都重连会让盘口一直在初始 dump 状态。
     */
    setTokens(next: readonly string[]) {
      const uniq = [...new Set(next.filter(Boolean))].sort()
      if (uniq.length === tokens.length && uniq.every((t, i) => t === tokens[i])) return
      tokens = uniq
      book.clear()
      dirty = true
      hardClose()
      attempt = 0
      if (tokens.length > 0) connect()
      else setState('idle')
    },
    onBook(fn: BookListener) {
      bookListeners.add(fn)
      return () => bookListeners.delete(fn)
    },
    onState(fn: StateListener) {
      stateListeners.add(fn)
      return () => stateListeners.delete(fn)
    },
    get state() {
      return state
    },
    close() {
      disposed = true
      hardClose()
      bookListeners.clear()
      stateListeners.clear()
      setState('closed')
    },
  }
}

export type ClobWs = ReturnType<typeof createClobWs>
