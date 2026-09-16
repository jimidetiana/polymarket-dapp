import { useAccount, useConnect, useDisconnect, useSwitchChain, useBalance, useReadContract } from 'wagmi'
import { polygon } from 'wagmi/chains'
import { formatUnits, erc20Abi } from 'viem'

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
 * 钱包信息块（三块之一）。
 *
 * 这里显示的是**链上真实余额**，不是内部记账。原项目有一套自己的余额账本
 * （wallet 表 + 模拟出入金），dapp 不需要 —— 用户的钱在自己钱包里，
 * 余额就该直接读链。
 *
 * 注意 Polymarket 用的是 USDC.e（bridged），不是原生 USDC。
 * 地址写死在这里而不是配置：读错代币会显示 0 余额，看起来像没充钱。
 */
const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const

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

export function WalletPanel() {
  const { address, isConnected, chainId } = useAccount()
  const onPolygon = chainId === polygon.id
  const enabled = isConnected && onPolygon

  // 原生代币（POL）用 useBalance
  const native = useBalance({ address, query: { enabled } })

  // ERC20 余额：wagmi v3 的 useBalance 去掉了 token 参数，改用 useReadContract。
  // Polymarket 用 USDC.e（bridged），不是原生 USDC —— 读错代币会显示 0，
  // 看起来像没充钱。
  const usdc = useReadContract({
    address: USDC_E_POLYGON,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: enabled && !!address },
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

  return (
    <Panel title="钱包">
      <div className="space-y-2">
        <Row label="地址" value={shortAddr(address)} mono />
        <Row
          label="USDC.e"
          value={usdc.isLoading ? '读取中…' : `$${fmtUnits(usdc.data, 6, 2)}`}
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
        余额直接读链，不是内部记账。下单需要 USDC.e 授权额度，首次会多一次签名。
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

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-neutral-500">{label}</span>
      <span className={mono ? 'font-mono text-neutral-200' : 'text-neutral-200'}>{value}</span>
    </div>
  )
}
