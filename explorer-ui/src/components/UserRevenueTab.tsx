import { useMemo, useState } from 'react'
import { useAccountUserRevenue, useTagUserRevenue } from '../hooks/useExplorerData'
import { useListTagUserRevenue } from '../hooks/useUser'
import { AssetChip, ChartSkeleton, F, Usd } from './ui'
import { MirroredBarChart } from './HdxCharts'
import type { MirrorBar } from './HdxCharts'
import { ChartTooltipRow as TipRow } from './DashboardPrimitives'
import { userRevenueColor } from './revenueColors'
import { useRevenueHollarColor } from '../hooks/useRevenueHollarColor'
import { userRevenueViaLabel } from './userRevenueLabels'
import { monthDayLabel } from '../utils/dashboardDates'
import { paths } from '../router'
import type { RevenueRange, UserRevenueBreakdown, UserRevenueStreamRow } from '../types'

type Scope =
  | { kind: 'account'; address: string }
  | { kind: 'tag'; tagId: string }
  | { kind: 'list-tag'; listId: string; tagId: string }

const RANGES: { key: RevenueRange; label: string }[] = [
  { key: '30d', label: '30D' },
  { key: '1y', label: '12M' },
  { key: 'all', label: 'All' },
]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const GRAIN_WORD = { day: 'by day', week: 'by week', month: 'by month' } as const
const fmtAsOf = (iso: string): string => `${iso.slice(11, 16)} UTC ${iso.slice(0, 10)}`

function pointLabel(grain: UserRevenueBreakdown['grain'], t: number): string {
  const d = new Date(t * 1000)
  if (grain === 'month') return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`
  return monthDayLabel(d.toISOString())
}

// The User Revenue tab: what this account (or tag) EARNED on Hydration, net,
// booked as it accrued — earned up, paid down per bucket, then each stream
// opened into the pots it came from (the pool, farm, market or token, with the
// custody path when the holding sat inside another one) and the asset it was
// paid in. All time equals the header's User Revenue figure (one account set,
// one read). Facts the fold classed `protocol` on these accounts (the
// protocol's own balance sheet) are named beside it, never inside it.
export function UserRevenueTab({ scope }: { scope: Scope }) {
  // HOLLAR interest's row dot and chart series wear HOLLAR's resolved colour.
  useRevenueHollarColor()
  const [range, setRange] = useState<RevenueRange>('all')
  const account = useAccountUserRevenue(scope.kind === 'account' ? scope.address : null, range)
  const tag = useTagUserRevenue(scope.kind === 'tag' ? scope.tagId : null, range)
  const listTag = useListTagUserRevenue(scope.kind === 'list-tag' ? scope.listId : null, scope.kind === 'list-tag' ? scope.tagId : null, range)
  const query = scope.kind === 'account' ? account : scope.kind === 'tag' ? tag : listTag
  const data = query.data
  const noun = scope.kind === 'account' ? 'account' : 'tag'

  const [toggled, setToggled] = useState<Set<string> | null>(null)
  const expanded = useMemo(() => {
    if (toggled) return toggled
    const first = data?.streams.find(s => s.items.length > 1 || s.otherCount > 0)
    return new Set(first ? [first.stream] : [])
  }, [toggled, data])
  const toggle = (stream: string) => {
    const next = new Set(expanded)
    if (next.has(stream)) next.delete(stream)
    else next.add(stream)
    setToggled(next)
  }

  const labels = useMemo(() => new Map((data?.streams ?? []).map(s => [s.stream, s.label])), [data])
  const bars: MirrorBar[] = useMemo(() => (data?.points ?? []).map(p => ({
    key: new Date(p.t * 1000).toISOString().slice(0, 10),
    up: p.earned,
    down: -p.paid,
    tip: (
      <>
        <strong>{pointLabel(data!.grain, p.t)}</strong>
        {p.streams.map(s => <TipRow key={s.stream} color={userRevenueColor(s.stream)} label={labels.get(s.stream) ?? s.stream} value={F.usd(s.net)} />)}
        <TipRow label="Net" value={F.usd(p.net)} />
      </>
    ),
  })), [data, labels])
  const ticks = useMemo(() => {
    const pts = data?.points ?? []
    const every = Math.max(1, Math.ceil(pts.length / 8))
    return pts.map((p, i) => ({ i, label: pointLabel(data!.grain, p.t) })).filter(t => t.i % every === 0)
  }, [data])

  const head = (
    <div className="ur-tab-head">
      <div className="ur-kpis">
        {([
          ['Earned', data?.totals.earned],
          ['Paid', data?.totals.paid],
          ['User Revenue', data?.totals.net],
        ] as const).map(([k, v]) => (
          <div className="cell" key={k}>
            <div className="k">{k}</div>
            <div className={`v mono${k !== 'Earned' && (v ?? 0) < 0 ? ' ur-neg' : ''}`}>{v != null ? <Usd v={v} /> : '—'}</div>
          </div>
        ))}
      </div>
      <div className="tabs" role="tablist" aria-label="Timeframe">
        {RANGES.map(r => (
          <button key={r.key} role="tab" aria-selected={range === r.key} className={range === r.key ? 'tab active' : 'tab'} onClick={() => setRange(r.key)}>{r.label}</button>
        ))}
      </div>
    </div>
  )

  if (query.isError) return <div className="pf-card"><div className="rev-empty">Couldn’t load User Revenue.</div></div>
  if (!data) return <div className="pf-card">{head}<ChartSkeleton /></div>

  const protocolNet = data.otherClasses.filter(c => c.holderClass !== 'user').reduce((a, c) => a + c.net, 0)

  return (
    <>
      <div className="pf-card">
        {head}
        {!data.complete && <div className="rev-empty">Not every month is published yet: these figures are partial.</div>}
        {data.streams.length === 0
          ? <div className="rev-empty">No User Revenue recorded for this {noun} {range === 'all' ? 'yet' : 'in this range'}.</div>
          : (
            <>
              {bars.length > 0 && <MirroredBarChart data={bars} h={170} xTicks={ticks} upColor="var(--green)" downColor="var(--red)" />}
              <table className="tbl rev-breakdown-tbl ur-breakdown-tbl">
                <thead>
                  <tr><th>Stream</th><th className="num">Earned</th><th className="num">Paid</th><th className="num">Net</th></tr>
                </thead>
                <tbody>
                  {data.streams.map(s => <StreamRows key={s.stream} stream={s} open={expanded.has(s.stream)} onToggle={() => toggle(s.stream)} />)}
                </tbody>
              </table>
            </>
          )}
      </div>
      {protocolNet !== 0 && (
        <p className="rev-note">
          These accounts are also the protocol’s own balance sheet: <Usd v={protocolNet} /> of income on them is classed
          protocol or unattributed and is not User Revenue.
        </p>
      )}
      <p className="rev-note">
        What this {noun} earned on Hydration, {GRAIN_WORD[data.grain]}, net: liquidity-provider fees, farm and staking
        rewards, lending interest and incentives, token accrual and referrer commissions, less borrow interest, exit fees and
        forfeited staking rewards — booked as it accrued, valued at the hour’s closed candle
        {data.asOf ? `, as of ${fmtAsOf(data.asOf)}` : ''}. Farm and voting figures can still be revised. See the <a href={paths.revenueUsers()}>User Revenue</a> page
        for what is not measured.
      </p>
    </>
  )
}

function StreamRows({ stream, open, onToggle }: { stream: UserRevenueStreamRow; open: boolean; onToggle: () => void }) {
  const color = userRevenueColor(stream.stream)
  const expandable = stream.items.length > 1 || stream.otherCount > 0 || stream.items.some(i => i.via)
  return (
    <>
      <tr className={`revbd-stream${expandable ? ' expandable' : ''}`} onClick={expandable ? onToggle : undefined} aria-expanded={expandable ? open : undefined}>
        <td data-label="Stream">
          <span className="rev-dot" style={{ background: color, marginRight: 8 }} />
          {stream.label}
          {stream.revisable && <span className="ur-tag" title="A later chain event can still move this figure">revisable</span>}
          {stream.unpriced > 0 && <span className="ur-tag ur-tag-muted" title="Facts booked but not valued: counted, never valued at $0">{F.count(stream.unpriced)} unpriced</span>}
          {expandable && <span className="revbd-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>}
        </td>
        <td className={`num mono${stream.earned ? '' : ' ur-empty'}`} data-label="Earned">{stream.earned ? <Usd v={stream.earned} /> : '—'}</td>
        <td className={`num mono ur-neg-cell${stream.paid ? '' : ' ur-empty'}`} data-label="Paid">{stream.paid ? <Usd v={stream.paid} /> : '—'}</td>
        <td className={`num mono${stream.net < 0 ? ' ur-neg' : ''}`} data-label="Net"><Usd v={stream.net} /></td>
      </tr>
      {expandable && open && stream.items.map(i => (
        <tr className="revbd-asset" key={`${i.pot}|${i.via}|${i.asset.assetId}`}>
          <td data-label="From">
            <span className="revbd-asset-cell">
              <AssetChip asset={i.asset} />
              <span>
                {i.potLabel}
                {i.via && <span className="ur-via">via {userRevenueViaLabel(i.via)}</span>}
              </span>
            </span>
          </td>
          <td className="num mono muted ur-sub" data-label="Earned">{i.earned ? <Usd v={i.earned} /> : '—'}</td>
          <td className="num mono muted ur-sub" data-label="Paid">{i.paid ? <Usd v={i.paid} /> : '—'}</td>
          <td className={`num mono${i.net < 0 ? ' ur-neg' : ''}`} data-label="Net"><Usd v={i.net} /></td>
        </tr>
      ))}
      {expandable && open && stream.otherCount > 0 && (
        <tr className="revbd-asset revbd-other">
          <td data-label="From"><span className="muted">{stream.otherCount} more</span></td>
          <td />
          <td />
          <td className="num mono muted" data-label="Net"><Usd v={stream.otherNet} /></td>
        </tr>
      )}
    </>
  )
}
