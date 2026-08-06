import { useState } from 'react'
import type { AssetLiquiditySource, AssetRef } from '../types'
import { useAssetLiquidity } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { Link, paths } from '../router'
import { AssetAmount, Ago, ChartSkeleton, Dash, F, PoolBadge, rowNav } from './ui'
import { ChartLegend, ShareBar, StackedAreaChart, type ShareSegment } from './HdxCharts'
import { useAssetColors } from '../utils/iconColor'

// The asset detail's Liquidity tab: every pool currently holding the asset
// (cards with composition bars, largest holding first), the asset's pooled
// amount over time stacked by source, and the pools it has left. All numbers
// come from /explorer/asset/:id/liquidity — the same loaders the pool pages
// read, so a card and the page it links to always agree.

const KIND_LABEL: Record<AssetLiquiditySource['kind'], string> = { omnipool: 'Omnipool', stableswap: 'Stableswap', xyk: 'XYK' }

// Fixed ordinal palette for the history's source bands (identity per series
// position — the API orders by peak size and folds the tail into Other, which
// always wears the neutral).
const SERIES_COLORS = ['var(--sky-deep)', 'var(--lavender-deep)', 'var(--green)', 'var(--amber)', 'var(--sky)', 'var(--lavender)']
const OTHER_COLOR = 'var(--text-low)'

function poolPath(s: { kind: AssetLiquiditySource['kind']; poolId: number | null }): string | null {
  if (s.kind === 'omnipool') return paths.omnipool()
  return s.poolId != null ? paths.pool(s.poolId) : null
}

// One current source as a composition card. The Omnipool card has no inline
// per-asset breakdown (40 assets live on /omnipool) — its bar shows the
// asset's slice of the whole pool instead.
function SourceCard({ s, asset }: { s: AssetLiquiditySource; asset: AssetRef }) {
  const colorFor = useAssetColors([asset, ...s.composition.map(c => c.asset)])
  const segments: ShareSegment[] = s.kind === 'omnipool'
    ? (s.assetUsd != null && s.tvlUsd != null && s.tvlUsd >= s.assetUsd ? [
        { key: 'self', label: asset.symbol, color: colorFor(asset), value: s.assetUsd, tip: <><span className="t-d">{asset.symbol}</span><span className="t-row">{F.usd(s.assetUsd)}</span></> },
        { key: 'rest', label: 'Rest of Omnipool', color: OTHER_COLOR, value: s.tvlUsd - s.assetUsd, tip: <><span className="t-d">Rest of Omnipool</span><span className="t-row">{F.usd(s.tvlUsd - s.assetUsd)}</span></> },
      ] : [])
    : s.tvlUsd != null
      ? s.composition.map((c, i) => ({
          key: `${c.asset.assetId}:${i}`, label: c.asset.symbol, color: colorFor(c.asset), value: c.usd ?? 0,
          tip: <><span className="t-d">{c.asset.symbol}</span><span className="t-row">{F.amount(c.amount, c.asset.decimals)} {c.asset.symbol}</span><span className="t-row">{F.usd(c.usd)}</span></>,
        }))
      : []
  const to = poolPath(s)
  const body = (
    <>
      <div className="hk" style={{ flexWrap: 'wrap', rowGap: 2 }}>
        <span>{s.name}</span>
        <PoolBadge pool={KIND_LABEL[s.kind]} />
        {s.hasPegs && <span className="badge" title="This pool trades around drifting price pegs" style={{ background: 'var(--lavender-soft)', color: 'var(--lavender-deep)' }}>pegs</span>}
        <span className="cap" style={{ marginLeft: 'auto' }}>{s.tvlUsd != null ? `${F.usd(s.tvlUsd)} TVL` : 'TVL —'}</span>
      </div>
      {segments.length > 0 && <ShareBar segments={segments} h={26} />}
      <div className="hv"><AssetAmount asset={asset} raw={s.assetAmount} link={false} /></div>
      <div className="hs">{F.usd(s.assetUsd)}{s.assetSharePct != null && <span className="muted"> · {s.assetSharePct.toFixed(1)}% of pool</span>}</div>
    </>
  )
  return to
    ? <Link to={to} className="hdx-card hdx-card-link" ariaLabel={`${s.name} pool`}>{body}</Link>
    : <div className="hdx-card">{body}</div>
}

export function AssetLiquidityTab({ asset }: { asset: AssetRef }) {
  const { data, isLoading, isError } = useAssetLiquidity(asset.assetId, true)
  const now = useNow()
  const [unit, setUnit] = useState<'amount' | 'usd'>('amount')

  if (isError) return <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Failed to load the liquidity data</div>
  if (isLoading || !data) {
    return (
      <>
        <div className="hdx-cards pool-cards" style={{ marginTop: 0 }}>
          {[0, 1, 2, 3].map(i => <div key={i} className="hdx-card" aria-hidden="true"><ChartSkeleton h={92} /></div>)}
        </div>
        <div className="pf-card" style={{ marginTop: 14 }}><ChartSkeleton h={220} /></div>
      </>
    )
  }

  // Cards for every source that arrived with an inline breakdown (the API
  // populates composition for the largest holdings; the Omnipool card renders
  // its asset-vs-rest bar without one). Everything else is a compact row.
  const isCard = (s: AssetLiquiditySource) => s.composition.length > 0 || s.kind === 'omnipool'
  const cards = data.sources.filter(isCard)
  const rest = data.sources.filter(s => !isCard(s))
  const history = data.history
  const series = history.series.map((s, i) => ({
    key: s.key,
    label: s.label,
    color: s.key === 'other' ? OTHER_COLOR : SERIES_COLORS[i % SERIES_COLORS.length],
    values: unit === 'amount' ? s.amounts : s.usd,
  }))

  return (
    <>
      {data.sources.length === 0 ? (
        <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>
          {asset.symbol} is not in any liquidity pool right now{data.former.length ? ' — its former pools are listed below' : ''}.
        </div>
      ) : (
        <>
          <div className="sec-title" style={{ marginTop: 4 }}>Current
            {/* Plain text, no AssetAmount: its icon chip breaks the title's
                baseline alignment, and the page is already about this asset. */}
            <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · {F.amount(data.totalAmount, asset.decimals)} {asset.symbol} pooled across {data.sources.length} {data.sources.length === 1 ? 'pool' : 'pools'} · {F.usd(data.totalUsd)}</span>
          </div>
          <div className="hdx-cards pool-cards" style={{ marginTop: 0 }}>
            {cards.map((s, i) => <SourceCard key={`${s.kind}:${s.poolId ?? 'omni'}:${i}`} s={s} asset={asset} />)}
          </div>
          {rest.length > 0 && (
            <div className="panel" style={{ marginTop: 14 }}><table className="tbl">
              <thead><tr><th>Pool</th><th>Venue</th><th className="r">TVL</th><th className="r">{asset.symbol} pooled</th><th className="r">Value</th></tr></thead>
              <tbody>
                {rest.map((s, i) => {
                  const to = poolPath(s)
                  return (
                    <tr key={`${s.kind}:${s.poolId ?? i}`} {...(to ? rowNav(to) : {})}>
                      <td data-label="Pool">{to ? <Link to={to} className="hash">{s.name}</Link> : s.name}</td>
                      <td data-label="Venue"><PoolBadge pool={KIND_LABEL[s.kind]} /></td>
                      <td data-label="TVL" className="r mono">{s.tvlUsd != null ? F.usd(s.tvlUsd) : <Dash />}</td>
                      <td data-label={`${asset.symbol} pooled`} className="r"><AssetAmount asset={asset} raw={s.assetAmount} /></td>
                      <td data-label="Value" className="r mono">{s.assetUsd != null ? F.usd(s.assetUsd) : <Dash />}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table></div>
          )}
        </>
      )}

      {history.buckets.length > 1 && (
        <>
          <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Pooled over time
            <span className="liq-toggle" style={{ marginLeft: 'auto' }}>
              <button className={unit === 'amount' ? 'active' : ''} onClick={() => setUnit('amount')}>{asset.symbol}</button>
              <button className={unit === 'usd' ? 'active' : ''} onClick={() => setUnit('usd')}>USD</button>
            </span>
          </div>
          <div className="pf-card">
            <ChartLegend items={series.map(s => ({ label: s.label, color: s.color }))} />
            <StackedAreaChart buckets={history.buckets} series={series} yFmt={unit === 'usd' ? F.usd : undefined} />
          </div>
        </>
      )}

      {data.former.length > 0 && (
        <>
          <div className="sec-title">Former pools
            <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · pools that no longer hold {asset.symbol}</span>
          </div>
          <div className="panel"><table className="tbl">
            <thead><tr><th>Pool</th><th>Venue</th><th className="r">Last active</th></tr></thead>
            <tbody>
              {data.former.map((f, i) => {
                const to = f.kind === 'omnipool' ? paths.omnipool() : f.poolId != null ? paths.pool(f.poolId) : null
                return (
                  <tr key={`${f.kind}:${f.poolId ?? i}`}>
                    <td data-label="Pool">{to ? <Link to={to} className="hash">{f.name}</Link> : f.name}</td>
                    <td data-label="Venue"><PoolBadge pool={KIND_LABEL[f.kind]} /></td>
                    <td data-label="Last active" className="r mono">
                      {f.lastActiveAt && f.lastActiveBlock != null ? <Link to={paths.block(f.lastActiveBlock)} className="hash"><Ago ts={f.lastActiveAt} now={now} /></Link>
                        : f.lastActiveAt ? <Ago ts={f.lastActiveAt} now={now} />
                        : <span className="muted" title="This pool predates the sampled pool history">before history</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        </>
      )}
    </>
  )
}
