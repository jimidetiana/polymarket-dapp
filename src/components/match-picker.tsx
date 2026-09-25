/**
 * 比赛选择器：搜索 + 状态筛选 + 比赛列表，直接铺在左栏的「比赛」分区里。
 *
 * ## 为什么不再是按钮 + 浮层
 *
 * 上一版是 header 里的一个按钮加一层浮层，两个硬伤：
 *   1. header 是横的，按钮在窄屏只有 max-w-[150px]，选中那场的标题会被截断 ——
 *      屏幕上唯一说明「现在看的是哪场」的地方反而显示不全。
 *   2. 手机上点开浮层会盖住大半张图，观感很突兀。
 * 列表改为常驻左栏后这两条一起消失：宽度够用，选中态一直看得见。
 *
 * 浮层那套簿记（开合、点外关闭、Escape、z 序）也一并去掉 ——
 * 一个展示列表的控件不该带这些。
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
 * ## 为什么是分页而不是让列表自己滚
 *
 * 上一版给列表加了 max-h + overflow-y-auto，两个问题：
 *   1. 滚动条会随比赛数量出现又消失，左栏的可用宽度跟着抖一下；
 *   2. 「还有多少场没看到」滚动条答不了 —— 人得先滚到底才知道。
 * 固定 7 行一页之后，页码直接把「第几页 / 共几页」摆出来。
 *
 * 左栏因此没有嵌套的滚动区：要么整栏装得下，要么整栏滚（浏览器那根常规滚动条）。
 */
import { useState } from 'react'
import type { SoccerMatch } from '../lib/gamma'
import { translateLeague, translateTeam } from '../lib/dict'
import { cn, formatKickoff, formatVolume } from '../lib/utils'
import {
  STATUS_CLASS,
  STATUS_LABEL,
  countStatuses,
  filterMatches,
  matchStatus,
  searchMatches,
  sortForList,
  type MatchFilter,
} from '../lib/match-list'
import { matchHasPosition } from '../lib/positions'

/**
 * 标签页。比 `MatchFilter` 多一个 `mine` —— 那个不是开赛状态，而是「这场跟我有关」，
 * 判据来自持仓（lib/positions.ts 的 matchHasPosition），所以不能并进 filterMatches
 * （那个函数只认状态，见 lib/match-list.ts）。多出来的那一个在组件里就地筛。
 *
 * ⚠️ **「我的」只含持仓，不含挂单。** 挂单（未成交委托）公开接口拿不到：只有 CLOB 的
 * 鉴权接口有，读它得先让用户签一次名 —— 弹窗里那段「持仓中」正是为此做成按需加载的。
 * 想在列表上标挂单，就得先接受「打开列表要签一次名」，那是另一个取舍。
 */
type Tab = MatchFilter | 'mine'

/**
 * 筛选标签。原项目那份还有「关注」「重点」：前者要一份持久化的关注列表，
 * 后者是「进行中 + 即将开始」的合称 —— dapp 没有关注，两个都省掉，
 * 状态之间由「全部」兜住。
 */
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'mine', label: '我的' },
  { key: 'live', label: '进行中' },
  { key: 'not_started', label: '即将开始' },
  { key: 'ended', label: '已结束' },
]

/** 每页场数。凭手感定的：一页大致填满左栏、又不需要内层滚动。
    行高本身随「有没有英文副行」浮动，所以这个数不必精确 */
const PAGE_SIZE = 7

export function MatchPicker({
  matches,
  matchId,
  onPick,
  positionEventIds,
}: {
  matches: SoccerMatch[]
  matchId: string | null
  onPick: (id: string) => void
  /**
   * 有持仓的子赛事 id 集合。命中就在那一行加个「持仓」徽标。
   *
   * 不传或空集就是没有标记 —— 没连钱包、读不到持仓、确实没有仓位，三者在这里
   * 表现相同（见 lib/use-positions.ts）。
   */
  positionEventIds?: ReadonlySet<string>
}) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Tab>('all')
  const [page, setPage] = useState(1)

  const empty = matches.length === 0

  // 两个都不 useMemo：三十来场、几次字符串拼接的量级，比缓存的簿记还便宜。
  // 顺带绕开了「缓存住旧的开赛状态」—— 状态随时间变，算在渲染里才跟得上。
  const counts = countStatuses(matches)
  /**
   * 这场比赛有没有我的仓位（含已完结的）。
   *
   * 判据是 `eventIds` 与持仓的 eventId **有交集**，而不是只比主赛事 id：仓位的
   * 大部分落在「- More Markets」那一族里（大小球就在那），只比主赛事会漏掉它们。
   */
  const hasHolding = (m: SoccerMatch) =>
    positionEventIds != null && matchHasPosition(m.eventIds, positionEventIds)
  const mineCount = positionEventIds == null ? 0 : matches.filter(hasHolding).length

  // 展示顺序：没结束的按开赛时间升序在前，已结束的沉底（见 sortForList）。
  // matches 本身的顺序是重要性排序（子赛事多的在前），只留给「没有指定时的兜底」
  const filtered = filter === 'mine' ? matches.filter(hasHolding) : filterMatches(matches, filter)
  const visible = sortForList(searchMatches(filtered, q))

  // 页数至少 1：空列表也得是「第 1 / 1 页」，否则页码处会显示 0
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  /**
   * 夹一下再用，而不是把 page 存成「永远合法」的。
   *
   * 越界是常态：筛到只剩 3 场时，page 可能还停在 3。用 effect 监听再回退要多
   * 渲染一轮，中间那一轮还会闪一次空列表；夹在渲染里算，同一轮就是对的。
   */
  const current = Math.min(page, pageCount)
  const rows = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  return (
    <div className="space-y-2">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          // 换了条件就回第一页：停在第 3 页看一批新结果，一上来就是空的
          setPage(1)
        }}
        placeholder="搜队名 / 联赛（中英文都行）"
        className="w-full rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground"
      />

      <div className="flex flex-wrap gap-1">
        {TABS.map((t) => {
          const active = filter === t.key
          const n = t.key === 'all' ? matches.length : t.key === 'mine' ? mineCount : counts[t.key]
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setFilter(t.key)
                setPage(1)
              }}
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

      {/* 不设 max-h：一页就是 7 行，列表本身不需要滚动 */}
      <div className="space-y-1.5">
        {rows.length === 0 ? (
          <p className="p-3 text-center text-xs text-muted-foreground">
            {empty ? '时间窗内没有比赛' : '没有匹配的比赛'}
          </p>
        ) : (
          rows.map((m) => (
            <MatchRow
              key={m.id}
              match={m}
              active={m.id === matchId}
              held={hasHolding(m)}
              onPick={() => onPick(m.id)}
            />
          ))
        )}
      </div>

      {/* 只有一页时整条不渲染：一个永远点不动的翻页器只是噪音 */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <button
            type="button"
            onClick={() => setPage(current - 1)}
            disabled={current <= 1}
            className="rounded-md border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            上一页
          </button>
          <span className="tnum text-[10px] text-muted-foreground">
            {current} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage(current + 1)}
            disabled={current >= pageCount}
            className="rounded-md border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 一场比赛一行。原项目那张卡片的简化版：去掉关注星标（dapp 没有关注列表）、
 * 去掉右箭头（这里点哪行都是同一个动作），加了子赛事数 —— 关系图能画多完整
 * 全看盘口族多不多，那是这一页最该看的一个数。
 *
 * 显示的是子赛事数而不是盘口数：列表是不带盘口拉的（gamma.ts 的
 * fetchSoccerEvents 解释了为什么），盘口数只有选中那场才知道。一族盘口对应
 * 一个子赛事，所以子赛事数是同一件事的粗刻度：1 = 只有胜平负，7 = 全套。
 */
function MatchRow({
  match,
  active,
  held,
  onPick,
}: {
  match: SoccerMatch
  active: boolean
  /** 这场比赛有仓位（含已完结的） */
  held: boolean
  onPick: () => void
}) {
  const homeZh = translateTeam(match.home)
  const awayZh = translateTeam(match.away)
  // 至少有一条译名才显示英文副行；两条都没译时那一行只是把上面重复一遍
  const hasEn = homeZh !== match.home || awayZh !== match.away
  const status = matchStatus(match.endDate)
  const vol = match.volume

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
          {/* 持仓徽标。用品牌色而不是语义色：这不是一个「好 / 坏」的状态，
              而是「这场跟我有关」—— 与选中态同一个强调色，一眼能跟状态徽标分开 */}
          {held && (
            <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              持仓
            </span>
          )}
          <span className="tnum text-[10px] text-muted-foreground">{match.eventIds.length} 个子赛事</span>
        </div>
      </div>
    </button>
  )
}
