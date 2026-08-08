import { usePoolActivity, usePoolDetail } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { AddrPill, Ago, AreaChart, AssetAmount, AssetChip, AssetIcon, ChartSkeleton, compactAmount, Crumbs, Dash, EmptyRow, F, PoolBadge, rowNav } from '../components/ui'
import { ChartLegend, MultiLineChart, ShareBar, StackedAreaChart, type ShareSegment } from '../components/HdxCharts'
import { ActivityTable } from '../components/ActivityTable'
import { useAssetColors } from '../utils/iconColor'
import type { PegSourceInfo, PoolDetail as PoolDetailData } from '../types'

// One stableswap or XYK pool, addressed by its share/LP token id: current
// composition (with drifting pegs and their oracle sources where the pool has
// them), parameters, the sampled history (TVL, per-asset composition, peg
// drift, LP supply) and the pool's recent activity.

const fmtPermill = (v: number) => `${(v / 10_000).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`
const fmtPerbill = (v: number) => `${(v / 10_000_000).toLocaleString('en-US', { maximumFractionDigits: 7 })}%`
const fmtPeg = (v: number) => v.toLocaleString('en-US', { minimumSignificantDigits: 4, maximumSignificantDigits: 6 })

function pegSourceLabel(src: PegSourceInfo): string {
  if (src.kind === 'value') return 'Constant'
  if (src.kind === 'mmOracle') return `MM oracle ${src.address ? `${src.address.slice(0, 6)}…${src.address.slice(-4)}` : ''}`.trim()
  return [src.source, src.oracleAsset?.symbol, src.period].filter(Boolean).join(' · ')
}

const PARAM_KIND_LABEL: Record<string, string> = {
  created: 'Created', amplification: 'Amplification', fee: 'Fee',
  'peg-source': 'Peg source', 'max-peg-update': 'Peg limit', destroyed: 'Destroyed',
}

function PoolBody({ d }: { d: PoolDetailData }) {
  const now = useNow()
  const colorFor = useAssetColors(d.assets.map(a => a.asset))
  // The pool's OWN activity, not its share token's: a swap through this pool
  // moves its member assets, so an asset-pinned feed on the share token shows
  // liquidity and share trades while the pool's swaps are invisible.
  const activity = usePoolActivity(d.poolId, 12)
  const activityRows = activity.data ?? []
  const hasPegs = d.assets.some(a => a.peg != null && a.peg.price !== 1)
  const ramping = d.amplification != null && d.amplification.current !== d.amplification.final

  const shareSegments: ShareSegment[] = d.tvlUsd != null
    ? d.assets.map((a, i) => ({
        key: `${a.asset.assetId}:${i}`, label: a.asset.symbol, color: colorFor(a.asset), value: a.usd ?? 0,
        tip: <><span className="t-d">{a.asset.symbol}</span><span className="t-row">{F.amount(a.amount, a.asset.decimals)} {a.asset.symbol}</span><span className="t-row">{F.usd(a.usd)}</span></>,
      }))
    : []

  // History models: composition in USD (nulls where a leg was unpriced or the
  // pool inactive); TVL and issuance as gap-aware line series.
  const compSeries = d.history.composition.map(c => ({
    key: String(c.asset.assetId), label: c.asset.symbol, color: colorFor(c.asset), values: c.usd,
  }))
  const hasCompUsd = compSeries.some(s => s.values.some(v => v != null))
  const tvlPoints = d.history.buckets.map((b, i) => ({ b, v: d.history.tvlUsd[i] })).filter(p => p.v != null)
  const pegSeries = (d.history.pegs ?? []).map(p => ({
    key: String(p.asset.assetId), label: p.asset.symbol, color: colorFor(p.asset), values: p.prices,
  }))
  const issuancePoints = (d.history.issuance ?? []).map((v, i) => ({ b: d.history.buckets[i], v })).filter(p => p.v != null)

  return (
    <>
      <div className="detail-card"><div className="dl">
        <div className="dt">Venue</div><div className="dd">{d.kind === 'stableswap' ? 'Stableswap' : 'XYK'}{d.destroyed && <span className="badge" style={{ marginLeft: 8, background: 'color-mix(in srgb, var(--red) 15%, transparent)', color: 'var(--red)' }}>Destroyed</span>}</div>
        <div className="dt">Pool account</div><div className="dd"><AddrPill account={d.account} /></div>
        <div className="dt">TVL</div><div className="dd mono">{d.tvlUsd != null ? F.usd(d.tvlUsd) : <Dash />}</div>
        <div className="dt">Trade fee</div><div className="dd mono">{d.feePermill != null ? fmtPermill(d.feePermill) : <Dash />}</div>
        {d.amplification != null && <>
          <div className="dt">Amplification</div>
          <div className="dd mono">{F.int(d.amplification.current)}
            {ramping && <span className="muted" style={{ marginLeft: 8 }}>ramping {F.int(d.amplification.initial)} → {F.int(d.amplification.final)} until block {F.int(d.amplification.finalBlock)}</span>}
          </div>
        </>}
        {hasPegs && d.maxPegUpdatePerbill != null && <>
          <div className="dt">Max peg drift</div>
          <div className="dd mono">{fmtPerbill(d.maxPegUpdatePerbill)} <span className="muted">per block</span></div>
        </>}
        <div className="dt">Share token</div><div className="dd"><AssetChip asset={d.shareToken} /> <span className="muted mono">#{d.poolId}</span></div>
        <div className="dt">LP supply</div><div className="dd mono">{F.amount(d.totalIssuance, d.shareToken.decimals)} <Link to={paths.holders(d.poolId)} className="hash" style={{ marginLeft: 8 }}>holders</Link></div>
        {d.createdAt && <>
          <div className="dt">Created</div>
          <div className="dd mono">{d.createdBlock != null ? <Link to={paths.block(d.createdBlock)} className="hash"><Ago ts={d.createdAt} now={now} /></Link> : <Ago ts={d.createdAt} now={now} />}</div>
        </>}
      </div></div>

      <div className="sec-title">Composition{d.destroyed && <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · last known, before the pool was destroyed</span>}</div>
      <div className="pf-card">
        {shareSegments.length > 0 && <ShareBar segments={shareSegments} h={30} />}
        <div className="panel" style={{ marginTop: shareSegments.length ? 14 : 0 }}><table className="tbl">
          <thead><tr><th>Asset</th><th className="r">Reserve</th><th className="r">Value</th><th className="r">Share</th>{hasPegs && <><th className="r">Peg</th><th>Peg source</th></>}</tr></thead>
          <tbody>
            {d.assets.map((a, i) => (
              <tr key={`${a.asset.assetId}:${i}`} {...rowNav(paths.asset(a.asset.assetId))}>
                <td data-label="Asset"><AssetChip asset={a.asset} /></td>
                <td data-label="Reserve" className="r"><AssetAmount asset={a.asset} raw={a.amount} /></td>
                <td data-label="Value" className="r mono">{a.usd != null ? F.usd(a.usd) : <Dash />}</td>
                <td data-label="Share" className="r mono muted">{a.sharePct != null ? `${a.sharePct.toFixed(1)}%` : '—'}</td>
                {hasPegs && <>
                  <td data-label="Peg" className="r mono">{a.peg ? fmtPeg(a.peg.price) : <Dash />}</td>
                  <td data-label="Peg source">{a.pegSource ? <span className="mono" style={{ fontSize: 12 }}>{pegSourceLabel(a.pegSource)}</span> : <Dash />}</td>
                </>}
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      {tvlPoints.length > 1 && (
        <>
          <div className="sec-title">TVL</div>
          <div className="pf-card"><AreaChart data={tvlPoints.map(p => p.v!)} dates={tvlPoints.map(p => p.b)} color="var(--sky-deep)" floor={0} /></div>
        </>
      )}

      {hasCompUsd && d.history.buckets.length > 1 && (
        <>
          <div className="sec-title">Composition over time</div>
          <div className="pf-card">
            <ChartLegend items={compSeries.map(s => ({ label: s.label, color: s.color }))} />
            <StackedAreaChart buckets={d.history.buckets} series={compSeries} yFmt={F.usd} />
          </div>
        </>
      )}

      {pegSeries.length > 0 && (
        <>
          <div className="sec-title">Peg drift
            <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · the on-chain rate the trading curve balances around, per unit of the pool's base asset</span>
          </div>
          <div className="pf-card">
            <ChartLegend items={pegSeries.map(s => ({ label: s.label, color: s.color }))} />
            <MultiLineChart buckets={d.history.buckets} series={pegSeries} yFmt={fmtPeg} />
          </div>
        </>
      )}

      {issuancePoints.length > 1 && (
        <>
          <div className="sec-title">LP supply</div>
          <div className="pf-card"><AreaChart data={issuancePoints.map(p => p.v!)} dates={issuancePoints.map(p => p.b)} color="var(--lavender-deep)" floor={0} valueFmt={v => `${compactAmount(v)} shares`} /></div>
        </>
      )}

      {d.paramEvents.length > 0 && (
        <>
          <div className="sec-title">Parameter changes</div>
          <div className="panel"><table className="tbl">
            <thead><tr><th style={{ width: 130 }}>When</th><th style={{ width: 120 }}>What</th><th>Change</th></tr></thead>
            <tbody>
              {d.paramEvents.map(e => (
                <tr key={`${e.blockHeight}:${e.kind}:${e.summary}`}>
                  <td data-label="When" className="mono"><Link to={paths.block(e.blockHeight)} className="hash"><Ago ts={e.timestamp} now={now} /></Link></td>
                  <td data-label="What"><PoolBadge pool={PARAM_KIND_LABEL[e.kind] ?? e.kind} /></td>
                  <td data-label="Change">{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}

      <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Activity
        <Link to={`${paths.asset(d.poolId)}?tab=activity`} className="ext-link" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>View all →</Link>
      </div>
      {activityRows.length || activity.isLoading
        ? <ActivityTable rows={activityRows} now={now} loading={activity.isLoading && !activityRows.length} pageSize={12} error={activity.error} onRetry={() => { void activity.refetch() }} />
        : <div className="panel"><table className="tbl"><tbody><EmptyRow cols={5}>No activity yet</EmptyRow></tbody></table></div>}
    </>
  )
}

export function PoolDetail({ poolId }: { poolId: number }) {
  const { data, isLoading, isError } = usePoolDetail(poolId)
  useDocumentTitle(data ? `${data.name} pool` : undefined)
  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Assets', to: paths.assets() }, { label: data?.name ?? `Pool #${poolId}` }]} />
        <div className="detail-header">
          <div className="page-title">
            {data && <AssetIcon assetId={data.shareToken.assetId} iconAssetId={data.shareToken.iconAssetId} symbol={data.shareToken.symbol} size={30} parachainId={data.shareToken.parachainId} origin={data.shareToken.origin} />}
            {' '}{data?.name ?? `Pool #${poolId}`}
            {data && <span className="sub muted" style={{ marginLeft: 8 }}><PoolBadge pool={data.kind === 'stableswap' ? 'Stableswap' : 'XYK'} /></span>}
          </div>
        </div>
      </div>
      {isError
        ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Pool not found</div>
        : isLoading || !data
          ? <><div className="detail-card"><ChartSkeleton h={120} /></div><div className="pf-card" style={{ marginTop: 14 }}><ChartSkeleton h={220} /></div></>
          : <PoolBody d={data} />}
    </div>
  )
}
