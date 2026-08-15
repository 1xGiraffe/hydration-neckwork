import { useMemo } from 'react'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useRevenueDashboard } from '../hooks/useExplorerData'
import { AddrPill, ChartSkeleton, F } from '../components/ui'
import { ChartLegend, ShareBar, StackedColumnChart } from '../components/HdxCharts'
import type { ShareSegment, StackColumn } from '../components/HdxCharts'
import { ChartTooltipRow as TipRow, DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { RevenueFlow } from '../components/RevenueFlow'
import { REVENUE_STREAMS_ORDERED, REVENUE_STREAM_COLOR, REVENUE_STREAM_LABEL } from '../components/revenueColors'
import { monthDayLabel } from '../utils/dashboardDates'
import type { RevenueDashboard, RevenueRange, RevenueStream } from '../types'
import { setQuery, useQueryValue } from '../router'

// /revenue — the protocol's income, watchable live. The river up top streams
// every income as it lands; the body answers "how much" (ribbon), "when"
// (stacked history) and "from whom" (breakdown + top payers).

// One grain per range: daily bars for a month, weekly for a year, monthly for
// the whole era.
const RANGES: { key: RevenueRange; label: string; caption: string }[] = [
  { key: '30d', label: '30D', caption: 'last 30 days' },
  { key: '1y', label: '1Y', caption: 'last year' },
  { key: 'all', label: 'All', caption: 'all time' },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function bucketLabel(range: RevenueRange, t: number): string {
  const d = new Date(t * 1000)
  if (range === 'all') return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`
  return monthDayLabel(d.toISOString())
}

function historyColumns(d: RevenueDashboard, range: RevenueRange): StackColumn[] {
  const byStream = new Map<RevenueStream, Map<number, number>>()
  for (const s of d.history.series) byStream.set(s.stream, new Map(s.points.map(p => [p.t, p.usd])))
  const ts = [...new Set(d.history.series.flatMap(s => s.points.map(p => p.t)))].sort((a, b) => a - b)
  // The chart draws every column's label; at 90 day-columns they collide, so
  // thin the AXIS labels to ~12 while each tooltip keeps its full date.
  const labelEvery = Math.max(1, Math.ceil(ts.length / 12))
  return ts.map((t, i) => {
    const parts = REVENUE_STREAMS_ORDERED
      .map(stream => ({ stream, usd: byStream.get(stream)?.get(t) ?? 0 }))
      .filter(p => p.usd > 0)
    const total = parts.reduce((sum, p) => sum + p.usd, 0)
    const label = bucketLabel(range, t)
    return {
      key: String(t),
      label: i % labelEvery === 0 ? label : '',
      segments: parts.map(p => ({
        key: p.stream,
        label: REVENUE_STREAM_LABEL[p.stream],
        color: REVENUE_STREAM_COLOR[p.stream],
        value: p.usd,
      })),
      tip: (
        <>
          <strong>{label}</strong>
          {[...parts].reverse().map(p => (
            <TipRow key={p.stream} color={REVENUE_STREAM_COLOR[p.stream]} label={REVENUE_STREAM_LABEL[p.stream]} value={F.usd(p.usd)} />
          ))}
          <TipRow label="Total" value={F.usd(total)} />
        </>
      ),
    }
  })
}

export function Revenue() {
  useDocumentTitle('Revenue')
  const rawRange = useQueryValue('range', '30d') as RevenueRange
  const range = RANGES.some(r => r.key === rawRange) ? rawRange : '30d'
  const { data } = useRevenueDashboard(range)

  const columns = useMemo(() => (data ? historyColumns(data, range) : []), [data, range])
  const shareSegments: ShareSegment[] = useMemo(() => (data?.breakdown ?? []).map(b => ({
    key: b.stream,
    label: REVENUE_STREAM_LABEL[b.stream],
    color: REVENUE_STREAM_COLOR[b.stream],
    value: b.usd,
    tip: <TipRow color={REVENUE_STREAM_COLOR[b.stream]} label={REVENUE_STREAM_LABEL[b.stream]} value={`${F.usd(b.usd)} · ${(b.share * 100).toFixed(1)}%`} />,
  })), [data])
  const legendItems = useMemo(() => REVENUE_STREAMS_ORDERED
    .filter(s => data?.history.series.some(x => x.stream === s && x.points.length))
    .map(s => ({ label: REVENUE_STREAM_LABEL[s], color: REVENUE_STREAM_COLOR[s] })), [data])

  const rangeCaption = RANGES.find(r => r.key === range)?.caption ?? range

  return (
    <div className="wrap">
      <div className="page-head">
        <h1 className="page-title">Revenue</h1>
      </div>

      <div className="panel rev-hero">
        <RevenueFlow />
        <div className="ribbon rev-hero-ribbon">
        {([
          ['24h', data?.totals.day],
          ['7 days', data?.totals.week],
          ['30 days', data?.totals.month],
          ['All time', data?.totals.allTime],
        ] as const).map(([k, v]) => (
          <div className="cell" key={k}>
            <div className="k">{k}</div>
            <div className="v">{v != null ? F.usd(v) : '—'}</div>
          </div>
        ))}
        </div>
      </div>

      {/* One timeframe for everything below it: history bars, breakdown, top payers. */}
      <div className="rev-controls">
        <div className="tabs" role="tablist" aria-label="Timeframe">
          {RANGES.map(r => (
            <button
              key={r.key}
              role="tab"
              aria-selected={range === r.key}
              className={range === r.key ? 'tab active' : 'tab'}
              onClick={() => setQuery({ range: r.key === '30d' ? null : r.key })}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <SecTitle title="History" subtitle="protocol revenue by stream" />
      <div className="pf-card">
        {!data && <ChartSkeleton />}
        {data && columns.length === 0 && <div className="rev-empty">No revenue recorded in this range yet.</div>}
        {data && columns.length > 0 && (
          <>
            <StackedColumnChart columns={columns} h={230} yFmt={v => F.usd(v)} />
            <ChartLegend items={legendItems} />
          </>
        )}
      </div>

      <div className="rev-grid">
        <div>
          <SecTitle title="Breakdown" subtitle={rangeCaption} />
          <div className="pf-card">
            {!data && <ChartSkeleton />}
            {data && shareSegments.length === 0 && <div className="rev-empty">No revenue recorded in this range yet.</div>}
            {data && shareSegments.length > 0 && (
              <>
                <ShareBar segments={shareSegments} />
                <table className="tbl rev-breakdown-tbl">
                  <thead>
                    <tr><th>Stream</th><th className="num">Revenue</th><th className="num">Share</th></tr>
                  </thead>
                  <tbody>
                    {data.breakdown.map(b => (
                      <tr key={b.stream}>
                        <td data-label="Stream">
                          <span className="rev-dot" style={{ background: REVENUE_STREAM_COLOR[b.stream], marginRight: 8 }} />
                          {REVENUE_STREAM_LABEL[b.stream]}
                        </td>
                        <td className="num mono" data-label="Revenue">{F.usd(b.usd)}</td>
                        <td className="num mono" data-label="Share">{(b.share * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
        <div>
          <SecTitle title="Top payers" subtitle={`accounts the protocol earned the most from, ${rangeCaption}`} />
          <div className="panel">
            {!data && <ChartSkeleton />}
            {data && data.topAccounts.length === 0 && <div className="rev-empty">No attributable payers in this range yet.</div>}
            {data && data.topAccounts.length > 0 && (
              <table className="tbl">
                <thead>
                  <tr><th>Account</th><th className="num">Revenue paid</th></tr>
                </thead>
                <tbody>
                  {data.topAccounts.map(row => (
                    <tr key={row.account.accountId}>
                      <td data-label="Account"><AddrPill account={row.account} noCopy /></td>
                      <td className="num mono" data-label="Revenue paid">{F.usd(row.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <p className="rev-note">
        Revenue counts what the protocol earns from usage: trade fees, liquidations,
        borrow interest and network fees. Returns on the treasury's own investments —
        for example looped PRIME or BIL allocations — are not income from users and
        are not included here.
      </p>
    </div>
  )
}
