import { formatVolume } from '@/lib/utils'
import { tr } from '@/lib/i18n'
import { VOLUME_COLORS } from '@/lib/market-volume'

// 外缘 86，小于布局预留的 76 × 1.15；与选中描边之间仍留有空隙。
const R = 84
const GAP = 2
const Y = Math.sqrt(R * R - GAP * GAP)
const ARCS = {
  own: `M ${-GAP} ${Y} A ${R} ${R} 0 0 1 ${-GAP} ${-Y}`,
  opposite: `M ${GAP} ${Y} A ${R} ${R} 0 0 0 ${GAP} ${-Y}`,
}

export function VolumeRing({ own, opposite, max }: {
  own: number | null
  opposite: number | null
  max: number
}) {
  const values = { own, opposite }
  const labels = { own: tr('左·正向', 'Left · This side'), opposite: tr('右·反向', 'Right · Opposite') }
  return (
    <g data-volume-ring="" fill="none">
      <circle r={R} stroke="var(--color-card)" strokeWidth={6} />
      {(['own', 'opposite'] as const).map((side) => {
        const value = values[side]
        const fraction = value != null && Number.isFinite(value) && max > 0 && Number.isFinite(max)
          ? Math.min(1, Math.max(0, value / max))
          : 0
        return (
          <g key={side} data-volume-side={side}>
            <title>{`${labels[side]} · ${tr('近期成交额', 'Recent volume')} ${value == null || !Number.isFinite(value) ? '—' : formatVolume(value)}`}</title>
            <path d={ARCS[side]} stroke="var(--color-border)" strokeWidth={4} />
            {fraction > 0 && (
              <path
                d={ARCS[side]}
                pathLength={100}
                stroke={VOLUME_COLORS[side]}
                strokeWidth={4}
                strokeDasharray={`${fraction * 100} 100`}
              />
            )}
          </g>
        )
      })}
    </g>
  )
}
