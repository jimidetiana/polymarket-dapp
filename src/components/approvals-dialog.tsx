/**
 * 交易授权弹窗。
 *
 * ## 它为什么还在（而充值弹窗没了）
 *
 * 这两件事看着像一套，其实不是：
 *
 *  - **充值**：要从用户钱包搬钱进代理钱包。实测证明搬不动 —— Polymarket V2 的
 *    抵押代币 pUSD 是链上 mint 出来的（交易方法 `handleOps`，即 ERC-4337 UserOp），
 *    一笔普通 ERC-20 转账变不出 mint。所以那条路整个停了，改成引导去官网。
 *    （详见 lib/money.ts 顶部。）
 *  - **授权**：让交易所能动代理钱包里的 pUSD 与条件代币。这件事**由 SDK 走
 *    relayer 完成、免 gas**，是正确且唯一可行的做法，与充值无关，所以留在这里。
 *
 * ## 为什么整块必须懒加载
 *
 * 授权要调 @polymarket/client（约 300 kB gzip）。App.tsx 里 OrderDialog 做成
 * lazy 就是为了不让首屏付这笔钱，这里同理 —— 见 lib/use-wallet.ts 顶部那段
 * 关于主包约束的说明。**面板本身不许静态 import 这个文件。**
 *
 * ## 为什么它只是一个按钮加一行状态
 *
 * 授权是个开关，不是一个过程。做成表单/向导只会让人以为要填什么。状态读的是
 * SDK 的只读接口（不弹签名），只有真点「一键授权」才会让用户签一次名。
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useWalletBalances } from '../lib/use-wallet'
import { useApprovalState, useSetupApprovals } from '../lib/use-clob'

interface Props {
  onClose: () => void
}

export function ApprovalsDialog({ onClose }: Props) {
  const bal = useWalletBalances()
  const state = useApprovalState(bal.proxyAddr, bal.enabled)
  const setup = useSetupApprovals()

  // Esc 关闭 + 锁背景滚动。与 order-dialog 同款：
  // 滚轮穿透到画布上会让人以为图在动，很困惑。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const running = setup.phase === 'running'
  const approved = state.state?.isFullyApproved === true

  return createPortal(
    <div
      className="fixed inset-0 z-[100] overflow-y-auto bg-black/70 p-3 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex min-h-full items-start justify-center py-4">
        <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl">
          <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">交易授权</p>
              <p className="truncate text-[10px] text-muted-foreground">
                交易所要能动你的 pUSD 和条件代币，才接得了单
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              aria-label="关闭"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="space-y-2.5 p-3">
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background p-2.5">
              <span className="text-xs text-muted-foreground">当前状态</span>
              <span className="shrink-0">
                {state.isLoading ? (
                  <span className="text-[11px] text-muted-foreground">读取中…</span>
                ) : approved ? (
                  <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                    已授权
                  </span>
                ) : state.state ? (
                  <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                    缺 {state.state.missingCount} 项
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">—</span>
                )}
              </span>
            </div>

            {!approved && (
              <button
                type="button"
                disabled={!setup.readiness.ready || running}
                onClick={() => void setup.run()}
                className="w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              >
                {running ? '授权中…' : '一键授权（免 gas）'}
              </button>
            )}

            {!approved && setup.readiness.ready && (
              <p className="text-[10px] leading-snug text-muted-foreground">
                会先让你在钱包里签一次名，用来派生 API 凭据 ——
                <span className="text-foreground">不上链、不花 gas</span>。之后同一会话不再问。
                授权本身由 Polymarket 代发，同样不需要 gas。
              </p>
            )}

            {!setup.readiness.ready && (
              <p className="text-[10px] leading-snug text-warning">{setup.readiness.reason}</p>
            )}

            {state.error && (
              <p className="text-[10px] leading-snug text-warning">读取授权状态失败：{state.error}</p>
            )}

            {setup.error && <p className="text-[10px] leading-snug text-error">{setup.error}</p>}

            {approved && (
              <p className="text-[10px] leading-snug text-muted-foreground">
                已经授权过了，不用再点。换钱包或换账户钱包后需要重新授权一次。
              </p>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
