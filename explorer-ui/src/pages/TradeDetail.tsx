import { useEffect } from 'react'
import { useTrade } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, redirect } from '../router'
import { Crumbs, F, AddrPill, AssetChip, StatusBadge, SkeletonRows } from '../components/ui'
import type { TradeHop } from '../types'

const HDX_ASSET: TradeHop['assetIn'] = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null }

// Route flow: in-asset →(pool)→ … →(pool)→ out-asset. Amount labels come from
// the hop events; eventless Aave 1:1 wraps infer values from adjacent hops.
function RouteFlow({ hops }: { hops: TradeHop[] }) {
  if (!hops.length) return null
  return (
    <div className="trade-route">
      <AssetChip asset={hops[0].assetIn} />
      {hops.map((h, i) => (
        <span className="trade-hop" key={i}>
          <span className="hop-arrow">
            <span className="hop-pool">{h.pool}{h.poolId != null ? ` #${h.poolId}` : ''}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="2" y1="12" x2="20" y2="12" /><polyline points="14 6 20 12 14 18" /></svg>
          </span>
          <AssetChip asset={h.assetOut} />
        </span>
      ))}
    </div>
  )
}

type DisplayHop = TradeHop & { displayAmountIn: string | null; displayAmountOut: string | null }

function isAaveHop(h: TradeHop): boolean {
  return h.pool.toLowerCase() === 'aave'
}

function convertRawAmount(raw: string | null, fromDecimals: number, toDecimals: number): string | null {
  if (!raw) return null
  if (fromDecimals === toDecimals) return raw
  if (!/^\d+$/.test(raw)) return null
  const delta = Math.abs(toDecimals - fromDecimals)
  const scale = 10n ** BigInt(delta)
  const n = BigInt(raw)
  return fromDecimals < toDecimals ? String(n * scale) : String(n / scale)
}

function displayRoute(hops: TradeHop[], totalAmountIn: string, totalAmountOut: string): DisplayHop[] {
  let currentAmount: string | null = totalAmountIn
  let currentDecimals = hops[0]?.assetIn.decimals ?? 0

  return hops.map((h, i) => {
    const canInfer = isAaveHop(h)
    let displayAmountIn = h.amountIn
    let displayAmountOut = h.amountOut

    if (!displayAmountIn && canInfer) displayAmountIn = convertRawAmount(currentAmount, currentDecimals, h.assetIn.decimals)
    if (!displayAmountOut && canInfer && displayAmountIn) displayAmountOut = convertRawAmount(displayAmountIn, h.assetIn.decimals, h.assetOut.decimals)
    if (!displayAmountOut && canInfer && i === hops.length - 1) displayAmountOut = totalAmountOut
    if (!displayAmountIn && canInfer && displayAmountOut) displayAmountIn = convertRawAmount(displayAmountOut, h.assetOut.decimals, h.assetIn.decimals)

    currentAmount = displayAmountOut ?? h.amountOut
    currentDecimals = h.assetOut.decimals
    return { ...h, displayAmountIn, displayAmountOut }
  })
}

function RouteAmount({ asset, amount }: { asset: TradeHop['assetIn']; amount: string | null }) {
  return amount
    ? <AssetValue asset={asset}>{F.exact(amount, asset.decimals)}</AssetValue>
    : <span className="muted mono">—</span>
}

function AssetValue({ asset, children }: { asset: TradeHop['assetIn']; children: string }) {
  return <span className="trade-leg"><AssetChip asset={asset} /> <span className="mono">{children}</span></span>
}

function AssetAmount({ asset, amount }: { asset: TradeHop['assetIn']; amount: string | null | undefined }) {
  return amount ? <AssetValue asset={asset}>{F.exact(amount, asset.decimals)}</AssetValue> : <span className="muted mono">—</span>
}

export function TradeDetailPage({ id, slug = 'swap' }: { id: string; slug?: 'swap' | 'dca' }) {
  const { data, isLoading, isError } = useTrade(id)
  const label = slug === 'dca' ? 'DCA' : 'Swap'
  useDocumentTitle(`${label} ${id}`)
  // Canonicalize /swap ↔ /dca once the data says which it is.
  useEffect(() => {
    if (!data) return
    const canonical = data.dca ? 'dca' : 'swap'
    if (canonical !== slug) redirect(paths.activityDetail(canonical, id))
  }, [data, slug, id])

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Activity', to: '/activity?tab=trade' }, { label: id }]} />
        <div className="page-title">{label} <span className="num">{id}</span>{data && <span className="sub">{data.direction.toLowerCase()} via {data.venue}</span>}</div>
      </div>

      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>No trade found in this extrinsic</div>
        : isLoading || !data ? <div className="detail-card"><SkeletonRows /></div> : (() => {
          const extId = data.extrinsicIndex != null ? `${data.blockHeight}-${data.extrinsicIndex}` : null
          const eventId = data.eventIndex != null ? `${data.blockHeight}-${data.eventIndex}` : null
          const visibleLimit = data.limit && Number(data.limit.amount) > 0 ? data.limit : null
          const hasRoute = data.route.length > 0
          const route = displayRoute(data.route, data.amountIn, data.amountOut)
          const hasRouteTable = route.some(h => h.displayAmountIn || h.displayAmountOut || h.fee)
          return (
            <>
              <div className="detail-card"><div className="dl">
                <div className="dt">Swap</div>
                <div className="dd">
                  <span className="asset-flow">
                    <AssetAmount asset={data.assetIn} amount={data.amountIn} />
                    {' → '}
                    <AssetAmount asset={data.assetOut} amount={data.amountOut} />
                  </span>
                </div>
                <div className="dt">Value</div><div className="dd mono">{F.usd(data.valueUsd)}</div>
                {data.executionPrice != null && <>
                  <div className="dt">Execution price</div>
                  <div className="dd">
                    <span className="asset-flow">
                      <AssetValue asset={data.assetIn}>1</AssetValue>
                      {' = '}
                      <AssetValue asset={data.assetOut}>{data.executionPrice.toLocaleString(undefined, { maximumSignificantDigits: 6 })}</AssetValue>
                    </span>
                  </div>
                </>}
                {data.who && <><div className="dt">Trader</div><div className="dd"><AddrPill account={data.who} /></div></>}
                <div className="dt">Timestamp</div><div className="dd mono">{F.datetime(data.timestamp)}</div>
                <div className="dt">Result</div><div className="dd"><StatusBadge ok={data.success} /></div>
                {extId && <><div className="dt">Extrinsic</div><div className="dd mono"><Link to={paths.extrinsic(extId)} className="hash">{extId}</Link></div></>}
                {!extId && eventId && <><div className="dt">Event</div><div className="dd mono"><Link to={paths.event(eventId)} className="hash">{eventId}</Link></div></>}
                {data.extrinsicFee && <><div className="dt">Fee</div><div className="dd"><AssetAmount asset={HDX_ASSET} amount={data.extrinsicFee} /></div></>}
              </div></div>

              {hasRoute && <>
                <div className="sec-title">Route · {data.route.length} hop{data.route.length === 1 ? '' : 's'}</div>
                <div className="panel" style={{ padding: '16px 18px' }}>
                  <RouteFlow hops={data.route} />
                  {hasRouteTable && (
                    <table className="tbl" style={{ marginTop: 12 }}>
                      <thead><tr><th>Pool</th><th>In</th><th className="r">Out</th><th className="r">Pool fee</th></tr></thead>
                      <tbody>
                        {route.map((h, i) => (
                          <tr key={i}>
                            <td data-label="Pool"><span className="badge" style={{ background: 'var(--sky-soft)', color: 'var(--sky)' }}>{h.pool}{h.poolId != null ? ` #${h.poolId}` : ''}</span></td>
                            <td data-label="In"><RouteAmount asset={h.assetIn} amount={h.displayAmountIn} /></td>
                            <td data-label="Out" className="r"><RouteAmount asset={h.assetOut} amount={h.displayAmountOut} /></td>
                            <td data-label="Pool fee" className="r">{h.fee ? <AssetAmount asset={h.fee.asset} amount={h.fee.amount} /> : <span className="muted mono">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>}

              {visibleLimit && <>
                <div className="sec-title">Execution</div>
                <div className="detail-card"><div className="dl">
                  <div className="dt">{visibleLimit.kind === 'minReceived' ? 'Min received (limit)' : 'Max paid (limit)'}</div>
                  <div className="dd"><AssetAmount asset={visibleLimit.asset} amount={visibleLimit.amount} /></div>
                  <div className="dt">{visibleLimit.kind === 'minReceived' ? 'Received' : 'Paid'}</div>
                  <div className="dd">
                    {visibleLimit.kind === 'minReceived'
                      ? <AssetAmount asset={data.assetOut} amount={data.amountOut} />
                      : <AssetAmount asset={data.assetIn} amount={data.amountIn} />}
                    {visibleLimit.marginPct != null && (
                      <span className="badge" style={{ marginLeft: 8, background: 'var(--green-soft)', color: 'var(--green)' }} title={visibleLimit.kind === 'minReceived' ? 'Executed above the slippage floor by this margin' : 'Executed under the slippage ceiling by this margin'}>
                        {visibleLimit.kind === 'minReceived' ? '+' : '−'}{Math.abs(visibleLimit.marginPct).toFixed(2)}% vs limit
                      </span>
                    )}
                  </div>
                </div></div>
              </>}
            </>
          )
        })()}
    </div>
  )
}
