import { cn } from '../lib/utils'

/**
 * 转圈等待图标。
 *
 * 用 Tailwind v4 内置的 `animate-spin`，描边取 `currentColor` —— 放在按钮里就跟随文字色，
 * 不用每处单独配色。两段弧：一圈淡的底 + 一截亮的头，转起来才看得出在动（纯整圈看着像静止）。
 * `size-4` 是默认大小，调用方用 className 覆盖（浮层里用 size-8）。
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4 animate-spin', className)} fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
