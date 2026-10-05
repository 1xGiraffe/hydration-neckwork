import { useMemo } from 'react'
import { earnedColumns } from '../components/userRevenueColumns'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useRevenueHollarColor } from '../hooks/useRevenueHollarColor'
import { useUserRevenueDashboard } from '../hooks/useExplorerData'
import { AddrPill, ChartSkeleton, Crumbs, F, Usd } from '../components/ui'
import { ChartLegend, StackedColumnChart } from '../components/HdxCharts'
import { DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { userRevenueColor, userRevenueStreamRank } from '../components/revenueColors'
import { breakdownWindowNote, userRevenueCauseLabel, userRevenueLagNote } from '../components/userRevenueLabels'
import type { RevenueRange, UserRevenueStreamSummary } from '../types'
import { paths, setQuery, useQueryValue } from '../router'

// /revenue/users — what users EARN on Hydration, net, booked as it accrues:
// the headline windows (closed hours), and over the chosen range the history
// of what was earned (costs are stated in the breakdown, never charted), the
// per-stream breakdown with earned / paid / net, what the fold booked but no user holds (protocol accounts and
// named unattributed causes), and the top earners (net). Every figure
// reads the published folds only: "through" the end of the newest closed hour.

const RANGES: { key: RevenueRange; label: string; caption: string; param: string | null }[] = [
  { key: '30d', label: '30D', caption: 'last 30 days', param: null },
  { key: '1y', label: '12M', caption: 'last 12 months', param: '12m' },
  { key: 'all', label: 'All', caption: 'all time', param: 'all' },
]
const rangeOfParam = (raw: string): RevenueRange => (raw === '12m' || raw === '1y' ? '1y' : raw === 'all' ? 'all' : '30d')
const fmtThrough = (iso: string): string => `${iso.slice(11, 16)} UTC ${iso.slice(0, 10)}`

function StreamCell({ b }: { b: UserRevenueStreamSummary }) {
  return (
    <td data-label="Stream" title={`Coverage: ${b.coverage}`}>
      <span className="rev-dot" style={{ background: userRevenueColor(b.stream), marginRight: 8 }} />
      {b.label}
      {b.revisable && <span className="ur-tag" title="A later chain event can still move this figure (a farm sync, a voting record)">revisable</span>}
      {b.unpriced > 0 && <span className="ur-tag ur-tag-muted" title="Facts booked but not valued (no price for the asset at the time): counted, never valued at $0">{F.count(b.unpriced)} unpriced</span>}
    </td>
  )
}

export function RevenueUsers() {
  useDocumentTitle('User Revenue')
  // HOLLAR interest's dot, series and legend swatch wear HOLLAR's resolved colour.
  useRevenueHollarColor()
  const range = rangeOfParam(useQueryValue('range', '30d'))
  const { data, isError } = useUserRevenueDashboard(range)
  // Referrer commissions are a stream like any other here (booked at claim time,
  // not per trade), always counted.
  const shown = useMemo(() => data?.breakdown ?? [], [data])
  // Every shown stream feeds the chart with what it earned (a signed stream's
  // costs are the breakdown's Paid column, never netted into its columns).
  const shownStreams = useMemo(() => new Set(shown.map(b => b.stream)), [shown])
  const incomeCols = useMemo(() => (data ? earnedColumns(data, range, shownStreams) : []), [data, range, shownStreams])
  // The legend in the chart's stack order (the palette's validated order).
  const ranked = useMemo(() => [...shown].sort((a, b) => userRevenueStreamRank(a.stream) - userRevenueStreamRank(b.stream)), [shown])
  const legend = useMemo(() => ranked.filter(b => b.earned > 0).map(b => ({ label: b.label, color: userRevenueColor(b.stream) })), [ranked])
  // The total row is the api's exact sum over every stream, snapped once — a sum of the
  // rows' snapped figures would drop each stream's sub-cent remainder. (An older api
  // without it: the rows' sum.)
  const total = useMemo(() => data?.breakdownTotal ?? {
    earned: shown.reduce((a, b) => a + b.earned, 0), paid: shown.reduce((a, b) => a + b.paid, 0), net: shown.reduce((a, b) => a + b.net, 0),
  }, [data, shown])
  const through = data?.publishedThrough ? fmtThrough(data.publishedThrough) : null
  const breakdownWindow = data ? breakdownWindowNote(data.fromDay, data.accountPublishedThrough, data.accountComplete) : null

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Revenue', to: paths.revenue() }, { label: 'User Revenue' }]} />
        <h1 className="page-title">User Revenue</h1>
      </div>

      <div className="panel rev-hero">
        <div className="ribbon rev-hero-ribbon rev-hero-ribbon-solo">
          {([
            ['24H', data?.totals.day],
            ['7D', data?.totals.week],
            ['30D', data?.totals.month],
            ['All time', data?.totals.allTime],
          ] as const).map(([k, v]) => (
            <div className="cell" key={k} title={data && v == null ? 'Not every hour of this window is published yet' : undefined}>
              <div className="k">{k}</div>
              <div className="v">{v != null ? <Usd v={v} /> : '—'}</div>
            </div>
          ))}
        </div>
        <div className="rev-asof">
          {through ? `closed hours through ${through}${userRevenueLagNote(data?.publishedThrough)} · recent hours may be restated` : data ? 'not published yet' : 'loading'}
          {data && !data.complete && ' · some hours are not published yet'}
        </div>
      </div>

      <div className="rev-controls">
        <div className="tabs" role="tablist" aria-label="Timeframe">
          {RANGES.map(r => (
            <button key={r.key} role="tab" aria-selected={range === r.key} className={range === r.key ? 'tab active' : 'tab'} onClick={() => setQuery({ range: r.param })}>
              {r.label}
            </button>
          ))}
        </div>
        {/* The sections below are UTC days of the account facts, not the closed hours of the ribbon above. */}
        {breakdownWindow && <span className="rev-range-note">{breakdownWindow}</span>}
      </div>

      <SecTitle title="Earned" subtitle="by stream" />
      <div className="pf-card">
        {isError && <div className="rev-empty">Couldn’t load User Revenue.</div>}
        {!data && !isError && <ChartSkeleton />}
        {data && incomeCols.length === 0 && <div className="rev-empty">No User Revenue published in this range yet.</div>}
        {data && incomeCols.length > 0 && (
          <>
            <StackedColumnChart columns={incomeCols} h={230} yFmt={v => F.usd(v)} />
            <ChartLegend items={legend} />
          </>
        )}
      </div>

      {/* Breakdown and top earners side by side on desktop; stacked on phones. */}
      <div className="rev-grid ur-breakdown-grid">
        <div>
          <div className="sec-title-row">
            <SecTitle title="Breakdown" />
          </div>
          <div className="pf-card ur-table-card">
            {!data && !isError && <ChartSkeleton />}
            {data && shown.length === 0 && <div className="rev-empty">No User Revenue published in this range yet.</div>}
            {data && shown.length > 0 && (
              <table className="tbl rev-breakdown-tbl ur-breakdown-tbl">
                <thead>
                  <tr><th>Stream</th><th className="num">Earned</th><th className="num">Paid</th><th className="num">Net</th></tr>
                </thead>
                <tbody>
                  {shown.map(b => (
                    <tr key={b.stream}>
                      <StreamCell b={b} />
                      <td className={`num mono${b.earned ? '' : ' ur-empty'}`} data-label="Earned">{b.earned ? <Usd v={b.earned} /> : '—'}</td>
                      <td className={`num mono ur-neg-cell${b.paid ? '' : ' ur-empty'}`} data-label="Paid">{b.paid ? <Usd v={b.paid} /> : '—'}</td>
                      <td className={`num mono${b.net < 0 ? ' ur-neg' : ''}`} data-label="Net"><Usd v={b.net} /></td>
                    </tr>
                  ))}
                  <tr className="ur-total-row">
                    <td data-label="Stream">User Revenue</td>
                    <td className="num mono" data-label="Earned"><Usd v={total.earned} /></td>
                    <td className="num mono" data-label="Paid"><Usd v={total.paid} /></td>
                    <td className={`num mono${total.net < 0 ? ' ur-neg' : ''}`} data-label="Net"><Usd v={total.net} /></td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div>
          <SecTitle title="Top earners" subtitle="net" />
          <div className="panel">
            {!data && <ChartSkeleton />}
            {data && data.topEarners.length === 0 && <div className="rev-empty">No earners in this range yet.</div>}
            {data && data.topEarners.length > 0 && (
              <table className="tbl">
                <thead><tr><th>Account</th><th className="num">User Revenue</th></tr></thead>
                <tbody>
                  {data.topEarners.map(r => (
                    <tr key={r.account.accountId}>
                      <td data-label="Account"><AddrPill account={r.account} noCopy /></td>
                      <td className="num mono" data-label="User Revenue"><Usd v={r.usd} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {data && data.notUser.length > 0 && (
        <>
          <SecTitle title="Not User Revenue" subtitle="booked by the same fold, held by no user" />
          <div className="pf-card ur-table-card">
            <table className="tbl rev-breakdown-tbl">
              <thead><tr><th>Held by</th><th className="num">Net</th></tr></thead>
              <tbody>
                {data.notUser.flatMap(c => [
                  <tr key={c.holderClass} className="ur-class-row">
                    <td data-label="Held by">{c.holderClass === 'protocol' ? 'Protocol accounts (treasury, pots, pallet accounts)' : 'Unattributed'}</td>
                    <td className="num mono" data-label="Net"><Usd v={c.net} /></td>
                  </tr>,
                  ...c.causes.filter(v => Math.abs(v.net) >= 0.005).slice(0, 8).map(v => (
                    <tr key={`${c.holderClass}:${v.via}`} className="revbd-asset">
                      <td data-label="Cause">{userRevenueCauseLabel(v.via)}</td>
                      <td className="num mono muted" data-label="Net"><Usd v={v.net} /></td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data && data.unmeasured.length > 0 && (
        <>
          <SecTitle title="Unmeasured" subtitle="income that exists on chain but has no measurable rate or amount — not counted, not zero" />
          <div className="pf-card">
            <ul className="ur-unmeasured">
              {data.unmeasured.map(u => <li key={u.id}><strong>{u.label}</strong> — {u.reason}</li>)}
            </ul>
          </div>
        </>
      )}

      <p className="rev-note">
        User Revenue is what accounts earn on Hydration, net, booked when the chain says it is owed rather than
        when it is claimed: liquidity-provider fees (an Omnipool position captures its payoff’s share of an inflow,
        the rest stays in the hub channel), farm rewards, lending interest and incentives, GIGAHDX and legacy staking
        rewards, yield-bearing token accrual and referrer commissions (booked at claim). Borrow interest (HOLLAR interest
        shown apart from every other borrowed asset’s), exit fees and forfeited staking rewards are paid and count negative. Price moves, swap P&amp;L and impermanent loss are not
        revenue. Values are in USD at the hour’s closed candle. Farm and voting figures can still be revised by a later
        sync or voting record. It is not additive with <a href={paths.revenueProtocol()}>Protocol Revenue</a>.
      </p>
    </div>
  )
}
