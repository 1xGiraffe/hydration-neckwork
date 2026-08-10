import { useState } from 'react'
import { usePools } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, Link } from '../router'
import { AssetIcon, Crumbs, Dash, EmptyRow, F, PoolBadge, rowNav, TableSkeleton } from '../components/ui'
import { useAssetColors } from '../utils/iconColor'
import { separateSeriesColors } from '../utils/seriesColors'
import type { PoolCompositionEntry, PoolListEntry } from '../types'

// Where the chain's money sits.
//
// The page's one job is to rank every venue by what it holds — but a pool is
// not a single number, it is a MIXTURE, and that is the fact a table of TVL
// alone throws away. So every row draws its own composition, and the page reads
// as a descending cascade of mixtures: a 50/50 basket and a venue holding
// twenty slivers are different shapes long before you read their numbers.
//
// Most pools hold nothing. Of 307 pools, 286 hold under $100 between them and
// 278 cannot be priced at all — the long tail of XYK pairs of tokens nothing
// trades. Listing them flat would bury the twenty that matter, so the dust
// folds behind one honest line that says exactly what is folded and unfolds in
// place. Nothing is hidden permanently; the page just does not open on it.

const DUST_USD = 100

// A pool's composition as one bar, at row scale: no axes, no tooltip, no
// hover state — the pool's own page carries the full chart. Segments are the
// assets' own icon colours, separated when two of a family would otherwise be
// the same colour (vDOT and aDOT are both Polkadot pink).
function CompositionBar({ composition, colors }: { composition: PoolCompositionEntry[]; colors: string[] }) {
  const priced = composition.filter(c => (c.usd ?? 0) > 0)
  if (!priced.length) return <span className="muted mono comp-none">no priced legs</span>
  const total = priced.reduce((s, c) => s + (c.usd ?? 0), 0)
  return (
    <span className="comp-bar" role="img"
      aria-label={priced.map(c => `${c.asset.symbol} ${Math.round(c.sharePct ?? 0)}%`).join(', ')}>
      {priced.map((c, i) => (
        <span key={`${c.asset.assetId}:${i}`} className="comp-seg"
          style={{ width: `${((c.usd ?? 0) / total) * 100}%`, background: colors[composition.indexOf(c)] ?? colors[i] }}
          title={`${c.asset.symbol} · ${F.usd(c.usd)} · ${Math.round(c.sharePct ?? 0)}%`} />
      ))}
    </span>
  )
}

function PoolRow({ p }: { p: PoolListEntry }) {
  const colorFor = useAssetColors(p.composition.map(c => c.asset))
  const colors = separateSeriesColors(p.composition.map(c => colorFor(c.asset)))
  const to = p.kind === 'omnipool' ? paths.omnipool() : p.poolId != null ? paths.pool(p.poolId) : undefined
  // Four icons is where a row stops reading as a set and starts reading as a
  // crowd; the rest is a count, and the bar already shows the whole mixture.
  const shown = p.composition.slice(0, 4)
  const rest = p.composition.length - shown.length
  return (
    <tr {...(to ? rowNav(to) : {})}>
      <td data-label="Pool">
        <div className="liq-pool">
          <span className="icon-stack">
            {shown.map((c, i) => (
              <AssetIcon key={`${c.asset.assetId}:${i}`} assetId={c.asset.assetId} iconAssetId={c.asset.iconAssetId}
                symbol={c.asset.symbol} size={22} parachainId={c.asset.parachainId} origin={c.asset.origin} />
            ))}
            {rest > 0 && <span className="liq-more mono">+{rest}</span>}
          </span>
          <span className="liq-name">
            <span className="liq-title">{p.name}</span>
            <span className="liq-sub">
              <PoolBadge pool={p.kind === 'omnipool' ? 'Omnipool' : p.kind === 'stableswap' ? 'Stableswap' : 'XYK'} />
            </span>
          </span>
        </div>
      </td>
      <td data-label="Composition" className="comp-cell"><CompositionBar composition={p.composition} colors={colors} /></td>
      <td data-label="TVL" className="r mono liq-tvl">{p.tvlUsd != null ? F.usd(p.tvlUsd) : <Dash />}</td>
      <td data-label="Share" className="r mono muted">{p.sharePct != null ? `${p.sharePct < 0.1 ? '<0.1' : p.sharePct.toFixed(1)}%` : <Dash />}</td>
    </tr>
  )
}

export function Liquidity() {
  useDocumentTitle('Liquidity')
  const { data, isLoading } = usePools()
  const [showDust, setShowDust] = useState(false)

  const pools = data?.pools ?? []
  const held = pools.filter(p => (p.tvlUsd ?? 0) >= DUST_USD)
  const dust = pools.filter(p => (p.tvlUsd ?? 0) < DUST_USD)
  const dustUsd = dust.reduce((s, p) => s + (p.tvlUsd ?? 0), 0)
  const rows = showDust ? [...held, ...dust] : held

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Liquidity' }]} />
        <div className="page-title">Liquidity <span className="sub">
          {data ? <>{F.usd(data.totalTvlUsd)} pooled across {held.length} {held.length === 1 ? 'pool' : 'pools'}</> : 'every pool, largest first'}
        </span></div>
      </div>

      <div className="panel">
        <table className="tbl liq-tbl">
          <thead><tr><th>Pool</th><th>Composition</th><th className="r">TVL</th><th className="r">Share</th></tr></thead>
          <tbody>
            {isLoading ? <TableSkeleton cols={4} rows={12} />
              : !rows.length ? <EmptyRow cols={4}>No pools</EmptyRow>
                : rows.map(p => <PoolRow key={`${p.kind}:${p.poolId ?? 'omnipool'}`} p={p} />)}
          </tbody>
        </table>
      </div>

      {/* The tail, named rather than dropped: a reader looking for one of these
          pairs can still find it, and everyone else is not asked to scroll past
          286 empty rows to reach nothing. */}
      {dust.length > 0 && (
        <div className="liq-dust">
          <span>{dust.length} pools hold {dustUsd > 0 ? `${F.usd(dustUsd)} between them` : 'nothing'}</span>
          <button type="button" className="liq-dust-toggle" onClick={() => setShowDust(v => !v)} aria-expanded={showDust}>
            {showDust ? 'hide them' : 'show them'}
          </button>
        </div>
      )}

      <div className="liq-foot muted">
        Reserves come from the newest chain snapshot. A pool whose legs have no price shows no TVL —
        it still holds tokens, they just have nothing to be worth. <Link to={paths.omnipool()} className="hash">Open the Omnipool →</Link>
      </div>
    </div>
  )
}
