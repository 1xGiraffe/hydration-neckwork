// The /revenue/users chart's columns: what accounts EARNED per stream and
// bucket, from the account-day facts (never a bucket's net). What they paid is
// stated in the page's breakdown, not charted.
import type { StackColumn } from './HdxCharts'
import { ChartTooltipRow as TipRow } from './DashboardPrimitives'
import { F } from './ui'
import { userRevenueColor, userRevenueStreamRank } from './revenueColors'
import { monthDayLabel } from '../utils/dashboardDates'
import type { RevenueRange, UserRevenueDashboard } from '../types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function bucketLabel(range: RevenueRange, t: number): string {
  const d = new Date(t * 1000)
  if (range === 'all') return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`
  return monthDayLabel(d.toISOString())
}
/**
 * Stacked columns of what accounts EARNED (Σ positive account-day facts) per
 * stream and bucket — never the bucket's net, which would let a signed stream's
 * costs eat into its earnings.
 */
export function earnedColumns(d: UserRevenueDashboard, range: RevenueRange, streams: Set<string>): StackColumn[] {
  const label = new Map(d.breakdown.map(b => [b.stream, b.label]))
  // Stacked in the palette's validated order (revenueColors.ts), never the payload's.
  const series = d.history.series.filter(s => streams.has(s.stream)).sort((a, b) => userRevenueStreamRank(a.stream) - userRevenueStreamRank(b.stream))
  const ts = [...new Set(series.flatMap(s => s.points.map(p => p.t)))].sort((a, b) => a - b)
  const by = new Map(series.map(s => [s.stream, new Map(s.points.map(p => [p.t, p.earned]))]))
  const labelEvery = Math.max(1, Math.ceil(ts.length / 12))
  return ts.map((t, i) => {
    const parts = series
      .map(s => ({ stream: s.stream, usd: by.get(s.stream)?.get(t) ?? 0 }))
      .filter(p => p.usd > 0)
    const total = parts.reduce((a, p) => a + p.usd, 0)
    const l = bucketLabel(range, t)
    return {
      key: String(t),
      label: i % labelEvery === 0 ? l : '',
      segments: parts.map(p => ({ key: p.stream, label: label.get(p.stream) ?? p.stream, color: userRevenueColor(p.stream), value: p.usd })),
      tip: (
        <>
          <strong>{l}</strong>
          {[...parts].reverse().map(p => <TipRow key={p.stream} color={userRevenueColor(p.stream)} label={label.get(p.stream) ?? p.stream} value={F.usd(p.usd)} />)}
          <TipRow label="Earned" value={F.usd(total)} />
        </>
      ),
    }
  })
}

