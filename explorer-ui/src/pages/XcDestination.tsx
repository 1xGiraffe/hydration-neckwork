import { useXcDestination } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths } from '../router'
import { Crumbs, F, AssetIcon, AssetDetailSkeleton, Dash, rowNav, EmptyRow } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'

// A cross-chain swap's destination: an asset that lives on NEAR or Zcash and is
// reachable from Hydration only by selling into it.
//
// Deliberately NOT an asset page. Hydration has no holders of ZEC, no pool in it,
// no supply of it and no price feed for it, so an asset page's panels would be
// blank or borrowed. This page states what is actually knowable — what the thing
// is, a reference price from a venue that lists it, and the swaps that delivered
// it — and says outright that the asset is not held here.

export function XcDestination({ slug }: { slug: string }) {
  const { data, isLoading, isError } = useXcDestination(slug)
  const now = useNow()
  useDocumentTitle(data ? `${data.destination.symbol} · cross-chain` : undefined)

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[
          { label: 'Home', to: paths.dashboard() },
          { label: 'Assets', to: paths.assets() },
          { label: data?.destination.symbol ?? slug },
        ]} />
        <div className="detail-header">
          <div className="page-title">
            {data?.destination.symbol ?? slug}
            {data && <span className="xc-chain">on {data.destination.chainName}</span>}
          </div>
        </div>
      </div>

      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Unknown cross-chain destination</div>
        : isLoading || !data ? <AssetDetailSkeleton /> : (
          <>
            {/* Said first and plainly, because the page sits in the asset list and
                everything else here would otherwise read as an asset's figures. */}
            <div className="xc-note">
              <strong>{data.destination.symbol}</strong> lives on {data.destination.chainName}, not on Hydration.
              You cannot hold it, trade it or provide liquidity in it here — there are no holders, no pools and no supply to show.
              What Hydration can do is <em>swap out</em> into it: an order sells an asset here and a solver network delivers {data.destination.symbol} on its own chain.
            </div>

            <div className="detail-card"><div className="dl">
              <div><dt>Reference price</dt><dd>
                {data.referencePrice != null
                  ? <><span className="mono">{F.priceUsd(data.referencePrice)}</span> <span className="muted">from {data.referenceSource}</span></>
                  : <Dash />}
              </dd></div>
              <div><dt>Cross-chain swaps</dt><dd>
                <span className="mono">{F.int(data.swapCount)}</span>
                {data.settledCount !== data.swapCount && <span className="muted"> · {F.int(data.settledCount)} settled</span>}
              </dd></div>
              <div><dt>Sold from Hydration</dt><dd>{data.soldUsd != null ? <span className="mono">{F.usd(data.soldUsd)}</span> : <Dash />}</dd></div>
              {/* Two different dollar figures on purpose: what left Hydration, and
                  what reached the recipient. The gap is both rails' fees plus the
                  solver's spread, and it is the number a reader wants. */}
              <div><dt>Delivered</dt><dd>
                {data.deliveredUsd != null
                  ? <><span className="mono">{F.usd(data.deliveredUsd)}</span>
                    {data.soldUsd != null && data.soldUsd > 0 && (
                      <span className="muted"> · {((1 - data.deliveredUsd / data.soldUsd) * 100).toFixed(1)}% lost to fees and spread</span>
                    )}</>
                  : <Dash />}
              </dd></div>
              <div><dt>Recipients</dt><dd><span className="mono">{F.int(data.recipientCount)}</span></dd></div>
              <div><dt>Decimals</dt><dd><span className="mono">{data.destination.decimals}</span></dd></div>
            </div></div>

            <div className="sec-title">Sold into it · {data.soldAssets.length}</div>
            <div className="panel"><table className="tbl">
              <thead><tr><th>Asset</th><th className="r">Swaps</th><th className="r">Amount</th><th className="r">Value</th></tr></thead>
              <tbody>
                {data.soldAssets.length ? data.soldAssets.map(a => (
                  <tr key={a.asset.assetId} {...rowNav(paths.asset(a.asset.assetId))}>
                    <td data-label="Asset"><span className="trade-leg">
                      <AssetIcon assetId={a.asset.assetId} iconAssetId={a.asset.iconAssetId} symbol={a.asset.symbol} size={20} parachainId={a.asset.parachainId} origin={a.asset.origin} />
                      {' '}<span className="mono">{a.asset.symbol}</span>
                    </span></td>
                    <td data-label="Swaps" className="r mono">{F.int(a.swaps)}</td>
                    <td data-label="Amount" className="r mono">{F.amount(a.amount, a.asset.decimals)}</td>
                    <td data-label="Value" className="r mono">{a.valueUsd != null ? F.usd(a.valueUsd) : <Dash />}</td>
                  </tr>
                )) : <EmptyRow cols={4}>No cross-chain swaps into {data.destination.symbol} yet</EmptyRow>}
              </tbody>
            </table></div>

            <div className="sec-title">Recent swaps · {data.recent.length}</div>
            <ActivityTable rows={data.recent} now={now} pageSize={data.recent.length || 1} />
          </>
        )}
    </div>
  )
}
