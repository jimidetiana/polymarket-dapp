/**
 * 下单相关的 React 层：账户解析、余额、盘口深度、下单/撤单。
 *
 * 与 lib/clob-client.ts 的分工：那边是纯逻辑（不 import React），这边只管
 * 「什么时候调、状态怎么摆」。跟 lib/book.ts 与 lib/clob-ws.ts 的分法一致。
 */
import { useCallback, useMemo } from 'react'
import { useAccount, useReadContract, useWalletClient } from 'wagmi'
import { erc20Abi, type WalletClient } from 'viem'
import { useQuery } from '@tanstack/react-query'
import { lookupProxyWallet, USDC_E_POLYGON } from './proxy-wallet'
import {
  cancelOrderById,
  fetchBook,
  getSecureClient,
  listOpenOrders,
  placeOrder,
  type OpenOrderRow,
  type PlaceOutcome,
  type PlaceRequest,
} from './clob-client'

/** 代理钱包缓存 10 分钟：它是 CREATE2 部署的合约地址，不会变 */
export function useProxyWallet() {
  const { address, isConnected, chainId } = useAccount()
  const enabled = isConnected && chainId === 137 && !!address
  const q = useQuery({
    // 与 connect-wallet.tsx 的 WalletPanel 用同一个 key，共享缓存
    queryKey: ['proxy-wallet', address],
    queryFn: () => lookupProxyWallet(address as string),
    enabled,
    staleTime: 10 * 60 * 1000,
  })
  // 显式标注返回类型：`0x${string}` 一旦落进对象字面量的属性位置就会被
  // 拓宽成 string，用它当 viem 的 address 参数（要求 `0x${string}`）会报错。
  // 同时把 status 收成三个字面量，免得调用方拿到裸 string 没法穷举判断。
  const proxyAddr: `0x${string}` | undefined =
    q.data?.status === 'ok' ? q.data.proxyWallet : undefined
  return {
    eoa: address,
    proxyAddr,
    status: q.data?.status ?? (q.isLoading ? ('loading' as const) : undefined),
    isLoading: q.isLoading,
    error: q.data?.status === 'error' ? q.data.message : null,
    enabled,
  }
}

/**
 * 可用 USDC.e（读**代理钱包**，读 EOA 会永远显示 $0）。
 *
 * 参数类型写 `` `0x${string}` `` 而不是 string：useReadContract 的 args 要求
 * 它，传 string 会在调用点报错，而那个错看起来像「读余额写错了」。
 */
export function useUsdcBalance(proxyAddr?: `0x${string}`): { value: bigint | undefined; isLoading: boolean } {
  const q = useReadContract({
    address: USDC_E_POLYGON,
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

// ── 下单 ────────────────────────────────────────────────

export type ClobReadiness =
  | { ready: true }
  | { ready: false; reason: string }

/**
 * 下单入口。
 *
 * 已认证客户端是**惰性**建的：createSecureClient 会让用户签一次名来派生
 * L2 凭据，放在挂载时做等于「一打开页面就弹签名」，没人受得了。所以它只在
 * 第一次真正点下单时建，之后缓存在模块级 Map 里。
 */
export function useClob() {
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

  const submit = useCallback(
    async (req: PlaceRequest): Promise<PlaceOutcome> => {
      if (!readiness.ready) throw new Error(readiness.reason)
      const client = await getSecureClient({
        eoa: address as string,
        accountWallet: proxy.proxyAddr as string,
        walletClient: walletClient as WalletClient,
      })
      return placeOrder(client, req)
    },
    [readiness, address, proxy.proxyAddr, walletClient],
  )

  const listMine = useCallback(async (): Promise<OpenOrderRow[]> => {
    if (!readiness.ready) throw new Error(readiness.reason)
    const client = await getSecureClient({
      eoa: address as string,
      accountWallet: proxy.proxyAddr as string,
      walletClient: walletClient as WalletClient,
    })
    return listOpenOrders(client)
  }, [readiness, address, proxy.proxyAddr, walletClient])

  const cancel = useCallback(
    async (orderId: string): Promise<string> => {
      if (!readiness.ready) throw new Error(readiness.reason)
      const client = await getSecureClient({
        eoa: address as string,
        accountWallet: proxy.proxyAddr as string,
        walletClient: walletClient as WalletClient,
      })
      return cancelOrderById(client, orderId)
    },
    [readiness, address, proxy.proxyAddr, walletClient],
  )

  return { readiness, submit, listMine, cancel }
}
