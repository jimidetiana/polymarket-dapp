/**
 * 操作说明弹窗。顶栏「说明」按钮打开，首次访问自动弹一次。
 *
 * 不牵 SDK，静态 import 进主包没问题 —— 它只是几段文案加一个 Discord 链接。
 * 外壳（遮罩、Esc 关闭、锁滚动）与 approvals-dialog 同款。
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { tr } from '../lib/i18n'

export const DISCORD_INVITE = 'https://discord.gg/KYrtKzbsp'

interface Props {
  onClose: () => void
}

export function HelpDialog({ onClose }: Props) {
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

  const steps: [string, string][] = [
    [
      tr('连接钱包', 'Connect wallet'),
      tr('点右上角连接钱包，网络切到 Polygon。', 'Click the top-right button and switch to Polygon.'),
    ],
    [
      tr('存入资金', 'Deposit'),
      tr(
        '在钱包菜单里点「去 Polymarket 存款」，钱进代理钱包后顶栏显示可交易余额。',
        'Use "Deposit on Polymarket" in the wallet menu. The top bar shows your tradable balance once funds land.',
      ),
    ],
    [
      tr('交易授权', 'Approve trading'),
      tr('首次下单前在钱包菜单里点「交易授权」，一次即可，免 gas。', 'Before your first order, run "Trading approvals" in the wallet menu. One-time, gasless.'),
    ],
    [
      tr('选比赛', 'Pick a match'),
      tr('左栏选一场比赛（窄屏点左上角菜单）。', 'Pick a match in the left panel (menu button on small screens).'),
    ],
    [
      tr('看图下单', 'Trade on the graph'),
      tr(
        '图上每个节点是一个盘口，点节点弹出下单面板。画布右上角可切换概率 / 赔率显示。',
        'Each node is a market. Click one to open the order panel. Toggle probability / odds at the top-right of the canvas.',
      ),
    ],
    [
      tr('查看订单', 'Check orders'),
      tr('顶栏「订单」查看挂单与持仓；图上带「持」角标的节点表示你有持仓。', 'Use "Orders" in the top bar for orders and positions. Nodes tagged "H" are ones you hold.'),
    ],
  ]

  return createPortal(
    <div
      className="fixed inset-0 z-[100] overflow-y-auto bg-black/70 p-3 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex min-h-full items-start justify-center py-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="help-dialog-title"
          className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl"
        >
          <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
            <p id="help-dialog-title" className="truncate text-sm font-semibold text-foreground">
              {tr('操作说明', 'How it works')}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              aria-label={tr('关闭', 'Close')}
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <ol className="space-y-2 p-3">
            {steps.map(([title, body], i) => (
              <li key={i} className="flex gap-2.5 rounded-lg border border-border bg-background p-2.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">{title}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="border-t border-border p-3">
            <a
              href={DISCORD_INVITE}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              {tr('加入 Discord 社区', 'Join our Discord')}
            </a>
            <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
              {tr('有问题、想看战绩播报，来 Discord 找我们', 'Questions or match updates? Find us on Discord')}
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
