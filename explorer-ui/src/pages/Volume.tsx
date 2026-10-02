import { useMemo, type ReactNode } from 'react'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, setQuery, useQueryValue } from '../router'
import { accountHref, AddrPill, AssetChip, AssetIcon, ChartSkeleton, Crumbs, Dash, EmptyRow, F, PoolBadge, rowNav, TableSkeleton, Usd } from '../components/ui'
import { ChartLegend, ShareBar, StackedBarChart, type AreaSeries, type ShareSegment } from '../components/HdxCharts'
import { ChartTooltipRow as TipRow, DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { usePlatformVolume, volumeApi, type PlatformVolume, type VolumeRange, type WindowStat } from '../api/volume'
import { VENUE_ORDER, venueColor, venueLabel } from '../components/volumeColors'
import { gridRefine } from '../utils/chartRefine'
import { asOfLabel, changeColor, fmtChange, fmtVolumeTvl, venueBands, volumeTipLabelAt } from '../utils/volume'

// /volume — how much trades on Hydration. Two figures, kept apart on purpose:
// ROUTED volume counts every trade once, netted across its route (the platform
// figure DefiLlama and /v1/stats/platform publish); VENUE volume counts every
// fill once in the pool it executed in, so a route through two pools counts in
// both and the venues sum to more than the routed total. The hero cards are
// routed, the bars are venues, and the tables rank the last 7 days.

// The trailing year reads 12M like every other window (`?range=12m`); the API's
// key stays `1y`, which is accepted from the URL too.
const RANGES: { key: VolumeRange; label: string; caption: string; param: string | null }[] = [
  { key: '30d', label: '30D', caption: 'last 30 days, daily', param: null },
  { key: '1y', label: '12M', caption: 'last 12 months, weekly', param: '12m' },
  { key: 'all', label: 'All', caption: 'all time, fortnightly', param: 'all' },
]
const rangeOfParam = (raw: string): VolumeRange => (raw === '12m' || raw === '1y' ? '1y' : raw === 'all' ? 'all' : '30d')

function Card({ k, v, s }: { k: string; v: ReactNode; s?: ReactNode }) {
  return (
    <div className="hdx-card">
      <div className="hk">{k}</div>
      <div className="hv">{v}</div>
      {s && <div className="hs">{s}</div>}
    </div>
  )
}

function ChangeLine({ s, tail }: { s: WindowStat; tail?: ReactNode }) {
  const label = fmtChange(s.changePct)
  return (
    <>
      {label ? <span style={{ color: changeColor(s.changePct) }}>{label}</span> : <span>no earlier period</span>}
      <span> vs the period before</span>{tail}
    </>
  )
}

function poolHref(p: PlatformVolume['topPools'][number]): string | undefined {
  if (p.venue === 'omnipool') return paths.omnipool()
  if (p.venue === 'hsm') return paths.hollar()
  if (p.venue === 'uniswapv3' && p.address) return paths.v3Pool(p.address)
  return p.poolId != null ? paths.pool(p.poolId) : undefined
}

/**
 * A ranked pool as the Liquidity page draws its rows: the pool's assets as a
 * stack of icons (four at most, then a count), the name, its venue badge under it.
 */
function PoolCell({ p }: { p: PlatformVolume['topPools'][number] }) {
  const assets = p.assets ?? []
  const shown = assets.slice(0, 4)
  const rest = assets.length - shown.length
  return (
    <div className="liq-pool">
      {shown.length > 0 && (
        <span className="icon-stack">
          {shown.map((a, i) => (
            <AssetIcon key={`${a.assetId}:${i}`} assetId={a.assetId} iconAssetId={a.iconAssetId} iconAssetIds={a.iconAssetIds}
              symbol={a.symbol} size={22} parachainId={a.parachainId} origin={a.origin} />
          ))}
          {rest > 0 && <span className="liq-more mono">+{rest}</span>}
        </span>
      )}
      <span className="liq-name">
        <span className="liq-title">{p.name}</span>
        <span className="liq-sub"><PoolBadge pool={venueLabel(p.venue)} /></span>
      </span>
    </div>
  )
}

/** A venue's place in VENUE_ORDER; a venue the UI does not know sorts last. */
function venueRank(v: string): number {
  const i = (VENUE_ORDER as string[]).indexOf(v)
  return i < 0 ? VENUE_ORDER.length : i
}

export function Volume() {
  useDocumentTitle('Volume')
  const range = rangeOfParam(useQueryValue('range', '30d'))
  const { data: d, isError } = usePlatformVolume(range)
  const bands = useMemo<AreaSeries[]>(() => (d ? venueBands(d.chart) : []), [d])
  const refine = useMemo(() => gridRefine((f, t, n) => volumeApi.platformWindow(f, t, n), bands), [bands])
  // The share bar, its legend and the table follow the charts' fixed venue order (VENUE_ORDER), not the payload's.
  const venues = useMemo(() => [...(d?.venues ?? [])].sort((a, b) => venueRank(a.venue) - venueRank(b.venue)), [d])
  const segments: ShareSegment[] = venues.filter(v => v.kpis.d7.volumeUsd > 0).map(v => ({
    key: v.venue, label: venueLabel(v.venue), color: venueColor(v.venue), value: v.kpis.d7.volumeUsd,
    tip: <TipRow color={venueColor(v.venue)} label={venueLabel(v.venue)}
      value={`${F.usd(v.kpis.d7.volumeUsd)} · ${d && d.venueTotal.d7.volumeUsd > 0 ? F.share(v.kpis.d7.volumeUsd / d.venueTotal.d7.volumeUsd) : '—'}`} />,
  }))
  const caption = RANGES.find(r => r.key === range)?.caption ?? range
  const through = asOfLabel(d?.asOf)

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Volume' }]} />
        <div className="page-title">Volume <span className="sub">{through ? `trading on Hydration, through ${through}` : 'trading on Hydration'}</span></div>
      </div>

      {isError && <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Failed to load volume</div>}

      <div className="hdx-cards" style={{ marginTop: 0 }}>
        {d ? <>
          <Card k="Routed volume · 24H" v={<Usd v={d.routed.d1.volumeUsd} />} s={<ChangeLine s={d.routed.d1} tail={<> · {F.int(d.routedTrades.d1)} trades</>} />} />
          <Card k="Routed volume · 7D" v={<Usd v={d.routed.d7.volumeUsd} />} s={<ChangeLine s={d.routed.d7} tail={<> · {F.int(d.routedTrades.d7)} trades</>} />} />
          <Card k="Routed volume · 30D" v={<Usd v={d.routed.d30.volumeUsd} />} s={<ChangeLine s={d.routed.d30} tail={<> · {F.int(d.routedTrades.d30)} trades</>} />} />
          <Card k="Venue volume · 24H" v={<Usd v={d.venueTotal.d1.volumeUsd} />} s={<>every swap in every pool it touched · 7D <Usd v={d.venueTotal.d7.volumeUsd} /></>} />
        </> : [0, 1, 2, 3].map(i => <div key={i} className="hdx-card"><ChartSkeleton h={56} /></div>)}
      </div>

      <SecTitle title="By venue" subtitle="venue volume, last 7 days" />
      <div className="pf-card">
        {!d ? <ChartSkeleton h={60} /> : segments.length === 0 ? <div className="rev-empty">Nothing traded in the last 7 days.</div> : <>
          <ChartLegend items={segments.map(s => ({ label: s.label, color: s.color }))} />
          <ShareBar segments={segments} h={30} />
          <table className="tbl vol-venue-tbl" style={{ marginTop: 14 }}>
            <thead><tr><th>Venue</th><th className="r">24H</th><th className="r">7D</th><th className="r">30D</th><th className="r">12M</th><th className="r">7D change</th></tr></thead>
            <tbody>
              {venues.filter(v => v.kpis.d365.volumeUsd > 0).map(v => (
                <tr key={v.venue}>
                  <td data-label="Venue"><span className="rev-dot" style={{ background: venueColor(v.venue), marginRight: 8 }} />{venueLabel(v.venue)}</td>
                  <td data-label="24H" className="r mono"><Usd v={v.kpis.d1.volumeUsd} /></td>
                  <td data-label="7D" className="r mono"><Usd v={v.kpis.d7.volumeUsd} /></td>
                  <td data-label="30D" className="r mono"><Usd v={v.kpis.d30.volumeUsd} /></td>
                  <td data-label="12M" className="r mono"><Usd v={v.kpis.d365.volumeUsd} /></td>
                  <td data-label="7D change" className="r mono" style={{ color: changeColor(v.kpis.d7.changePct) }}>{fmtChange(v.kpis.d7.changePct) ?? <Dash />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>}
      </div>

      <div className="sec-title-row">
        <SecTitle title="History" subtitle={`venue volume, ${caption}`} />
        <div className="tabs" role="tablist" aria-label="Timeframe">
          {RANGES.map(r => (
            <button key={r.key} role="tab" aria-selected={range === r.key} className={range === r.key ? 'tab active' : 'tab'}
              onClick={() => setQuery({ range: r.param, zvolp: null })}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pf-card">
        {!d ? <ChartSkeleton h={220} /> : bands.length === 0 ? <div className="rev-empty">Nothing traded in this range.</div> : <>
          <ChartLegend items={bands.map(b => ({ label: b.label, color: b.color }))} />
          <StackedBarChart bare key={range} buckets={d.chart.buckets} series={bands} yFmt={F.usd} zoomKey="zvolp"
            refine={refine} tipLabel={volumeTipLabelAt(d.asOf)} totalLabel="Venue volume" />
          <div className="hdx-note" title="Venue volume counts every swap once in each pool it executed in. Routed volume, in the cards above, counts each trade once, netted across its route. Drag across the chart to zoom; a few days refine to hourly bars.">
            A route counts in every pool it touched, so the bars stand taller than routed volume.
          </div>
        </>}
      </div>

      <SecTitle title="Top pools" subtitle="venue volume, last 7 days" />
      <div className="panel">
        <table className="tbl vol-pools-tbl">
          <thead><tr><th style={{ width: 40 }}>#</th><th>Pool</th><th className="r">7D volume</th><th className="r">TVL</th><th className="r" title="7-day volume over the pool's mean TVL across the 7 days">7D volume / TVL</th></tr></thead>
          <tbody>
            {!d ? <TableSkeleton cols={5} rows={10} /> : !d.topPools.length ? <EmptyRow cols={5}>No pool traded in the last 7 days</EmptyRow> : d.topPools.map((p, i) => {
              const to = poolHref(p)
              return (
                <tr key={`${p.venue}:${p.poolId ?? p.address ?? p.name}`} {...(to ? rowNav(to) : {})}>
                  <td data-label="#" className="mono muted">{i + 1}</td>
                  <td data-label="Pool"><PoolCell p={p} /></td>
                  <td data-label="7D volume" className="r mono"><Usd v={p.volume7dUsd} /></td>
                  <td data-label="TVL" className="r mono">{p.tvlUsd != null ? <Usd v={p.tvlUsd} /> : <Dash />}</td>
                  <td data-label="7D volume / TVL" className="r mono muted">{p.volumeTvl7d != null ? fmtVolumeTvl(p.volumeTvl7d) : <Dash />}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="rev-grid">
        <div>
          <SecTitle title="Top assets" subtitle="asset volume, last 7 days" />
          <div className="panel">
            <table className="tbl">
              <thead><tr><th>Asset</th><th className="r">7D volume</th><th className="r">Share</th></tr></thead>
              <tbody>
                {!d ? <TableSkeleton cols={3} rows={10} /> : !d.topAssets.length ? <EmptyRow cols={3}>No asset traded in the last 7 days</EmptyRow> : d.topAssets.map(a => (
                  <tr key={a.asset.assetId} {...rowNav(paths.asset(a.asset.assetId))}>
                    <td data-label="Asset"><AssetChip asset={a.asset} link={false} /></td>
                    <td data-label="7D volume" className="r mono"><Usd v={a.volume7dUsd} /></td>
                    <td data-label="Share" className="r mono muted">{F.sharePct(a.sharePct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <SecTitle title="Top traders" subtitle="netted trading volume, last 7 days" />
          <div className="panel">
            <table className="tbl">
              <thead><tr><th>Account</th><th className="r">7D volume</th><th className="r">Trades</th></tr></thead>
              <tbody>
                {!d ? <TableSkeleton cols={3} rows={10} /> : !d.topTraders.length ? <EmptyRow cols={3}>No trades in the last 7 days</EmptyRow> : d.topTraders.map(t => (
                  <tr key={t.account.accountId} {...rowNav(accountHref(t.account))}>
                    <td data-label="Account"><AddrPill account={t.account} noCopy /></td>
                    <td data-label="7D volume" className="r mono"><Usd v={t.volume7dUsd} /></td>
                    <td data-label="Trades" className="r mono muted">{F.int(t.trades)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <p className="rev-note" title="An asset's money-market aToken counts with it (DOT includes aDOT), so asset shares sum to twice the traded value. A trader's volume is netted per trade across its route; protocol pools, pots and pallet accounts are left out. Every figure is valued at the hourly price closed when the trade happened.">
        Asset volume counts both sides of a swap, trader volume each trade once; aToken wraps are never volume.
      </p>
    </div>
  )
}
