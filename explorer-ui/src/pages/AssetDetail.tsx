import { Suspense, lazy, useEffect, useState } from 'react'
import { useActivityCount, useAsset, useAssetActivity, useAssetDcas, useHolders, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { api } from '../api/explorer'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, navigate, useQuery, useQueryValue, setQuery } from '../router'
import { Crumbs, F, AssetIcon, AssetAmount, AddrPill, AssetDetailSkeleton, TableSkeleton, EmptyRow, rowNav, accountHref, TagGroupPill, ActivityChips, Pager, normalizeActivityType, normalizeActivityAction, Dash, pendingRows } from '../components/ui'
import { ActiveDcaTable } from '../components/AccountSections'
import { AssetLiquidityTab } from '../components/AssetLiquidity'
import { FilterZone, useFilters } from '../components/Filters'
import { activityFilterFields } from '../components/activityFilters'
import { PriceChart, ema7 } from '../components/PriceChart'
import { ActivityTable } from '../components/ActivityTable'
import { BellIcon } from '../components/NotifyButton'
import type { AlertPreset } from '../components/NewAlertDialog'
import { ASSET_ALERT_MIN_USD, assetRuleCount } from '../notificationKinds'
import { useNotificationMutation, useNotificationsOverview } from '../hooks/useNotifications'
import { userApi } from '../api/explorer'
import { useSession } from '../session'
import { requestConnect } from '../connectDialog'
import { stashPendingNotification } from '../pendingNotification'
import { offeredPages } from '../utils/activityPaging'
import type { AssetListItem, NotificationKind, NotificationRuleInput } from '../types'

// The alert dialog is only reached by clicking one of the header's buttons, so it
// costs this page nothing until then — the same lazy mount the notifications page
// gives it.
const NewAlertDialog = lazy(() => import('../components/NewAlertDialog').then(m => ({ default: m.NewAlertDialog })))

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
  const tab = (rawTab === 'holders' || rawTab === 'activity' || rawTab === 'dcas' || rawTab === 'liquidity' ? rawTab : initialTab) as 'holders' | 'activity' | 'dcas' | 'liquidity'
  const activityType = normalizeActivityType(useQueryValue('type', 'all'))
  // Activities filters — the same set as the global feed minus the token combo
  // (this page IS the token filter). `page` resets whenever a filter changes.
  const activityFilters = useFilters({ reservedKeys: ['tab', 'type', 'page', 'hpage'], pageKey: 'page', keys: ['action', 'from', 'to', 'min', 'minRevenue'] })
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
  // Asset activity is served by the global feed's endpoint under the same
  // per-category depth bound, so the › arrow has to stop where that bound does —
  // one page further is a refused request. Only `maxOffset` is read here: the total
  // that comes with it is the chain-wide feed's length, not this asset's.
  const activityBound = useActivityCount(activityType, activityFilters.values.from, activityFilters.values.to,
    { min: activityFilters.values.min || undefined, minRevenue: activityFilters.values.minRevenue || undefined },
    activityAction || undefined)
  const activityPages = offeredPages({ page: activityPage, rowsOnPage: assetActivity.length, maxOffset: activityBound.data?.maxOffset, pageSize: ACTIVITY_PAGE })
  // Holders are paginated server-side (no cap) — fetched only while the tab is open.
  const HOLDERS_PAGE = 50
  const hp = parseInt(q.get('hpage') ?? '', 10)
  const hpage = Number.isFinite(hp) && hp > 0 ? hp : 0
  const setHpage = (p: number) => setQuery({ hpage: p > 0 ? String(p) : null })
  const holders = useHolders(assetId, hpage * HOLDERS_PAGE, HOLDERS_PAGE, tab === 'holders')
  const holderRows = holders.data?.holders ?? []
  const holderCount = data?.holderCount ?? 0
  const holderPages = Math.max(1, Math.ceil((holders.data?.total ?? holderCount) / HOLDERS_PAGE))
  // Ongoing DCA orders trading this asset — fetched only while the tab is open.
  // Stats (head block, measured block time) feed the live "next trade" cells.
  const dcas = useAssetDcas(assetId, tab === 'dcas')
  const dcaBuys = dcas.data?.buys ?? []
  const dcaSells = dcas.data?.sells ?? []
  const { data: stats } = useStats(tab === 'dcas' && !!(dcaBuys.length || dcaSells.length))
  // A /hdx "N orders" deep link lands with ?side=buys|sells: scroll that section
  // into view once there are rows to scroll to. The path navigation has already
  // reset scroll to the top, so this fires at most once per landing; switching
  // tabs clears `side`, so a later return to the tab stays where the reader is.
  // Readiness needs BOTH payloads: the sections mount only once the asset detail
  // is in (the page-level skeleton gate), and the DCA rows can win that race.
  const side = q.get('side')
  const dcasReady = !!dcas.data && !!data
  useEffect(() => {
    if (tab !== 'dcas' || !dcasReady || (side !== 'buys' && side !== 'sells')) return
    document.getElementById(`dca-${side}`)?.scrollIntoView()
  }, [tab, side, dcasReady])

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Assets', to: paths.assets() }, { label: a?.symbol ?? String(assetId) }]} />
        <div className="detail-header">
          <div className="page-title">{a && <AssetIcon assetId={a.assetId} iconAssetId={a.iconAssetId} symbol={a.symbol} size={30} parachainId={a.parachainId} origin={a.origin} />} {a?.symbol ?? a?.name ?? `Asset`} <span className="sub muted">#{a?.assetId ?? assetId}</span></div>
          {a && <AssetAlertActions asset={a} />}
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
              {/* Collateral seized from borrowers in the money market, over the
                  asset's full history. Present for every asset the market holds or
                  has held — a reserve that has never been liquidated reads $0. */}
              {data.liquidations && <>
                <div className="dt">Liquidated</div>
                <div className="dd mono">{F.usd(data.liquidations.total.valueUsd)}
                  <span className="muted" style={{ marginLeft: 8 }}>{F.amount(data.liquidations.total.amount, data.liquidations.decimals)} {a.symbol}</span>
                </div>
              </>}
            </div></div>

            {data.priceSeries.length > 1 && (
              <>
                <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Price
                  <a className="ext-link" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }} href={preisPairUrl(assetId)} target="_blank" rel="noopener">Open in preis ↗</a>
                </div>
                <PriceChart data={data.priceSeries} dates={data.priceDates} price={a.price} change24h={a.change24h}
                  liquidations={data.liquidations} asset={a} zoomKey="zp"
                  refine={(dates => dates && dates.length === data.priceSeries.length
                    ? async (fromSec: number, toSec: number, points: number) => {
                      // Base points are daily closes stamped at their interval start;
                      // pad `to` by a day so the last day's finer candles are included.
                      const from = fromSec, to = toSec + 86_400
                      if (!Number.isFinite(from) || !Number.isFinite(to)) return null
                      const w = await api.assetPrices(assetId, from, to, points)
                      return w.priceSeries.length > 1 ? { data: w.priceSeries, dates: w.priceDates } : null
                    }
                    : undefined)(data.priceDates)} />
              </>
            )}

            <div className="tabs">
              <button className={tab === 'activity' ? 'active' : ''} onClick={() => initialTab === 'holders' ? navigate(paths.asset(assetId)) : setQuery({ tab: null, page: null, hpage: null, side: null })}>Activities</button>
              <button className={tab === 'holders' ? 'active' : ''} onClick={() => setQuery({ tab: 'holders', page: null, hpage: null, side: null })}>Holders <span className="cnt">{F.int(data.holderCount)}</span></button>
              <button className={tab === 'liquidity' ? 'active' : ''} onClick={() => setQuery({ tab: 'liquidity', page: null, hpage: null, side: null })}>Liquidity {data.liquiditySourceCount != null && <span className="cnt">{F.int(data.liquiditySourceCount)}</span>}</button>
              <button className={tab === 'dcas' ? 'active' : ''} onClick={() => setQuery({ tab: 'dcas', page: null, hpage: null, side: null })}>DCAs <span className="cnt">{F.int(data.dcaCount)}</span></button>
            </div>

            {tab === 'activity' && <>
              <ActivityChips value={activityType} onChange={v => setQuery({ type: v === 'all' ? null : v, action: null, page: null })} />
              <FilterZone fields={activityFilterFields(activityType, [], false)} values={{ ...activityFilters.values, action: activityAction }} onChange={activityFilters.onChange} onClear={activityFilters.onClear} />
              <ActivityTable rows={assetActivity} now={now} live={activityPage === 0} anchorRef={activity.anchorRef} loading={activity.isFetching && !assetActivity.length} pending={activity.isPlaceholderData} pageSize={ACTIVITY_PAGE}
                error={activity.error} onRetry={() => { void activity.refetch() }} />
              <Pager page={activityPage} hasNext={activityPages.hasNext} note={activityPages.note} onPage={p => setQuery({ page: p > 0 ? String(p) : null })} />
            </>}

            {tab === 'holders' && (
              <div className="panel"><table className="tbl">
                <thead><tr><th style={{ width: 50 }}>#</th><th>Holder</th><th className="r">Balance</th><th className="r">Value</th><th className="r">Share</th></tr></thead>
                <tbody {...pendingRows(holders.isPlaceholderData)}>
                  {holders.isLoading && !holderRows.length ? <TableSkeleton cols={5} rows={HOLDERS_PAGE} />
                    : holderRows.length ? holderRows.map((h, i) => (
                    // Semantic key (Accounts' rowKey idiom): a login can regroup
                    // a row from account to viewer-tag between polls, and an
                    // index key would then recycle the old row's DOM state.
                    <tr key={h.tag ? `tag:${h.tag.tagId}` : h.account ? `account:${h.account.accountId}` : `row:${i}`} {...(h.account ? rowNav(accountHref(h.account)) : {})}>
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

            {tab === 'liquidity' && <AssetLiquidityTab asset={a} />}

            {/* The same table an account's active orders use, one section per
                side of THIS asset, each an anchor for the /hdx "N orders" links.
                Empty sections stay visible: "no ongoing sells" is an answer. */}
            {tab === 'dcas' && (
              dcas.isLoading && !dcas.data
                ? <div className="panel"><table className="tbl"><tbody><TableSkeleton cols={8} rows={6} /></tbody></table></div>
                : dcas.isError
                  ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Failed to load the DCA orders</div>
                  : <>
                    {/* scrollMarginTop keeps a scrolled-to section title clear of
                        the 61px sticky topbar. */}
                    <div id="dca-buys" style={{ scrollMarginTop: 74 }}>
                      <ActiveDcaTable dcas={dcaBuys} showOwner totals headBlock={stats?.headBlock ?? 0} headTime={stats?.headTime} now={now} blockSec={stats?.avgBlockSec}
                        title={<>Buys · {dcaBuys.length} <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}>· ongoing orders buying {a.symbol}</span></>}
                        emptyText={`No ongoing DCA orders buying ${a.symbol}`} />
                    </div>
                    <div id="dca-sells" style={{ scrollMarginTop: 74 }}>
                      <ActiveDcaTable dcas={dcaSells} showOwner totals headBlock={stats?.headBlock ?? 0} headTime={stats?.headTime} now={now} blockSec={stats?.avgBlockSec}
                        title={<>Sells · {dcaSells.length} <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}>· ongoing orders selling {a.symbol}</span></>}
                        emptyText={`No ongoing DCA orders selling ${a.symbol}`} />
                    </div>
                  </>
            )}
          </>
        )}
    </div>
  )
}

/* ── the header's alert buttons ───────────────────────────────────────────── */

// The three alerts this page can prefill from what it already shows: a price
// threshold seeded from the live price, and a value floor on this token's trades
// and on its transfers.
//
// Each button OPENS the shared new-alert dialog with the token locked in and the
// fields filled, rather than creating a rule on the spot. That is the difference
// from NotifyButton (which every other surface still uses): here a second alert
// at another level is an ordinary thing to want — "$0.025 as well as $0.02" — so
// there is nothing for an exact-parameters toggle to be right about. Duplicates
// cost nothing anyway: the create is idempotent server-side, and the dialog says
// so in place when it happens.
//
// The subscribed state this surface DOES show is a count: how many alerts of that
// kind already watch this token, whatever their threshold, linking to where they
// are managed.
function AssetAlertActions({ asset }: { asset: AssetListItem }) {
  const session = useSession()
  const overview = useNotificationsOverview()
  const createRule = useNotificationMutation(userApi.createNotificationRule)
  const [preset, setPreset] = useState<AlertPreset | null>(null)
  const [open, setOpen] = useState(false)
  // Mounted separately from `open` so the lazy chunk is fetched on the first click
  // and the dialog's close animation still has a component to run on.
  const [mounted, setMounted] = useState(false)
  const rules = overview.data?.rules ?? []
  const lockAsset = { assetId: asset.assetId, symbol: asset.symbol, price: asset.price }

  const buttons: { label: string; title: string; preset: AlertPreset }[] = [
    // A price alert needs a price to be prefilled FROM; without a feed for this
    // token there is no meaningful default and the button would open on a blank.
    ...(asset.price != null ? [{
      label: 'Price alert',
      title: `Alert me when ${asset.symbol} crosses a price — now ${F.priceUsd(asset.price)}`,
      preset: {
        kind: 'price' as NotificationKind,
        label: 'Price alert',
        lockAsset,
        params: { price: asset.price, direction: 'above' },
        name: `${asset.symbol} price`,
      },
    }] : []),
    {
      label: 'Trade alert',
      title: `Alert me on ${asset.symbol} trades over ${F.usd(ASSET_ALERT_MIN_USD)}`,
      preset: {
        kind: 'large-trade' as NotificationKind,
        label: 'Trade alert',
        lockAsset,
        params: { minUsd: ASSET_ALERT_MIN_USD },
        name: `Large ${asset.symbol} trades`,
      },
    },
    {
      label: 'Transfer alert',
      title: `Alert me on ${asset.symbol} transfers over ${F.usd(ASSET_ALERT_MIN_USD)}`,
      preset: {
        kind: 'large-transfer' as NotificationKind,
        label: 'Transfer alert',
        lockAsset,
        params: { minUsd: ASSET_ALERT_MIN_USD },
        name: `Large ${asset.symbol} transfers`,
      },
    },
  ]

  return (
    <div className="notify-actions">
      {buttons.map(b => {
        const count = session ? assetRuleCount(rules, b.preset.kind, asset.assetId) : 0
        return (
          <span key={b.label} className="notify-wrap">
            <button
              type="button"
              className="btn sm notify-btn"
              title={b.title}
              onClick={() => { setPreset(b.preset); setMounted(true); setOpen(true) }}
            >
              <BellIcon /> {b.label}
            </button>
            {count > 0 && (
              <Link to={paths.notifications('alerts')} className="notify-count"
                title={`${count} ${b.label.toLowerCase()}${count === 1 ? '' : 's'} on ${asset.symbol} — manage`}
              >{F.int(count)}</Link>
            )}
          </span>
        )
      })}

      {mounted && preset && (
        <Suspense fallback={null}>
          <NewAlertDialog
            open={open}
            onOpenChange={setOpen}
            // The token is locked, so the dialog needs no token directory here.
            assets={[]}
            pending={createRule.isPending}
            preset={preset}
            submitLabel={session ? undefined : 'Log in to save this alert'}
            onSubmit={async (input: NotificationRuleInput) => {
              // Logged out this is still a real save: the rule the dialog just
              // built is parked and the login dialog takes over, and the pending
              // handoff creates it once the wallet round trip finishes. A "log in
              // first" dead end would throw away the numbers just chosen.
              if (!session) {
                stashPendingNotification({ kind: input.kind, params: input.params, ...(input.name ? { name: input.name } : {}) })
                setOpen(false)
                requestConnect()
                return
              }
              const created = await createRule.mutateAsync([input])
              // Already had exactly this one: the dialog stays open and says so,
              // which is a gentler answer than a closed dialog that appears to
              // have made a duplicate.
              if (created.existing) return { existing: true }
              setOpen(false)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
