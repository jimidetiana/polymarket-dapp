/**
 * 持仓的 React 层。
 *
 * ## ⚠️ 本模块**不 import @polymarket/client**，这是硬约束
 *
 * 画布（market-graph-canvas）和比赛列表（match-picker）都在**主包**里，而 SDK 约
 * 300 kB gzip。一旦这条路上间接碰到 SDK，整块就被打回首屏了 —— 违反它不报错、
 * 不影响类型，只让首屏包悄悄变胖。同 lib/use-wallet.ts 顶部那条约束，理由也一样。
 *
 * 所以持仓走 lib/positions.ts 那套公开 REST（免鉴权），**不走 SecureClient**。
 * 顺带的好处：不弹签名，也不依赖那个要单独启动的本地签名服务。
 */
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useProxyWallet } from './use-wallet'
import {
  EMPTY_POSITION_INDEX,
  fetchMarketPositions,
  fetchMarketTrades,
  fetchPositions,
  indexPositions,
  type PolyPosition,
  type PolyTrade,
  type PositionIndex,
} from './positions'

/**
 * 当前账户的持仓索引。
 *
 * 地址用**代理钱包**（gamma public-profile 的 proxyWallet），与余额读数同一个地址 ——
 * 持仓和钱都在那上面，传签名地址会稳定返回空数组，而空数组和「确实没有持仓」在界面上
 * 长得一模一样（见 lib/proxy-wallet.ts 顶部那个 $0 余额的坑）。
 *
 * **拿不到就给空索引**，不返回 error、不设「读取中」态：这是个标记，不是关卡。没连钱包、
 * 网络不通、接口变形，表现都一样 —— 没有标记。为一个标记在图上加一层错误提示，
 * 是拿大代价换小问题。
 *
 * staleTime 60 秒：持仓只在下单/成交后变，而那两件事的量级是分钟。
 */
export function usePositions(): { index: PositionIndex; loading: boolean } {
  const { proxyAddr } = useProxyWallet()

  const q = useQuery({
    queryKey: ['positions', proxyAddr],
    queryFn: () => fetchPositions(proxyAddr as string),
    enabled: !!proxyAddr,
    staleTime: 60_000,
    retry: 1,
  })

  const index = useMemo(
    () => (q.data ? indexPositions(q.data) : EMPTY_POSITION_INDEX),
    [q.data],
  )

  return { index, loading: q.isLoading }
}

/**
 * 某一张盘口上的**持仓**与**成交明细**，给下单弹窗的「我的订单」用。
 *
 * ## 为什么按 conditionId 而不是 tokenId
 *
 * `asset=<tokenId>` 这个参数**被服务端静默忽略** —— 传了照样返回全量（见
 * lib/positions.ts 顶部的实测表）。它不报错、不返回空，而是返回**别人家盘口的
 * 数据**，看起来完全像生效了。所以只能用 conditionId。
 *
 * 一张盘口两侧（Yes/No、Over/Under）各有自己的 token，而 conditionId 是两侧共用的 ——
 * 所以这里拿回的是**整张盘口两侧**的仓位，正是弹窗该显示的：买了 Over 的人要看得见
 * 自己在这张盘上的全部仓位，而不是只有当前切着的那一侧。
 *
 * 免鉴权、不弹签名，所以可以随弹窗自动加载。**挂单（未成交委托）不在这里** ——
 * 公开接口没有那份数据，只有 CLOB 的鉴权接口有，见 order-dialog 里那一段。
 */
export function useMarketOrders(
  conditionId: string | null,
  enabled: boolean,
): {
  positions: PolyPosition[]
  trades: PolyTrade[]
  loading: boolean
  /** 拿不到时的文案。这两段是弹窗的主要内容，失败要说一声，不像标记那样静默 */
  error: string | null
  refresh: () => void
} {
  const { proxyAddr } = useProxyWallet()
  const on = enabled && !!proxyAddr && !!conditionId

  const q = useQuery({
    queryKey: ['market-orders', proxyAddr, conditionId],
    queryFn: async () => {
      const user = proxyAddr as string
      const cid = conditionId as string
      // 两趟并行：互不依赖，串起来只是把弹窗的等待时间加倍
      const [positions, trades] = await Promise.all([
        fetchMarketPositions(user, cid),
        fetchMarketTrades(user, cid),
      ])
      return { positions, trades }
    },
    enabled: on,
    staleTime: 30_000,
    retry: 1,
  })

  /**
   * 两段都空时，把**查询用的地址**打出来。
   *
   * 「成交了却查不到」有两种成因，在界面上长得一模一样：确实没有成交，或者
   * **查错了地址** —— 这里的地址来自 gamma 的 `public-profile`，而订单的 maker 是
   * SDK 自己解析出来的账户钱包（V2 是 Deposit Wallet，见 lib/clob-client.ts）。
   * 这两个地址在历史账户上**不是同一个**，那就一条记录都查不到。
   *
   * 这一行让两种成因可以当场分开：对一眼 clob-client 那行
   * `[clob] 账户身份：{ wallet }`，不一样就是查错了地址。
   */
  useEffect(() => {
    if (!q.data || q.data.positions.length || q.data.trades.length) return
    console.info(`[positions] 本盘口在 ${proxyAddr} 上没有持仓也没有成交。` +
      `若刚成交过，请与 [clob] 账户身份里的 wallet 比对 —— 不一致即查错了地址。`)
  }, [q.data, proxyAddr])

  return {
    positions: q.data?.positions ?? EMPTY_POSITIONS,
    trades: q.data?.trades ?? EMPTY_TRADES,
    loading: on && q.isLoading,
    error: q.error instanceof Error ? q.error.message : null,
    refresh: () => void q.refetch(),
  }
}

// 模块级常量：每次渲染新建 [] 会让依赖它的 useMemo / memo 组件每轮都判为「变了」
const EMPTY_POSITIONS: PolyPosition[] = []
const EMPTY_TRADES: PolyTrade[] = []
