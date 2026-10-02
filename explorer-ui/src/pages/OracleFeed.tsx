import { useMemo, type ReactNode } from 'react'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { Link, paths, setPage, setQuery, usePageParam, useQueryValue } from '../router'
import { AddrPill, ChartSkeleton, Crumbs, EmptyRow, F, MomentLink, Pager, TableSkeleton } from '../components/ui'
import { ChartLegend, MultiLineChart, type AreaSeries } from '../components/HdxCharts'
import { DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { Age, AssetMini, ConsumerList, Dur, FeedValue, fmtRatio, isUsdPair, KindBadge, SourceCell, STATUS_LABEL, StatusDot, ageNow } from '../components/OracleParts'
import { useOracleFeed, type EmaUpdateRow, type FeedRange, type FeedUpdateRow, type OracleFeedDetail } from '../api/oracles'

// /oracle/:feed — one feed's delivery: what it is, who pushes it, who reads it,
// its cadence against its own stale rule, its value over time with the market
// beside it, and every update. An EMA pair shows its Short and Day averages and
// the last updates the explorer holds; an adapter with no history of its own (a
// composite, a constant) shows what it is made of.

/** A move between updates: two decimals, more when it is under a hundredth of a percent (a 6-hourly rate step). */
export function fmtChangePct(pct: number): string {
  const a = Math.abs(pct)
  return (pct >= 0 ? '+' : '') + pct.toFixed(a > 0 && a < 0.01 ? 4 : 2) + '%'
}

const RANGES: { key: FeedRange; label: string }[] = [
  { key: '7d', label: '7D' }, { key: '30d', label: '30D' }, { key: '12m', label: '12M' }, { key: 'all', label: 'All' },
]

function Card({ k, v, s }: { k: string; v: ReactNode; s?: ReactNode }) {
  return <div className="hdx-card"><div className="hk">{k}</div><div className="hv">{v}</div>{s && <div className="hs">{s}</div>}</div>
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="orc-detail-row"><span className="orc-detail-k">{label}</span><span className="orc-detail-v">{children}</span></div>
}

const SERIES_COLOR: Record<string, string> = { value: 'var(--accent)', market: 'var(--sky)', short: 'var(--accent)', day: 'var(--sky)' }

/** The drawn lines: a series with no point in the window is neither drawn nor named in the legend. */
export function chartSeries(chart: OracleFeedDetail['chart']): AreaSeries[] {
  return (chart?.series ?? []).filter(s => s.values.some(v => v != null)).map(s => ({
    key: s.key, label: s.label, color: SERIES_COLOR[s.key] ?? 'var(--accent)', values: s.values, dashed: s.key === 'market' || s.key === 'day',
  }))
}

function FeedChartCard({ d, range }: { d: OracleFeedDetail; range: FeedRange }) {
  const ranges = RANGES
  const usd = isUsdPair(d.label)
  const series = useMemo<AreaSeries[]>(() => chartSeries(d.chart), [d.chart])
  if (!d.chart) return null
  return (
    <>
      <div className="sec-title-row">
        <SecTitle title="History" subtitle={d.kind === 'ema' ? 'Short and Day averages, the newest update in each bucket' : d.subject ? 'feed value, with the explorer\'s market price beside it' : 'feed value'} />
        <div className="tabs" role="tablist" aria-label="Timeframe">
          {ranges.map(r => (
            <button key={r.key} role="tab" aria-selected={range === r.key} className={range === r.key ? 'tab active' : 'tab'}
              onClick={() => setQuery({ range: r.key === '30d' ? null : r.key, page: null, zorc: null })}>{r.label}</button>
          ))}
        </div>
      </div>
      <div className="pf-card">
        <ChartLegend items={series.map(s => ({ label: s.label, color: s.color, dashed: s.dashed }))} />
        <MultiLineChart key={range} buckets={d.chart.buckets} series={series} h={220} zoomKey="zorc" markLast
          yFmt={v => (usd ? (Math.abs(v) < 100 ? '$' + fmtRatio(v) : F.priceUsd(v)) : fmtRatio(v))} />
        {d.kind === 'ema' && d.ema && !d.ema.complete && <div className="hdx-note">The EMA history is still loading.</div>}
        {d.kind !== 'ema' && !d.historyComplete && <div className="hdx-note">The update history is still loading; older updates appear once it has.</div>}
      </div>
    </>
  )
}

function FeedUpdates({ d, now }: { d: OracleFeedDetail; now: number }) {
  const u = d.updates
  const usd = isUsdPair(d.label)
  const totalPages = Math.max(1, Math.ceil(u.total / u.pageSize))
  if (d.kind === 'ema') {
    const rows = u.rows as EmaUpdateRow[]
    const periods = ['LastBlock', 'Short', 'TenMinutes', 'Day'] as const
    return (
      <>
        <SecTitle title="Updates" subtitle={`the last ${F.int(u.total)} the explorer holds, newest first · 1 ${d.ema?.assetB.symbol} in ${d.ema?.assetA.symbol}`} />
        <div className="panel">
          <table className="tbl orc-tbl">
            <thead><tr><th>When</th>{periods.map(p => <th key={p} className="r">{p}</th>)}</tr></thead>
            <tbody>
              {!rows.length ? <EmptyRow cols={5}>No updates held</EmptyRow> : rows.map(r => (
                <tr key={`${r.blockHeight}:${r.eventIndex}`}>
                  <td data-label="When" className="mono"><MomentLink at={{ blockHeight: r.blockHeight, extrinsicIndex: null, timestamp: r.timestamp }} now={now} /></td>
                  {periods.map(p => <td key={p} data-label={p} className="r mono"><FeedValue value={r.prices.find(x => x.period === p)?.value ?? null} usd={false} digits={6} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && <Pager page={u.page} totalPages={totalPages} onPage={setPage} />}
      </>
    )
  }
  const rows = u.rows as FeedUpdateRow[]
  return (
    <>
      <SecTitle title="Updates" subtitle={`${F.int(u.total)} in all, newest first`} />
      <div className="panel">
        <table className="tbl orc-tbl">
          <thead><tr><th>When</th><th className="r">Value</th><th className="r">Change</th><th className="r">Interval</th><th>Pushed by</th><th className="r">Block</th></tr></thead>
          <tbody>
            {!rows.length ? <EmptyRow cols={6}>No updates</EmptyRow> : rows.map(r => (
              <tr key={`${r.blockHeight}:${r.eventIndex}`}>
                <td data-label="When" className="mono"><MomentLink at={r} now={now} /></td>
                <td data-label="Value" className="r mono"><FeedValue value={r.value} usd={usd} /></td>
                <td data-label="Change" className="r mono">{r.changePct == null ? <span className="muted">—</span> : <span style={{ color: r.changePct > 0 ? 'var(--green)' : r.changePct < 0 ? 'var(--red)' : undefined }}>{fmtChangePct(r.changePct)}</span>}</td>
                <td data-label="Interval" className="r mono"><Dur sec={r.intervalSec} /></td>
                <td data-label="Pushed by">{r.pusher ? <AddrPill account={r.pusher} noCopy /> : <span className="mono muted">{r.extrinsicIndex == null ? 'runtime' : '—'}</span>}</td>
                <td data-label="Block" className="r mono"><Link to={paths.block(r.blockHeight)} className="hash">{F.int(r.blockHeight)}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && <Pager page={u.page} totalPages={totalPages} onPage={setPage} />}
    </>
  )
}

export function OracleFeed({ feed }: { feed: string }) {
  const rangeParam = useQueryValue('range', '30d')
  const range: FeedRange = (RANGES.find(r => r.key === rangeParam)?.key ?? '30d')
  const page = usePageParam()
  const { data: d, isError, isLoading } = useOracleFeed(feed, range, page)
  const now = useNow(15_000)
  useDocumentTitle(d ? `${d.label} · Oracle` : 'Oracle')
  const usd = isUsdPair(d?.label)
  const builtAt = d?.updatedAt && d.ageSec != null ? new Date(Date.parse(d.updatedAt) + d.ageSec * 1000).toISOString() : null

  if (isError && !d) {
    return (
      <div className="wrap">
        <div className="page-head"><Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Oracles', to: paths.oracles() }, { label: 'Not found' }]} /></div>
        <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>No oracle feed {feed}</div>
      </div>
    )
  }
  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Oracles', to: paths.oracles() }, { label: d?.label ?? '…' }]} />
        <div className="page-title orc-title">
          {d ? <>{d.label} <KindBadge kind={d.kind === 'dia' ? 'dia' : d.kind === 'push' ? (d.status === 'static' ? 'fixed' : 'push') : d.kind === 'ema' ? 'ema' : d.source?.kind ?? 'unknown'} />
            <span className="sub"><StatusDot status={d.status} /> {STATUS_LABEL[d.status]}{d.provider ? ` · ${d.provider}` : ''}</span></> : 'Oracle feed'}
        </div>
      </div>

      <div className="hdx-cards" style={{ marginTop: 0 }}>
        {d ? <>
          <Card k="Latest value" v={<FeedValue value={d.latestValue} usd={usd} digits={d.kind === 'ema' ? 6 : undefined} />} s={d.ema ? `1 ${d.ema.assetB.symbol} in ${d.ema.assetA.symbol} · Short` : d.reportedAt ? `reported ${d.reportedAt.slice(0, 19).replace('T', ' ')} UTC` : undefined} />
          <Card k="Updated" v={d.status === 'static' ? 'once' : <Age sec={ageNow(d.ageSec, builtAt, now)} at={d.updatedAt} />}
            s={d.cadence ? <>stale after <Dur sec={d.cadence.staleAfterSec} /></> : d.updatedAt == null ? 'computed on every call' : undefined} />
          {d.cadence && <Card k="Updates" v={`${F.int(d.cadence.updates24h)} · 24H`} s={`${F.int(d.cadence.updates7d)} · 7D, ${F.int(d.cadence.updates30d)} · 30D${d.allTimeUpdates != null ? `, ${F.int(d.allTimeUpdates)} all time` : ''}`} />}
          {d.cadence && <Card k="Median interval" v={<Dur sec={d.cadence.medianIntervalSec} />} s={<>longest gap <Dur sec={d.cadence.longestGapSec} /> · 30D of updates</>} />}
        </> : [0, 1, 2, 3].map(i => <div key={i} className="hdx-card"><ChartSkeleton h={56} /></div>)}
      </div>

      {d && (
        <div className="pf-card orc-detail">
          {d.contract && <Row label="Contract"><Link to={paths.account(d.contract)} className="hash">{d.contract}</Link></Row>}
          {d.key && <Row label="DIA key"><span className="mono">{d.key}</span></Row>}
          {d.ema && <Row label="EMA pair"><span className="orc-pool"><span className="muted">{d.ema.sourceLabel}</span><AssetMini asset={d.ema.assetB} /><span className="muted">in</span><AssetMini asset={d.ema.assetA} /></span></Row>}
          {d.ema && d.ema.prices.length > 0 && <Row label="Periods">{d.ema.prices.map(p => <span key={p.period} className="orc-period"><span className="muted">{p.period}</span> <FeedValue value={p.value} usd={false} digits={6} /></span>)}</Row>}
          {d.pushers.length > 0 && <Row label="Pushed by">{d.pushers.slice(0, 4).map(p => <span key={p.account.accountId} className="orc-period"><AddrPill account={p.account} noCopy /> <span className="muted mono">{F.int(p.updates)}</span></span>)}</Row>}
          {d.relays.length > 0 && <Row label="Through">{d.relays.map(r => <AddrPill key={r.accountId} account={r} noCopy />)}</Row>}
          <Row label="Used by"><ConsumerList consumers={d.consumers} empty="nothing reads it" /></Row>
          {d.firstUpdateAt && <Row label="First update"><span className="mono">{d.firstUpdateAt.slice(0, 10)}</span></Row>}
          {d.source && (d.kind === 'source' || d.source.components?.length) ? <Row label="Made of"><SourceCell s={d.source} /></Row> : null}
          {d.source?.note && <Row label="Note"><span>{d.source.note}</span></Row>}
        </div>
      )}

      {isLoading && !d ? <div className="pf-card" style={{ marginTop: 18 }}><ChartSkeleton h={220} /></div> : d && <FeedChartCard d={d} range={range} />}
      {isLoading && !d ? <div className="panel" style={{ marginTop: 18 }}><table className="tbl"><tbody><TableSkeleton cols={6} rows={8} /></tbody></table></div>
        : d && d.kind !== 'source' && <FeedUpdates d={d} now={now} />}

      <div className="liq-foot muted">
        {d?.kind === 'ema'
          ? 'An EMA pair updates when its venue trades (Bifrost: when its XCM push lands). Counts and the 7D/30D chart cover the last 30 days; 12M and All reach back to February 2026, when the event began. The table lists the newest updates the explorer keeps exact.'
          : 'Ages count from the block that carried the update. Stale: older than the longest gap of its last 30 days of updates + 10 % (at least 15 min).'}
        {' '}<Link to={paths.oracles()} className="hash">All oracles →</Link>
      </div>
    </div>
  )
}
