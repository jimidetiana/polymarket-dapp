import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import type { Connector } from 'wagmi'
import { polygon } from 'wagmi/chains'
import { formatPol, formatUsd } from '../lib/money'
import { tr } from '../lib/i18n'
import { useWalletBalances } from '../lib/use-wallet'
import { explainConnectError, pickable } from '../lib/wallet-connect'
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
 * 顶栏的钱包入口：一个按钮 +（连上之后）一层详情浮窗。
 *
 * ## 状态决定按钮是什么
 *
 *   未连接   → 「连接钱包」（扩展只装了一个就直接连，多个才给列表）
 *   链不对   → 「切到 Polygon 网络」
 *   已连接   → **余额数字**，点开浮窗看地址、gas、存款入口与断开
 *
 * ## 按钮上为什么不再是地址
 *
 * 原来是 `0x1234…abcd`。那个缩写**不回答任何问题**：地址长得都一样，
 * 是哪个钱包、里面有多少钱，都看不出来；而「我的钱呢」正是这个按钮会被
 * 点开的原因。余额是那个问题的答案，地址只是实现细节 —— 它留在浮窗里
 * 给需要核对的人看（面板里本来就写着签名地址和资金地址两行）。
 *
 * 显示的数是**可交易余额**（代理钱包里的 pUSD）—— 下单能动用的就是这笔钱。
 * 一个例外：代理钱包还是空的、钱还躺在签名地址上（还没走官方存款）时，
 * 摆一个 $0.00 会让人以为读数坏了，所以改显示签名地址上的金额并在旁边标
 * 一句「未存入」。它同时回答了「我的钱去哪了」和「我还差哪一步」。
 *
 * 未连接、链不对时不渲染余额 —— 那时没有可读的钱，按钮本身就在说别的
 * 事情（连钱包 / 切网络）。
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
  // 不再取 address：它原来只用来在按钮上印缩写，现在按钮印的是余额，
  // 地址挪进浮窗（由 WalletPanel 自己读）—— 留个没用到的变量会被 noUnusedLocals 拦下
  const { isConnected, chainId } = useAccount()
  const { connectors, connect, isPending, error } = useConnect()
  const available = useAvailableConnectors(connectors)
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  /**
   * 按钮上的那个数。与浮窗里的 WalletPanel 读的是同一组 query（key 相同，
   * react-query 会去重），所以这一处不额外发请求。
   */
  const bal = useWalletBalances()
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
        connectors={available}
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
        {tr('切到 Polygon 网络', 'Switch to Polygon')}
      </button>
    )
  }

  const inEoa = bal.eoaUsdcE.value
  const tradable = bal.trading.value
  // 判据写成 === 0n 而不是 falsy：加载中时 value 是 undefined，
  // 用 !inEoa 之类的写法会先闪一下「未存入」（与 WalletPanel 同一个理由）
  const notDeposited = tradable === 0n && inEoa != null && inEoa > 0n
  const shown = notDeposited ? inEoa : tradable

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={
          notDeposited
            ? tr('钱还在签名地址上，还没存进代理钱包', 'Funds are still on the signer address, not deposited yet')
            : tr('可交易余额：代理钱包里的 pUSD', 'Tradable balance: pUSD in the proxy wallet')
        }
        className="flex items-center gap-1 rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground hover:bg-muted"
      >
        {/* 读不出来时是「—」而不是「$—」：前者是「还不知道」，后者像是「零」 */}
        <span className="font-mono tnum">{shown == null ? '—' : `$${formatUsd(shown)}`}</span>
        {notDeposited && (
          <span className="shrink-0 text-[10px] text-warning">{tr('未存入', 'not deposited')}</span>
        )}
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
                摆在顶栏上和余额并排，很容易点错 */}
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                disconnect()
              }}
              className="mt-2 w-full rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {tr('断开连接', 'Disconnect')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Provider 检测不碰 render，也不请求账户权限。钱包晚于页面注入时，
 * ethereum#initialized / EIP-6963 更新会重查；从钱包切回浏览器也重查一次。
 */
function useAvailableConnectors(connectors: readonly Connector[]) {
  const [available, setAvailable] = useState<Connector[] | null>(null)
  useEffect(() => {
    let active = true
    let revision = 0
    const detect = () => {
      const current = ++revision
      void pickable(connectors).then((next) => {
        if (active && current === revision) setAvailable(next)
      })
    }
    detect()
    window.addEventListener('ethereum#initialized', detect)
    window.addEventListener('focus', detect)
    return () => {
      active = false
      window.removeEventListener('ethereum#initialized', detect)
      window.removeEventListener('focus', detect)
    }
  }, [connectors])
  return available
}

/**
 * 一个注入钱包时仍然直接连接，旁边的箭头提供 WalletConnect 入口。
 * 没有注入钱包的手机则直接打开 WalletConnect；多个扩展才先选钱包。
 * null 表示检测中，[] 表示没有可用连接方式，不能再盲调 injected。
 */
export function WalletPicker({
  connectors,
  isPending,
  error,
  onPick,
}: {
  connectors: Connector[] | null
  isPending: boolean
  error: unknown
  onPick: (c: Connector) => void
}) {
  const [open, setOpen] = useState(false)
  const wallets = connectors ?? []
  const injected = wallets.filter((c) => c.type === 'injected')
  const direct = wallets.length === 1 ? wallets[0] : injected.length === 1 ? injected[0] : undefined
  const disabled = isPending || connectors === null
  const toggle = () => setOpen((v) => !v)
  const label = connectors === null
    ? tr('检测钱包…', 'Detecting wallets…')
    : isPending
      ? tr('连接中…', 'Connecting…')
      : direct?.type === 'walletConnect'
        ? tr('连接手机钱包', 'Connect mobile wallet')
        : direct && direct.id !== 'injected'
          ? tr(`连接 ${direct.name}`, `Connect ${direct.name}`)
          : tr('连接钱包', 'Connect wallet')

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => direct ? onPick(direct) : toggle()}
          disabled={disabled}
          aria-expanded={direct ? undefined : open}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {label}
        </button>
        {direct && wallets.length > 1 && (
          <button
            type="button"
            onClick={toggle}
            disabled={disabled}
            aria-label={tr('其他钱包 / 手机连接', 'Other wallets / mobile connection')}
            aria-expanded={open}
            className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            ▾
          </button>
        )}
      </div>

      <ConnectError error={error} />

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-[min(92vw,17rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            {wallets.length === 0 ? (
              <p className="p-3 text-xs leading-relaxed text-muted-foreground">
                {tr(
                  '未检测到浏览器钱包，本站尚未启用 WalletConnect。请在币安钱包或 MetaMask 的内置浏览器中打开当前网址后连接。添加到主屏不会自动获得钱包。',
                  'No browser wallet detected, and WalletConnect is not enabled on this site. Open this URL in the Binance Wallet or MetaMask in-app browser to connect. Adding it to your home screen does not provide a wallet.',
                )}
              </p>
            ) : wallets.map((c) => (
              <button
                key={c.uid}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setOpen(false)
                  onPick(c)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground hover:bg-muted disabled:opacity-50"
              >
                {c.icon ? (
                  <img src={c.icon} alt="" className="size-4 shrink-0 rounded" />
                ) : (
                  <span className="size-4 shrink-0 rounded bg-muted" />
                )}
                <span className="truncate">
                  {c.type === 'walletConnect'
                    ? tr('WalletConnect · 手机 / 扫码', 'WalletConnect · Mobile / QR')
                    : c.id === 'injected' ? tr('浏览器钱包', 'Browser wallet') : c.name}
                </span>
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
        <p className="text-xs text-muted-foreground">{tr('未连接。连接后显示链上余额。', 'Not connected. Connect to see on-chain balances.')}</p>
      </>
    )
  }

  if (!onPolygon) {
    return (
      <>
        <p className="text-xs text-warning">{tr('当前网络不是 Polygon，余额与下单都不可用。', 'Not on Polygon — balances and trading are unavailable.')}</p>
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
          label={tr('当前钱包', 'Wallet')}
          value={bal.connector?.name ?? '—'}
          hint={tr('dapp 实际在用的扩展', 'extension in use')}
        />
        <Row label={tr('签名地址', 'Signer')} value={shortAddr(address)} mono hint={tr('EOA，只负责签名', 'EOA, signs only')} />
        <Row
          label={tr('资金地址', 'Funds')}
          value={proxy.isLoading ? tr('查询中…', 'Loading…') : shortAddr(proxyAddr)}
          mono
          hint={tr('Safe，钱在这里', 'Safe, holds funds')}
        />
        <div className="h-px bg-border" />
        <Row
          label={tr('可交易余额', 'Tradable')}
          value={
            proxy.isLoading || bal.trading.isLoading
              ? tr('读取中…', 'Loading…')
              : proxyAddr
                ? `$${formatUsd(inProxy)}`
                : '—'
          }
          mono
          hint={tr('Safe 里的 USDC.e，下单用这个', 'USDC.e in the Safe, used for orders')}
        />
        {/* 签名地址有余额才显示：没存款时这一行就是那个「我的钱去哪了」的答案 */}
        {inEoa != null && inEoa > 0n && (
          <Row
            label={tr('签名地址 USDC.e', 'Signer USDC.e')}
            value={`$${formatUsd(inEoa)}`}
            mono
            hint={tr('还没存款', 'not deposited')}
          />
        )}
        {inNative != null && inNative > 0n && (
          <Row
            label={tr('签名地址 USDC', 'Signer USDC')}
            value={`$${formatUsd(inNative)}`}
            mono
            hint={tr('官方存款流程能收', 'accepted by official deposit')}
          />
        )}
        <div className="h-px bg-border" />
        <Row
          label="POL（gas）"
          value={bal.pol.isLoading ? tr('读取中…', 'Loading…') : formatPol(bal.pol.data?.value)}
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
        {tr('去 Polymarket 存款', 'Deposit on Polymarket')}
      </PolymarketLink>

      {/* 交易授权那只一半留着：它走 SDK 的 relayer，是正确且唯一可行的做法。
          按钮本身不碰 SDK，点开才 lazy 加载那个弹窗。 */}
      <button
        type="button"
        onClick={() => setApprovalsOpen(true)}
        disabled={!proxyAddr}
        className="mt-1.5 w-full rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {tr('交易授权', 'Trading approvals')}
      </button>

      {/* 还没存款。**这条是面板上最重要的一句话** —— 它解释的正是「钱读不出来」
          这个看起来像 bug 的现象，而它其实只是还差一步存款。 */}
      {notDeposited && (
        <p className="mt-2 rounded border border-warning/30 bg-warning/10 p-2 text-[10px] leading-snug text-warning">
          {tr(
            `钱在签名地址上（$${formatUsd(inEoa)}），还没进 Polymarket 的代理钱包，所以「可交易 pUSD」是 $0.00 —— 不是读错了，是还差一步存款。这一步得在官网做（`,
            `Your funds ($${formatUsd(inEoa)}) are on the signer address and haven't reached your Polymarket proxy wallet yet, so tradable pUSD shows $0.00 — it's not a read error, you still need to deposit. That has to be done on the official site (`,
          )}
          <PolymarketLink>polymarket.com</PolymarketLink>
          {tr(
            '），存款会铸出交易用的 pUSD；本项目做不了这件事，也不该假装能做。',
            '), which mints the pUSD used for trading; this app can’t do that step.',
          )}
        </p>
      )}

      {/* 原生 USDC 与 USDC.e 的区分保留：官方的存款流程两种都收，
          但站内不要再暗示「自己转一笔就行」—— 那条路已经拆了。 */}
      {wrongToken && (
        <p className="mt-2 rounded border border-warning/30 bg-warning/10 p-2 text-[10px] leading-snug text-warning">
          {tr(
            `签名地址上是 $${formatUsd(inNative)} 原生 USDC，不是 USDC.e。这不影响存款 —— 官方的存款流程两种都收，也会把该换的换掉。直接走上面的入口就行。`,
            `The signer address holds $${formatUsd(inNative)} of native USDC, not USDC.e. That's fine — the official deposit flow accepts both and converts as needed. Just use the link above.`,
          )}
        </p>
      )}

      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        {tr(
          '「可交易 pUSD」读的是代理钱包 —— Polymarket 把交易资金放在那里，读签名地址会永远显示 $0。pUSD 是 Polymarket 的抵押代币，由官方存款流程铸造。gas 从签名地址出。',
          'Tradable pUSD is read from the proxy wallet — Polymarket keeps trading funds there, so the signer address would always show $0. pUSD is Polymarket’s collateral token, minted by the official deposit flow. Gas is paid from the signer address.',
        )}
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
