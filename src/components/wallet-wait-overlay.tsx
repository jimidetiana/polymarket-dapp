import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { getWalletWait, subscribeWalletWait, type WalletWaitKind } from '../lib/wallet-activity'
import { tr, useLang } from '../lib/i18n'
import { Spinner } from './spinner'

/**
 * 等待钱包的全局浮层。**挂在根上一份**（main.tsx），由 lib/wallet-activity 的全局信号驱动，
 * 不关心是哪条路径触发的 —— 连接、切链、下单签名都共用它。
 *
 * ## 它解决的具体问题
 *
 * 手机端每次跳去钱包都有几秒空白、首单还要连签多次，中途回到应用这边却没有任何「还在等你」
 * 的提示。这个浮层在整段等待期间都显示转圈 + 一句「回钱包确认」，把那些空白缝隙填上，
 * 顺便挡住重复点击（见 connect-wallet 里关于 -32002 的注释）。
 *
 * ## 为什么要 350ms 去抖
 *
 * 桌面扩展的签名弹窗几乎是秒开秒确认，网页端连接也很快。那种一两百毫秒就过去的等待，
 * 弹个浮层再立刻收掉只会「闪一下」，比不弹更糟。所以等待超过 350ms 才真正显示 —— 快的
 * 流程（桌面）悄无声息，慢的流程（手机往返钱包）才给反馈，正好对上用户说的「网页端很快、
 * 手机端慢」。
 *
 * ## 为什么留一个「关闭提示」
 *
 * 浮层是全屏遮挡的。正常情况下每一段等待都绑在会 resolve/reject 的异步操作上（连接被拒、
 * 签名被拒都会收尾），浮层自动消失。但手机端 WalletConnect 的会话偶尔会**静默断掉**，
 * 那时没有收尾事件、浮层会一直挂着。给一个纯前端的「关掉这层提示」的出口兜底（它不取消
 * 底下的操作，只是把这层遮罩收起来），免得真卡住时连页面都点不动。
 */
export function WalletWaitOverlay() {
  useLang() // 切语言时跟着重渲染
  const kind = useSyncExternalStore<WalletWaitKind | null>(subscribeWalletWait, getWalletWait, () => null)
  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!kind) {
      setVisible(false)
      setDismissed(false)
      return
    }
    // 新一段等待：清掉上一段手动关掉的状态，并起 350ms 去抖
    setDismissed(false)
    const t = window.setTimeout(() => setVisible(true), 350)
    return () => window.clearTimeout(t)
  }, [kind])

  if (!kind || !visible || dismissed) return null

  const copy = {
    connect: {
      title: tr('正在连接钱包…', 'Connecting wallet…'),
      hint: tr('请在钱包里确认连接请求。手机钱包可能要等几秒才弹出。', 'Confirm the connection in your wallet. On mobile it can take a few seconds to appear.'),
    },
    switch: {
      title: tr('正在切换网络…', 'Switching network…'),
      hint: tr('请在钱包里确认切换到 Polygon 网络。', 'Confirm the switch to the Polygon network in your wallet.'),
    },
    sign: {
      title: tr('正在等待钱包确认…', 'Waiting for your wallet…'),
      hint: tr('请回到钱包里确认。首次下单可能要连续确认多次（派生凭据、授权、下单），每弹出一次就回钱包点一下。', 'Return to your wallet to confirm. The first order may ask you to confirm several times in a row (credentials, approvals, order) — go back to the wallet for each prompt.'),
    },
  }[kind]

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xs rounded-xl border border-border bg-card p-5 text-center shadow-2xl">
        <Spinner className="mx-auto size-8 text-primary" />
        <p className="mt-3 text-sm font-semibold text-foreground">{copy.title}</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{copy.hint}</p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="mt-3 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {tr('关闭提示', 'Dismiss')}
        </button>
      </div>
    </div>,
    document.body,
  )
}
