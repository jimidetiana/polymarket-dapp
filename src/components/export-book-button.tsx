/**
 * 「导出盘口」按钮 —— 画布右上角，和价格口径开关、展示更多摆一列。
 *
 * 导出的是**页面上此刻显示的那些盘口**（比赛信息 + 每个盘口基本信息 + 每侧前 3 档挂单），
 * 一个 JSON 文件。口径与组装都在 lib/book-export，这里只管三件界面上的事：
 * 点一下、转圈、出错时把话说清楚。
 *
 * 按钮上报的是「N/M 个盘口」而不是「N 个盘口」：M 是这场比赛的总数，两个数摆在一起，
 * 才看得出这份文件只是当前这一页 —— 剩下的盘口要翻页再导。
 *
 * ## 为什么是独立组件
 *
 * market-graph-canvas.tsx 已经 1300 行，而这块东西（一个 loading 态、一段错误文案、
 * 一次 lazy import）跟画布的布局、缩放、命中判定没有任何关系。
 *
 * ## 为什么 lib 是动态 import
 *
 * 导出模块只在点下去的那一刻才有用。静态 import 会把它（以及它那份 JSON 组装逻辑）
 * 打进主包 —— 和 App.tsx 把 OrderDialog 做成 lazy 是同一个理由，只是量小得多。
 */
import { useCallback, useState } from 'react'
import { tr } from '../lib/i18n'
import type { MarketGraph } from '../graph/types'

type Phase = 'idle' | 'running'

export function ExportBookButton({
  graph,
  nodeIds,
  eventIds,
}: {
  graph: MarketGraph
  /**
   * 要导出的盘口节点 id —— **画布此刻显示的那些**。
   *
   * 由画布算（它才知道「展示更多 / 折叠」此刻的状态），不在这里从 graph 推。
   */
  nodeIds: ReadonlySet<string>
  /** 组成这场比赛的全部子赛事 id，记进文件便于回查。见 lib/gamma.mergeIntoMatches */
  eventIds?: readonly string[]
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  /** 导出成功后在按钮下方报一行「N/M 个盘口 · 每侧 3 档」，让人知道这次拿到了什么 */
  const [done, setDone] = useState<string | null>(null)

  const run = useCallback(async () => {
    setPhase('running')
    setError(null)
    setDone(null)
    try {
      const { exportMatchBook } = await import('../lib/book-export')
      const data = await exportMatchBook(graph, { nodeIds, eventIds })
      setDone(
        tr(
          `已导出 ${data.scope.markets}/${data.scope.ofTotal} 个盘口 · 每侧 ${data.levelsPerSide} 档`,
          `Exported ${data.scope.markets}/${data.scope.ofTotal} markets · ${data.levelsPerSide} levels/side`,
        ) +
          // 有拉不到的就说出来 —— 不说的话这份文件缺了什么在文件里看不出来
          (data.stats.missing > 0
            ? tr(`（${data.stats.missing} 个未拉到）`, ` (${data.stats.missing} missing)`)
            : ''),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPhase('idle')
    }
  }, [graph, nodeIds, eventIds])

  const busy = phase === 'running'

  return (
    <>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title={tr(
          '导出当前页面盘口的挂单明细，每侧前 3 档（JSON）',
          'Export the markets shown on this page with the top 3 levels per side (JSON)',
        )}
        className="rounded-md border border-border bg-popover/90 px-2 py-1 text-[11px] text-foreground/80 shadow-sm backdrop-blur-sm hover:bg-muted disabled:opacity-60"
      >
        {busy ? tr('导出中…', 'Exporting…') : tr('导出盘口', 'Export book')}
      </button>

      {/* 结果/错误贴在按钮下方。max-w 收一下：盘口价格就在右上角这一片，
          一条长文案横过去会把那些数字盖住 */}
      {done && (
        <p className="max-w-[13rem] rounded-md border border-border bg-popover/90 px-2 py-1 text-right text-[10px] leading-snug text-muted-foreground shadow-sm backdrop-blur-sm">
          {done}
        </p>
      )}
      {error && (
        <p className="max-w-[13rem] rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-right text-[10px] leading-snug text-warning shadow-sm backdrop-blur-sm">
          {tr('导出失败：', 'Export failed: ')}
          {error}
        </p>
      )}
    </>
  )
}
