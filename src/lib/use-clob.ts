/**
 * 下单相关的 React 层：账户解析、余额、盘口深度、下单/撤单、交易授权。
 *
 * 与 lib/clob-client.ts 的分工：那边是纯逻辑（不 import React），这边只管
 * 「什么时候调、状态怎么摆」。跟 lib/book.ts 与 lib/clob-ws.ts 的分法一致。
 *
 * ⚠️ 本模块（经 clob-client.ts）**会**把 @polymarket/client 拉进依赖图，
 * 约 300 kB gzip。所以它只能被 lazy 加载的弹窗引用 —— App.tsx 把 OrderDialog
 * 做成 lazy 就是为了这个。主包里的组件（如钱包面板）请用 lib/use-wallet.ts，
 * 那边不碰 SDK。
 *
 * 站内充值**已经停掉了**（pUSD 是链上 mint 出来的，一笔 ERC-20 转账变不出来），
 * 所以这里没有 useDeposit。理由见 lib/money.ts。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount, useReadContract, useWalletClient } from 'wagmi'
import { erc20Abi, type WalletClient } from 'viem'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PUSD_POLYGON } from './proxy-wallet'
import { useProxyWallet } from './use-wallet'
import { BUILDER_FEE_RATES, maxBpsOf } from './fee'
import {
  cancelOrderById,
  explainError,
  fetchApprovalState,
  fetchBook,
  fetchFeeRates,
  getSecureClient,
  listOpenOrders,
  placeOrder,
  setupApprovals,
  type ApprovalState,
  type OpenOrderRow,
  type PlaceOutcome,
  type PlaceRequest,
} from './clob-client'

// 代理地址的读法搬去了 lib/use-wallet.ts（那边不引 SDK，主包能用）。
// 这里转出去是为了不动既有调用点，新代码请直接从 lib/use-wallet 引。
export { useProxyWallet }

/**
 * 可用**抵押余额**（pUSD，读**代理钱包** —— 读 EOA 会永远显示 $0）。
 *
 * 名字从 `useUsdcBalance` 改过来，因为它读的不是 USDC：Polymarket V2 的抵押
 * 代币是 pUSD。老名字配老代币，两样一起错，而且错得看不出来 —— 余额恒为 0
 * 跟「还没入金」长得一模一样。见 lib/proxy-wallet.ts。
 *
 * 参数类型写 `` `0x${string}` `` 而不是 string：useReadContract 的 args 要求
 * 它，传 string 会在调用点报错，而那个错看起来像「读余额写错了」。
 */
export function useCollateralBalance(proxyAddr?: `0x${string}`): { value: bigint | undefined; isLoading: boolean } {
  const q = useReadContract({
    address: PUSD_POLYGON,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: proxyAddr ? [proxyAddr] : undefined,
    query: { enabled: !!proxyAddr },
  })
  return { value: q.data, isLoading: q.isLoading }
}

// ── 盘口深度 ────────────────────────────────────────────

export type BookLevelView = { price: number; size: number }

export type BookView = {
  /** 买盘由高到低 */
  bids: BookLevelView[]
  /** 卖盘由低到高 */
  asks: BookLevelView[]
  bestBid: number | null
  bestAsk: number | null
  /** CLOB 对该盘口给出的 tick。比 Gamma 的 orderPriceMinTickSize 更权威 */
  tickSize: string | null
  /** 最小下单份额。表单的下限用它，而不是写死 5 */
  minOrderSize: number | null
}

/**
 * 拉盘口深度。
 *
 * 用 SDK 的公共接口（**不需要鉴权**）而不是扩展 WS：深度用 WS 要自己
 * 维护增量 diff，错一次就静默失真；而这里要回答的只是「此刻大概什么价
 * 能成交」，轮询既够用又不会错。
 *
 * CLOB 的 levels 顺序是**反的**：bids 从低到高（最优买价在最后），
 * asks 从高到低（最优卖价在最后）。不重排就会把最差价当成最优价显示。
 */
export function useOrderBook(assetId: string | null, enabled: boolean) {
  const q = useQuery({
    queryKey: ['clob-book', assetId],
    queryFn: () => fetchBook(assetId as string),
    enabled: enabled && !!assetId,
    refetchInterval: 5000,
    retry: 1,
  })

  const view = useMemo<BookView | null>(() => {
    const b = q.data
    if (!b) return null
    const conv = (raw: unknown, dir: 'bid' | 'ask'): BookLevelView[] => {
      const arr = Array.isArray(raw) ? raw : []
      const out: BookLevelView[] = []
      for (const lv of arr) {
        const o = lv as { price?: unknown; size?: unknown }
        const price = Number(o?.price)
        const size = Number(o?.size)
        if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue
        out.push({ price, size })
      }
      out.sort((a, c) => (dir === 'bid' ? c.price - a.price : a.price - c.price))
      return out
    }
    const bids = conv(b.bids, 'bid')
    const asks = conv(b.asks, 'ask')
    return {
      bids,
      asks,
      bestBid: bids.length ? bids[0].price : null,
      bestAsk: asks.length ? asks[0].price : null,
      tickSize: b.tickSize == null ? null : String(b.tickSize),
      minOrderSize: b.minOrderSize == null ? null : Number(b.minOrderSize),
    }
  }, [q.data])

  return {
    book: view,
    loading: q.isLoading,
    error: q.error instanceof Error ? q.error.message : null,
    refresh: () => void q.refetch(),
  }
}

// ── 费率 ────────────────────────────────────────────────

/**
 * 展示用的手续费率。
 *
 * ## 为什么是一个**不依赖钱包**的查询
 *
 * 费率按 builder code 配，**与谁下单无关** —— `fetchFeeRates` 的请求参数里没有
 * user/wallet。所以：
 *
 *  - queryKey **不含地址**。含了就会在换钱包、断连、重连时各白查一遍，而答案
 *    永远是同一个。
 *  - 一个构建只有一个答案，所以**不是每单查一次**。`staleTime` 给 30 分钟：
 *    后台改费率不需要秒级生效，但也不该让一个开着不关的页面挂着几小时前的数。
 *  - 走的是公共客户端，**不弹签名**。用户该在决定连不连钱包之前就看到要收多少。
 *
 * ## 拿不到就退回常量,不挡下单
 *
 * 费率只影响**显示**,不影响能不能下单、也不影响实际扣多少(那个由交易所按 code
 * 查它自己库里的配置决定)。所以查询失败时退回 `BUILDER_FEE_RATES`,界面照常可用 ——
 * 拦住用户下单来回避一个显示问题,是拿大代价换小问题。**不做「读取中」态,也不
 * 因为查不到而禁用按钮**:这是个提示,不是一道关卡。
 *
 * 但**不一致要留个响**:常量与 API 的值不同,说明设置页改过而代码没跟上。平时
 * 界面用 API 的值是对的,可一旦 API 失败就会退回那个过期的常量并报出错的数,而
 * 界面上看不出任何异常。控制台这一行是那种情况唯一的信号。
 */
export function useBuilderFeeRates(): { feeBps: number } {
  const q = useQuery({
    queryKey: ['builder-fee-rates'],
    queryFn: fetchFeeRates,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  })

  useEffect(() => {
    if (!q.data) return
    const stale =
      q.data.makerBps !== BUILDER_FEE_RATES.makerBps || q.data.takerBps !== BUILDER_FEE_RATES.takerBps
    if (!stale) return
    console.warn(
      `[fee] 设置页的费率与 lib/fee.ts 的 BUILDER_FEE_RATES 不一致:` +
        `API = maker ${q.data.makerBps} / taker ${q.data.takerBps} bps,` +
        `常量 = maker ${BUILDER_FEE_RATES.makerBps} / taker ${BUILDER_FEE_RATES.takerBps} bps。` +
        `界面现在用 API 的值(对),但 API 一旦失败会退回那个过期的常量。请把常量改成一样的。`,
    )
  }, [q.data])

  // 只给 feeBps:调用方要的就是「报给用户的那个费率」,已经取过 max(maker, taker)。
  // 把原始的两个值也递出去只会让每个调用点各自再 max 一次 —— 那个方向错一次
  // 就会在界面少报手续费。
  return { feeBps: maxBpsOf(q.data ?? BUILDER_FEE_RATES) }
}

// ── 下单 ────────────────────────────────────────────────

export type ClobReadiness =
  | { ready: true }
  | { ready: false; reason: string }

/**
 * 建（或取缓存的）已认证客户端。
 *
 * 抽出来是因为下单、读挂单、撤单、补交易授权**四个入口**都要这一段：
 * 先按同一组条件判断能不能用，再去拿客户端。原来这三段几乎逐字重复，
 * 而漏掉某处的一个检查不会报错 —— 只会在那一条路径上静默地拿着一个
 * 不完整的账户去发请求。判定只有一处，才不会漏。
 *
 * 已认证客户端是**惰性**建的：createSecureClient 会让用户签一次名来派生
 * L2 凭据，放在挂载时做等于「一打开页面就弹签名」。所以它只在真正需要
 * 发请求的那一刻调，之后缓存在 getSecureClient 的模块级 Map 里。
 */
function useSecureClient() {
  const { address, isConnected, chainId } = useAccount()
  const proxy = useProxyWallet()
  const { data: walletClient } = useWalletClient()

  const readiness = useMemo<ClobReadiness>(() => {
    if (!isConnected || !address) return { ready: false, reason: '未连接钱包' }
    if (chainId !== 137) return { ready: false, reason: '钱包不在 Polygon 网络' }
    if (proxy.isLoading) return { ready: false, reason: '正在解析代理钱包…' }
    if (proxy.status === 'no-account') {
      return {
        ready: false,
        reason: '这个地址还没在 Polymarket 开户，没有代理钱包。先去 polymarket.com 用同一个钱包存一次款。',
      }
    }
    if (proxy.error) return { ready: false, reason: `代理钱包查询失败：${proxy.error}` }
    if (!proxy.proxyAddr) return { ready: false, reason: '代理钱包地址还没拿到' }
    if (!walletClient) return { ready: false, reason: '钱包客户端还没就绪，稍等一秒再试' }
    return { ready: true }
  }, [isConnected, address, chainId, proxy, walletClient])

  const get = useCallback(async () => {
    if (!readiness.ready) throw new Error(readiness.reason)
    return getSecureClient({
      eoa: address as string,
      accountWallet: proxy.proxyAddr as string,
      walletClient: walletClient as WalletClient,
    })
  }, [readiness, address, proxy.proxyAddr, walletClient])

  return { readiness, get }
}

/**
 * 下单入口。
 */
export function useClob() {
  const { readiness, get } = useSecureClient()

  const submit = useCallback(
    async (req: PlaceRequest): Promise<PlaceOutcome> => placeOrder(await get(), req),
    [get],
  )

  const listMine = useCallback(async (): Promise<OpenOrderRow[]> => listOpenOrders(await get()), [get])

  const cancel = useCallback(
    async (orderId: string): Promise<string> => cancelOrderById(await get(), orderId),
    [get],
  )

  return { readiness, submit, listMine, cancel }
}

// ── 交易授权 ────────────────────────────────────────────

/**
 * 查「交易授权还缺什么」。**只读，不弹签名。**
 *
 * 走的是 SDK 的公共客户端，所以打开充值面板就能显示状态，不会因为建
 * SecureClient 而先让用户签一次名。
 */
export function useApprovalState(proxyAddr: `0x${string}` | undefined, enabled: boolean) {
  const q = useQuery({
    queryKey: ['approvals', proxyAddr],
    queryFn: () => fetchApprovalState(proxyAddr as string),
    enabled: enabled && !!proxyAddr,
    staleTime: 60_000,
  })
  const state: ApprovalState | undefined = q.data
  return {
    state,
    isLoading: q.isLoading,
    error: q.error instanceof Error ? q.error.message : null,
    refresh: () => void q.refetch(),
  }
}

export type SetupApprovalsPhase = 'idle' | 'running'

/**
 * 补交易授权。免 gas，但会弹一次签名（派生 L2 凭据，不上链）。
 *
 * 账户钱包的部署由 `createSecureClient` 内部负责，这里不用管 —— 见
 * `setupApprovals` 的注释。
 */
export function useSetupApprovals() {
  const { readiness, get } = useSecureClient()
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<SetupApprovalsPhase>('idle')
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (): Promise<void> => {
    setPhase('running')
    setError(null)
    try {
      await setupApprovals(await get())
      // 授权状态变了，把面板上的那份也刷掉，否则会一直显示「缺 N 项」
      await queryClient.invalidateQueries({ queryKey: ['approvals'] })
    } catch (e) {
      setError(explainError(e))
    } finally {
      setPhase('idle')
    }
  }, [get, queryClient])

  return { readiness, phase, error, run }
}
