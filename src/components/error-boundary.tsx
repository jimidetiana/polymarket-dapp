/**
 * 渲染期抛错的兜底。
 *
 * ## 为什么必须有
 *
 * React 遇到渲染期抛错会**卸载整棵树** —— 没有 boundary 时，用户看到的是一片纯白，
 * 没有任何线索。（控制台里 React 自己也会提示 "Consider adding an error boundary"。）
 * 这个项目已经踩过两次：
 *
 *  1. 手机上双指捏合盘口图：在 setView 的更新函数里读了已被清空的手势状态
 *     （见 market-graph-canvas.tsx 的 onPointerMove）。
 *  2. dev 下依赖预构建过期：lazy 的下单弹窗撞上 `504 Outdated Optimize Dep`，
 *     动态 import 被拒（见 vite.config.ts 的 optimizeDeps）。生产侧同理 ——
 *     换了部署之后 PWA 缓存里的旧 chunk 名一样会 404。
 *
 * ## 「重新加载」不做原地重试
 *
 * `React.lazy` 会把失败的 import **缓存住**，原地重试拿到的还是同一个 rejected promise，
 * 点了没反应。上面两类成因刷新一次都能恢复（重装依赖、重取新 chunk 名），
 * 所以出口直接是刷新页面。
 *
 * 文案里把 `error.message` 摆出来：白屏最难的不是修，是**没人知道它为什么白**。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { tr } from '../lib/i18n'

interface Props {
  children: ReactNode
  /** 出错时给用户的一句人话：说清**哪一块**没出来。不传就只说「界面出错了」 */
  hint?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 兜底界面只显示 message；完整堆栈落在控制台，供排查用
    console.error('[ui] 渲染期抛错，已由 ErrorBoundary 接住：', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      // z 比等待钱包浮层（z-200）、下单弹窗（z-100）都高：出错时它要盖在最上面
      <div className="fixed inset-0 z-[300] flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 text-center shadow-2xl">
          <p className="text-sm font-semibold text-foreground">{tr('界面出错了', 'Something broke')}</p>
          {this.props.hint && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{this.props.hint}</p>
          )}
          <p className="mt-2 max-h-28 overflow-auto rounded border border-border bg-background p-2 text-left font-mono text-[10px] leading-snug text-warning">
            {String(error.message || error)}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 w-full rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted"
          >
            {tr('重新加载页面', 'Reload page')}
          </button>
        </div>
      </div>
    )
  }
}
