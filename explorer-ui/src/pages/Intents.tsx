import { useEffect, useState, type ReactNode } from 'react'
import { useActivity, useActivityCount, useIceDashboard, useOpenIntents, useStats } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useNow } from '../hooks/useNow'
import { Link, paths, redirect, navigate, setQuery, useQueryValue, usePageParam } from '../router'
import { AddrPill, Ago, AssetAmount, Usd, AssetChip, ChartSkeleton, Crumbs, EmptyRow, F, LoadError, Pager, TableSkeleton, compactAmount } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'
import { ActiveDcaTable, LimitOrdersTable } from '../components/AccountSections'
import { RovingTabs, TabPanel } from '../components/RovingTabs'
import { intentLabel } from '../components/activityColors'
import { useAssetColors } from '../utils/iconColor'
import { offeredPages } from '../utils/activityPaging'
import { ChartLegend, MultiLineChart, ShareBar, StackedColumnChart } from '../components/HdxCharts'
import type { AreaSeries, ShareSegment, StackColumn } from '../components/HdxCharts'
import { ChartTooltipRow as TipRow, DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { monthDayLabel as mdLabel } from '../utils/dashboardDates'
import { fmtPermill } from '../utils/dca'
import { REVENUE_STREAM_COLOR } from '../components/revenueColors'
import type { AssetRef, IceBp, IceDashboard, IceOpenIntents, IceOpenOrders, IceRoutingEntry } from '../types'

// Intents: the ICE venue runtime 443 added. A swap intent is the product's limit
// order, a DCA intent the new DCA, and an off-chain solver settles both in batches —
// matching intents against each other where it can and routing the rest through
// the AMMs from its own holding account. The page reads the venue: what it settled
// and how well, who traded, the open book live, the fee it earns, the solver's
// settings, and every intent's activity.

const WINDOW_LABEL = '30 days'
// A phone shows the feed ten rows a page: each row is a card there.
const ACTIVITY_PAGE = 25
const ACTIVITY_PAGE_NARROW = 10
// The open book pages in the browser: the whole list is already here, and a page
// of it keeps the sections below within reach.
const BOOK_PAGE = 10
const MATCHED_COLOR = 'var(--cat-intent)'
const ROUTED_COLOR = 'var(--sky-deep)'
const MIGRATED_COLOR = 'var(--green)'
const CANCELLED_COLOR = 'var(--amber)'
const FEE_COLOR = REVENUE_STREAM_COLOR.ice_matched_fee
const MODE_TONE: Record<IceDashboard['status']['solverMode'], string> = {
  V4: 'var(--green)', Passthrough: 'var(--amber)', Disabled: 'var(--red)',
}
const MUTED_SUB = { color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 } as const
const NARROW = '(max-width: 720px)'
// A day whose matched volume is more than this share of the window's is called
// out: one large intent-to-intent match otherwise reads as a steady rate.
const MATCHED_CONCENTRATION = 0.5

// The intent feed's own action filter: the Trade tab's intent slugs, labelled by the
// badges they select (a placement or fill of either kind; DCA trades apart).
const INTENT_ACTIONS: { v: string; label: string }[] = [
  { v: 'intent-place', label: 'Placed' },
  { v: 'intent-fill', label: 'Filled' },
  { v: 'intent-dca-trade', label: intentLabel('dca', 'DcaTrade') },
  { v: 'intent-cancel', label: 'Cancelled' },
  { v: 'intent-expire', label: 'Expired' },
]
const BOOK_TABS = ['limit', 'dca', 'assets'] as const
type BookTab = typeof BOOK_TABS[number]

// Signed basis points to a tenth, the way the API computes them.
function fmtBp(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const s = Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)
  return (v > 0 ? '+' : '') + s + ' bp'
}
// Dollar axis ticks on the shared rough scale ($74.2, $1.2k), never two decimals.
const usdTick = (v: number): string => v === 0 ? '$0' : '$' + compactAmount(v)
function Switch({ on }: { on: boolean }) {
  return <span style={{ color: on ? 'var(--green)' : 'var(--text-low)' }}>{on ? 'on' : 'off'}</span>
}
function Card({ k, v, s, dot }: { k: string; v: ReactNode; s?: ReactNode; dot?: string }) {
  return (
    <div className="hdx-card">
      <div className="hk">{dot && <i style={{ background: dot }} />}{k}</div>
      <div className="hv">{v}</div>
      {s && <div className="hs">{s}</div>}
    </div>
  )
}
// Every column carries a label slot; only every n-th prints so the days stay legible.
function dayLabel(days: string[], i: number, labels: number): string {
  const every = Math.max(1, Math.ceil(days.length / labels))
  return i % every === 0 ? mdLabel(days[i]) : ''
}
function fillTotals(d: IceDashboard) {
  return d.fillsPerDay.reduce((t, x) => ({
    fills: t.fills + x.fills, solutions: t.solutions + x.solutions, usd: t.usd + x.usd, matched: t.matched + x.matchedUsd, routed: t.routed + x.routedUsd,
  }), { fills: 0, solutions: 0, usd: 0, matched: 0, routed: 0 })
}
const reservedUsd = (o: IceOpenOrders): number => o.byAsset.reduce((sum, r) => sum + (r.reservedUsd ?? 0), 0)
function blocksText(n: number): string {
  return `${F.int(n)} ${n === 1 ? 'block' : 'blocks'}`
}

// Two registry assets can share a symbol (USDC 21 and 22, USDT 10 and 23). Where
// both appear in one list each carries its id, the Omnipool page's convention.
function sharedSymbolIds(assets: readonly AssetRef[]): Set<number> {
  const ids = new Map<string, Set<number>>()
  for (const a of assets) (ids.get(a.symbol) ?? ids.set(a.symbol, new Set()).get(a.symbol)!).add(a.assetId)
  return new Set([...ids.values()].filter(s => s.size > 1).flatMap(s => [...s]))
}
const symbolLabel = (a: AssetRef, shared: ReadonlySet<number>): string => shared.has(a.assetId) ? `${a.symbol} #${a.assetId}` : a.symbol
function Chip({ asset, shared }: { asset: AssetRef; shared: ReadonlySet<number> }) {
  return <><AssetChip asset={asset} />{shared.has(asset.assetId) && <span className="muted mono"> #{asset.assetId}</span>}</>
}

// 0. what this is, for a reader who has not met intents before
function Intro() {
  return (
    <>
      <p className="ice-lede">
        An intent is an order that says what you want, not how to get it: a limit order to swap at a price you set, or a DCA that buys in slices over time.
        ICE, Hydration’s intent engine, collects them and a solver settles them in batches every few seconds — filling opposite intents against each other first, and sending only the rest through the pools.
      </p>
      <details className="ice-gloss">
        <summary>Terms on this page</summary>
        <dl>
          <dt>Intent</dt><dd>An order held on chain until it is filled, cancelled or expires: a limit order (swap at a set price or better, whole or in parts) or a DCA intent (one trade every period, from a budget).</dd>
          <dt>ICE</dt><dd>The pallet that holds the intents and checks every settlement against them: no intent is filled below its limit.</dd>
          <dt>Solver</dt><dd>The off-chain program that proposes a batch — a solution — of fills each block; the chain accepts it only if every fill meets its intent.</dd>
          <dt>Matched</dt><dd>Volume filled intent against intent, one owner’s sell meeting another’s buy, without touching a pool. ICE’s fee is charged on this part only.</dd>
          <dt>Routed</dt><dd>What the solver had to trade through the pools (Omnipool, stableswap, XYK, Uniswap v3) to fill what could not be matched; it pays the pools’ own fees.</dd>
        </dl>
      </details>
    </>
  )
}

// 1. headline strip — the venue in six numbers
function Ribbon({ d, open }: { d: IceDashboard; open: IceOpenOrders }) {
  const t = fillTotals(d)
  const fee = d.feeRevenue.perDay.reduce((s, x) => s + x.usd, 0)
  const cells: { k: string; v: ReactNode; s?: ReactNode }[] = [
    { k: 'Open orders', v: F.int(open.total), s: <>{F.int(open.limit)} limit · {F.int(open.dca)} DCA</> },
    { k: 'Reserved', v: <Usd v={reservedUsd(open)} />, s: 'held for open orders' },
    { k: `Volume · ${WINDOW_LABEL}`, v: <Usd v={t.usd} />, s: <>{F.int(t.fills)} fills</> },
    { k: 'Matched', v: t.usd > 0 ? F.share(t.matched / t.usd) : '—', s: 'never touched a pool' },
    { k: `Traders · ${WINDOW_LABEL}`, v: F.int(d.traders), s: <>{F.int(d.allTime.owners)} ever</> },
    { k: `Fee · ${WINDOW_LABEL}`, v: <Usd v={fee} />, s: `${fmtPermill(d.status.protocolFeePpm)} of matched` },
  ]
  return (
    <div className="ribbon standalone">
      {cells.map((c, i) => (
        <span key={c.k} style={{ display: 'contents' }}>
          {i > 0 && <span className="rs" />}
          <span className="cell"><span className="k">{c.k}</span><span className="v">{c.v}</span>{c.s && <span className="s">{c.s}</span>}</span>
        </span>
      ))}
    </div>
  )
}

// 2. fills — settled volume per day, matched against another intent or routed
function FillsSection({ d, narrow }: { d: IceDashboard; narrow: boolean }) {
  const rows = d.fillsPerDay
  const days = rows.map(x => x.day)
  const totals = fillTotals(d)
  const any = totals.fills > 0 || totals.solutions > 0
  const top = rows.reduce<typeof rows[number] | null>((m, x) => (m == null || x.matchedUsd > m.matchedUsd ? x : m), null)
  const concentrated = top != null && totals.matched > 0 && top.matchedUsd / totals.matched > MATCHED_CONCENTRATION
  const matchedDays = rows.filter(x => x.matchedUsd > 0).map(x => x.matchedUsd).sort((a, b) => a - b)
  const medianMatchedDay = matchedDays.length ? matchedDays[Math.floor((matchedDays.length - 1) / 2)] : 0
  const columns: StackColumn[] = rows.map((x, i) => ({
    key: x.day, label: dayLabel(days, i, narrow ? 5 : 10),
    segments: [
      { key: 'matched', label: 'Matched', color: MATCHED_COLOR, value: x.matchedUsd },
      { key: 'routed', label: 'Routed', color: ROUTED_COLOR, value: x.routedUsd },
    ],
    tip: (
      <>
        <span className="t-d">{mdLabel(x.day)}</span>
        <TipRow color={MATCHED_COLOR} label="Matched" value={F.usd(x.matchedUsd)} />
        <TipRow color={ROUTED_COLOR} label="Routed" value={F.usd(x.routedUsd)} />
        <TipRow label="Fills" value={F.int(x.fills)} />
        <TipRow label="Batches" value={F.int(x.solutions)} />
      </>
    ),
  }))
  return (
    <>
      <SecTitle title="Fills" subtitle={`${WINDOW_LABEL} · matched intent against intent vs routed through the pools`} />
      <div className="pf-card">
        {any ? (
          <>
            <ChartLegend items={[{ label: 'Matched', color: MATCHED_COLOR }, { label: 'Routed', color: ROUTED_COLOR }]} />
            <StackedColumnChart columns={columns} h={narrow ? 420 : 200} yFmt={usdTick} />
            <div className="hdx-cards">
              <Card k="Volume" v={<Usd v={totals.usd} />} s={`${F.int(totals.fills)} fills — limit orders and DCA trades, valued when they settled`} />
              <Card k="Matched" v={<Usd v={totals.matched} />} dot={MATCHED_COLOR} s={totals.usd > 0 ? `${F.share(totals.matched / totals.usd)} filled intent against intent` : 'filled intent against intent'} />
              <Card k="Routed" v={<Usd v={totals.routed} />} dot={ROUTED_COLOR} s="traded through the pools by the solver" />
              <Card k="Batches" v={F.int(totals.solutions)} s={totals.solutions > 0 ? `${(totals.fills / totals.solutions).toFixed(1)} fills per batch` : 'solutions the chain accepted'} />
            </div>
            {concentrated && top && (
              <div className="hdx-note">
                {F.usd(top.matchedUsd)} of the {F.usd(totals.matched)} matched came on {mdLabel(top.day)} alone; on a typical day with any match it was {F.usd(medianMatchedDay)}.
              </div>
            )}
            {d.unpricedFills > 0 && <div className="hdx-note">{F.int(d.unpricedFills)} {d.unpricedFills === 1 ? 'fill has' : 'fills have'} no price at settlement and {d.unpricedFills === 1 ? 'is' : 'are'} left out of every dollar figure.</div>}
          </>
        ) : <div className="hdx-note" style={{ marginTop: 0 }}>No fills in the last {WINDOW_LABEL}.</div>}
      </div>
    </>
  )
}

// 3. execution quality — closed limit orders
function bpSub(q: IceBp & { fills: number }): string {
  return q.fills > 0 ? `p10 ${fmtBp(q.p10)} · p90 ${fmtBp(q.p90)} · ${F.int(q.fills)} fills` : 'no fills in the window'
}
function QualitySection({ d }: { d: IceDashboard }) {
  const q = d.quality
  const any = q.medianBlocksToFill != null || q.cancelRate != null || q.priceVsLimitBp.p50 != null
  return (
    <>
      <SecTitle title="Execution quality" subtitle={`limit orders closed in the last ${WINDOW_LABEL}`} />
      <div className="pf-card">
        <div className="hdx-cards" style={{ marginTop: 0 }}>
          <Card k="Median time to fill" v={q.medianBlocksToFill != null ? blocksText(q.medianBlocksToFill) : '—'}
            s={q.medianTimeToFillSec != null ? `~${q.medianTimeToFillSec < 10 ? q.medianTimeToFillSec.toFixed(1) : F.int(Math.round(q.medianTimeToFillSec))}s · placement to first fill` : 'placement to first fill'} />
          <Card k="Market-style fills" v={fmtBp(q.priceVsLimitBpImmediate.p50)} s={<>median vs limit · {bpSub(q.priceVsLimitBpImmediate)}</>} />
          <Card k="Resting orders" v={fmtBp(q.priceVsLimitBpResting.p50)} s={<>median vs limit · {bpSub(q.priceVsLimitBpResting)}</>} />
          <Card k="Partial fills" v={F.share(q.partialShare)} s="of filled orders took more than one fill" />
          <Card k="Cancelled" v={F.share(q.cancelRate)} s="of closed orders, by their owner" />
          <Card k="Expired" v={F.share(q.expiryRate)} s="of closed orders, unfilled at their deadline" />
        </div>
        <div className="hdx-note">
          Price vs limit is how much more a fill paid than its order’s limit asked, in basis points (+100 bp = 1% better).
          A swap in the app is placed as an intent whose limit is the quote less its slippage allowance and fills within two blocks, so its figure is that allowance rather than an improvement; an order that rested fills at or near its limit.
        </div>
        {!any && <div className="hdx-note">No limit order has closed in the window — every figure fills in with the first fill, cancel or expiry.</div>}
      </div>
    </>
  )
}

// 4. who traded and what — top traders beside top pairs
function TradersPairsSection({ d }: { d: IceDashboard }) {
  const shared = sharedSymbolIds(d.topPairs.flatMap(p => [p.assetIn, p.assetOut]))
  return (
    <div className="rev-grid">
      <div>
        <SecTitle title="Top traders" subtitle={`intent owners by fill volume, ${WINDOW_LABEL}`} />
        <div className="panel">
          <table className="tbl ice-rank">
            <thead><tr><th>Owner</th><th className="r">Fills</th><th className="r">Volume</th></tr></thead>
            <tbody>
              {!d.topTraders.length ? <EmptyRow cols={3}>No fills in the last {WINDOW_LABEL}</EmptyRow> : d.topTraders.map(t => (
                <tr key={t.account.accountId}>
                  <td data-label="Owner"><AddrPill account={t.account} noCopy /></td>
                  <td data-label="Fills" className="r mono">{F.int(t.fills)}</td>
                  <td data-label="Volume" className="r mono"><Usd v={t.usd} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <SecTitle title="Top pairs" subtitle={`sold → bought, by fill volume, ${WINDOW_LABEL}`} />
        <div className="panel">
          <table className="tbl ice-rank">
            <thead><tr><th>Pair</th><th className="r">Fills</th><th className="r">Volume</th></tr></thead>
            <tbody>
              {!d.topPairs.length ? <EmptyRow cols={3}>No fills in the last {WINDOW_LABEL}</EmptyRow> : d.topPairs.map(p => (
                <tr key={`${p.assetIn.assetId}-${p.assetOut.assetId}`}>
                  <td data-label="Pair"><span className="trade-leg"><Chip asset={p.assetIn} shared={shared} /><span className="muted">→</span><Chip asset={p.assetOut} shared={shared} /></span></td>
                  <td data-label="Fills" className="r mono">{F.int(p.fills)}</td>
                  <td data-label="Volume" className="r mono"><Usd v={p.usd} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// 5. open book — live: every resting order, and what the venue holds per asset
function ReservesTable({ o, shared }: { o: IceOpenOrders; shared: ReadonlySet<number> }) {
  return (
    <div className="panel">
      <table className="tbl">
        <thead><tr><th>Asset</th><th className="r">Orders</th><th className="r">Reserved</th><th className="r">Value</th></tr></thead>
        <tbody>
          {!o.byAsset.length ? <EmptyRow cols={4}>No open orders</EmptyRow> : o.byAsset.map(r => (
            <tr key={r.asset.assetId}>
              <td data-label="Asset"><Chip asset={r.asset} shared={shared} /></td>
              <td data-label="Orders" className="r mono">{F.int(r.orders)}</td>
              <td data-label="Reserved" className="r mono"><AssetAmount asset={r.asset} raw={r.reserved} /></td>
              <td data-label="Value" className="r mono muted"><Usd v={r.reservedUsd} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
// The book's tab and page live in the URL (`book`, `bpage`); a page past the end —
// the list shrank under a poll — is clamped back to the last one.
function useBookPage(rows: number | null): [number, (p: number) => void] {
  const requested = Number(useQueryValue('bpage', '0'))
  const pages = rows == null ? null : Math.max(1, Math.ceil(rows / BOOK_PAGE))
  const page = Number.isInteger(requested) && requested > 0 ? requested : 0
  const clamped = pages != null && page > pages - 1 ? pages - 1 : page
  useEffect(() => {
    if (clamped !== page) setQuery({ bpage: clamped > 0 ? String(clamped) : null })
  }, [clamped, page])
  return [clamped, p => setQuery({ bpage: p > 0 ? String(p) : null })]
}
function bookLocation(tab: BookTab): string {
  const params = new URLSearchParams(window.location.search)
  if (tab === 'limit') params.delete('book')
  else params.set('book', tab)
  params.delete('bpage')
  const q = params.toString()
  return q ? `${window.location.pathname}?${q}` : window.location.pathname
}
function OpenBookSection({ summary, open, openError }: { summary: IceOpenOrders; open: IceOpenIntents | undefined; openError: boolean }) {
  const requested = useQueryValue('book', 'limit')
  const tab: BookTab = (BOOK_TABS as readonly string[]).includes(requested) ? requested as BookTab : 'limit'
  const rows = !open ? null : tab === 'limit' ? open.limitOrders.length : tab === 'dca' ? open.dcaIntents.length : null
  const [page, setPage] = useBookPage(rows)
  const colorFor = useAssetColors(summary.byAsset.map(r => r.asset))
  const shared = sharedSymbolIds(summary.byAsset.map(r => r.asset))
  const { data: stats } = useStats(true)
  const now = useNow()
  const segs: ShareSegment[] = summary.byAsset.map(r => ({
    key: String(r.asset.assetId), label: symbolLabel(r.asset, shared), color: colorFor(r.asset), value: r.reservedUsd ?? 0,
    tip: (
      <>
        <span className="t-d">{symbolLabel(r.asset, shared)}</span>
        <TipRow label="Reserved" value={`${F.amount(r.reserved, r.asset.decimals)} ${r.asset.symbol}`} />
        <TipRow label="Value" value={F.usd(r.reservedUsd)} />
        <TipRow label="Orders" value={F.int(r.orders)} />
      </>
    ),
  }))
  const slice = <T,>(xs: T[]): T[] => xs.slice(page * BOOK_PAGE, (page + 1) * BOOK_PAGE)
  const pager = (n: number) => n > BOOK_PAGE ? <Pager page={page} totalPages={Math.ceil(n / BOOK_PAGE)} onPage={setPage} /> : null
  const cut = (shown: number, total: number) => total > shown ? <div className="hdx-note">The {F.int(shown)} largest of {F.int(total)}, by value.</div> : null
  const tabs = [
    { id: 'limit', label: <>Limit orders <span className="cnt">{F.int(open?.limitOrdersTotal ?? summary.limit)}</span></> },
    { id: 'dca', label: <>DCA intents <span className="cnt">{F.int(open?.dcaIntentsTotal ?? summary.dca)}</span></> },
    { id: 'assets', label: <>By asset <span className="cnt">{F.int(summary.byAsset.length)}</span></> },
  ]
  return (
    <>
      <SecTitle title="Open orders" subtitle="live · intents not yet filled, cancelled or expired, and the funds they hold" />
      <div className="pf-card">
        <div className="hdx-cards" style={{ marginTop: 0, marginBottom: segs.length ? 14 : 0 }}>
          <Card k="Open" v={F.int(summary.total)} s="limit orders and DCA intents" />
          <Card k="Limit orders" v={F.int(summary.limit)} s="waiting for their price" />
          <Card k="DCA intents" v={F.int(summary.dca)} s="budgeted or rolling" />
          <Card k="Reserved" v={<Usd v={reservedUsd(summary)} />} s="locked by open orders, at current prices" />
        </div>
        {segs.length > 0 && <>
          <ChartLegend items={segs.map(s => ({ label: s.label, color: s.color }))} />
          <ShareBar segments={segs} h={22} />
        </>}
      </div>
      <RovingTabs tabs={tabs} value={tab} idPrefix="ice-book" label="Open orders"
        onChange={(id, replace) => (replace ? redirect : navigate)(bookLocation(id as BookTab))} />
      <TabPanel idPrefix="ice-book" id={tab}>
        {tab === 'assets' ? <ReservesTable o={summary} shared={shared} />
          : openError && !open ? <LoadError title="Couldn’t load the open orders" card="panel" />
          : !open ? <div className="panel"><table className="tbl"><tbody><TableSkeleton cols={6} rows={5} mobileCols={2} /></tbody></table></div>
          : tab === 'limit' ? <>
            <LimitOrdersTable orders={slice(open.limitOrders)} now={now} showOwner title={<>Resting limit orders <span style={MUTED_SUB}>· largest first</span></>} emptyText="No resting limit orders" />
            {pager(open.limitOrders.length)}
            {cut(open.limitOrders.length, open.limitOrdersTotal)}
          </>
          : <>
            <ActiveDcaTable dcas={slice(open.dcaIntents)} showOwner headBlock={stats?.headBlock ?? 0} headTime={stats?.headTime} now={now} blockSec={stats?.avgBlockSec}
              title={<>Running DCA intents <span style={MUTED_SUB}>· largest budget first</span></>} emptyText="No running DCA intents" />
            {pager(open.dcaIntents.length)}
            {cut(open.dcaIntents.length, open.dcaIntentsTotal)}
          </>}
      </TabPanel>
    </>
  )
}

// 6. fee revenue — the matched-volume fee, as the revenue model books it
function FeeSection({ d, narrow }: { d: IceDashboard; narrow: boolean }) {
  const perDay = d.feeRevenue.perDay
  const days = perDay.map(x => x.day)
  const total = perDay.reduce((s, x) => s + x.usd, 0)
  const holdings = d.feeRevenue.potHoldings
  const holdingsUsd = holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0)
  const shared = sharedSymbolIds(holdings.map(h => h.asset))
  const line: AreaSeries[] = [{ key: 'fee', label: 'Fee per day', color: FEE_COLOR, values: perDay.map(x => x.usd) }]
  return (
    <>
      <SecTitle title="Protocol fee revenue" subtitle={`${fmtPermill(d.status.protocolFeePpm)} of matched volume, paid to the fee account with each batch`} />
      <div className="pf-card">
        {total > 0 ? (
          <>
            <ChartLegend items={[{ label: 'Fee per day', color: FEE_COLOR }]} />
            <MultiLineChart buckets={days} series={line} h={narrow ? 360 : 170} yFmt={usdTick} floorZero />
          </>
        ) : <div className="hdx-note" style={{ marginTop: 0 }}>No protocol fee revenue in the window — the fee is charged on matched volume only, never on the routed part.</div>}
        <div className="hdx-cards">
          <Card k={WINDOW_LABEL} v={<Usd v={total} />} dot={FEE_COLOR} s={<>calendar days, UTC — the stream the <Link to={paths.revenueProtocol()}>Protocol Revenue</Link> page books as ICE matched fee, whose 30D is a rolling 720 hours</>} />
          <Card k="In the fee account" v={<Usd v={holdingsUsd} />} s="held right now, at current prices" />
        </div>
        <div className="hdx-note">A batch’s fee in an asset is only paid out when it reaches that asset’s existential deposit; a smaller one stays with the solver and is not booked, so a little matched volume earns no fee.</div>
        {holdings.length > 0 && (
          <div className="panel" style={{ marginTop: 12 }}>
            <table className="tbl">
              <thead><tr><th>Asset</th><th className="r">Held</th><th className="r">Value</th></tr></thead>
              <tbody>
                {holdings.map(h => (
                  <tr key={h.asset.assetId}>
                    <td data-label="Asset"><Chip asset={h.asset} shared={shared} /></td>
                    <td data-label="Held" className="r mono"><AssetAmount asset={h.asset} raw={h.amount} /></td>
                    <td data-label="Value" className="r mono muted"><Usd v={h.valueUsd} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

// 7. the venue — solver settings, routing overrides, and the DCA pallet beside it
const ROUTING_KIND: Record<string, string> = {
  OmnipoolAsset: 'Omnipool asset', StableswapPool: 'Stableswap pool', XykPool: 'XYK pool', XykPools: 'XYK pools',
  AaveWrap: 'Aave wrap', AaveWraps: 'Aave wraps', UniswapV3Pool: 'Uniswap v3 pool', UniswapV3Pools: 'Uniswap v3 pools',
}
const ROUTING_SHOWN = 6
const ROUTE_ITEMS = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 14px' } as const
function RoutingTarget({ r, shared }: { r: IceRoutingEntry; shared: ReadonlySet<number> }) {
  const [all, setAll] = useState(false)
  if (r.contracts.length) {
    return <span style={ROUTE_ITEMS}>{r.contracts.map(c => <Link key={c} to={paths.v3Pool(c)} className="hash mono">{F.shortHash(c)}</Link>)}</span>
  }
  if (r.kind === 'StableswapPool' && r.assets[0]?.[0]) {
    const share = r.assets[0][0]
    return <Link to={paths.pool(share.assetId)} className="mono">{share.symbol}</Link>
  }
  const shown = all ? r.assets : r.assets.slice(0, ROUTING_SHOWN)
  const rest = r.assets.length - shown.length
  return (
    <span style={ROUTE_ITEMS}>
      {shown.map(t => (
        <span key={t.map(a => a.assetId).join('-')} className="trade-leg">
          {t.map((a, i) => <span key={a.assetId} style={{ display: 'contents' }}>{i > 0 && <span className="muted" aria-label={r.kind.startsWith('Aave') ? 'wraps to' : 'and'}>{r.kind.startsWith('Aave') ? '⇄' : '/'}</span>}<Chip asset={a} shared={shared} /></span>)}
        </span>
      ))}
      {r.assets.length > ROUTING_SHOWN && (
        <button type="button" className="ice-more" aria-expanded={all} onClick={() => setAll(v => !v)}>
          {all ? 'show fewer' : `+${F.int(rest)} more`}
        </button>
      )}
    </span>
  )
}
function VenueSection({ d, narrow }: { d: IceDashboard; narrow: boolean }) {
  const s = d.status
  const m = d.migration
  const migrations = m.migrated + m.cancelled > 0
  const days = m.perDay.map(x => x.day)
  const shared = sharedSymbolIds(s.routing.flatMap(r => r.assets.flat()))
  const columns: StackColumn[] = m.perDay.map((x, i) => ({
    key: x.day, label: dayLabel(days, i, narrow ? 5 : 10),
    segments: [
      { key: 'migrated', label: 'Migrated', color: MIGRATED_COLOR, value: x.migrated },
      { key: 'cancelled', label: 'Cancelled', color: CANCELLED_COLOR, value: x.cancelled },
    ],
    tip: (
      <>
        <span className="t-d">{mdLabel(x.day)}</span>
        <TipRow color={MIGRATED_COLOR} label="Migrated" value={F.int(x.migrated)} />
        <TipRow color={CANCELLED_COLOR} label="Cancelled" value={F.int(x.cancelled)} />
      </>
    ),
  }))
  return (
    <>
      <SecTitle title="Solver settings" subtitle={<>set by governance · as of {s.asOfBlock > 0 ? <Link to={paths.block(s.asOfBlock)} className="hash mono">block {F.int(s.asOfBlock)}</Link> : 'launch'}</>} />
      <div className="pf-card">
        <div className="hdx-cards" style={{ marginTop: 0 }}>
          <Card k="Solver mode" v={<span style={{ color: MODE_TONE[s.solverMode] }}>{s.solverMode}</span>} s={s.solverMode === 'V4' ? 'batches checked in full: matching, prices, fee' : s.solverMode === 'Passthrough' ? 'emergency: each intent executed on its own, no matching or fee' : 'no batch is accepted'} />
          <Card k="Matched fee" v={fmtPermill(s.protocolFeePpm)} s="of the intent-to-intent volume" />
          <Card k="Uniswap v3" v={s.uniswapV3 ? <span className="mono" title={`factory ${s.uniswapV3.factory} · router ${s.uniswapV3.swapRouter} · quoter ${s.uniswapV3.quoter}`}>{F.shortHash(s.uniswapV3.factory)}</span> : <span className="muted">not set</span>} s="the factory whose pools the solver can route through" />
          <Card k="Old DCA" v={F.int(m.remainingSchedules)} s={<>schedules still running on the DCA pallet · migration to intents <Switch on={s.dcaMigrationEnabled} /></>} />
        </div>
        {s.routing.length > 0 && (
          <div className="panel" style={{ marginTop: 12 }}>
            <table className="tbl">
              <thead><tr><th>Routing override</th><th>Covers</th><th>State</th><th className="r">Since</th></tr></thead>
              <tbody>
                {s.routing.map(r => (
                  <tr key={`${r.kind}-${r.block}-${r.contracts.join()}-${r.assets.map(t => t.map(a => a.assetId).join('.')).join()}`}>
                    <td data-label="Override">{ROUTING_KIND[r.kind] ?? r.kind}{r.assets.length > 1 && <span className="muted mono"> · {F.int(r.assets.length)}</span>}{r.contracts.length > 1 && <span className="muted mono"> · {F.int(r.contracts.length)}</span>}</td>
                    <td data-label="Covers"><RoutingTarget r={r} shared={shared} /></td>
                    <td data-label="State"><span style={{ color: r.state === 'Included' ? 'var(--green)' : 'var(--amber)' }}>{r.state === 'Included' ? 'included' : 'excluded'}</span></td>
                    <td data-label="Since" className="r mono"><Link to={paths.block(r.block)} className="hash">{F.int(r.block)}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {migrations ? (
          <>
            <div className="hdx-cards">
              <Card k="Migrated" v={F.int(m.migrated)} dot={MIGRATED_COLOR} s="schedules now running as DCA intents" />
              <Card k="Cancelled" v={F.int(m.cancelled)} dot={CANCELLED_COLOR} s="refunded to their owners" />
            </div>
            <ChartLegend items={[{ label: 'Migrated', color: MIGRATED_COLOR }, { label: 'Cancelled', color: CANCELLED_COLOR }]} />
            <StackedColumnChart columns={columns} h={narrow ? 320 : 140} yFmt={v => F.int(Math.round(v))} />
            {m.byReason.length > 0 && (
              <div className="panel" style={{ marginTop: 12 }}>
                <table className="tbl">
                  <thead><tr><th>Cancel reason</th><th className="r">Schedules</th></tr></thead>
                  <tbody>
                    {m.byReason.map(r => (
                      <tr key={r.reason}>
                        <td data-label="Cancel reason" className="mono">{r.reason}</td>
                        <td data-label="Schedules" className="r mono">{F.int(r.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="hdx-note">
            {s.dcaMigrationEnabled
              ? 'Migration is on: each old DCA schedule turns into a DCA intent at its next trade, or is cancelled and refunded. None has yet.'
              : 'Governance has not switched on the migration of old DCA schedules to DCA intents, so the two run side by side.'}
          </div>
        )}
      </div>
    </>
  )
}

// 8. intent activity — every placement, fill, DCA trade, cancel and expiry
function ActivitySection({ narrow }: { narrow: boolean }) {
  const size = narrow ? ACTIVITY_PAGE_NARROW : ACTIVITY_PAGE
  const page = usePageParam()
  const requested = useQueryValue('action', '')
  const action = INTENT_ACTIONS.some(a => a.v === requested) ? requested : ''
  const now = useNow()
  const { data, isFetching, isPlaceholderData, error, refetch, anchorRef } = useActivity(size, undefined, undefined, page * size, 'intent', undefined, action || undefined)
  const { data: count } = useActivityCount('intent', undefined, undefined, undefined, action || undefined)
  const rows = data ?? []
  const pages = offeredPages({ page, rowsOnPage: rows.length, rowCount: count?.total, maxOffset: count?.maxOffset, pageSize: size })
  return (
    <>
      <div className="sec-title-row">
        <div className="sec-title">Intent activity <span style={MUTED_SUB}>· newest first</span></div>
        <select className="activity-action" value={action} onChange={e => setQuery({ action: e.target.value || null, page: null })} aria-label="Intent action">
          <option value="">All actions</option>
          {INTENT_ACTIONS.map(a => <option key={a.v} value={a.v}>{a.label}</option>)}
        </select>
      </div>
      <ActivityTable rows={rows} now={now} live={page === 0} anchorRef={anchorRef} loading={isFetching && rows.length === 0} pending={isPlaceholderData} pageSize={size} error={error} onRetry={() => { void refetch() }} />
      <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={p => setQuery({ page: p > 0 ? String(p) : null })} />
    </>
  )
}

function IntentsSkeleton() {
  return (
    <>
      <ChartSkeleton h={78} />
      <SecTitle title="Fills" /><ChartSkeleton h={300} />
      <SecTitle title="Execution quality" /><ChartSkeleton h={120} />
      <SecTitle title="Top traders" />
      <div className="panel"><table className="tbl"><tbody><TableSkeleton cols={3} rows={5} /></tbody></table></div>
    </>
  )
}

export function Intents() {
  const { data, isError, refetch } = useIceDashboard()
  const open = useOpenIntents()
  const narrow = useMediaQuery(NARROW)
  const now = useNow()
  useDocumentTitle('Intents')
  // The open book is live; until it answers, the dashboard's own (≤ 5 min old)
  // reserve fold stands in, so the strip never waits on the second request.
  const summary = open.data?.summary ?? data?.openOrders
  return (
    <div className="wrap ice-page">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Intents' }]} />
        <div className="page-title">Intents <span className="sub">limit orders & DCA, settled by ICE</span></div>
      </div>
      <Intro />
      {isError
        ? <LoadError title="Couldn’t load the intents dashboard" onRetry={() => { void refetch() }} />
        : !data || !summary ? <IntentsSkeleton /> : (
          <>
            <Ribbon d={data} open={summary} />
            <div className="ice-asof">30-day figures as of <Ago ts={data.generatedAt} now={now} /> · open orders live</div>
            <FillsSection d={data} narrow={narrow} />
            <QualitySection d={data} />
            <TradersPairsSection d={data} />
            <OpenBookSection summary={summary} open={open.data} openError={open.isError} />
            <FeeSection d={data} narrow={narrow} />
            <VenueSection d={data} narrow={narrow} />
            <ActivitySection narrow={narrow} />
          </>
        )}
    </div>
  )
}
