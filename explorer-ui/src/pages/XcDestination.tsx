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
            {data && <AssetIcon assetId={0} symbol={data.destination.symbol} size={30} origin={data.destination.origin} />}
            {' '}{data?.destination.symbol ?? slug}
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

            {/* `.dl` is a two-column grid whose cells ARE the `.dt`/`.dd` elements —
                wrapping each pair in a div leaves both unstyled and unpadded. */}
            <div className="detail-card"><div className="dl">
              <div className="dt">Chain</div>
              <div className="dd">{data.destination.chainName} <span className="muted mono">{data.destination.oneClickId}</span></div>
              <div className="dt">Reference price</div>
              <div className="dd mono">
                {data.referencePrice != null
                  ? <>{F.priceUsd(data.referencePrice)} <span className="muted">from {data.referenceSource}</span></>
                  : <Dash />}
              </div>
              <div className="dt">Cross-chain swaps</div>
              <div className="dd num">
                {F.int(data.swapCount)}
                {data.settledCount !== data.swapCount && <span className="muted">{F.int(data.settledCount)} settled</span>}
              </div>
              <div className="dt">Sold from Hydration</div>
              <div className="dd mono">{data.soldUsd != null ? F.usd(data.soldUsd) : <Dash />}</div>
              {/* Two different dollar figures on purpose: what left Hydration, and
                  what reached the recipient. The gap is both rails' fees plus the
                  solver's spread, and it is the number a reader wants. */}
              <div className="dt">Delivered</div>
              <div className="dd mono">
                {data.deliveredUsd != null
                  ? <>{F.usd(data.deliveredUsd)}
                    {data.soldUsd != null && data.soldUsd > 0 && (
                      <span className="muted">{((1 - data.deliveredUsd / data.soldUsd) * 100).toFixed(1)}% to fees and spread</span>
                    )}</>
                  : <Dash />}
              </div>
              <div className="dt">Recipients</div>
              <div className="dd num">{F.int(data.recipientCount)}</div>
              <div className="dt">Decimals</div>
              <div className="dd num">{data.destination.decimals}</div>
              <div className="dt">First swap</div>
              <div className="dd mono">{data.firstAt ? data.firstAt.slice(0, 10) : <Dash />}</div>
            </div></div>

            <div className="sec-title">Sold into it · {data.soldAssets.length}</div>
            <div className="panel"><table className="tbl">
              <thead><tr><th>Asset</th><th className="r">Swaps</th><th className="r">Amount</th><th className="r">Value</th></tr></thead>
              <tbody>
                {data.soldAssets.length ? data.soldAssets.map(a => (
                  <tr key={a.asset.assetId} {...rowNav(paths.asset(a.asset.assetId))}>
                    <td data-label="Asset"><span className="trade-leg">
                      <AssetIcon assetId={a.asset.assetId} iconAssetId={a.asset.iconAssetId} iconAssetIds={a.asset.iconAssetIds} symbol={a.asset.symbol} size={20} parachainId={a.asset.parachainId} origin={a.asset.origin} />
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
