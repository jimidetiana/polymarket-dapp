import { useAccount, useConnect, useDisconnect, useSwitchChain, useBalance, useReadContract } from 'wagmi'
import { polygon } from 'wagmi/chains'
import { formatUnits, erc20Abi } from 'viem'
import { useQuery } from '@tanstack/react-query'
import { lookupProxyWallet, USDC_E_POLYGON } from '../lib/proxy-wallet'

/** 地址缩写。0x1234...abcd */
export function shortAddr(a?: string): string {
  if (!a) return ''
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/**
 * 连接钱包按钮 + 链校验。
 *
 * ## 私钥不经过这里
 *
 * 点「连接」时 dapp 只拿到两样东西：地址（公开）和后续的签名能力。
 * 私钥始终在钱包扩展内部，dapp 的 JS 上下文碰不到 —— 这是钱包的安全边界，
 * 不是我们代码的选择。所以下单时每笔都要用户在钱包里点一次签名。
 *
 * ## 为什么要显式校验链
 *
 * Polymarket CLOB 在 Polygon 上（USDC.e 与条件代币都在那边）。
 * 用户钱包很可能停在以太主网，此时下单会静默失败或白烧 gas，
 * 且报错信息完全看不出是链错了。所以链不对时**不给下单入口**，
 * 只给一个切链按钮。
 */
export function ConnectWallet() {
  const { address, isConnected, chainId } = useAccount()
  const { connectors, connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()

  const wrongChain = isConnected && chainId !== polygon.id

  if (!isConnected) {
    const injected = connectors[0]
    return (
      <button
        type="button"
        onClick={() => injected && connect({ connector: injected })}
        disabled={isPending || !injected}
        className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {isPending ? '连接中…' : !injected ? '未检测到钱包' : '连接钱包'}
      </button>
    )
  }

  if (wrongChain) {
    return (
      <button
        type="button"
        onClick={() => switchChain({ chainId: polygon.id })}
        className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20"
      >
        切到 Polygon 网络
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs text-neutral-300">{shortAddr(address)}</span>
      <button
        type="button"
        onClick={() => disconnect()}
        className="rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800"
      >
        断开
      </button>
    </div>
  )
}

/**
 * 从 bigint 原始值格式化余额。
 *
 * wagmi v3 的 useBalance 不再返回 `formatted`，只给 `value: bigint` ——
 * 这反而更好：bigint 是精确的，自己用 formatUnits 转，不会在中途经过浮点。
 * 与 lib/tick.ts 里「钱的运算不碰浮点」是同一条原则。
 */
function fmtUnits(v: bigint | undefined, decimals: number, dp: number): string {
  if (v == null) return '—'
  const s = formatUnits(v, decimals)
  const n = Number(s)
  return Number.isFinite(n) ? n.toFixed(dp) : s
}

/**
 * 钱包信息块（三块之一）。
 *
 * ## 关键：余额要读**代理钱包**，不是 EOA
 *
 * Polymarket 把用户资金放在一个代理合约里，EOA 只负责签名。
 * 直接读 EOA 的 USDC.e 会显示 $0 —— 即使账户里有钱。实测就踩到了。
 * 详见 lib/proxy-wallet.ts。
 *
 * 所以这里显示两个地址：EOA（签名用）与代理（资金所在）。
 * 让人一眼看出钱在哪，而不是对着一个 0 猜。
 */
export function WalletPanel() {
  const { address, isConnected, chainId } = useAccount()
  const onPolygon = chainId === polygon.id
  const enabled = isConnected && onPolygon

  // 代理地址只能问 Polymarket，不能本地推导（CREATE2 salt 规则不公开）
  const proxy = useQuery({
    queryKey: ['proxy-wallet', address],
    queryFn: () => lookupProxyWallet(address as string),
    enabled: enabled && !!address,
    staleTime: 10 * 60 * 1000, // 代理地址不会变，缓存久一点
  })
  const proxyAddr = proxy.data?.status === 'ok' ? proxy.data.proxyWallet : undefined

  // gas 费从 EOA 出，所以 POL 读 EOA
  const native = useBalance({ address, query: { enabled } })

  // 交易资金在代理地址上，所以 USDC.e 读代理。
  // wagmi v3 的 useBalance 去掉了 token 参数，ERC20 改用 useReadContract。
  const usdc = useReadContract({
    address: USDC_E_POLYGON,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: proxyAddr ? [proxyAddr] : undefined,
    query: { enabled: enabled && !!proxyAddr },
  })

  if (!isConnected) {
    return (
      <Panel title="钱包">
        <p className="text-xs text-neutral-500">未连接。连接后显示链上余额。</p>
      </Panel>
    )
  }

  if (!onPolygon) {
    return (
      <Panel title="钱包">
        <p className="text-xs text-amber-400">当前网络不是 Polygon，余额与下单都不可用。</p>
      </Panel>
    )
  }

  // 没在 Polymarket 开过户 = 没有代理地址 = 无法交易。
  // 必须说清楚，否则用户看到 $0 会以为是余额问题或程序坏了。
  if (proxy.data?.status === 'no-account') {
    return (
      <Panel title="钱包">
        <div className="space-y-2">
          <Row label="签名地址" value={shortAddr(address)} mono />
        </div>
        <p className="mt-2 text-[10px] leading-snug text-amber-400">
          这个地址还没在 Polymarket 开户，因此没有代理钱包，无法下单。
          请先到 polymarket.com 用同一个钱包存一次款，代理地址会自动创建。
        </p>
      </Panel>
    )
  }

  return (
    <Panel title="钱包">
      <div className="space-y-2">
        <Row label="签名地址" value={shortAddr(address)} mono hint="EOA，只负责签名" />
        <Row
          label="资金地址"
          value={
            proxy.isLoading
              ? '查询中…'
              : proxy.data?.status === 'error'
                ? '查询失败'
                : shortAddr(proxyAddr)
          }
          mono
          hint="代理钱包，钱在这里"
        />
        <div className="h-px bg-neutral-800" />
        <Row
          label="USDC.e"
          value={
            proxy.isLoading || usdc.isLoading
              ? '读取中…'
              : proxyAddr
                ? `$${fmtUnits(usdc.data, 6, 2)}`
                : '—'
          }
          mono
        />
        <Row
          label="POL（gas）"
          value={
            native.isLoading
              ? '读取中…'
              : fmtUnits(native.data?.value, native.data?.decimals ?? 18, 4)
          }
          mono
        />
      </div>
      <p className="mt-2 text-[10px] leading-snug text-neutral-500">
        USDC.e 读的是<span className="text-neutral-400">代理钱包</span>——Polymarket
        把资金放在那里，读 EOA 会永远显示 $0。gas 从签名地址出。
      </p>
    </Panel>
  )
}

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      <p className="mb-2 text-xs font-semibold text-neutral-200">{title}</p>
      {children}
    </div>
  )
}

function Row({
  label,
  value,
  mono,
  hint,
}: {
  label: string
  value: string
  mono?: boolean
  hint?: string
}) {
  return (
    <div className="flex items-start justify-between gap-2 text-xs">
      <span className="text-neutral-500" title={hint}>
        {label}
        {hint && <span className="ml-1 text-[9px] text-neutral-600">{hint}</span>}
      </span>
      <span className={mono ? 'font-mono text-neutral-200' : 'text-neutral-200'}>{value}</span>
    </div>
  )
}
