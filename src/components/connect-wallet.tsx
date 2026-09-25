import { Suspense, lazy, useEffect, useRef, useState } from 'react'
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
 * 顶栏的钱包入口：一个按钮 +（连上之后）一层余额浮窗。
 *
 * ## 状态决定按钮是什么
 *
 *   未连接   → 「连接钱包」（扩展只装了一个就直接连，多个才给列表）
 *   链不对   → 「切到 Polygon 网络」
 *   已连接   → 缩写地址，点开浮窗看余额和断开
 *
 * 余额不再常驻版面：那是一整块信息，而「看一眼余额」是低频动作。
 * 低频的收进浮窗，顶栏的位置留给高频的东西。
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
export function WalletMenu() {
  const { address, isConnected, chainId } = useAccount()
  const { connectors, connect, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  /** 余额浮窗。没连上时没有余额可看，这个值也不会被用到 */
  const [open, setOpen] = useState(false)

  const wrongChain = isConnected && chainId !== polygon.id

  // 连上后自动切到 Polygon —— 省得每次登录都要手动点「切到 Polygon 网络」。
  // 用 ref 保证每次"在错网络上"只自动弹一次：用户若拒了就不再反复弹（下方那个
  // 手动按钮仍在，可兜底）；等他自己切回对的网络、之后又切错时才会再自动弹。
  const autoSwitchedRef = useRef(false)
  useEffect(() => {
    if (!isConnected || chainId == null || chainId === polygon.id) {
      autoSwitchedRef.current = false
      return
    }
    if (autoSwitchedRef.current) return
    autoSwitchedRef.current = true
    switchChain({ chainId: polygon.id })
  }, [isConnected, chainId, switchChain])

  if (!isConnected) {
    return (
      <WalletPicker
        connectors={pickable(connectors)}
        isPending={isPending}
        error={error}
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
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground hover:bg-muted"
      >
        <span className="font-mono tnum">{shortAddr(address)}</span>
        <span className="shrink-0 text-muted-foreground">▾</span>
      </button>

      {open && (
        <>
          {/* 点外面关掉。铺一层透明的固定层压住页面，z 比浮窗低 ——
              与 WalletPicker、MatchPicker 同一个做法 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* 右对齐：这个按钮在顶栏最右边，浮窗左对齐会从屏幕右缘溢出去 */}
          <div className="absolute right-0 z-50 mt-1 w-[min(92vw,20rem)] rounded-lg border border-border bg-popover p-3 shadow-xl">
            <WalletPanel />

            {/* 断开放在浮窗里而不是顶栏上：它是低频且不可轻率的动作，
                摆在顶栏上和地址并排，很容易点错 */}
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                disconnect()
              }}
              className="mt-2 w-full rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              断开连接
            </button>
          </div>
        </>
      )}
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
 *
 * ## 兜底分支是唯一能连错钱包的地方（实测踩到过）
 *
 * 6963 一个都没发现时，我们只剩 `window.ethereum` 这一个把手，而它**可能被多个
 * 扩展抢**（MetaMask + 币安钱包同时装着是常见组合）。此时点「连接」用哪个不由
 * 我们决定，也不是用户能选的。
 *
 * 什么时候会「一个都没发现」：扩展没在广播 6963（老版本），或者 —— 更容易被
 * 忽略的一种 —— **这个浏览器里根本没装那个钱包**。扩展不跨浏览器共享，Chrome 里
 * 装了 MetaMask 不代表 Edge 里也有；此时列表里只剩币安一个按钮，点下去连的就是
 * 币安，而人以为自己在用 MetaMask。同一个扩展组合换浏览器会连到不同钱包，
 * 原因多半在这里，而不是代码。
 *
 * wagmi 那边另有一句值得知道但**不是**本次原因：`createConfig.ts:335` 的
 * `if (storage && !store.persist.hasHydrated()) return` 会丢掉 hydrate 完成前
 * 到达的广播且不重试。但 `createConfig.ts:267` 是 `skipHydration: ssr`，我们没传
 * `ssr`（默认 false），localStorage 同步 hydrate，所以那句 guard 不会触发。
 *
 * ⚠️ 这里**刻意不去读 `window.ethereum`**（曾经为了在兜底时留一行日志读过一次，
 * 已撤回）：有些扩展把 `window.ethereum` 定义成会抛错的 getter，而在 render 里
 * 读它一旦抛出，整个组件树会失效 —— 表现是「页面看着还在，但点什么都没反应」。
 * 一行控制台日志换不来这个风险。连上之后面板顶部的「当前钱包」会显示实际用的
 * 是哪个扩展，那个是事后可查的。
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
 *
 * `error` 是 `useConnect()` 的失败原因，**必须显示出来**：见 ConnectError。
 */
function WalletPicker({
  connectors,
  isPending,
  error,
  onPick,
}: {
  connectors: Connector[]
  isPending: boolean
  error: unknown
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
      <div className="relative">
        <button
          type="button"
          onClick={() => onPick(connectors[0])}
          disabled={isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? '连接中…' : `连接 ${connectors[0].name}`}
        </button>
        <ConnectError error={error} />
      </div>
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

      <ConnectError error={error} />

      {open && (
        <>
          {/* 点外面关掉。放在菜单下层，z 比菜单低 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
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
 * 连接失败的那一行。
 *
 * ## 为什么必须有（实测踩到过）
 *
 * wagmi 把连接失败写进 `useConnect().error`，而这里**原本从来没读过它**。
 * 后果是失败在界面上根本不存在：点「连接钱包」什么都不发生，人会以为是按钮坏了
 * 或者站点挂了，然后反复点 —— 而每一次点都在往扩展里**再塞一个**待处理请求。
 * MetaMask 的 `wallet_requestPermissions` 是串行的，上一笔没处理完时后续调用
 * 全部立刻返回 -32002，于是「点一次没反应」变成「怎么点都没反应」。
 *
 * ## -32002 要单独翻译
 *
 * wagmi 对它是**抛出**的（`connectors/injected.ts:137-139`，
 * `ResourceUnavailableRpcError.code` 就是 -32002，原文注释写着 "Or prompt is
 * already open"）。但原文 "Request of type 'wallet_requestPermissions' already
 * pending for origin ..." 完全看不出该怎么办，而解法很具体：去扩展里把那个
 * 待确认的弹窗处理掉。所以这一条换成一句人话。
 *
 * 放在按钮**下方悬浮**而不是撑开布局：顶栏是 flex 行，插一个块级元素会把
 * 地址/按钮挤歪。
 *
 * z 取 40 而不是 50：钱包列表本身就是 z-50 且同样挂在 top-full，取 50 会和它
 * 叠在一起。取 40 让列表打开时盖住这行 —— 那时错误信息本来也不该抢注意力。
 */
function ConnectError({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p className="absolute right-0 top-full z-40 mt-1 w-64 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] leading-snug text-warning">
      {explainConnectError(error)}
    </p>
  )
}

/**
 * 连接失败翻译成人话。
 *
 * ## 沿 cause 链走
 *
 * 真正的错误在最里层：wagmi 的 `ConnectError` 包着 viem 的 `ProviderRpcError`，
 * 包着 MetaMask 的原始报文。只看最外层 `error.message` 会得到一句泛泛的
 * "Failed to connect."，而 -32002 那层信息全丢 —— 那正是唯一有用的那层。
 *
 * ## ⚠️ 不要用 `instanceof Error` 判断（实测踩到过）
 *
 * 第一版写的是 `if (cur instanceof Error) { push(cur.name, cur.message) }`，
 * 结果界面上显示的是 **`[object Object]`** —— 这个错误对象不是这个 realm 的
 * `Error` 实例，判断为 false，直接落到 `String(cur)` 分支。所以这里改成
 * **鸭子类型**：只认 `name` / `shortMessage` / `message` / `code` 这几个字段
 * 存不存在，不问它是什么类的实例。
 *
 * `code` 要单独取：-32002 只有 `code` 里才有，报文里那句 "already pending"
 * 换个扩展可能就不一样了，两个都留着才稳。
 *
 * 深度限死 6 层：正常就两三层，设上限是防某个扩展造出自引用的 cause。
 */
function explainConnectError(e: unknown): string {
  const texts: string[] = []
  const msgs: string[] = []
  let cur: unknown = e
  for (let i = 0; cur != null && i < 6; i++) {
    if (typeof cur === 'string') {
      texts.push(cur)
      msgs.push(cur)
      break
    }
    if (typeof cur !== 'object') {
      texts.push(String(cur))
      break
    }
    const o = cur as Record<string, unknown>
    for (const k of ['shortMessage', 'message', 'name']) {
      const v = o[k]
      if (typeof v !== 'string' || !v) continue
      texts.push(v)
      // name 只是类名（如 "ConnectError"），不适合给人看，只用来做匹配
      if (k !== 'name') msgs.push(v)
    }
    if (typeof o.code === 'number' || typeof o.code === 'string') {
      texts.push(`code=${o.code}`)
    }
    cur = o.cause
  }

  const text = texts.join(' | ')
  if (/-32002|already pending/i.test(text)) {
    return 'MetaMask 里还有一个没处理完的连接请求（-32002）。打开 MetaMask 把那笔待确认的弹窗确认或取消掉，再点一次。'
  }
  if (/reject|denied|refus/i.test(text)) return '你在钱包里拒绝了这次连接。'
  // 兜底取**最里层**那条报文：外层的 "Failed to connect." 谁看了都没用
  return msgs[msgs.length - 1] ?? texts[texts.length - 1] ?? '连接失败'
}

/**
 * 钱包信息块。**只返回内容，不带外框** —— 外框和标题由左栏的
 * 「钱包」分区（App.tsx 的 SidebarSection）给，这里再套一层卡片
 * 就成了标题说两遍的俄罗斯套娃。
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
      <>
        <p className="text-xs text-muted-foreground">未连接。连接后显示链上余额。</p>
      </>
    )
  }

  if (!onPolygon) {
    return (
      <>
        <p className="text-xs text-warning">当前网络不是 Polygon，余额与下单都不可用。</p>
      </>
    )
  }

  // Safe（资金地址）由 EOA 本地确定性派生，连上钱包就一定有 —— 不再有
  // 「没开户/查询失败」这类分支（那是旧的 gamma 查询时代的事）。

  return (
    <>
      <div className="space-y-2">
        {/* 装在同一个浏览器里的扩展可能不止一个（MetaMask + 币安钱包很常见）。
            地址只显示缩写，光看 0x1234…abcd 分不出是哪个钱包 —— 而「余额不是
            我以为的那个钱包的」正是最难自查的一类问题。名字摆在最前面，
            下面每一行读的都是这个钱包。 */}
        <Row
          label="当前钱包"
          value={bal.connector?.name ?? '—'}
          hint="dapp 实际在用的扩展"
        />
        <Row label="签名地址" value={shortAddr(address)} mono hint="EOA，只负责签名" />
        <Row
          label="资金地址"
          value={proxy.isLoading ? '查询中…' : shortAddr(proxyAddr)}
          mono
          hint="Safe，钱在这里"
        />
        <div className="h-px bg-border" />
        <Row
          label="可交易余额"
          value={
            proxy.isLoading || bal.trading.isLoading
              ? '读取中…'
              : proxyAddr
                ? `$${formatUsd(inProxy)}`
                : '—'
          }
          mono
          hint="Safe 里的 USDC.e，下单用这个"
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
    </>
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
