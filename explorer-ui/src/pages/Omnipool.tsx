import { useState } from 'react'
import { useOmnipool } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths } from '../router'
import { AddrPill, AreaChart, AssetAmount, AssetChip, ChartSkeleton, Crumbs, Dash, F, rowNav } from '../components/ui'
import { ChartLegend, ShareBar, StackedAreaChart, type ShareSegment } from '../components/HdxCharts'
import { useAssetColors } from '../utils/iconColor'
import type { AssetRef } from '../types'

// The Omnipool: Hydration's shared-liquidity pool where every listed asset
// trades against the H2O hub. Current per-asset reserves with weights, caps
// and tradability, plus the sampled composition history. Asset rows land on
// each asset's own Liquidity tab.

// H2O (asset 1) never appears in the composition — it is the hub the pool
// prices everything against. Minimal ref so the header can render its amount
// with the shared conventions.
const HUB_ASSET: AssetRef = { assetId: 1, iconAssetId: 1, symbol: 'H2O', name: 'Hub asset', decimals: 12, parachainId: null }
const OTHER_COLOR = 'var(--text-low)'

export function Omnipool() {
  const { data, isLoading, isError } = useOmnipool()
  useDocumentTitle('Omnipool')
  useNow()
  // The pool's mix rotated completely while its TVL swung an order of
  // magnitude, so the share view is the readable default — the TVL chart below
  // carries the absolute scale; USD stays one click away.
  const [unit, setUnit] = useState<'share' | 'usd'>('share')
  const colorFor = useAssetColors(data ? [...data.assets.map(r => r.asset), HUB_ASSET] : [])

  const body = () => {
    if (!data) return null
    const hubUsd = data.lrnaPrice != null ? Number(data.hubReserveTotal) / 1e12 * data.lrnaPrice : null

    // Current composition bar: the table's top rows, tail folded into Other so
    // the bar stays legible (the table below has every asset).
    const priced = data.assets.filter(r => r.reserveUsd != null)
    const top = priced.slice(0, 8)
    const restUsd = priced.slice(8).reduce((s, r) => s + (r.reserveUsd ?? 0), 0)
    const segments: ShareSegment[] = [
      ...top.map(r => ({
        key: String(r.asset.assetId), label: r.asset.symbol, color: colorFor(r.asset), value: r.reserveUsd ?? 0,
        tip: <><span className="t-d">{r.asset.symbol}</span><span className="t-row">{F.amount(r.reserve, r.asset.decimals)} {r.asset.symbol}</span><span className="t-row">{F.usd(r.reserveUsd)}</span></>,
      })),
      ...(restUsd > 0 ? [{ key: 'other', label: 'Other', color: OTHER_COLOR, value: restUsd, tip: <><span className="t-d">Other assets</span><span className="t-row">{F.usd(restUsd)}</span></> }] : []),
    ]

    // Share mode normalizes each bucket to 100% of its priced total, so the
    // composition rotation stays readable across the TVL decline.
    const bucketTotals = data.history.buckets.map((_, i) =>
      data.history.composition.reduce((s, c) => s + (c.usd[i] ?? 0), 0))
    // Two listings can share a ticker (e.g. WETH via two bridges) — suffix the
    // id so their legend entries stay tellable apart.
    const symbolCounts = new Map<string, number>()
    for (const c of data.history.composition) symbolCounts.set(c.asset.symbol, (symbolCounts.get(c.asset.symbol) ?? 0) + 1)
    const compSeries = data.history.composition.map(c => ({
      key: String(c.asset.assetId),
      label: (symbolCounts.get(c.asset.symbol) ?? 0) > 1 ? `${c.asset.symbol} #${c.asset.assetId}` : c.asset.symbol,
      color: c.asset.assetId === -1 ? OTHER_COLOR : colorFor(c.asset),
      values: unit === 'share'
        ? c.usd.map((v, i) => (v == null || !(bucketTotals[i] > 0) ? null : (v / bucketTotals[i]) * 100))
        : c.usd,
    }))
    const tvlPoints = data.history.buckets.map((b, i) => ({ b, v: data.history.tvlUsd[i] })).filter(p => p.v != null)

    return (
      <>
        <div className="detail-card"><div className="dl">
          <div className="dt">TVL</div><div className="dd mono">{data.tvlUsd != null ? F.usd(data.tvlUsd) : <Dash />}</div>
          <div className="dt">Assets</div><div className="dd num">{F.int(data.assetCount)}</div>
          <div className="dt">Hub reserve</div>
          <div className="dd"><AssetAmount asset={HUB_ASSET} raw={data.hubReserveTotal} />{hubUsd != null && <span className="muted mono" style={{ marginLeft: 8 }}>{F.usd(hubUsd)}</span>}</div>
          <div className="dt">H2O price</div><div className="dd mono">{data.lrnaPrice != null ? F.priceUsd(data.lrnaPrice) : <Dash />}</div>
          <div className="dt">Pool account</div><div className="dd"><AddrPill account={data.account} /></div>
        </div></div>

        <div className="sec-title">Composition</div>
        <div className="pf-card">
          {segments.length > 0 && <>
            <ChartLegend items={segments.map(s => ({ label: s.label, color: s.color }))} />
            <ShareBar segments={segments} h={30} />
          </>}
          <div className="panel" style={{ marginTop: 14 }}><table className="tbl">
            <thead><tr><th style={{ width: 40 }}>#</th><th>Asset</th><th className="r">Reserve</th><th className="r">Value</th><th className="r">Weight</th><th className="r">Cap</th><th className="r">Tradability</th></tr></thead>
            <tbody>
              {data.assets.map((r, i) => (
                <tr key={r.asset.assetId} {...rowNav(`${paths.asset(r.asset.assetId)}?tab=liquidity`)}>
                  <td data-label="#" className="mono muted">{i + 1}</td>
                  <td data-label="Asset"><AssetChip asset={r.asset} /></td>
                  <td data-label="Reserve" className="r"><AssetAmount asset={r.asset} raw={r.reserve} /></td>
                  <td data-label="Value" className="r mono">{r.reserveUsd != null ? F.usd(r.reserveUsd) : <Dash />}</td>
                  <td data-label="Weight" className="r mono muted">{r.weightPct != null ? `${r.weightPct.toFixed(1)}%` : '—'}</td>
                  <td data-label="Cap" className="r mono muted">{r.capPct != null ? `${r.capPct.toLocaleString('en-US', { maximumFractionDigits: 1 })}%` : '—'}</td>
                  <td data-label="Tradability" className="r mono" style={r.tradable.length === 1 && r.tradable[0] === 'Frozen' ? { color: 'var(--red)' } : undefined}>
                    {r.tradable.length === 4 ? <span className="muted">Full</span> : r.tradable.join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>

        {compSeries.length > 0 && data.history.buckets.length > 1 && (
          <>
            <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Composition over time
              <span className="liq-toggle" style={{ marginLeft: 'auto' }}>
                <button className={unit === 'share' ? 'active' : ''} onClick={() => setUnit('share')}>%</button>
                <button className={unit === 'usd' ? 'active' : ''} onClick={() => setUnit('usd')}>USD</button>
              </span>
            </div>
            <div className="pf-card">
              <ChartLegend items={compSeries.map(s => ({ label: s.label, color: s.color }))} />
              <StackedAreaChart buckets={data.history.buckets} series={compSeries}
                yFmt={unit === 'share' ? v => `${parseFloat(v.toFixed(1))}%` : F.usd} showShare={unit === 'usd'} />
            </div>
          </>
        )}

        {tvlPoints.length > 1 && (
          <>
            <div className="sec-title">TVL</div>
            <div className="pf-card"><AreaChart data={tvlPoints.map(p => p.v!)} dates={tvlPoints.map(p => p.b)} color="var(--sky-deep)" floor={0} /></div>
          </>
        )}
      </>
    )
  }

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Assets', to: paths.assets() }, { label: 'Omnipool' }]} />
        <div className="detail-header">
          <div className="page-title">Omnipool <span className="sub muted">shared liquidity, every asset paired with the H2O hub</span></div>
        </div>
      </div>
      {isError
        ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Failed to load the Omnipool</div>
        : isLoading || !data
          ? <><div className="detail-card"><ChartSkeleton h={120} /></div><div className="pf-card" style={{ marginTop: 14 }}><ChartSkeleton h={220} /></div></>
          : body()}
    </div>
  )
}
