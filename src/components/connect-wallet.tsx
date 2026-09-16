import { useState } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain, useBalance, useReadContract } from 'wagmi'
import type { Connector } from 'wagmi'
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
    return (
      <WalletPicker
        connectors={pickable(connectors)}
        isPending={isPending}
        onPick={(c) => connect({ connector: c })}
      />
    )
  }

  if (wrongChain) {
    return (
      <button
        type="button"
        onClick={() => switchChain({ chainId: polygon.id })}
        className="rounded-md border border-warning/50 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning hover:bg-warning/20"
      >
        切到 Polygon 网络
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs tnum text-foreground">{shortAddr(address)}</span>
      <button
        type="button"
        onClick={() => disconnect()}
        className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        断开
      </button>
    </div>
  )
}

/**
 * 去掉重复的连接器。
 *
 * wagmi v3 默认开着 EIP-6963 发现（依赖 mipd），所以 connectors 里同时有：
 *   1. 各扩展按 6963 广播的自己（带 icon 与 rdns，名字准确）
 *   2. 我们在 wagmi.ts 里配的那个通用 injected()
 * 装了币安钱包时，它会以 "Binance Wallet" 出现在第 1 类里 —— 也就是说
 * **不需要专门的币安连接器**，能连不上只是因为之前 UI 写死了 connectors[0]。
 *
 * 通用 injected 会和第 1 类里的某一个指向同一个 window.ethereum，
 * 列出来就成了两个按钮点下去是同一个钱包。所以：有具体扩展时就丢掉通用的，
 * 一个都没发现时才留着它当兜底（老扩展不广播 6963，只能靠通用注入）。
 */
function pickable(connectors: readonly Connector[]): Connector[] {
  const discovered = connectors.filter((c) => c.id !== 'injected')
  return discovered.length > 0 ? [...discovered] : [...connectors]
}

/**
 * 钱包选择器。
 *
 * 一个钱包时不弹菜单 —— 多一次点击换不来任何信息。两个以上才给列表，
 * 这也是装了多个扩展时唯一能选中想要的那个的办法。
 */
function WalletPicker({
  connectors,
  isPending,
  onPick,
}: {
  connectors: Connector[]
  isPending: boolean
  onPick: (c: Connector) => void
}) {
  const [open, setOpen] = useState(false)

  if (connectors.length === 0) {
    return (
      <a
        href="https://www.binance.com/en/web3wallet"
        target="_blank"
        rel="noreferrer"
        className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        未检测到钱包
      </a>
    )
  }

  if (connectors.length === 1) {
    return (
      <button
        type="button"
        onClick={() => onPick(connectors[0])}
        disabled={isPending}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? '连接中…' : `连接 ${connectors[0].name}`}
      </button>
    )
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? '连接中…' : '连接钱包'}
      </button>

      {open && (
        <>
          {/* 点外面关掉。放在菜单下层，z 比菜单低 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-popover shadow-2">
            {connectors.map((c) => (
              <button
                key={c.uid}
                type="button"
                onClick={() => {
                  setOpen(false)
                  onPick(c)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground hover:bg-muted"
              >
                {c.icon ? (
                  <img src={c.icon} alt="" className="size-4 shrink-0 rounded" />
                ) : (
                  <span className="size-4 shrink-0 rounded bg-muted" />
                )}
                <span className="truncate">{c.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
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
        <p className="text-xs text-muted-foreground">未连接。连接后显示链上余额。</p>
      </Panel>
    )
  }

  if (!onPolygon) {
    return (
      <Panel title="钱包">
        <p className="text-xs text-warning">当前网络不是 Polygon，余额与下单都不可用。</p>
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
        <p className="mt-2 text-[10px] leading-snug text-warning">
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
        <div className="h-px bg-border" />
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
      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        USDC.e 读的是<span className="text-foreground">代理钱包</span>——Polymarket
        把资金放在那里，读 EOA 会永远显示 $0。gas 从签名地址出。
      </p>
    </Panel>
  )
}

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="mb-2 text-xs font-semibold text-foreground">{title}</p>
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
      <span className="text-muted-foreground" title={hint}>
        {label}
        {hint && <span className="ml-1 text-[9px] text-muted-foreground/70">{hint}</span>}
      </span>
      <span className={mono ? 'font-mono tnum text-foreground' : 'text-foreground'}>{value}</span>
    </div>
  )
}
