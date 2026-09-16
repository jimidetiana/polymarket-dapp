/**
 * 词典维护页面。**只在开发时存在**，正式构建不打包（见 App.tsx 的 import.meta.env.DEV 门）。
 *
 * ## 为什么是页面而不是脚本
 *
 * 要维护的是「Gamma 实际给出的队名」，这份名单每天在变，且只有拉过接口才知道。
 * 页面直接复用 useSoccerMatches，把当刻真实名单摆出来 —— 比对着 JSON 凭空补词条
 * 靠谱得多，也不会补一堆永远不会出现的队名。
 *
 * ## 数据流
 *
 *   编辑 → localStorage 覆盖层（即时生效，刷新页面就能在图上看到）
 *        → 导出 JSON → 手工粘进 src/data/*.zh.json → 提交
 *
 * 覆盖层是**草稿**，仓库 JSON 才是真相。这样分开的原因：localStorage 只在本机，
 * 换台电脑或清缓存就没了；提交进仓库才会跟着部署到线上。导出按钮给的就是
 * 可以直接覆盖那两个文件的完整内容（基准 + 覆盖已合并、按键排序）。
 */
import { useEffect, useMemo, useState } from 'react'
import { useSoccerMatches } from '@/lib/use-graph'
import {
  BASE_LEAGUES,
  BASE_TEAMS,
  exportMerged,
  getOverrides,
  leagueIcon,
  setLeagueIcon,
  setLeagueOverride,
  setTeamIcon,
  setTeamOverride,
  teamIcon,
  translateLeague,
  translateTeam,
} from '@/lib/dict'

/** 一行待维护的球队 */
type TeamRow = {
  en: string
  zh: string
  /** true = 译名来自词典；false = 没有译名，zh 里是英文原名 */
  translated: boolean
  icon: string
  /** 出现在哪些比赛里，便于判断这队是不是真的足球队 */
  seenIn: string[]
}

type LeagueRow = {
  code: string
  zh: string
  translated: boolean
  icon: string
  /** Gamma 自带的徽标，作为「不填也有图」的兜底展示 */
  gammaIcon: string | null
  count: number
}

export default function DictAdmin() {
  const { matches, loading, error, reload } = useSoccerMatches()
  // 编辑后自增，用来强制重算下面的表格（词典状态在模块内，不是 React state）
  const [rev, setRev] = useState(0)
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [q, setQ] = useState('')

  const { teams, leagues } = useMemo(() => {
    const tMap = new Map<string, TeamRow>()
    const lMap = new Map<string, LeagueRow>()

    for (const m of matches) {
      for (const en of [m.home, m.away]) {
        if (!en) continue
        const zh = translateTeam(en)
        const row = tMap.get(en)
        if (row) {
          row.seenIn.push(m.title)
        } else {
          tMap.set(en, {
            en,
            zh,
            translated: zh !== en,
            icon: teamIcon(en) ?? '',
            seenIn: [m.title],
          })
        }
      }
      if (m.leagueCode) {
        const row = lMap.get(m.leagueCode)
        if (row) {
          row.count += 1
        } else {
          const zh = translateLeague(m.leagueCode)
          lMap.set(m.leagueCode, {
            code: m.leagueCode,
            zh: zh ?? '',
            translated: zh != null,
            icon: getOverrides().leagueIcons[m.leagueCode] ?? '',
            gammaIcon: m.leagueIcon,
            count: 1,
          })
        }
      }
    }

    return {
      teams: [...tMap.values()].sort((a, b) => {
        // 缺译名的排最前：那才是要干的活
        if (a.translated !== b.translated) return a.translated ? 1 : -1
        return a.en.localeCompare(b.en)
      }),
      leagues: [...lMap.values()].sort((a, b) => {
        if (a.translated !== b.translated) return a.translated ? 1 : -1
        return b.count - a.count
      }),
    }
    // rev 是刻意的依赖：编辑写进模块级变量，React 察觉不到，靠它触发重算
  }, [matches, rev])

  const shownTeams = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return teams.filter((t) => {
      if (onlyMissing && t.translated) return false
      if (!kw) return true
      return t.en.toLowerCase().includes(kw) || t.zh.toLowerCase().includes(kw)
    })
  }, [teams, onlyMissing, q])

  const missingCount = teams.filter((t) => !t.translated).length
  const missingLeagues = leagues.filter((l) => !l.translated).length

  return (
    <div className="min-h-dvh bg-background p-4 text-foreground">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">词典维护</h1>
          <p className="text-[11px] text-muted-foreground">
            仅开发环境可见。改动存在浏览器里，导出后粘进 src/data/*.zh.json 才会生效到线上。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="#/"
            className="rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground/80 hover:bg-muted"
          >
            ← 回关系图
          </a>
          <button
            type="button"
            onClick={reload}
            className="rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground/80 hover:bg-muted"
          >
            重拉比赛
          </button>
        </div>
      </header>

      {loading && <p className="text-xs text-muted-foreground">正在拉取比赛…</p>}
      {error && matches.length === 0 && <p className="text-xs text-warning">{error}</p>}

      {matches.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-muted-foreground">
              {matches.length} 场比赛 · {teams.length} 支球队（缺译名{' '}
              <b className={missingCount > 0 ? 'text-warning' : 'text-success'}>{missingCount}</b>）
              · {leagues.length} 个联赛（缺{' '}
              <b className={missingLeagues > 0 ? 'text-warning' : 'text-success'}>
                {missingLeagues}
              </b>
              ）
            </span>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={onlyMissing}
                onChange={(e) => setOnlyMissing(e.target.checked)}
              />
              只看缺译名
            </label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索队名"
              className="rounded-md border border-border bg-input px-2 py-1 text-xs"
            />
          </div>

          <Section title={`球队（${shownTeams.length}）`}>
            {shownTeams.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                {onlyMissing ? '当前比赛里的球队都有译名了。' : '没有匹配的球队。'}
              </p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="p-2 font-normal">英文原名（词典键）</th>
                    <th className="p-2 font-normal">中文名</th>
                    <th className="p-2 font-normal">图标 URL</th>
                    <th className="p-2 font-normal">出现在</th>
                  </tr>
                </thead>
                <tbody>
                  {shownTeams.map((t) => (
                    <tr key={t.en} className="border-b border-border/50">
                      <td className="p-2 font-mono">
                        <div className="flex items-center gap-2">
                          {t.icon && (
                            // eslint-disable-next-line jsx-a11y/alt-text
                            <img src={t.icon} alt="" className="h-4 w-4 rounded-sm object-contain" />
                          )}
                          <span className={t.translated ? '' : 'text-warning'}>{t.en}</span>
                        </div>
                      </td>
                      <td className="p-2">
                        <input
                          defaultValue={t.translated ? t.zh : ''}
                          placeholder="填中文名"
                          onBlur={(e) => {
                            setTeamOverride(t.en, e.target.value || null)
                            setRev((n) => n + 1)
                          }}
                          className="w-40 rounded-md border border-border bg-input px-2 py-1"
                        />
                      </td>
                      <td className="p-2">
                        <input
                          defaultValue={t.icon}
                          placeholder="https://…（可留空）"
                          onBlur={(e) => {
                            setTeamIcon(t.en, e.target.value || null)
                            setRev((n) => n + 1)
                          }}
                          className="w-64 rounded-md border border-border bg-input px-2 py-1 font-mono text-[11px]"
                        />
                      </td>
                      <td className="max-w-[280px] truncate p-2 text-muted-foreground">
                        {t.seenIn[0]}
                        {t.seenIn.length > 1 && ` 等 ${t.seenIn.length} 场`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title={`联赛（${leagues.length}）`}>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="p-2 font-normal">代码</th>
                  <th className="p-2 font-normal">中文名</th>
                  <th className="p-2 font-normal">图标 URL（留空用 Gamma 的）</th>
                  <th className="p-2 font-normal">场次</th>
                </tr>
              </thead>
              <tbody>
                {leagues.map((l) => (
                  <tr key={l.code} className="border-b border-border/50">
                    <td className="p-2 font-mono">
                      <div className="flex items-center gap-2">
                        {(l.icon || l.gammaIcon) && (
                          <img
                            src={leagueIcon(l.code, l.gammaIcon) ?? ''}
                            alt=""
                            className="h-4 w-4 rounded-sm object-contain"
                          />
                        )}
                        <span className={l.translated ? '' : 'text-warning'}>{l.code}</span>
                      </div>
                    </td>
                    <td className="p-2">
                      <input
                        defaultValue={l.zh}
                        placeholder="填中文名"
                        onBlur={(e) => {
                          setLeagueOverride(l.code, e.target.value || null)
                          setRev((n) => n + 1)
                        }}
                        className="w-40 rounded-md border border-border bg-input px-2 py-1"
                      />
                    </td>
                    <td className="p-2">
                      <input
                        defaultValue={l.icon}
                        placeholder={l.gammaIcon ?? 'https://…'}
                        onBlur={(e) => {
                          setLeagueIcon(l.code, e.target.value || null)
                          setRev((n) => n + 1)
                        }}
                        className="w-64 rounded-md border border-border bg-input px-2 py-1 font-mono text-[11px]"
                      />
                    </td>
                    <td className="p-2 text-muted-foreground">{l.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <ExportPanel rev={rev} />
        </>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 overflow-x-auto rounded-lg border border-border bg-card">
      <h2 className="border-b border-border px-3 py-2 text-xs font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/**
 * 导出面板。给的是**整份文件内容**而不是 diff —— 直接覆盖对应文件即可，
 * 不用人肉合并。基准和覆盖已合并、按键排序，所以重复导出的 diff 是稳定的。
 */
function ExportPanel({ rev }: { rev: number }) {
  const [which, setWhich] = useState<'teams' | 'leagues' | 'icons' | 'leagueIcons'>('teams')
  const [copied, setCopied] = useState(false)

  // rev 变了要重新算：导出内容依赖模块内的覆盖层
  const merged = useMemo(() => exportMerged(), [rev])
  const text = merged[which]

  useEffect(() => setCopied(false), [which, text])

  const FILES: Record<typeof which, string> = {
    teams: 'src/data/teams.zh.json',
    leagues: 'src/data/leagues.zh.json',
    icons: 'src/data/teams.icon.json（暂未接入，先留着）',
    leagueIcons: 'src/data/leagues.icon.json（暂未接入，先留着）',
  }

  const counts = {
    teams: Object.keys(BASE_TEAMS).length,
    leagues: Object.keys(BASE_LEAGUES).length,
    icons: Object.keys(getOverrides().icons).length,
    leagueIcons: Object.keys(getOverrides().leagueIcons).length,
  }

  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-semibold">导出</h2>
        {(['teams', 'leagues', 'icons', 'leagueIcons'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setWhich(k)}
            className={
              'rounded-md border px-2 py-1 text-[11px] ' +
              (which === k
                ? 'border-primary text-primary'
                : 'border-border text-foreground/70 hover:bg-muted')
            }
          >
            {k === 'teams'
              ? '球队译名'
              : k === 'leagues'
                ? '联赛译名'
                : k === 'icons'
                  ? '球队图标'
                  : '联赛图标'}
          </button>
        ))}
        <span className="text-[11px] text-muted-foreground">
          → 覆盖 <code className="font-mono">{FILES[which]}</code>
          {which === 'teams' && `（基准 ${counts.teams} 条）`}
          {which === 'leagues' && `（基准 ${counts.leagues} 条）`}
        </span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }}
          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground"
        >
          {copied ? '已复制' : '复制全文'}
        </button>
      </div>
      <textarea
        readOnly
        value={text}
        className="h-64 w-full rounded-md border border-border bg-input p-2 font-mono text-[11px]"
      />
    </section>
  )
}
