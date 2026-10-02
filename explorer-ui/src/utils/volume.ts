import type { AreaSeries } from '../components/HdxCharts'
import { F } from '../components/ui'
import { VENUE_ORDER, VENUE_COLOR, VENUE_LABEL } from '../components/volumeColors'
import { utcDay, utcSeconds } from './time'
import type { ChartWindowPayload } from '../types'
import type { WindowKey } from '../api/volume'

/** The trailing windows every volume surface states, in strip order, spelled 24H, 7D, 30D, 12M. */
export const WINDOWS: { key: WindowKey; label: string; days: number }[] = [
  { key: 'd1', label: '24H', days: 1 },
  { key: 'd7', label: '7D', days: 7 },
  { key: 'd30', label: '30D', days: 30 },
  { key: 'd365', label: '12M', days: 365 },
]

/** Volume ÷ TVL for a window, as a share of the pool ("6.8%"); a dash without a denominator. */
export function fmtVolumeTvl(ratio: number | null | undefined): string {
  return F.share(ratio)
}

/** A change against the previous period, signed ("+27.85%"); null when there was no previous volume. */
export function fmtChange(changePct: number | null | undefined): string | null {
  return changePct == null || !Number.isFinite(changePct) ? null : F.pct(changePct / 100)
}

/** The ink a change reads in: green up, red down, muted flat or unknown. */
export function changeColor(changePct: number | null | undefined): string {
  if (changePct == null || !Number.isFinite(changePct) || Math.abs(changePct) < 0.05) return 'var(--text-low)'
  return changePct > 0 ? 'var(--green)' : 'var(--red)'
}

/** The venue bands a payload carries volume in, in the fixed stack order. */
export function venueBands(chart: ChartWindowPayload, venues: string[] = VENUE_ORDER): AreaSeries[] {
  return VENUE_ORDER
    .filter(v => venues.includes(v) && (chart.series[v] ?? []).some(x => (x ?? 0) > 0))
    .map(v => ({ key: v, label: VENUE_LABEL[v], color: VENUE_COLOR[v], values: chart.series[v] }))
}

/**
 * A bar covers its bucket: an hour names its start, one day itself, a longer step its
 * first and last day. The bucket holding the payload's cut (`asOf`, the instant the
 * models end at) is still open, so its label ends at the cut instead of naming a span
 * it does not hold yet. A bucket begins at its own key, which the grid lays at or
 * before the first data hour, so its start needs no cap.
 */
export function volumeTipLabel(bucket: string, grainSec: number, asOf?: string | null): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(bucket)) return bucket
  if (grainSec > 0 && grainSec < 86_400) return `${bucket.slice(0, 16)} UTC`
  const startSec = utcSeconds(bucket)
  const cutSec = asOf ? Date.parse(asOf) / 1000 : Number.NaN
  if (grainSec > 0 && Number.isFinite(cutSec) && cutSec > startSec && cutSec < startSec + grainSec) {
    const through = asOfLabel(asOf)
    const cutDay = utcDay(cutSec)
    // A cut at midnight closes the day before it.
    if (cutSec % 86_400 === 0) {
      const lastDay = utcDay(cutSec - 86_400)
      return lastDay === bucket.slice(0, 10) ? `${lastDay} (so far)` : `${bucket.slice(0, 10)} – ${lastDay} (so far)`
    }
    return cutDay === bucket.slice(0, 10) ? `${cutDay} through ${through} (so far)` : `${bucket.slice(0, 10)} – ${cutDay} ${through} (so far)`
  }
  if (grainSec > 86_400) return `${bucket.slice(0, 10)} – ${utcDay(startSec + grainSec - 86_400)}`
  return bucket.slice(0, 10)
}

/** volumeTipLabel bound to a payload's cut, in the StackedBarChart `tipLabel` shape. */
export function volumeTipLabelAt(asOf: string | null | undefined): (bucket: string, grainSec: number) => string {
  return (bucket, grainSec) => volumeTipLabel(bucket, grainSec, asOf)
}

/** "02:00 UTC" — the hour a volume window runs to. */
export function asOfLabel(asOf: string | null | undefined): string | null {
  if (!asOf) return null
  const d = new Date(asOf)
  if (!Number.isFinite(d.getTime())) return null
  return `${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`
}
