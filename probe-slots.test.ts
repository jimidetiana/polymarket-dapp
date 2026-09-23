/**
 * 一次性诊断 —— **不是项目代码,跑完就删**。
 *
 * 回答「有的盘口显示无此盘,但平台上其实有」到底是哪种原因:
 *
 *   A. 盘口在 Gamma 里有,但成交量为 0,被 buildMarketGraph 的 minVolume 过滤掉了
 *   B. 盘口在 Gamma 里有,但 parseMarket 没认出来 / 认成了别的
 *   C. Gamma 里确实没有这条线
 *
 * 借 vitest 跑是为了让 TS 与免后缀 import 能直接用。发的都是只读 GET。
 *
 * 运行:npx vitest run probe-slots
 * 只看某一场:MATCH="Inter" npx vitest run probe-slots
 */
import { test } from 'vitest'
import {
  fetchMatchMarkets,
  fetchSoccerEvents,
  mergeIntoMatches,
  toGraphMarketInput,
} from './src/lib/gamma'
import { buildMarketGraph } from './src/graph/graph'
import { parseMarket } from './src/graph/parse'
import { TEMPLATE_SLOTS, resolveTemplate, type SlotBind } from './src/graph/template'
import { inferGoalCounts, matchMinute } from './src/graph/goals'
import type { MarketDescriptor } from './src/graph/types'

/** 与 template.ts 的 findNode 同一条规则,只是作用在 desc 上 */
function bindMatches(d: MarketDescriptor, b: SlotBind): boolean {
  if (d.family !== b.family || d.period !== b.period) return false
  if (b.family === 'ou') return d.metric === 'goals' && d.subject === b.subject && d.line === b.line
  if (b.family === 'moneyline') return d.role === b.role
  const homeLine = b.subject === 'away' ? -(b.line ?? 0) : (b.line ?? 0)
  return d.homeLine != null && d.homeLine === homeLine
}

/** 槽位的「关键词」:问句里含这些就算候选,用来抓解析失败的 */
function hint(b: SlotBind): RegExp {
  if (b.family === 'moneyline') return b.role === 'draw' ? /draw|tie/i : /win/i
  const line = Math.abs(b.line ?? 0)
  return new RegExp(`(^|[^\\d])${line}([^\\d]|$)`)
}

test('无此盘 归因', async () => {
  const matches = mergeIntoMatches(await fetchSoccerEvents())
  const want = process.env.MATCH?.toLowerCase()
  const picked = want
    ? matches.filter((m) => m.title.toLowerCase().includes(want))
    : matches.slice(0, 8)
  console.log(`共 ${matches.length} 场,诊断 ${picked.length} 场\n`)

  const totals = { slots: 0, empty: 0, zeroVol: 0, parse: 0, absent: 0 }

  for (const m of picked) {
    const raw = await fetchMatchMarkets(m.eventIds)
    const inputs = raw.map(toGraphMarketInput)
    const ev = { id: m.id, homeTeamEn: m.home, awayTeamEn: m.away, endTime: m.endDate }
    const minute = matchMinute(m.endDate)
    const state = { homeGoals: 0, awayGoals: 0, minute }
    const withFilter = buildMarketGraph(ev, inputs, { minVolume: 0, state })
    const noFilter = buildMarketGraph(ev, inputs, { minVolume: -1, state })
    const slotsA = resolveTemplate(withFilter, inferGoalCounts(withFilter, minute))
    const slotsB = resolveTemplate(noFilter, inferGoalCounts(noFilter, minute))
    const emptyA = slotsA.filter((s) => s.kind === 'market' && !s.nodeId)
    const emptyB = slotsB.filter((s) => s.kind === 'market' && !s.nodeId)

    console.log(
      `▶ ${m.title} · ${m.eventIds.length} 子赛事 · ${raw.length} 盘口 · ` +
        `节点 ${withFilter.nodes.length}(不过滤成交量 ${noFilter.nodes.length}) · ` +
        `空槽位 ${emptyA.length}/19(不过滤成交量 ${emptyB.length}/19)`,
    )
    totals.slots += 19
    totals.empty += emptyA.length

    for (const s of emptyA) {
      const b = s.bind!
      // 每条盘口:解析结果 + 是否命中该槽位
      const parsed = inputs.map((i) => ({
        i,
        d: parseMarket({ questionEn: i.questionEn, line: i.line, homeTeamEn: m.home, awayTeamEn: m.away }),
      }))
      const hit = parsed.filter((p) => p.d && bindMatches(p.d, b))
      if (hit.length > 0) {
        totals.zeroVol += 1
        for (const p of hit) {
          console.log(
            `    A 零成交被过滤  [${s.label}]  "${p.i.questionEn}"  volume=${p.i.volume} liquidity=${p.i.liquidity} outcomes=${JSON.stringify(p.i.outcomes)} prices=${JSON.stringify(p.i.outcomePrices)}`,
          )
        }
        continue
      }
      const re = hint(b)
      const cand = parsed.filter((p) => re.test(p.i.questionEn))
      if (cand.length > 0) {
        totals.parse += 1
        console.log(`    B 解析没对上    [${s.label}]  候选 ${cand.length} 条:`)
        for (const p of cand.slice(0, 6)) {
          const d = p.d
          console.log(
            `        "${p.i.questionEn}"  line=${p.i.line}  → ` +
              (d ? `${d.family}/${d.period}/${d.subject}/line=${d.line}/homeLine=${d.homeLine}/role=${d.role}` : 'parse=null'),
          )
        }
        continue
      }
      totals.absent += 1
      console.log(`    C 平台没挂      [${s.label}]`)
    }
  }

  console.log(
    `\n汇总:${totals.slots} 个槽位,空 ${totals.empty} 个 —— ` +
      `A 零成交被过滤 ${totals.zeroVol} · B 解析没对上 ${totals.parse} · C 平台没挂 ${totals.absent}`,
  )
}, 180_000)
