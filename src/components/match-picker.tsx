/**
 * 比赛选择器：一个按钮 + 一层浮层，浮层里是「搜索 + 状态筛选 + 比赛卡片列表」。
 *
 * ## 为什么不再是原生 <select>
 *
 * 原来那版是 `<select>{m.title}（N 盘口）`，两个硬伤：
 *   1. 显示 Gamma 的英文标题。词典（lib/dict）早就加载好了、管理页面也一直在
 *      维护它，只是没在这条路上用 —— 于是中文界面里唯一一处英文就是这里。
 *   2. 没有搜索。三十来场挤在一个原生下拉里，只能靠眼睛扫。
 *
 * 列表形式照原项目赛事页的 MatchCard
 * （trader/frontend/src/pages/soccer.tsx）：中文队名 + 英文副行 +
 * 「联赛 · 开赛时间 · 成交额」+ 状态徽标。
 *
 * ## 为什么是浮层而不是左侧栏
 *
 * dapp 的既有前提是「关系图占绝对主位」（见 App.tsx 顶部注释）：右侧栏只有
 * 288px，再插一列比赛列表会把画布挤窄。浮层不参与布局，画布的 ResizeObserver
 * 也量不到它，开合不会触发缩放重算。
 *
 * 真要改成侧栏，把下面浮层里那段列表搬进 <aside> 即可，逻辑一行不用动。
 */
import { useEffect, useRef, useState } from 'react'
import type { SoccerMatch } from '../lib/gamma'
import { translateLeague, translateTeam } from '../lib/dict'
import { cn, formatKickoff, formatVolume } from '../lib/utils'
import {
  STATUS_CLASS,
  STATUS_LABEL,
  countStatuses,
  filterMatches,
  matchStatus,
  matchVolume,
  searchMatches,
  type MatchFilter,
} from '../lib/match-list'

/**
 * 筛选标签。原项目那份还有「关注」「重点」：前者要一份持久化的关注列表，
 * 后者是「进行中 + 即将开始」的合称 —— dapp 没有关注，两个都省掉，
 * 状态之间由「全部」兜住。
 */
const TABS: Array<{ key: MatchFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'live', label: '进行中' },
  { key: 'not_started', label: '即将开始' },
  { key: 'ended', label: '已结束' },
]

export function MatchPicker({
  matches,
  matchId,
  onPick,
}: {
  matches: SoccerMatch[]
  matchId: string | null
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<MatchFilter>('all')
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开就聚焦搜索框：点开这个控件的下一步十有八九是打字
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const current = matches.find((m) => m.id === matchId) ?? null
  const empty = matches.length === 0

  // 两个都不 useMemo：三十来场、几次字符串拼接的量级，比缓存的簿记还便宜。
  // 顺带绕开了「缓存住旧的开赛状态」—— 状态随时间变，算在渲染里才跟得上。
  const counts = countStatuses(matches)
  const visible = searchMatches(filterMatches(matches, filter), q)

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={empty}
        className={cn(
          'flex max-w-[150px] items-center gap-1 rounded-md border border-border bg-input px-2 py-1 text-xs sm:max-w-[300px]',
          empty ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {/* min-w-0 是必须的：flex 子项的 min-width:auto 会撑破上面的 max-w，
            手机上就会溢出到 header 之外 */}
        <span className="min-w-0 truncate">
          {empty
            ? '（无比赛）'
            : current
              ? `${translateTeam(current.home)} vs ${translateTeam(current.away)}（${current.markets.length} 盘口）`
              : '选一场比赛'}
        </span>
        <span className="shrink-0 text-muted-foreground">▾</span>
      </button>

      {open && (
        <>
          {/* 点外面关掉。与 connect-wallet 的钱包菜单同一个做法：
              铺一层透明的固定层压住页面，z 比面板低 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
            }}
            className="absolute right-0 z-50 mt-1 w-[min(92vw,26rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
          >
            <div className="space-y-2 border-b border-border p-2">
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜队名 / 联赛（中英文都行）"
                className="w-full rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground"
              />
              <div className="flex flex-wrap gap-1">
                {TABS.map((t) => {
                  const active = filter === t.key
                  const n = t.key === 'all' ? matches.length : counts[t.key]
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setFilter(t.key)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[10px] font-medium transition-colors',
                        active
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-foreground hover:bg-muted',
                      )}
                    >
                      {t.label}（{n}）
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="max-h-[60vh] space-y-1.5 overflow-y-auto p-2">
              {visible.length === 0 ? (
                <p className="p-3 text-center text-xs text-muted-foreground">
                  {empty ? '时间窗内没有比赛' : '没有匹配的比赛'}
                </p>
              ) : (
                visible.map((m) => (
                  <MatchRow
                    key={m.id}
                    match={m}
                    active={m.id === matchId}
                    onPick={() => {
                      onPick(m.id)
                      setOpen(false)
                    }}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 一场比赛一行。原项目那张卡片的简化版：去掉关注星标（dapp 没有关注列表）、
 * 去掉右箭头（这里点哪行都是同一个动作），加了盘口数 —— 关系图能画多完整
 * 全看盘口数，那是这一页最该看的一个数。
 */
function MatchRow({
  match,
  active,
  onPick,
}: {
  match: SoccerMatch
  active: boolean
  onPick: () => void
}) {
  const homeZh = translateTeam(match.home)
  const awayZh = translateTeam(match.away)
  // 至少有一条译名才显示英文副行；两条都没译时那一行只是把上面重复一遍
  const hasEn = homeZh !== match.home || awayZh !== match.away
  const status = matchStatus(match.endDate)
  const vol = matchVolume(match)

  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'w-full rounded-lg border bg-card px-2.5 py-2 text-left transition-colors',
        active ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">
            {homeZh} <span className="text-muted-foreground">vs</span> {awayZh}
          </p>
          {hasEn && (
            <p className="truncate text-[10px] text-muted-foreground">
              {match.home} vs {match.away}
            </p>
          )}
          <p className="truncate text-[10px] text-muted-foreground">
            {translateLeague(match.leagueCode) ?? '足球'} · {formatKickoff(match.endDate)}
            {vol != null && ` · 成交 ${formatVolume(vol)}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 text-[10px] font-medium',
              STATUS_CLASS[status],
            )}
          >
            {STATUS_LABEL[status]}
          </span>
          <span className="tnum text-[10px] text-muted-foreground">{match.markets.length} 盘口</span>
        </div>
      </div>
    </button>
  )
}
