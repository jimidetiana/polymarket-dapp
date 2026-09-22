/**
 * 钱包读数：代理地址 + 各项余额。
 *
 * ## 为什么单独一个文件，而不是并进 use-clob.ts
 *
 * 本模块**不 import @polymarket/client**，而 use-clob.ts 会（它引 clob-client.ts）。
 *
 * 钱包面板在主包里，下单/交易授权弹窗是 lazy 加载的 —— App.tsx 算过这笔账：
 * SDK 约 300 kB gzip，静态 import 会让首屏为「下单」付这个代价。所以面板
 * 一旦**间接**碰到 SDK，整块就被打回首屏了。
 *
 * 由此得出主包组件必须守的规则：**只 import 不碰 SDK 的 hook**。违反它不会
 * 报错、不会有类型问题，只会让首屏包悄悄变胖 —— 正是最难在 review 里看出来的
 * 那种退化。构建后比 chunk 大小是这条约束的兜底（见 README 的验证一节）。
 */
import { useAccount, useBalance, useReadContract } from 'wagmi'
import { polygon } from 'wagmi/chains'
import { erc20Abi } from 'viem'
import { useQuery } from '@tanstack/react-query'
import { lookupProxyWallet, PUSD_POLYGON, USDC_E_POLYGON, USDC_NATIVE_POLYGON } from './proxy-wallet'

/**
 * 代理钱包地址。**只能问 Polymarket**，不能本地推导（CREATE2 salt 规则不公开）。
 *
 * 查询 key 与历史保持一致（`['proxy-wallet', address]`），这样钱包面板与
 * 各个弹窗共享同一份缓存，不会因为落在不同组件里就重复请求。
 */
export function useProxyWallet() {
  const { address, isConnected, chainId } = useAccount()
  const enabled = isConnected && chainId === 137 && !!address
  const q = useQuery({
    queryKey: ['proxy-wallet', address],
    queryFn: () => lookupProxyWallet(address as string),
    enabled,
    staleTime: 10 * 60 * 1000, // 代理地址不会变，缓存久一点
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
 * 读某个 ERC20 在某个地址上的余额。
 *
 * 抽成 hook 而不是把几段 useReadContract 平铺开：它们只差代币和持有人，
 * 而参数配错（把原生 USDC 的地址配给 USDC.e 之类）在界面上看不出来 ——
 * 两边都只是一个金额。少一处复制就少一个这种错。
 *
 * wagmi v3 的 useBalance 去掉了 token 参数，ERC20 只能走 useReadContract。
 */
export function useTokenBalance(
  token: `0x${string}`,
  owner: `0x${string}` | undefined,
  enabled: boolean,
) {
  const q = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: owner ? [owner] : undefined,
    query: { enabled: enabled && !!owner },
  })
  return { value: q.data, isLoading: q.isLoading }
}

/**
 * 面板与交易授权弹窗共用的全套读数。
 *
 * 三组余额读的都是同一个 balanceOf，只差代币与持有人：
 *
 *   - `trading`        代理钱包的 **pUSD** —— **下单真正能动用的钱**
 *   - `eoaUsdcE`       签名地址的 USDC.e —— 还没存款时钱就在这儿
 *   - `eoaNativeUsdc`  签名地址的原生 USDC —— 只用来区分「是哪种美元」
 *
 * ⚠️ `trading` 读 pUSD 而不是 USDC.e，这是**改过一次的**：老代码读 USDC.e
 * （上一代协议的抵押品），结果用户存款到账后面板仍显示 $0.00 —— 钱在，读错币。
 * 见 lib/proxy-wallet.ts 的 PUSD_POLYGON。
 *
 * 三个都读，是因为只读第一个的时候，一个还没存过款的人会看到 $0.00 而以为
 * 程序坏了 —— 他的钱明明就在钱包里。信息给全，人自己就判断得出「我还差一步」。
 *
 * gas（POL）读签名地址：链上交易的手续费只从 EOA 出。
 */
export function useWalletBalances() {
  const { address, isConnected, chainId } = useAccount()
  const onPolygon = chainId === polygon.id
  const enabled = isConnected && onPolygon

  const proxy = useProxyWallet()
  const proxyAddr = proxy.proxyAddr

  const pol = useBalance({ address, query: { enabled } })
  const trading = useTokenBalance(PUSD_POLYGON, proxyAddr, enabled)
  const eoaUsdcE = useTokenBalance(USDC_E_POLYGON, address, enabled)
  const eoaNativeUsdc = useTokenBalance(USDC_NATIVE_POLYGON, address, enabled)

  return { address, isConnected, onPolygon, enabled, proxy, proxyAddr, pol, trading, eoaUsdcE, eoaNativeUsdc }
}
