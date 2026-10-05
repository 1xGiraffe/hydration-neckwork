import { useState } from 'react'
import { usePools } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, Link, setQuery, useQuery } from '../router'
import { AssetIcon, Usd, Crumbs, Dash, EmptyRow, F, PoolBadge, rowNav, TableSkeleton } from '../components/ui'
import { useAssetColors } from '../utils/iconColor'
import { fmtVolumeTvl } from '../utils/volume'
import type { PoolCompositionEntry, PoolListEntry } from '../types'
import { parsePoolType, POOL_TYPE_FILTERS, poolsOfType } from './liquidityFilter'
import { useYields } from '../hooks/usePositions'
import { PoolApr } from '../components/positions/PoolApr'
import { omnipoolAprSpan, omnipoolListingOf } from '../components/positions/liquidityModel'
import { aprText } from '../components/positions/yieldFormat'

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
// assets' app-wide resolved colours (a family pair like vDOT/aDOT is already
// separated centrally), so a row's bar matches the pool page it links to.
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
  const colors = p.composition.map(c => colorFor(c.asset))
  const to = p.kind === 'omnipool' ? paths.omnipool() : p.kind === 'uniswapv3' && p.address ? paths.v3Pool(p.address) : p.poolId != null ? paths.pool(p.poolId) : undefined
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
              <AssetIcon key={`${c.asset.assetId}:${i}`} assetId={c.asset.assetId} iconAssetId={c.asset.iconAssetId} iconAssetIds={c.asset.iconAssetIds}
                symbol={c.asset.symbol} size={22} parachainId={c.asset.parachainId} origin={c.asset.origin} />
            ))}
            {rest > 0 && <span className="liq-more mono">+{rest}</span>}
          </span>
          <span className="liq-name">
            <span className="liq-title">{p.name}</span>
            <span className="liq-sub">
              <PoolBadge pool={p.kind === 'omnipool' ? 'Omnipool' : p.kind === 'stableswap' ? 'Stableswap' : p.kind === 'uniswapv3' ? 'Uniswap v3' : 'XYK'} />
            </span>
          </span>
        </div>
      </td>
      <td data-label="Composition" className="comp-cell"><CompositionBar composition={p.composition} colors={colors} /></td>
      <td data-label="TVL" className="r mono liq-tvl">{p.tvlUsd != null ? <Usd v={p.tvlUsd} /> : <Dash />}</td>
      <td data-label="24H volume" className="r mono">{p.volume24hUsd != null ? <Usd v={p.volume24hUsd} /> : <Dash />}</td>
      <td data-label="Volume/TVL" className="r mono muted" title="24H volume over the pool's current TVL">{p.volumeTvl24h != null ? fmtVolumeTvl(p.volumeTvl24h) : <Dash />}</td>
      <td data-label="Share" className="r mono muted">{p.sharePct == null ? <Dash /> : p.sharePct < 0.1 ? '<0.1%' : F.sharePct(p.sharePct)}</td>
      <td data-label="APR" className="r"><PoolRowApr p={p} /></td>
    </tr>
  )
}

// The row's pool APR, as the pool page states it. The Omnipool has no single
// rate — each asset is its own pool (fees, farms) — so its row states the span
// of its assets' rates and the Omnipool page lists each one.
function PoolRowApr({ p }: { p: PoolListEntry }) {
  const yields = useYields()
  if (p.kind === 'omnipool') {
    const span = omnipoolAprSpan(yields.data)
    return span
      ? <span className="mono muted" title="Each Omnipool asset earns its own APR (fees and farms) — see the Omnipool page">{aprText(span[0])}–{aprText(span[1])}</span>
      : <span className="mono muted">{yields.isPending ? '…' : 'per asset'}</span>
  }
  const family = p.kind === 'uniswapv3' ? 'uniswapV3' : p.kind
  const key = p.kind === 'uniswapv3' ? p.address : p.poolId != null ? String(p.poolId) : undefined
  if (!key) return <Dash />
  // A pool whose share (or its money-market wrapper) is also an Omnipool asset
  // keeps its own rate here, with what providing it to the Omnipool earns beneath.
  const omniId = p.kind === 'stableswap' && p.poolId != null ? omnipoolListingOf(yields.data, p.poolId) : null
  const omni = omniId != null ? yields.data?.omnipool[String(omniId)]?.totalAprPct : null
  return (
    <>
      <PoolApr family={family} poolKey={key} label={p.name} />
      {omni != null && <span className="liq-apr-omni muted mono" title="What providing this pool's token to the Omnipool earns (fees, its own yield and farms)">{aprText(omni)} in Omnipool</span>}
    </>
  )
}

export function Liquidity() {
  useDocumentTitle('Liquidity')
  const { data, isLoading } = usePools()
  const [showDust, setShowDust] = useState(false)
  const type = parsePoolType(useQuery().get('type'))

  const pools = poolsOfType(data?.pools ?? [], type)
  const pooledUsd = type === 'all' ? data?.totalTvlUsd : pools.reduce((s, p) => s + (p.tvlUsd ?? 0), 0)
  const held = pools.filter(p => (p.tvlUsd ?? 0) >= DUST_USD)
  const dust = pools.filter(p => (p.tvlUsd ?? 0) < DUST_USD)
  const dustUsd = dust.reduce((s, p) => s + (p.tvlUsd ?? 0), 0)
  const rows = showDust ? [...held, ...dust] : held

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Liquidity' }]} />
        <div className="page-title">Liquidity <span className="sub">
          {data ? <><Usd v={pooledUsd} /> pooled across {held.length} {held.length === 1 ? 'pool' : 'pools'}</> : 'every pool, largest first'}
        </span></div>
      </div>

      <div className="liq-filter">
        <div className="seg-bar" role="group" aria-label="Pool type">
          {POOL_TYPE_FILTERS.map(f => (
            <button key={f.v} type="button" aria-pressed={type === f.v} className={`seg-btn${type === f.v ? ' active' : ''}`}
              onClick={() => setQuery({ type: f.v === 'all' ? null : f.v })}>{f.label}</button>
          ))}
        </div>
      </div>

      <div className="panel">
        <table className="tbl liq-tbl">
          <thead><tr><th>Pool</th><th>Composition</th><th className="r">TVL</th><th className="r">24H volume</th><th className="r">Volume/TVL</th><th className="r">Share</th><th className="r" title="Estimated APR: 30D fees at current TVL (concentrated liquidity: 7D), the legs' lending and own yield, and live farm rewards at full loyalty">APR</th></tr></thead>
          <tbody>
            {isLoading ? <TableSkeleton cols={7} rows={12} />
              : !rows.length ? <EmptyRow cols={7}>No pools</EmptyRow>
                : rows.map(p => <PoolRow key={`${p.kind}:${p.address ?? p.poolId ?? 'omnipool'}`} p={p} />)}
          </tbody>
        </table>
      </div>

      {/* The tail, named rather than dropped: a reader looking for one of these
          pairs can still find it, and everyone else is not asked to scroll past
          286 empty rows to reach nothing. */}
      {dust.length > 0 && (
        <div className="liq-dust">
          <span>{dust.length} pools hold {dustUsd > 0 ? <><Usd v={dustUsd} /> between them</> : 'nothing'}</span>
          <button type="button" className="liq-dust-toggle" onClick={() => setShowDust(v => !v)} aria-expanded={showDust}>
            {showDust ? 'hide them' : 'show them'}
          </button>
        </div>
      )}

      <div className="liq-foot muted">
        Reserves come from the newest chain snapshot. A pool whose legs have no price shows no TVL —
        it still holds tokens, they just have nothing to be worth. 24h volume counts every swap that executed in the
        pool once (a route through two pools counts in both); Volume/TVL is that over the pool's current TVL. APR is
        the pool's estimated rate — 30D fees at current TVL (concentrated liquidity: 7D), the legs' own and lending yield and
        live farms at full loyalty; hover it for the breakdown. The Omnipool row spans its assets' rates. <Link to={paths.omnipool()} className="hash">Open the Omnipool →</Link>
      </div>
    </div>
  )
}
