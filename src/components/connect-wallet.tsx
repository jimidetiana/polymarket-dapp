import { Suspense, lazy, useState } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import type { Connector } from 'wagmi'
import { polygon } from 'wagmi/chains'
import { formatPol, formatUsd } from '../lib/money'
import { useWalletBalances } from '../lib/use-wallet'
import { cn } from '../lib/utils'

/**
 * 交易授权弹窗，**动态** import。
 *
 * 它链到底下会牵进 @polymarket/client（约 300 kB gzip），而本文件在主包里 ——
 * 写成静态 import 会把那一整块打回首屏，App.tsx 把 OrderDialog 做成 lazy
 * 省的正是这笔钱。动态 import 会被打包器切成独立 chunk，主包不受影响。
 *
 * 注意 `.then(m => ({ default: m.ApprovalsDialog }))`：那个模块是**具名导出**，
 * React.lazy 只认 default。
 */
const ApprovalsDialog = lazy(() =>
  import('./approvals-dialog').then((m) => ({ default: m.ApprovalsDialog })),
)

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
 * Polymarket CLOB 在 Polygon 上（抵押代币 pUSD 与条件代币都在那边）。
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
 * 钱包信息块（三块之一）。
 *
 * ## 关键：可交易余额要读**代理钱包**，不是 EOA
 *
 * Polymarket 把用户资金放在一个代理合约里，EOA 只负责签名。
 * 直接读 EOA 的 USDC.e 会显示 $0 —— 即使账户里有钱。实测就踩到了。
 * 详见 lib/proxy-wallet.ts。
 *
 * ## 但只读代理钱包是另一半坑
 *
 * 「读不到钱包里的钱」真正让人困惑的场景是**还没存款**：钱好端端躺在
 * 签名地址上，代理钱包是空的，面板只显示一个 $0.00。数字上没错，但人看到
 * 的是「我的钱不见了」。所以签名地址的余额也要读出来、摆出来 —— 几个余额
 * 放在一起，人自己就判断得出「我还差一步存款」，而不是对着一个 0 猜。
 *
 * ## 存款这个动作**不在站内做**
 *
 * pUSD 由 Polymarket 链上 mint（ERC-4337 UserOp），一笔 ERC-20 转账变不出来；
 * 硬做的结果是把钱卡在代理钱包里 —— 而本项目没有提现入口。所以这里只给一个
 * 去官网的入口。理由见 lib/money.ts 顶部。
 *
 * ## 这个组件必须保持「不碰 SDK」
 *
 * 它在主包里。读数走 lib/use-wallet.ts（不引 @polymarket/client），只有点
 * 「交易授权」时才动态加载弹窗。一旦在这里静态 import 任何牵进 SDK 的模块，
 * 首屏包就会悄悄胖 300 kB —— 不会报错，也不会被类型检查发现。
 */
export function WalletPanel() {
  const bal = useWalletBalances()
  const { address, isConnected, onPolygon } = bal
  const { proxy, proxyAddr } = bal

  /** 交易授权弹窗。只在真正点开时才加载那块 chunk */
  const [approvalsOpen, setApprovalsOpen] = useState(false)

  const inProxy = bal.trading.value
  const inEoa = bal.eoaUsdcE.value
  const inNative = bal.eoaNativeUsdc.value

  // 判据写成 === 0n 而不是 falsy：加载中时 value 是 undefined，
  // 用 !inProxy 会在数据回来之前先闪一下「你还没存款」。
  const notDeposited = inProxy === 0n && inEoa != null && inEoa > 0n
  // 有原生 USDC 但 USDC.e 是 0。**这不是错误状态** —— 官方存款流程两种都收，
  // 所以提示的口气是「这不影响你存款」，不是「你搞错了」。
  const wrongToken = inEoa === 0n && inNative != null && inNative > 0n

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

  /**
   * 没在 Polymarket 开过户 = 没有代理地址 = 无法交易。
   *
   * 这里**也要把签名地址的余额读出来**：没开过户的人几乎必然还没存款，
   * 而他的钱就在签名地址上。只说「无法下单」而不给他看自己的钱，
   * 等于把他最关心的问题略过了。
   *
   * 开户只能在 polymarket.com 完成 —— 地址由工厂合约按不公开的 salt 规则推导，
   * 本地算不出来。
   */
  if (proxy.status === 'no-account') {
    return (
      <Panel title="钱包">
        <div className="space-y-2">
          <Row label="签名地址" value={shortAddr(address)} mono />
          {inEoa != null && inEoa > 0n && (
            <Row label="签名地址 USDC.e" value={`$${formatUsd(inEoa)}`} mono />
          )}
        </div>
        <p className="mt-2 text-[10px] leading-snug text-warning">
          这个地址还没在 Polymarket 开户，因此没有代理钱包，也无法下单。
          到 <PolymarketLink>polymarket.com</PolymarketLink> 用同一个钱包存一次款，
          代理钱包和交易账户会一并建好。
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
              : proxy.status === 'error'
                ? '查询失败'
                : shortAddr(proxyAddr)
          }
          mono
          hint="代理钱包，钱在这里"
        />
        <div className="h-px bg-border" />
        <Row
          label="可交易 pUSD"
          value={
            proxy.isLoading || bal.trading.isLoading
              ? '读取中…'
              : proxyAddr
                ? `$${formatUsd(inProxy)}`
                : '—'
          }
          mono
          hint="代理钱包里的，下单用这个"
        />
        {/* 签名地址有余额才显示：没存款时这一行就是那个「我的钱去哪了」的答案 */}
        {inEoa != null && inEoa > 0n && (
          <Row
            label="签名地址 USDC.e"
            value={`$${formatUsd(inEoa)}`}
            mono
            hint="还没存款"
          />
        )}
        {inNative != null && inNative > 0n && (
          <Row
            label="签名地址 USDC"
            value={`$${formatUsd(inNative)}`}
            mono
            hint="官方存款流程能收"
          />
        )}
        <div className="h-px bg-border" />
        <Row
          label="POL（gas）"
          value={bal.pol.isLoading ? '读取中…' : formatPol(bal.pol.data?.value)}
          mono
        />
      </div>

      {/*
        入金入口：去官网，不自己做。
        pUSD 是 Polymarket 那边链上 mint 出来的（ERC-4337 UserOp），
        一笔 ERC-20 转账变不出 mint —— 见 lib/money.ts 顶部。而官方流程免 gas，
        实测 POL 为 0 也能存进去，比自己做既正确又省事。
      */}
      <PolymarketLink variant="button" className="mt-2.5">
        去 Polymarket 存款
      </PolymarketLink>

      {/* 交易授权那只一半留着：它走 SDK 的 relayer，是正确且唯一可行的做法。
          按钮本身不碰 SDK，点开才 lazy 加载那个弹窗。 */}
      <button
        type="button"
        onClick={() => setApprovalsOpen(true)}
        disabled={!proxyAddr}
        className="mt-1.5 w-full rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        交易授权
      </button>

      {/* 还没存款。**这条是面板上最重要的一句话** —— 它解释的正是「钱读不出来」
          这个看起来像 bug 的现象，而它其实只是还差一步存款。 */}
      {notDeposited && (
        <p className="mt-2 rounded border border-warning/30 bg-warning/10 p-2 text-[10px] leading-snug text-warning">
          钱在<span className="font-semibold">签名地址</span>上（$
          {formatUsd(inEoa)}），还没进 Polymarket
          的代理钱包，所以「可交易 pUSD」是 $0.00 —— 不是读错了，是还差一步存款。
          这一步得在官网做（
          <PolymarketLink>polymarket.com</PolymarketLink>
          ），存款会铸出交易用的 pUSD；本项目做不了这件事，也不该假装能做。
        </p>
      )}

      {/* 原生 USDC 与 USDC.e 的区分保留：官方的存款流程两种都收，
          但站内不要再暗示「自己转一笔就行」—— 那条路已经拆了。 */}
      {wrongToken && (
        <p className="mt-2 rounded border border-warning/30 bg-warning/10 p-2 text-[10px] leading-snug text-warning">
          签名地址上是 ${formatUsd(inNative)} <span className="font-semibold">原生 USDC</span>，
          不是 USDC.e。这不影响存款 —— 官方的存款流程两种都收，也会把该换的换掉。
          直接走上面的入口就行。
        </p>
      )}

      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        「可交易 pUSD」读的是<span className="text-foreground">代理钱包</span>——
        Polymarket 把交易资金放在那里，读签名地址会永远显示 $0。
        pUSD 是 Polymarket 的抵押代币，由官方存款流程铸造。gas 从签名地址出。
      </p>

      {approvalsOpen && (
        <Suspense fallback={null}>
          <ApprovalsDialog onClose={() => setApprovalsOpen(false)} />
        </Suspense>
      )}
    </Panel>
  )
}

/**
 * 去 Polymarket 官网的链接。三处会把人支使过去（没开户、还没存款、代币不对），
 * 措辞各不相同但去处是同一个 —— 写三遍的话，改 URL 时漏一处不会有任何提示。
 *
 * ## 为什么是根地址，不是 /deposit 之类的深链
 *
 * 猜一个看起来合理的深链，猜错了就是 404 —— 那比让人多点一次导航还糟，
 * 而且坏掉的时候没人会发现（只有真去点才会暴露）。根地址永远能用。
 *
 * ## 为什么要 variant，而不是让调用点传 className 覆盖
 *
 * `lib/utils.ts` 的 `cn` 只是把字符串拼起来，**不做同类冲突仲裁**（没装
 * tailwind-merge）。传 className 去覆盖 `underline` 这类类名，结果会是两个
 * 类同时留在元素上，谁赢取决于 Tailwind 产出样式的顺序 —— 那种胜负读代码
 * 看不出来，改一次 Tailwind 版本就可能翻过来。所以两套样式各自写全，各用各的。
 */
const LINK_VARIANTS = {
  /** 夹在正文里的一句话链接 */
  inline: 'font-medium text-primary underline underline-offset-2 hover:opacity-80',
  /** 整行的按钮。样式写全，不从 inline 那套继承任何东西 */
  button:
    'flex w-full items-center justify-center rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/20',
} as const

function PolymarketLink({
  children,
  variant = 'inline',
  className,
}: {
  children: React.ReactNode
  variant?: keyof typeof LINK_VARIANTS
  /** 只用来补外边距这类不与变体冲突的类 */
  className?: string
}) {
  return (
    <a
      href="https://polymarket.com"
      target="_blank"
      rel="noreferrer"
      className={cn(LINK_VARIANTS[variant], className)}
    >
      {children}
    </a>
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
