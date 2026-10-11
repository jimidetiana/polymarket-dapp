import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { getWalletSigning, subscribeWalletSigning } from '../lib/wallet-activity'
import { tr, useLang } from '../lib/i18n'
import { Spinner } from './spinner'

/**
 * 「正在等待钱包确认签名」的浮层。挂在 main.tsx 根上一份，由 lib/wallet-activity 的签名信号驱动。
 *
 * ## 只在签名真正悬而未决时出现
 *
 * 不盯连接 / 切网络（那时浏览器自己的选择框、钱包界面会盖住一切，叠浮层既被挡又无意义）——
 * 只在**签名请求已发出、正等钱包回应**时出现。签名一有结果（确认 / 拒绝 / 出错），信号归零，
 * 浮层立刻消失；所以不会出现「认证都好了浮层还挂着」。
 *
 * ## 350ms 去抖
 *
 * 桌面扩展常常秒开秒确认，一两百毫秒就过去的签名弹个浮层再立刻收只会「闪一下」。等待超过
 * 350ms 才显示：快流程（桌面）悄无声息，慢流程（手机往返钱包）才给反馈。
 *
 * ## 绝不把人困住
 *
 * 浮层是提示，不是关卡：它从不阻挡底层流程推进（SDK 等的是钱包的回应，与这层无关），而且
 * 永远留一个显眼的「关闭」出口。手机上偶有钱包没被自动唤到前台、签名请求挂在后台的情况，
 * 这时浮层会一直等 —— 所以等久了（6 秒）追加一句「钱包没弹出就手动切过去，或关闭重试」，
 * 关掉后在这次签名结束前不再弹，人可以自行切去钱包或重来，不会卡死在一张盖板上。
 */
export function WalletWaitOverlay() {
  useLang() // 切语言时跟着重渲染
  const signing = useSyncExternalStore(subscribeWalletSigning, getWalletSigning, () => false)
  const [visible, setVisible] = useState(false)
  const [slow, setSlow] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!signing) {
      setVisible(false)
      setSlow(false)
      setDismissed(false)
      return
    }
    // 新一段签名等待：清掉上一段的手动关闭 / 久等标记，起 350ms 去抖；显示后再数 6 秒算「久等」
    setDismissed(false)
    setSlow(false)
    const show = window.setTimeout(() => setVisible(true), 350)
    const long = window.setTimeout(() => setSlow(true), 6000)
    return () => {
      window.clearTimeout(show)
      window.clearTimeout(long)
    }
  }, [signing])

  if (!signing || !visible || dismissed) return null

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xs rounded-xl border border-border bg-card p-5 text-center shadow-2xl">
        <Spinner className="mx-auto size-8 text-primary" />
        <p className="mt-3 text-sm font-semibold text-foreground">{tr('正在等待钱包确认…', 'Waiting for your wallet…')}</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {tr('请回到钱包里确认这次签名。首次下单可能要连续确认多次（派生凭据、授权、下单）。', 'Return to your wallet to confirm this signature. The first order may ask you to confirm several times in a row (credentials, approvals, order).')}
        </p>
        {slow && (
          <p className="mt-2 rounded border border-warning/30 bg-warning/10 p-2 text-[10px] leading-snug text-warning">
            {tr('钱包没有自动弹出？请手动切到钱包 App 确认，或关闭本提示后重试。', "Wallet didn't open automatically? Switch to your wallet app to confirm, or dismiss this and retry.")}
          </p>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="mt-3 w-full rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted"
        >
          {tr('关闭', 'Dismiss')}
        </button>
      </div>
    </div>,
    document.body,
  )
}
