import { useMemo, useState } from 'react'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useRevenueDashboard, useStakerDistributions } from '../hooks/useExplorerData'
import { AddrPill, ChartSkeleton, F, compactAmount } from '../components/ui'
import { ChartLegend, ShareBar, StackedColumnChart } from '../components/HdxCharts'
import type { ShareSegment, StackColumn } from '../components/HdxCharts'
import { ChartTooltipRow as TipRow, DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { RevenueFlow } from '../components/RevenueFlow'
import {
  REVENUE_STREAMS_ORDERED, REVENUE_STREAM_COLOR, REVENUE_STREAM_LABEL,
  STAKER_POTS_ORDERED, STAKER_POT_COLOR, STAKER_POT_LABEL,
} from '../components/revenueColors'
import { monthDayLabel } from '../utils/dashboardDates'
import type { RevenueDashboard, RevenueRange, RevenueStream, StakerDistributions, StakerPoint, StakerPot } from '../types'
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

type StakerUnit = 'usd' | 'hdx'

const hdxAmount = (v: number): string => `${compactAmount(v)} HDX`

function stakerColumns(d: StakerDistributions, range: RevenueRange, unit: StakerUnit): StackColumn[] {
  const byPot = new Map<StakerPot, Map<number, StakerPoint>>()
  for (const s of d.series) byPot.set(s.pot, new Map(s.points.map(p => [p.t, p])))
  const ts = [...new Set(d.series.flatMap(s => s.points.map(p => p.t)))].sort((a, b) => a - b)
  const labelEvery = Math.max(1, Math.ceil(ts.length / 12))
  const fmt = unit === 'usd' ? F.usd : hdxAmount
  return ts.map((t, i) => {
    const parts = STAKER_POTS_ORDERED
      .map(pot => ({ pot, point: byPot.get(pot)?.get(t) }))
      .filter((p): p is { pot: StakerPot; point: StakerPoint } => (p.point?.[unit] ?? 0) > 0)
    const totalUsd = parts.reduce((sum, p) => sum + p.point.usd, 0)
    const totalHdx = parts.reduce((sum, p) => sum + p.point.hdx, 0)
    const label = bucketLabel(range, t)
    return {
      key: String(t),
      label: i % labelEvery === 0 ? label : '',
      segments: parts.map(p => ({
        key: p.pot,
        label: STAKER_POT_LABEL[p.pot],
        color: STAKER_POT_COLOR[p.pot],
        value: p.point[unit],
      })),
      tip: (
        <>
          <strong>{label}</strong>
          {[...parts].reverse().map(p => (
            <TipRow key={p.pot} color={STAKER_POT_COLOR[p.pot]} label={STAKER_POT_LABEL[p.pot]} value={fmt(p.point[unit])} />
          ))}
          <TipRow label="Total" value={`${hdxAmount(totalHdx)} · ${F.usd(totalUsd)}`} />
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
  // The staker section carries its own timeframe, independent of the page tabs;
  // it opens on the recent month (the all-time tiles still show beside it, and
  // the full history is one tap away on All).
  const [stakerRange, setStakerRange] = useState<RevenueRange>('30d')
  const [stakerUnit, setStakerUnit] = useState<StakerUnit>('hdx')
  const { data: stakers } = useStakerDistributions(stakerRange)

  const columns = useMemo(() => (data ? historyColumns(data, range) : []), [data, range])
  const stakerCols = useMemo(() => (stakers ? stakerColumns(stakers, stakerRange, stakerUnit) : []), [stakers, stakerRange, stakerUnit])
  const stakerLegend = useMemo(() => STAKER_POTS_ORDERED
    .filter(pot => stakers?.series.some(s => s.pot === pot && s.points.length))
    .map(pot => ({ label: STAKER_POT_LABEL[pot], color: STAKER_POT_COLOR[pot] })), [stakers])
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
  const stakerRangeCaption = RANGES.find(r => r.key === stakerRange)?.caption ?? stakerRange

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

      {/* Own timeframe on purpose: the full history is this section's story. */}
      <div className="sec-title-row">
        <SecTitle title="Staker distributions" subtitle={`trade-fee HDX routed to the staking pots, ${stakerRangeCaption}`} />
        <div className="tabs" role="tablist" aria-label="Staker timeframe">
          {RANGES.map(r => (
            <button
              key={r.key}
              role="tab"
              aria-selected={stakerRange === r.key}
              className={stakerRange === r.key ? 'tab active' : 'tab'}
              onClick={() => setStakerRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pf-card">
        {!stakers && <ChartSkeleton />}
        {stakers && stakerCols.length === 0 && <div className="rev-empty">No staker distributions in this range yet.</div>}
        {stakers && stakerCols.length > 0 && (
          <>
            <div className="rev-stakers-head">
              <div className="ribbon rev-stakers-ribbon">
                {(stakerRange === 'all'
                  ? ([
                      ['all time', hdxAmount(stakers.allTime.hdx)],
                      ['value at distribution', F.usd(stakers.allTime.usd)],
                    ] as const)
                  : ([
                      [stakerRangeCaption, hdxAmount(stakers.totals.hdx)],
                      ['value at distribution', F.usd(stakers.totals.usd)],
                      ['all time', hdxAmount(stakers.allTime.hdx)],
                      ['all-time value', F.usd(stakers.allTime.usd)],
                    ] as const)
                ).map(([k, v]) => (
                  <div className="cell" key={k}>
                    <div className="k">{k}</div>
                    <div className="v">{v}</div>
                  </div>
                ))}
              </div>
              <span className="liq-toggle">
                <button className={stakerUnit === 'hdx' ? 'active' : ''} onClick={() => setStakerUnit('hdx')}>HDX</button>
                <button className={stakerUnit === 'usd' ? 'active' : ''} onClick={() => setStakerUnit('usd')}>USD</button>
              </span>
            </div>
            <StackedColumnChart columns={stakerCols} h={200} yFmt={stakerUnit === 'usd' ? v => F.usd(v) : v => compactAmount(v)} />
            <ChartLegend items={stakerLegend} />
          </>
        )}
      </div>
      <p className="rev-note">
        Half of every Omnipool trade fee leaves the pool; the fee processor converts
        it to HDX — the buyback — and hands 15% of the fee to the GIGAHDX yield pot,
        25% to the voting-rewards pot and 5% to legacy staking (referrers take the
        remaining 5%). Before 22 Jun 2026 the referrals converter and direct in-HDX
        fee legs played the same role. Treasury incentive programmes paying into the
        same pots are excluded — only fee-derived flows count. These amounts are the
        stakers' share of the trade-fee stream above, not additional revenue.
      </p>

      <p className="rev-note">
        Revenue counts what the protocol earns from usage: trade fees, liquidations,
        borrow interest and network fees. Returns on the treasury's own investments —
        for example looped PRIME or BIL allocations — are not income from users and
        are not included here.
      </p>
    </div>
  )
}
