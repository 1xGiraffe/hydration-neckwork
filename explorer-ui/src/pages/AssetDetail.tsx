import { useAsset, useAssetActivity, useHolders } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, navigate, useQuery, useQueryValue, setQuery } from '../router'
import { Crumbs, F, AssetIcon, AssetAmount, AddrPill, AssetDetailSkeleton, TableSkeleton, EmptyRow, rowNav, accountHref, TagGroupPill, ActivityChips, Pager, normalizeActivityType, normalizeActivityAction, Dash } from '../components/ui'
import { FilterZone, useFilters } from '../components/Filters'
import { activityFilterFields } from '../components/activityFilters'
import { PriceChart, ema7 } from '../components/PriceChart'
import { ActivityTable } from '../components/ActivityTable'

const PREIS_URL = (import.meta.env.VITE_PREIS_URL as string | undefined) || 'http://localhost:5173'
const PREIS_DEFAULT_QUOTE_ID = 10
const PREIS_STABLE_FALLBACK_QUOTE: Record<number, number> = { 10: 22, 22: 10 }

function preisPairUrl(assetId: number): string {
  const base = PREIS_URL.replace(/\/+$/, '')
  const quoteId = PREIS_STABLE_FALLBACK_QUOTE[assetId] ?? PREIS_DEFAULT_QUOTE_ID
  return `${base}/${assetId}-${quoteId}`
}

export function AssetDetail({ assetId, initialTab = 'activity' }: { assetId: number; initialTab?: 'holders' | 'activity' }) {
  const { data, isLoading, isError } = useAsset(assetId)
  useDocumentTitle(data ? (data.asset.price != null ? `${data.asset.symbol} ${F.priceUsd(data.asset.price)}` : data.asset.symbol) : undefined)
  const now = useNow()
  const q = useQuery()
  const rawTab = q.get('tab')
  const tab = (rawTab === 'holders' || rawTab === 'activity' ? rawTab : initialTab) as 'holders' | 'activity'
  const activityType = normalizeActivityType(useQueryValue('type', 'all'))
  // Activities filters — the same set as the global feed minus the token combo
  // (this page IS the token filter). `page` resets whenever a filter changes.
  const activityFilters = useFilters({ reservedKeys: ['tab', 'type', 'page', 'hpage'], pageKey: 'page', keys: ['action', 'from', 'to', 'min'] })
  const activityAction = normalizeActivityAction(activityType, activityFilters.values.action ?? '')
  const requestedPage = parseInt(q.get('page') ?? '', 10)
  const activityPage = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const a = data?.asset
  const chCol = (c: number | null | undefined) => c == null ? 'var(--text-low)' : c >= 0 ? 'var(--green)' : 'var(--red)'
  const emaNow = data ? ema7(data.priceSeries) : null
  // The asset activity is fetched server-side, scoped to this asset over the full
  // block range (the global activity only carries the last ~100 rows, which never
  // include low-activity assets). The type chip filters server-side too, so rare
  // categories aren't starved by the row cap.
  const ACTIVITY_PAGE = 40
  const activity = useAssetActivity(assetId, activityType, activityPage * ACTIVITY_PAGE, activityAction || undefined, tab === 'activity',
    activityFilters.values.from, activityFilters.values.to, activityFilters.values.min || undefined)
  const assetActivity = activity.data ?? []
  // Holders are paginated server-side (no cap) — fetched only while the tab is open.
  const HOLDERS_PAGE = 50
  const hp = parseInt(q.get('hpage') ?? '', 10)
  const hpage = Number.isFinite(hp) && hp > 0 ? hp : 0
  const setHpage = (p: number) => setQuery({ hpage: p > 0 ? String(p) : null })
  const holders = useHolders(assetId, hpage * HOLDERS_PAGE, HOLDERS_PAGE, tab === 'holders')
  const holderRows = holders.data?.holders ?? []
  const holderCount = data?.holderCount ?? 0
  const holderPages = Math.max(1, Math.ceil((holders.data?.total ?? holderCount) / HOLDERS_PAGE))

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Assets', to: paths.assets() }, { label: a?.symbol ?? String(assetId) }]} />
        <div className="detail-header">
          <div className="page-title">{a && <AssetIcon assetId={a.assetId} iconAssetId={a.iconAssetId} symbol={a.symbol} size={30} parachainId={a.parachainId} origin={a.origin} />} {a?.symbol ?? a?.name ?? `Asset`} <span className="sub muted">#{a?.assetId ?? assetId}</span></div>
        </div>
      </div>

      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Asset not found</div>
        : isLoading || !data || !a ? <AssetDetailSkeleton /> : (
          <>
            <div className="detail-card"><div className="dl">
              <div className="dt">Asset ID</div><div className="dd num">#{a.assetId}</div>
              <div className="dt">Name</div><div className="dd">{a.name ?? a.symbol}</div>
              <div className="dt">Decimals</div><div className="dd num">{a.decimals}</div>
              <div className="dt">Price</div><div className="dd mono">{F.priceUsd(a.price)} <span style={{ color: chCol(a.change24h), marginLeft: 8 }}>{F.pct(a.change24h)}</span>{emaNow != null && <span className="mono ema-tag">EMA7 {F.priceUsd(emaNow)}</span>}</div>
              <div className="dt">Holders</div><div className="dd num">{F.int(data.holderCount)}</div>
              <div className="dt">TVL</div><div className="dd mono">{F.usd(data.totalUsd)}</div>
            </div></div>

            {data.priceSeries.length > 1 && (
              <>
                <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Price
                  <a className="ext-link" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }} href={preisPairUrl(assetId)} target="_blank" rel="noopener">Open in preis</a>
                </div>
                <PriceChart data={data.priceSeries} dates={data.priceDates} price={a.price} change24h={a.change24h} />
              </>
            )}

            <div className="tabs">
              <button className={tab === 'activity' ? 'active' : ''} onClick={() => initialTab === 'holders' ? navigate(paths.asset(assetId)) : setQuery({ tab: null, page: null, hpage: null })}>Activities</button>
              <button className={tab === 'holders' ? 'active' : ''} onClick={() => setQuery({ tab: 'holders', page: null, hpage: null })}>Holders <span className="cnt">{F.int(data.holderCount)}</span></button>
            </div>

            {tab === 'activity' && <>
              <ActivityChips value={activityType} onChange={v => setQuery({ type: v === 'all' ? null : v, action: null, page: null })} />
              <FilterZone fields={activityFilterFields(activityType, [], false)} values={{ ...activityFilters.values, action: activityAction }} onChange={activityFilters.onChange} onClear={activityFilters.onClear} />
              <ActivityTable rows={assetActivity} now={now} live={activityPage === 0} loading={activity.isFetching && !assetActivity.length} />
              <Pager page={activityPage} hasNext={(activity.data?.length ?? 0) === ACTIVITY_PAGE} onPage={p => setQuery({ page: p > 0 ? String(p) : null })} />
            </>}

            {tab === 'holders' && (
              <div className="panel"><table className="tbl">
                <thead><tr><th style={{ width: 50 }}>#</th><th>Holder</th><th className="r">Balance</th><th className="r">Value</th><th className="r">Share</th></tr></thead>
                <tbody>
                  {holders.isLoading && !holderRows.length ? <TableSkeleton cols={5} />
                    : holderRows.length ? holderRows.map((h, i) => (
                    <tr key={i} {...(h.account ? rowNav(accountHref(h.account)) : {})}>
                      <td data-label="Rank" className="mono muted">{h.rank}</td>
                      <td data-label="Holder">{h.tag ? <TagGroupPill tag={h.tag} /> : h.account ? <AddrPill account={h.account} noCopy /> : <Dash />}</td>
                      <td data-label="Balance" className="r"><AssetAmount asset={a} raw={h.balance} /></td>
                      <td data-label="Value" className="r mono">{F.usd(h.valueUsd)}</td>
                      <td data-label="Share" className="r mono muted">{((h.share ?? 0) * 100).toFixed(1)}%</td>
                    </tr>
                  )) : <EmptyRow cols={5}>No holders</EmptyRow>}
                </tbody>
              </table>
              <Pager page={hpage} totalPages={holderPages} onPage={setHpage} />
              </div>
            )}
          </>
        )}
    </div>
  )
}
