import type { GraphNode, VolumeSample } from '@/graph/types'
import type { PolyTrade } from './positions'

export const VOLUME_COLORS = {
  own: 'var(--pm-state-success)',
  opposite: 'var(--pm-state-error)',
}

export function summarizeVolume(trades: readonly PolyTrade[], nodes: readonly GraphNode[]): VolumeSample {
  const byToken: Record<string, number> = {}
  const markets = new Set(nodes.map((n) => n.conditionId).filter(Boolean))
  for (const n of nodes) {
    if (!n.conditionId) continue
    for (const s of n.sides) if (s.tokenId) byToken[s.tokenId] = 0
  }
  let count = 0
  let oldest: number | null = null
  let newest: number | null = null
  for (const t of trades) {
    if (!markets.has(t.conditionId) || !Object.hasOwn(byToken, t.asset)) continue
    if (!Number.isFinite(t.size) || t.size <= 0 || !Number.isFinite(t.price) || t.price < 0 || t.price > 1) continue
    byToken[t.asset] += t.size * t.price
    count++
    if (Number.isFinite(t.timestamp) && t.timestamp > 0) {
      oldest = Math.min(oldest ?? t.timestamp, t.timestamp)
      newest = Math.max(newest ?? t.timestamp, t.timestamp)
    }
  }
  return { byToken, count, oldest, newest }
}

/** 正向是当前槽位的 token，不是 market 的 primarySide；让球对面槽位须左右互换。 */
export function slotVolumes(node: GraphNode | undefined, tokenId: string | null, sample?: VolumeSample) {
  const own = tokenId && sample ? sample.byToken[tokenId] ?? null : null
  const others = node?.sides.filter((s) => s.tokenId && s.tokenId !== tokenId) ?? []
  const amounts = others.map((s) => sample?.byToken[s.tokenId!] ?? null)
  const opposite = amounts.length && amounts.every((v) => v != null)
    ? amounts.reduce<number>((sum, v) => sum + (v ?? 0), 0)
    : null
  return { own, opposite }
}
