/* eslint-disable react-refresh/only-export-components -- shared account-section components + their count helper */
import { useMemo } from 'react'
import { F, Amt, Usd, Num, AssetIcon, AssetAmount, AreaChart, ChartCardSkeleton, healthFactorDisplay, AddrPill, MomentLink, ProgressRing, rowNav, Dash, EmptyRow, Copy } from './ui'
import type { ChartMarker, DetailTab } from './ui'
import type { AccountMoneyMarket } from '../types'
import { Link, paths, setQuery } from '../router'
import { limitBinding } from '../utils/limitBinding'
import type { ActivitySlug } from '../router'
import { performancePoints } from './performance'
import { CAT } from './activityColors'
import { estimateBlockCountdown } from '../utils/blockCountdown'
import { blockSeconds, blockSpanSeconds, dcaAmountLeft, dcaCadence, dcaLeftUsd, dcaProgress, dcaRunway, fmtDuration } from '../utils/dca'
import type { PositionsPresence, MoneyMarketPosition, ActiveDca, OpenLimitOrder, AssetBalanceHistory, AccountProxyInfo, MultisigInfo, MultisigMembership, ProxyRelation, ValueEvent, ContractInfo, FarmRewardsSummary, MoneyMarketRewardsSummary } from '../types'
import type { ListCount } from '../api/explorer'
import type { ReactNode } from 'react'

// Render helpers shared by the Account and Tag detail pages so both surface the
// same on-chain data (balances, money-market card, DCA orders, LP positions,
// portfolio chart, balance history) with identical markup.

// Live "next execution" cell for an Active DCA order: the distance to its planned
// block at the chain's measured pace (`blockSec`, from stats — block time has been
// 12s, is ~6s and is heading for 2s, so it is never assumed here).
// Re-renders on the shared 1s clock (`now`) so the countdown ticks; the title
// carries the estimated wall-clock time. Once the block is at/under the head it's
// either due (waiting for the next plan) or pending.
//
// Time leads and the block trails it: "in 12m" is the answer, block 13,336,587
// is where it will happen.
export function DcaNextExec({ nextBlock, headBlock, headTime, now, blockSec }: { nextBlock: number | null; headBlock: number; headTime?: string; now: number; blockSec?: number }) {
  if (nextBlock == null) return <Dash />
  // The block links even when not yet produced — the block page renders a live
  // countdown for future heights.
  const blockLink = <span className="dca-blocks muted mono"><Link to={paths.block(nextBlock)} className="hash">{F.int(nextBlock)}</Link></span>
  const blocksAway = nextBlock - headBlock
  if (blocksAway <= 0 || !headBlock) {
    return <span title="Next execution is at or before the current head — awaiting its turn">due <span className="dca-sub">{blockLink}</span></span>
  }
  const timing = estimateBlockCountdown(nextBlock, headBlock, headTime, now, blockSeconds(blockSec))
  const secondsUntil = timing?.secondsUntil ?? blockSpanSeconds(blocksAway, blockSec)
  return (
    <span title={timing ? `Est. ${F.datetime(new Date(timing.etaMs).toISOString())}` : `Approximately ${blocksAway} blocks away`}>
      in {fmtDuration(secondsUntil, { seconds: true })}<span className="dca-sub">{blockLink}</span>
    </span>
  )
}

// Value-event marker presentation: kind → badge label, marker link slug and the
// hover-card body. The slug only needs to resolve (SLUG_TYPES groups action-level
// slugs by family); the detail page canonicalizes add- vs remove-liquidity etc.
const VALUE_EVENT_LABELS: Record<ValueEvent['kind'], string> = {
  'transfer-in': 'Transfer in', 'transfer-out': 'Transfer out', swap: 'Swap',
  liquidity: 'Liquidity', liquidation: 'Liquidation', dca: 'DCA',
  'cross-chain': 'Cross-chain', price: 'Price move', other: 'Transfer',
}
const VALUE_EVENT_SLUGS: Record<ValueEvent['kind'], ActivitySlug> = {
  'transfer-in': 'transfer', 'transfer-out': 'transfer', swap: 'swap',
  liquidity: 'add-liquidity', liquidation: 'liquidate', dca: 'dca',
  'cross-chain': 'cross-chain', price: 'transfer' /* unlinked */, other: 'transfer',
}
// Cross-chain markers carry the flow direction alongside the kind.
function valueEventLabel(ev: ValueEvent): string {
  if (ev.kind === 'cross-chain' && ev.direction) return ev.direction === 'in' ? 'Cross-chain in' : 'Cross-chain out'
  return VALUE_EVENT_LABELS[ev.kind]
}
// Single-marker hover card: date + kind + value, then the event's asset
// context and (for transfers) the counterparty. The kind keeps the marker's
// --mk color. Swap/DCA markers carry their traded pair (in → out); transfer
// and cross-chain markers show the token amount when the marker is exactly one
// event's leg. A DCA marker is a whole schedule, so its card names the
// schedule and trade count; a 'price' marker has no asset/event row — just the
// signed move.
function valueEventTip(ev: ValueEvent): ReactNode {
  const dir = ev.kind === 'transfer-in' || (ev.kind === 'cross-chain' && ev.direction === 'in') ? 'from'
    : ev.kind === 'transfer-out' || (ev.kind === 'cross-chain' && ev.direction === 'out') ? 'to' : null
  const kindLabel = ev.kind === 'dca' && ev.dcaScheduleId != null ? `DCA #${ev.dcaScheduleId}` : valueEventLabel(ev)
  const pair = ev.assetIn && ev.assetOut && (
    <span className="trade-leg">
      <AssetIcon assetId={ev.assetIn.assetId} iconAssetId={ev.assetIn.iconAssetId} iconAssetIds={ev.assetIn.iconAssetIds} symbol={ev.assetIn.symbol} size={16} parachainId={ev.assetIn.parachainId} origin={ev.assetIn.origin} />
      {' '}<span className="mono">{ev.assetIn.symbol}</span>
      <span className="muted">{' → '}</span>
      <AssetIcon assetId={ev.assetOut.assetId} iconAssetId={ev.assetOut.iconAssetId} iconAssetIds={ev.assetOut.iconAssetIds} symbol={ev.assetOut.symbol} size={16} parachainId={ev.assetOut.parachainId} origin={ev.assetOut.origin} />
      {' '}<span className="mono">{ev.assetOut.symbol}</span>
    </span>
  )
  return <>
    <div className="apx-mark-row">
      <span className="t-d">{ev.timestamp.slice(0, 10)}</span>
      <span className="t-k" style={{ color: 'var(--mk)' }}>{kindLabel}</span>
      <span className="t-p">{F.usd(ev.valueUsd)}</span>
    </div>
    {(pair || ev.asset || (dir && ev.counterparty) || (ev.kind === 'dca' && ev.dcaTrades != null)) && (
      <div className="apx-mark-row">
        {pair || (ev.asset && <span className="trade-leg">
          <AssetIcon assetId={ev.asset.assetId} iconAssetId={ev.asset.iconAssetId} iconAssetIds={ev.asset.iconAssetIds} symbol={ev.asset.symbol} size={16} parachainId={ev.asset.parachainId} origin={ev.asset.origin} />
          {' '}<span className="mono">{ev.amount != null ? `${F.amount(ev.amount, ev.asset.decimals)} ` : ''}{ev.asset.symbol}</span>
        </span>)}
        {dir && ev.counterparty && <><span className="muted">{dir}</span><AddrPill account={ev.counterparty} noCopy /></>}
        {ev.kind === 'dca' && ev.dcaTrades != null && <span className="muted">{F.int(ev.dcaTrades)} trades</span>}
      </div>
    )}
  </>
}
// Compact asset context for a cluster row: the traded pair for swap/DCA
// markers, else the (amount +) symbol of the value-bearing asset. Price-move
// markers have no asset and stay bare.
function valueEventDetail(ev: ValueEvent): ReactNode | undefined {
  if (ev.assetIn && ev.assetOut) {
    return <span className="trade-leg">
      <AssetIcon assetId={ev.assetIn.assetId} iconAssetId={ev.assetIn.iconAssetId} iconAssetIds={ev.assetIn.iconAssetIds} symbol={ev.assetIn.symbol} size={13} parachainId={ev.assetIn.parachainId} origin={ev.assetIn.origin} />
      <span className="mono">{ev.assetIn.symbol}</span>
      <span className="muted">→</span>
      <AssetIcon assetId={ev.assetOut.assetId} iconAssetId={ev.assetOut.iconAssetId} iconAssetIds={ev.assetOut.iconAssetIds} symbol={ev.assetOut.symbol} size={13} parachainId={ev.assetOut.parachainId} origin={ev.assetOut.origin} />
      <span className="mono">{ev.assetOut.symbol}</span>
    </span>
  }
  if (ev.asset) {
    return <span className="trade-leg">
      <AssetIcon assetId={ev.asset.assetId} iconAssetId={ev.asset.iconAssetId} iconAssetIds={ev.asset.iconAssetIds} symbol={ev.asset.symbol} size={13} parachainId={ev.asset.parachainId} origin={ev.asset.origin} />
      <span className="mono">{ev.amount != null ? `${F.amount(ev.amount, ev.asset.decimals)} ` : ''}{ev.asset.symbol}</span>
    </span>
  }
  return undefined
}
function valueEventMarker(ev: ValueEvent): ChartMarker {
  return {
    ts: ev.timestamp,
    kind: ev.kind,
    label: valueEventLabel(ev),
    valueUsd: ev.valueUsd,
    detail: valueEventDetail(ev),
    // A DCA marker links to its schedule page; a 'price' marker (and a cross-
    // chain marker the server couldn't match to a feed row) annotates a move
    // with no detail row to open; everything else links to the event.
    href: ev.kind === 'dca' && ev.dcaScheduleId != null
      ? paths.dcaSchedule(ev.dcaScheduleId)
      : ev.kind === 'price' || ev.linkable === false
        ? null
        : paths.activityDetail(VALUE_EVENT_SLUGS[ev.kind], `${ev.blockHeight}-e${ev.eventIndex}`),
    tip: valueEventTip(ev),
  }
}

// Portfolio value area chart. `netUsd` is the value shown at the top of the
// card (portfolio minus any borrowed debt); the series carries no dates of its
// own, so we borrow the first asset's balance-history point timestamps when the
// lengths line up (else a value-only tooltip). `valueEvents` (scope-agnostic —
// the parent fetches per account or tag) flag the largest transfers/swaps/
// liquidations as clickable markers on the chart's time axis.
export function PortfolioChart({ title, netUsd, series, dates: datesProp, balanceHistory, loading, valueEvents, refine, exHdxSeries, exHdxNetUsd }: {
  title: string; netUsd: number; series: number[]; dates?: string[]; balanceHistory?: AssetBalanceHistory[]; loading?: boolean; valueEvents?: ValueEvent[] | null
  refine?: (fromSec: number, toSec: number, points: number) => Promise<{ data: number[]; dates: string[]; overlay?: number[] }| null>
  /** The same curve with HDX and HDX LP taken out, for holders whose own token
   *  dominates the balance sheet (the Treasury). Absent everywhere else, so the
   *  second line and the legend exist exactly where the API ships the series. */
  exHdxSeries?: number[]
  exHdxNetUsd?: number
}) {
  // Stable across renders: Account holds a 1s clock, and AreaChart's marker
  // clustering memoizes on this array's identity.
  const markers = useMemo(() => (valueEvents?.length ? valueEvents.map(valueEventMarker) : undefined), [valueEvents])
  if (!series || series.length <= 1) {
    return loading ? (
      <>
        <div className="sec-title">{title}</div>
        {/* Same shape as the loaded card below: value + the 24H/1W/1M/1Y row. */}
        <ChartCardSkeleton metrics={4} />
      </>
    ) : null
  }
  // Prefer the portfolio's own per-bucket dates; fall back to a same-length asset
  // history if that's all that lines up. Either way the AreaChart shows the date
  // on hover (no static x-axis labels).
  const bp = balanceHistory?.[0]?.points
  const dates = datesProp && datesProp.length === series.length ? datesProp
    : bp && bp.length === series.length ? bp.map(p => p.ts) : undefined
  const perf = (label: string, val: number) => (
    <span key={label} className="perf"><span className="pk">{label}</span><span className="pv" style={{ color: val >= 0 ? 'var(--green)' : 'var(--red)' }}>{val >= 0 ? '+' : ''}{val.toFixed(1)}%</span></span>
  )
  // Suppress windows whose baseline is dust or that span the account's initial
  // funding (>20× growth) — "+1859057.1%" carries no information.
  const perfItems = performancePoints(series, dates, [
    { label: '24H', days: 1 },
    { label: '1W', days: 7 },
    { label: '1M', days: 30 },
    { label: '1Y', days: 365 },
  ], { minBase: 1, maxRatio: 20 })
  // The second curve renders only when it covers the same points as the total; a
  // mismatched length means the two came from different reconstructions, and the
  // comparison a reader would draw from them would be wrong.
  const overlay = exHdxSeries && exHdxSeries.length === series.length
    ? { data: exHdxSeries, label: 'Ex-HDX', color: 'var(--sky)' }
    : undefined
  // The total keeps its own green/red directional tint and its area fill — the
  // ex-HDX curve is an addition to that chart, not a restyling of it. The legend
  // swatch therefore reads the direction off the FULL series, which is the state
  // the legend is read in; a zoom retints the line by its own slice, exactly as it
  // always has on the single-curve chart.
  const totalUp = series[series.length - 1] >= series[0]
  return (
    <>
      <div className="sec-title">{title}</div>
      <div className="pf-card">
        <div className="pf-head"><div className="pf-now"><Usd v={netUsd} /></div>{perfItems.length > 0 && <div className="perf-row">{perfItems.map(p => perf(p.label, p.value))}</div>}</div>
        {/* Legend only with two curves: it names them and carries the ex-HDX figure
            beside the headline, so the lower line has a number the reader can
            attach to it without hovering. */}
        {overlay && (
          <div className="pf-legend">
            <span className="pf-key"><i className="pf-swatch" style={{ background: totalUp ? 'var(--green)' : 'var(--red)' }} />Total</span>
            <span className="pf-key"><i className="pf-swatch" style={{ background: 'var(--sky)' }} />Ex-HDX{exHdxNetUsd != null && <span className="pf-key-val"><Usd v={exHdxNetUsd} /></span>}</span>
          </div>
        )}
        <AreaChart data={series} h={180} dates={dates} markers={markers} refine={refine} zoomKey="zv" label="Total" overlay={overlay} />
      </div>
    </>
  )
}

// One count per isolated market: the API aggregates money market positions to
// one entry per market (core, GIGAHDX, BIL, …), and the Borrow tab renders one
// card per entry — so the tab badge counts what the tab shows. Collapsing the
// family to 1 undercounted every multi-market account and tag.
export function mmPositionCount(markets: MoneyMarketPosition[]): number {
  return markets.length
}

export function moneyMarketDebtUsd(markets: MoneyMarketPosition[]): number {
  return markets.reduce((total, market) => total + Number(market.totalDebtBase) / 1e8, 0)
}

// What the three position tabs hold right now, plus whether the holder has
// history worth a tab of its own when nothing is open (positions-presence).
// Orders counts active DCAs + resting limit orders, Liquidity the LP position
// rows, Borrow one per (account × market) area — each badge counts what its
// tab lists first.
export interface PositionTabCounts {
  orders: number
  liquidity: number
  borrow: number
  presence?: PositionsPresence | null
  /**
   * positions-presence is still loading: the position tab a `?view=` names is
   * kept (without a badge) until it answers, so a deep link does not fall back to
   * Overview and then jump once presence lands.
   */
  presenceLoading?: boolean
  /** The `?view=` the page was asked for. */
  requestedView?: string
}

export function profileTabs(
  balanceCount: number,
  positions: PositionTabCounts,
  // The activity list's own total. `activity.complete === false` means it counts
  // only the newest rows of a longer feed, which the badge marks with a `+` rather
  // than passing off as the account's whole history.
  activity?: ListCount,
  votesCount?: number,
  hasContract?: boolean,
  // Raw extrinsic/event counts for the flattened first-level tabs.
  extrinsicsCount?: number,
  eventsCount?: number,
  // Header-stat revenue total; the Protocol Revenue tab exists exactly when
  // the stat does, so the two can never disagree about whether there is any.
  revenueUsd?: number,
): DetailTab[] {
  const p = positions.presence
  // A tab with nothing open still shows when its history exists; its badge then
  // stays off rather than reading "0".
  const positionTab = (key: string, label: string, count: number, hasHistory: boolean): DetailTab[] =>
    count > 0 ? [{ key, label, count }]
      : hasHistory || (positions.presenceLoading && positions.requestedView === key) ? [{ key, label }] : []
  return [
    { key: 'overview', label: 'Overview' },
    { key: 'balances', label: 'Balances', count: balanceCount },
    ...positionTab('orders', 'Orders', positions.orders, (p?.orderHistory ?? 0) > 0),
    ...positionTab('liquidity', 'Liquidity', positions.liquidity, !!p?.liquidityHistory),
    ...positionTab('borrow', 'Borrow', positions.borrow, !!p?.moneyMarketHistory),
    ...(hasContract ? [{ key: 'contract', label: 'Contract' }] : []),
    { key: 'activity', label: 'Activity', ...(activity?.total == null ? {} : { count: activity.total, countAtLeast: !activity.complete }) },
    // Extrinsics and Events are first-level tabs, not sub-tabs of Activity: all
    // three are ways of listing what the account did, and burying two of them
    // one level down made them invisible.
    { key: 'extrinsics', label: 'Extrinsics', ...(extrinsicsCount == null ? {} : { count: extrinsicsCount }) },
    { key: 'events', label: 'Events', ...(eventsCount == null ? {} : { count: eventsCount }) },
    ...(votesCount && votesCount > 0 ? [{ key: 'votes', label: 'Votes', count: votesCount }] : []),
    ...(revenueUsd && revenueUsd > 0 ? [{ key: 'revenue', label: 'Protocol Revenue' }] : []),
  ]
}

// The tab a `?view=` asks for, among the tabs the page actually has. The old
// Positions tab split into Orders · Liquidity · Borrow, so a `positions` link
// lands on the first of those the holder has — Borrow first, since the money
// market card is what Positions used to lead with.
export function resolveProfileView(view: string, tabs: DetailTab[]): string {
  const has = (key: string) => tabs.some(t => t.key === key)
  if (view === 'positions') return ['borrow', 'liquidity', 'orders'].find(has) ?? 'overview'
  return has(view) ? view : 'overview'
}

// The Value stat is portfolio MINUS money-market debt on every surface that shows
// it, so a borrower's headline figure is netted against a loan the balance list
// never holds — and goes negative once the debt outgrows the wallet. This is the
// row that names that subtraction: what the primary market lent and borrowed,
// then each supplemental market (GIGAHDX, BIL, …) carrying debt of its own. The
// markets are isolated, so each is named separately rather than blended into one
// figure that would hide which one is levered. Returns null when nothing is
// borrowed, so the caller renders no row at all rather than an empty one.
function moneyMarketValueBreakdown(markets: MoneyMarketPosition[]): ReactNode {
  const primary = markets.find(p => p.role === 'primary') ?? markets.find(p => p.marketKey === 'core')
  const primarySupplyUsd = Number(primary?.totalSuppliedBase ?? primary?.totalCollateralBase ?? 0) / 1e8
  const primaryDebtUsd = Number(primary?.totalDebtBase ?? 0) / 1e8
  const supplementalDebts = markets
    .filter(p => p !== primary && Number(p.totalDebtBase) > 0)
    .map(p => ({ key: p.marketKey, label: p.market, usd: Number(p.totalDebtBase) / 1e8 }))
  if (primaryDebtUsd <= 0 && !supplementalDebts.length) return null
  return (
    <div className="hint">
      {primaryDebtUsd > 0 && <>primary <Usd v={primarySupplyUsd} /> lent · −<Usd v={primaryDebtUsd} /> borrowed</>}
      {supplementalDebts.map((m, i) => <span key={m.key}>{(primaryDebtUsd > 0 || i > 0) && <span aria-hidden="true"> · </span>}<span className="mm-secondary-debt">{m.label} debt −<Usd v={m.usd} /></span></span>)}
    </div>
  )
}

const MM_REWARDS_TITLE = 'What claiming every lending incentive now would pay (the money market\'s own getAllUserRewards), at current prices. Included in Value; rewards whose asset has no price are not.'
const MM_BELOW_ED_TITLE = ' Some amounts are below the reward asset\'s existential deposit: a claim including them reverts until the account holds at least that much of the asset. Still owed.'

const FARM_REWARDS_TITLE = 'What claiming every farm entry now would pay (loyalty multiplier applied, already-claimed rewards subtracted), at current prices. Included in Value; rewards whose asset has no price are not.'
const BELOW_ED_TITLE = ' Some amounts are below the reward asset\'s existential deposit while the account holds less than that of the asset: a claim now would pay them to the treasury (a withdraw forfeits them the same way), so they are not counted.'
// Non-zero rewards whose asset has no price: they are in no USD sum.
const unpricedCount = (entries: { amount: string; valueUsd: number | null }[]): number =>
  entries.filter(e => e.amount !== '0' && e.valueUsd == null).length
// Non-zero farm rewards a claim would not pay the account (below ED, owner holding less).
const unpayableCount = (entries: { amount: string; payable?: boolean }[]): number =>
  entries.filter(e => e.amount !== '0' && e.payable === false).length
const unpricedNote = (n: number): string => (n > 0 ? ` (+ ${n} unpriced)` : '')

export function ProfileStats({ tradingVolumeUsd, liquidationVolumeUsd, revenueUsd, valueUsd, exHdxValueUsd, moneyMarket, farmRewards, moneyMarketRewards }: {
  tradingVolumeUsd?: number | null
  liquidationVolumeUsd?: number | null
  // Protocol revenue earned from this account (fees paid, penalties, interest).
  revenueUsd?: number | null
  valueUsd: number
  // `valueUsd` with HDX and HDX LP taken out. Shipped only for holders whose own
  // token dominates the balance sheet (the Treasury), so — like revenueUsd — the
  // tile exists exactly when the figure does. Rendered even at/above `valueUsd`
  // (an account with no HDX) rather than hidden on a threshold: on a surface that
  // advertises the split, a missing tile reads as missing data.
  exHdxValueUsd?: number | null
  // The positions `valueUsd` was already netted against. Owned by this component
  // rather than each page, so the account and tag surfaces cannot drift into
  // explaining the same subtraction differently — or, as the account page did,
  // not at all.
  moneyMarket?: MoneyMarketPosition[]
  // Unclaimed farm rewards: already inside `valueUsd`; stated as its share.
  farmRewards?: FarmRewardsSummary | null
  // Claimable lending incentives: the same — inside `valueUsd`, stated as its share.
  moneyMarketRewards?: MoneyMarketRewardsSummary | null
}) {
  const trading = tradingVolumeUsd ?? 0
  const liquidation = liquidationVolumeUsd ?? 0
  const revenue = revenueUsd ?? 0
  const valueHint = moneyMarket?.length ? moneyMarketValueBreakdown(moneyMarket) : null
  const rewardsUnpriced = unpricedCount((farmRewards?.items ?? []).map(i => ({ amount: i.claimable, valueUsd: i.claimableUsd })))
  const rewardsUnpayable = unpayableCount((farmRewards?.items ?? []).map(i => ({ amount: i.claimable, payable: i.payable })))
  const incentivesUnpriced = unpricedCount((moneyMarketRewards?.items ?? []).map(i => ({ amount: i.claimable, valueUsd: i.claimableUsd })))
  const incentivesBelowEd = (moneyMarketRewards?.items ?? []).some(i => i.belowExistentialDeposit)
  return (
    <>
    <div className="acct-stats">
      {trading > 0 && <div className="acct-bal subtle">
        <div className="lab">Trading</div>
        <div className="amt"><Usd v={trading} /></div>
      </div>}
      {liquidation > 0 && <div className="acct-bal subtle">
        <div className="lab">Liquidation</div>
        <div className="amt"><Usd v={liquidation} /></div>
      </div>}
      {revenue > 0 && <div className="acct-bal subtle">
        {/* "Protocol Revenue" where the row has room; the narrow swap keeps the
            four stat tiles on one line on phones. */}
        <div className="lab"><span className="lab-wide">Protocol Revenue</span><span className="lab-narrow" title="Protocol Revenue">P. Revenue</span></div>
        <div className="amt"><Usd v={revenue} /></div>
      </div>}
      {exHdxValueUsd != null && <div className="acct-bal subtle">
        {/* Same wide/narrow pair as Protocol Revenue — "Ex-HDX value" where the row
            has room, "Ex-HDX" on phones, so the tiles stay on one line. */}
        <div className="lab"><span className="lab-wide">Ex-HDX value</span><span className="lab-narrow">Ex-HDX</span></div>
        <div className="amt"><Usd v={exHdxValueUsd} /></div>
      </div>}
      <div className="acct-bal">
        <div className="lab">Value</div>
        <div className="amt"><Usd v={valueUsd} /></div>
      </div>
    </div>
    {/* The money-market breakdown rides on its own full-width row below the
        stats, so it can run left under trading/liquidation instead of
        wrapping inside the value's narrow column. */}
    {valueHint && <div className="acct-stats-hint">{valueHint}</div>}
    {farmRewards && (farmRewards.totalUsd > 0 || rewardsUnpriced > 0 || rewardsUnpayable > 0) && <div className="acct-stats-hint">
      <div className="hint" title={`${FARM_REWARDS_TITLE}${rewardsUnpayable > 0 ? BELOW_ED_TITLE : ''} As of block ${F.int(farmRewards.asOfBlock)}.`}>Incl. <Usd v={farmRewards.totalUsd} /> unclaimed farm rewards{rewardsUnpriced > 0 ? ` (+ ${rewardsUnpriced} unpriced, not included)` : ''}{rewardsUnpayable > 0 ? ` (+ ${rewardsUnpayable} unpayable, not included)` : ''}</div>
    </div>}
    {moneyMarketRewards && (moneyMarketRewards.totalUsd > 0 || incentivesUnpriced > 0) && <div className="acct-stats-hint">
      <div className="hint" title={`${MM_REWARDS_TITLE}${incentivesBelowEd ? MM_BELOW_ED_TITLE : ''} As of block ${F.int(moneyMarketRewards.asOfBlock)}.`}>Incl. <Usd v={moneyMarketRewards.totalUsd} /> unclaimed lending incentives{incentivesUnpriced > 0 ? ` (+ ${incentivesUnpriced} unpriced, not included)` : ''}</div>
    </div>}
  </>
  )
}

function currentLtvPct(mm: MoneyMarketPosition): number {
  const collateral = Number(mm.totalCollateralBase)
  const debt = Number(mm.totalDebtBase)
  return collateral > 0 && debt > 0 ? debt / collateral * 100 : 0
}

function MoneyMarketRiskBar({ mm }: { mm: MoneyMarketPosition }) {
  const debtUsd = Number(mm.totalDebtBase) / 1e8
  if (debtUsd <= 0 || mm.healthFactor === 'unknown' || Number(mm.liquidationThreshold) <= 0) return null
  const ltvPct = currentLtvPct(mm)
  const liqPct = Number(mm.liquidationThreshold) / 100
  const fillPct = liqPct > 0 ? Math.min(100, ltvPct / liqPct * 100) : 0
  return (
    <div className="mm-bar">
      <div
        className="mm-bar-track"
        role="meter"
        aria-label={`${mm.market} current loan-to-value`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, ltvPct)}
        aria-valuetext={`${ltvPct.toFixed(1)}% current loan-to-value; liquidation threshold ${liqPct.toFixed(0)}%`}
      >
        <div className="mm-bar-fill" style={{ width: `${fillPct.toFixed(1)}%` }} />
        <div className="mm-bar-liq" />
      </div>
      <div className="mm-bar-lab"><span>Current LTV {ltvPct.toFixed(1)}%</span><span className="muted">liquidation @ {liqPct.toFixed(0)}%</span></div>
    </div>
  )
}

function MoneyMarketReserveColumns({ mm }: { mm: MoneyMarketPosition }) {
  if (!mm.reserves?.length) return null
  const supplied = mm.reserves.filter(r => r.supplied !== '0')
  const borrowed = mm.reserves.filter(r => r.debt !== '0')
  return (
    <div className="mm-cols">
      <div>
        <div className="mm-col-head">Lent</div>
        {supplied.map(r => (
          <div className="mm-row" key={`s${r.assetId}`}>
            <Link to={paths.asset(r.assetId)} className="trade-leg"><AssetIcon assetId={r.assetId} iconAssetId={r.iconAssetId} iconAssetIds={r.iconAssetIds} symbol={r.symbol} size={18} parachainId={r.parachainId} origin={r.origin} /> <span className="mono">{r.symbol}</span></Link>
            <span className="mono"><Amt raw={r.supplied} dec={r.decimals} /></span>
            <span className="mono muted"><Usd v={r.suppliedUsd} /></span>
            {r.collateral ? <span className="badge ok mm-collateral-badge">collateral</span> : null}
          </div>
        ))}
        {!supplied.length && <div className="mm-empty">None</div>}
      </div>
      <div>
        <div className="mm-col-head">Borrowed</div>
        {borrowed.map(r => (
          <div className="mm-row" key={`d${r.assetId}`}>
            <Link to={paths.asset(r.assetId)} className="trade-leg"><AssetIcon assetId={r.assetId} iconAssetId={r.iconAssetId} iconAssetIds={r.iconAssetIds} symbol={r.symbol} size={18} parachainId={r.parachainId} origin={r.origin} /> <span className="mono">{r.symbol}</span></Link>
            <span className="mono"><Amt raw={r.debt} dec={r.decimals} /></span>
            <span className="mono muted"><Usd v={r.debtUsd} /></span>
          </div>
        ))}
        {!borrowed.length && <div className="mm-empty">No outstanding debt</div>}
      </div>
    </div>
  )
}

// Non-primary market labels that map to a registered asset get its CDN icon
// next to the label (GIGAHDX → asset 67, BIL → asset 55 — the token each
// market is named after).
const MARKET_ICON_ASSET: Record<string, number> = { gigahdx: 67, bil: 55 }

// Every market gets the full position treatment; only the primary market is
// allowed to deep-link into DefiSim.
function MoneyMarketCard({ mm, defisimAddress }: { mm: MoneyMarketPosition; defisimAddress?: string }) {
  const hf = healthFactorDisplay(mm.healthFactor)
  const supplyUsd = Number(mm.totalSuppliedBase ?? mm.totalCollateralBase) / 1e8
  const debtUsd = Number(mm.totalDebtBase) / 1e8
  const headingId = `money-market-${mm.marketKey.replace(/[^a-z0-9_-]/gi, '-')}`
  const isPrimary = mm.role === 'primary'
  const iconAsset = MARKET_ICON_ASSET[mm.marketKey]
  // The market's claimable incentives (already in Value, never in Lent).
  const rewards = (mm.unclaimedRewards ?? []).filter(r => r.claimable !== '0')
  const pricedRewards = rewards.filter(r => r.claimableUsd != null)
  const rewardsUsd = pricedRewards.reduce((s, r) => s + (r.claimableUsd ?? 0), 0)
  const rewardsUnpriced = unpricedCount(rewards.map(r => ({ amount: r.claimable, valueUsd: r.claimableUsd })))
  return (
    <section className="mm-market-section" aria-labelledby={headingId} data-market-key={mm.marketKey}>
      <header className="sec-title mm-title-row">
        <h2 id={headingId} className="mm-title">{isPrimary ? mm.market : 'Money Market'}</h2>
        <span className="mm-title-note">
          {isPrimary ? 'primary' : <>{iconAsset != null && <AssetIcon assetId={iconAsset} symbol={mm.market} size={14} />} {mm.market}</>} · lend &amp; borrow
        </span>
        {mm.stakingBacked && <span className="mm-title-note">collateral is staked HDX — counted once in the wallet balance</span>}
        {defisimAddress && <a className="ext-link mm-defisim-link" href={`https://defisim.neckwork.net/?address=${encodeURIComponent(defisimAddress)}`} target="_blank" rel="noopener noreferrer">Open in DefiSim ↗</a>}
      </header>
      <div className="mm-card">
        <div className="mm-summary">
          <div className="mm-stat"><span className="k">Lent</span><span className="v"><Usd v={supplyUsd} /></span></div>
          <div className="mm-stat"><span className="k">Borrowed</span><span className="v">{debtUsd > 0 ? <Usd v={debtUsd} /> : '—'}</span></div>
          <div className="mm-stat"><span className="k">Net worth</span><span className="v"><Usd v={supplyUsd - debtUsd} /></span></div>
          <div className="mm-stat"><span className="k">Available to borrow</span><span className="v"><Usd v={Number(mm.availableBorrowsBase) / 1e8} /></span></div>
          {/* "Lowest member health" is only true of a row that SUMS several
              members, where the figure is the worst of them. It used to key off
              simAccount, which was a proxy for "this is an aggregate" — until a
              per-account row started carrying one so it could link to its own
              address. memberCount says it directly: absent on one account's own
              position, and 1 on a tag whose market has a single holder. */}
          <div className="mm-stat"><span className="k">{(mm.memberCount ?? 0) > 1 ? 'Lowest member health' : 'Health factor'}</span><span className={`v hf ${hf.cls}`}>{hf.label}</span></div>
          {rewards.length > 0 && <div className="mm-stat" title={`${MM_REWARDS_TITLE}${rewards.some(r => r.belowExistentialDeposit) ? MM_BELOW_ED_TITLE : ''} Not part of Lent.`}>
            <span className="k">Unclaimed incentives</span>
            {/* With no priced incentive the raw amounts stand in — an unpriced
                reward still reads as a reward, never as $0.00. */}
            <span className="v">{pricedRewards.length
              ? <><Usd v={rewardsUsd} />{unpricedNote(rewardsUnpriced)}</>
              : rewards.map((r, i) => <span key={`${r.asset.assetId}-${i}`}>{i > 0 ? ' · ' : ''}<Amt raw={r.claimable} dec={r.asset.decimals} /> {r.asset.symbol}</span>)}</span>
          </div>}
        </div>
        <MoneyMarketRiskBar mm={mm} />
        <MoneyMarketReserveColumns mm={mm} />
      </div>
    </section>
  )
}

// Shared account/tag renderer. The role comes from the API so presentation does
// not depend on risk order or on a magic market label. Every market renders as
// the same full card — primary first, DefiSim scoped to it.
// A tag's money-market positions, one block per member rather than one summed
// block for the tag. A combined health factor is a useful headline — it is what
// the header stat shows — but it is not a position anyone can act on: liquidation
// happens per account, and DefiSim simulates one account at a time. So each member
// that holds a position gets its own card set, addressed and linkable.
//
// Ordered by the money at stake, so the account that matters leads. Members with
// no position are absent rather than rendered empty.
export function MoneyMarketByAccount({ accounts }: { accounts: AccountMoneyMarket[] }) {
  if (!accounts.length) return null
  return (
    <>
      {accounts.map(entry => (
        <div key={entry.account.accountId} className="mm-account">
          <div className="sec-title mm-account-head">
            <AddrPill account={entry.account} />
          </div>
          {/* The same cards the account page renders, so a position reads the same
              wherever it is met. defisimAddress falls back to this member's own
              address; the card itself withholds the link on an isolated market,
              which DefiSim cannot simulate. */}
          <MoneyMarketPositions markets={entry.markets} defisimAddress={entry.account.address} />
        </div>
      ))}
    </>
  )
}

export function MoneyMarketPositions({ markets, defisimAddress }: { markets: MoneyMarketPosition[]; defisimAddress?: string }) {
  const primary = markets.find(m => m.role === 'primary') ?? markets.find(m => m.marketKey === 'core')
  const others = markets.filter(m => m !== primary)
  const primaryDefisim = primary?.defiSimSupported ? (primary.simAccount ?? defisimAddress) : undefined
  return (
    <>
      {primary && <MoneyMarketCard mm={primary} defisimAddress={primaryDefisim} />}
      {others.map(mm => <MoneyMarketCard key={mm.marketKey} mm={mm} />)}
    </>
  )
}

// What a section of orders adds up to, in the units its columns already speak.
// Every figure folds only what a row displays: the per-day rate is each order's
// per-trade value at its own cadence, the budget is each row's dollar figure
// (funding balance for open-ended), and "left" scales a budget by the raw
// remaining/total ratio — an unknown remainder counts as fully left rather than
// silently spent. Rows with no price stay out of the sums instead of anchoring
// them at $0; `pricedOrders` says how many rows the money figures actually fold.
//
// Rates are NEXT-24H realistic, not instantaneous — the same cap the /hdx
// dashboard applies: each order contributes at most the trades it can still pay
// for (dcaRunway), so a 30-second whale minutes from exhausting its budget
// cannot inflate the daily figure by orders of magnitude.
export interface DcaAggregates {
  orders: number
  pricedOrders: number
  perDayUsd: number        // ≈ combined spend/buy rate, capped by what each order can still fund
  tradesPerDay: number     // combined execution rate (all orders, priced or not), same cap
  budgetUsd: number        // Σ budget (open-ended: funding balance) in dollars
  leftUsd: number          // Σ still to spend, same basis
  trades: number           // Σ executions done
  nextBlock: number | null // the soonest planned execution across the orders
}
export function dcaAggregates(dcas: ActiveDca[], blockSec?: number): DcaAggregates {
  const agg: DcaAggregates = { orders: dcas.length, pricedOrders: 0, perDayUsd: 0, tradesPerDay: 0, budgetUsd: 0, leftUsd: 0, trades: 0, nextBlock: null }
  for (const d of dcas) {
    const cadence = dcaCadence(d.periodSeconds, d.period, blockSec)
    if (cadence.seconds > 0) {
      const runway = dcaRunway({
        direction: d.direction, amountPer: d.amountPerTrade, totalAmount: d.totalAmount,
        filledAmount: d.filledAmount, executionsDone: d.executionsDone,
        periodSeconds: cadence.seconds, fundingBalance: d.fundingBalance,
      })
      // No runway (a Buy that has never executed, an unreadable owner) leaves
      // the order uncapped — the rate is ≈ either way.
      const perDay = Math.min(86400 / cadence.seconds, runway?.trades ?? Infinity)
      agg.tradesPerDay += perDay
      if (d.valueUsd != null) agg.perDayUsd += d.valueUsd * perDay
    }
    const openEnded = d.totalAmount === '0'
    const budget = openEnded ? d.fundingUsd : d.budgetUsd
    if (budget != null) {
      agg.pricedOrders += 1
      agg.budgetUsd += budget
      // An open-ended order's visible dollar figure IS what is left; a budgeted
      // one keeps the fraction its raw remainder says. The ratio is display-only,
      // so Number() precision is the same class as the dollar values themselves.
      const total = Number(d.totalAmount)
      const ratio = openEnded ? 1
        : d.remainingAmount != null && total > 0 ? Math.min(1, Math.max(0, Number(d.remainingAmount) / total)) : 1
      agg.leftUsd += budget * ratio
    }
    agg.trades += d.executionsDone
    if (d.nextExecutionBlock != null) agg.nextBlock = agg.nextBlock == null ? d.nextExecutionBlock : Math.min(agg.nextBlock, d.nextExecutionBlock)
  }
  return agg
}

// The aggregate first row of an asset's DCA section: the orders below it summed
// into the same columns — combined rate under Per trade, total money under
// Budget, overall share spent under Filled, the section's own pulse under Every
// and Next trade. Everything here is approximate by construction (measured
// cadences, current prices, projected open-ended budgets), so the money and
// share figures carry the ≈/~ the per-row cells reserve for estimates.
function DcaTotalsRow({ dcas, showOwner, headBlock, headTime, now, blockSec }: {
  dcas: ActiveDca[]; showOwner?: boolean; headBlock: number; headTime?: string; now: number; blockSec?: number
}) {
  const agg = dcaAggregates(dcas, blockSec)
  const spentShare = agg.budgetUsd > 0 ? Math.max(0, Math.min(100, (1 - agg.leftUsd / agg.budgetUsd) * 100)) : null
  const unpriced = agg.orders - agg.pricedOrders
  return (
    <tr className="dca-total">
      <td data-label="Orders" colSpan={showOwner ? 2 : 1}>
        <span className="muted">All {F.int(agg.orders)} orders combined</span>
        {unpriced > 0 && <span className="dca-sub mono muted" title="Orders in an asset with no price feed — in the counts and timing here, but not in the dollar figures">{F.int(unpriced)} unpriced</span>}
      </td>
      <td data-label="Rate" className="r">
        {agg.perDayUsd > 0 ? <><span className="mono">≈ <Usd v={agg.perDayUsd} /></span><span className="muted">/day</span></> : <Dash />}
        <span className="dca-sub mono muted">combined rate</span>
      </td>
      {/* Deliberately blank: these orders are limits on different pairs quoted in
          different assets, so there is no total of them to state. */}
      <td data-label="Limit" className="r"><Dash /></td>
      <td data-label="Budget" className="r">
        {agg.pricedOrders > 0 ? <>
          <span className="mono">≈ <Usd v={agg.budgetUsd} /></span>
          <span className="dca-sub mono muted"><Usd v={agg.leftUsd} /> left</span>
        </> : <Dash />}
      </td>
      <td data-label="Filled" className="r">
        {spentShare != null && <span className="mono">~{Math.round(spentShare)}%</span>}
        <span className="dca-sub mono muted">{F.int(agg.trades)} {agg.trades === 1 ? 'trade' : 'trades'}</span>
      </td>
      <td data-label="Every" className="r mono" title="One trade lands roughly this often across all these orders together">
        {agg.tradesPerDay > 0 ? <>~{fmtDuration(86400 / agg.tradesPerDay)}<span className="dca-sub mono muted">between trades</span></> : <Dash />}
      </td>
      <td data-label="Next trade" className="r mono">
        <DcaNextExec nextBlock={agg.nextBlock} headBlock={headBlock} headTime={headTime} now={now} blockSec={blockSec} />
        {agg.nextBlock != null && <span className="dca-sub mono muted">soonest</span>}
      </td>
      <td data-label="Runs out" className="r"><Dash /></td>
    </tr>
  )
}

// An active order answers, in this order: what it trades, how much per trade and
// in total (with today's dollar value under each), how far along it is, how often
// it fires, when that is next, and when the budget runs out. Cadence and timing
// are durations; the blocks that produce them ride underneath in the quiet type.
//
// The account and tag pages use the defaults; the asset page names each section
// itself (`title`), shows whose order each row is (`showOwner` — the page isn't
// the owner there), keeps an empty section visible (`emptyText`) so a reader
// sent to "sells" can see there are none rather than wonder where the table
// went, and leads with the aggregate of the whole section (`totals`).
// A DCA order's price ceiling, one axis for every kind and direction: the most it
// pays for a unit of what it buys. The exact 12 dp figure and the order's own term
// (a Sell's floor on what it receives, a Buy's cap on what it pays) ride in the
// title, since the cell shows the rough scale like every other number here.
function DcaLimitCell({ dca }: { dca: ActiveDca }) {
  const { limit, assetIn, assetOut } = dca
  if (!limit || !Number.isFinite(Number(limit.price))) {
    return <span className="muted" title="No absolute limit — this order relies on its slippage tolerance against the oracle price">—</span>
  }
  // The order's own term, scaled — a tooltip that stated raw integer units would
  // be a number nobody can compare to the amounts in the row beside it.
  const binding = limitBinding(limit.marketRatio)
  const bound = limit.asset === 'out'
    ? `at least ${F.exact(limit.amount, assetOut.decimals)} ${assetOut.symbol} per trade`
    : `at most ${F.exact(limit.amount, assetIn.decimals)} ${assetIn.symbol} per trade`
  return (
    <span title={`Pays at most ${limit.price} ${assetIn.symbol} per ${assetOut.symbol} — the order asks for ${bound}`}>
      ≤ <Num v={Number(limit.price)} /> <span className="muted">{assetIn.symbol}</span>
      <span className="dca-sub mono muted">per {assetOut.symbol}
        {binding && <span className={`limit-flag limit-flag-${binding.kind}`} title={binding.title}>{binding.label}</span>}
      </span>
    </span>
  )
}

export function ActiveDcaTable({ dcas, headBlock, headTime, now, blockSec, title, showOwner, emptyText, totals }: {
  dcas: ActiveDca[]; headBlock: number; headTime?: string; now: number; blockSec?: number
  title?: ReactNode; showOwner?: boolean; emptyText?: ReactNode; totals?: boolean
}) {
  if (!dcas.length && !emptyText) return null
  return (
    <>
      <div className="sec-title">{title ?? <>Active DCA orders · {dcas.length}</>}</div>
      {/* The owner variant is the asset page's, where a Buys and a Sells table
          stack: fixed shared column widths keep the pair's columns on the same
          vertical lines (see .dca-tbl-aligned). */}
      <div className="panel"><table className={'tbl dca-tbl' + (showOwner ? ' dca-tbl-aligned' : '')}>
        <thead><tr>
          {showOwner && <th>Owner</th>}
          <th>Selling → Buying</th><th className="r">Per trade</th><th className="r">Limit</th><th className="r">Budget</th>
          <th className="r">Filled</th><th className="r">Every</th><th className="r">Next trade</th><th className="r">Runs out</th>
        </tr></thead>
        <tbody>
          {/* A sum of one order would just repeat the order. */}
          {totals && dcas.length > 1 && <DcaTotalsRow dcas={dcas} showOwner={showOwner} headBlock={headBlock} headTime={headTime} now={now} blockSec={blockSec} />}
          {!dcas.length ? <EmptyRow cols={showOwner ? 9 : 8}>{emptyText}</EmptyRow> : dcas.map(d => {
            // Buy orders specify the output per trade ("buy 80 USDC"); sell orders the input.
            const isBuy = d.direction === 'Buy'
            const perAsset = isBuy ? d.assetOut : d.assetIn
            const openEnded = d.totalAmount === '0'
            // What the order still has to spend, in dollars: a budgeted one's
            // unspent share of its budget, an open-ended one's whole funding
            // balance (which is all it has left by definition). An asset with no
            // price feed keeps the figure in the sold asset rather than losing it.
            const leftUsd = openEnded ? d.fundingUsd : dcaLeftUsd(d.totalAmount, d.filledAmount, d.budgetUsd)
            const leftRaw = openEnded ? d.fundingBalance : dcaAmountLeft(d.totalAmount, d.filledAmount)
            const left = leftUsd != null ? <Usd v={leftUsd} />
              : leftRaw != null ? <><Amt raw={leftRaw} dec={d.assetIn.decimals} /> {d.assetIn.symbol}</>
                : null
            // Open-ended orders have no budget to be a fraction of: their share and
            // their end come from the balance still funding them (see dcaProgress).
            const { pct, projected } = dcaProgress(d.totalAmount, d.filledAmount, d.fundingBalance)
            const timing = d.nextExecutionBlock != null && headBlock
              ? estimateBlockCountdown(d.nextExecutionBlock, headBlock, headTime, now, blockSeconds(blockSec))
              : null
            // Measured from this order's own trades where it has them, so an order
            // that outlived a block-time change reads at the pace it runs now.
            const cadence = dcaCadence(d.periodSeconds, d.period, blockSec)
            const runway = dcaRunway({
              direction: d.direction, amountPer: d.amountPerTrade, totalAmount: d.totalAmount,
              filledAmount: d.filledAmount, executionsDone: d.executionsDone,
              periodSeconds: cadence.seconds, secondsToNext: timing?.secondsUntil ?? null,
              fundingBalance: d.fundingBalance,
            })
            return (
              // A DCA intent and a pallet-DCA schedule are the same order to a
              // reader, so they share this table — but not an id space (schedule
              // 76 and intent #76 both exist), so the key and the link come from
              // whichever identity the row actually has.
              <tr key={d.intentId ?? `dca-${d.id}`}
                {...rowNav(d.intentId ? paths.intent(d.intentId) : paths.dcaSchedule(d.id))}
                {...(d.intentId ? { 'data-intent-order': d.intentId } : { 'data-dca-schedule': d.id })}>
                {showOwner && <td data-label="Owner">{d.who ? <AddrPill account={d.who} noCopy /> : <Dash />}</td>}
                <td data-label="Selling → Buying">
                  <span className="asset-flow">
                    <span className="trade-leg"><AssetIcon assetId={d.assetIn.assetId} iconAssetId={d.assetIn.iconAssetId} iconAssetIds={d.assetIn.iconAssetIds} symbol={d.assetIn.symbol} size={20} parachainId={d.assetIn.parachainId} origin={d.assetIn.origin} /> <span className="mono">{d.assetIn.symbol}</span></span>
                    {' → '}
                    <span className="trade-leg"><AssetIcon assetId={d.assetOut.assetId} iconAssetId={d.assetOut.iconAssetId} iconAssetIds={d.assetOut.iconAssetIds} symbol={d.assetOut.symbol} size={20} parachainId={d.assetOut.parachainId} origin={d.assetOut.origin} /> <span className="mono">{d.assetOut.symbol}</span></span>
                    {d.intentId && <span className="dca-kind" title={`ICE DCA intent #${d.id} — runtime 443’s DCA, filled by a solver rather than by the DCA pallet`}>intent</span>}
                  </span>
                </td>
                <td data-label="Per trade" className="r">
                  <AssetAmount asset={perAsset} raw={d.amountPerTrade} />{isBuy ? <span className="muted"> bought</span> : null}
                  {d.valueUsd != null && <span className="dca-sub mono muted"><Usd v={d.valueUsd} /></span>}
                </td>
                {/* The most it will pay for what it buys. A Sell order floors what
                    it receives and a Buy order caps what it pays; those read as
                    opposite terms but bound the same thing, so both are quoted as
                    a ceiling on the price and the order's own term sits under it.
                    An order with no absolute bound rides on slippage against the
                    oracle alone — that is a dash, not a limit of zero. */}
                <td data-label="Limit" className="r mono">
                  <DcaLimitCell dca={d} />
                </td>
                <td data-label="Budget" className="r">
                  {openEnded ? <>
                    <span className="mono muted">open-ended</span>
                    {left && <span className="dca-sub mono muted" title="Owner’s balance of the sold asset — what the order still has to spend">
                      {left} left
                    </span>}
                  </> : <>
                    <AssetAmount asset={d.assetIn} raw={d.totalAmount} />
                    {/* What the order started with and what is still ahead of it,
                        on one line under the budget — two amounts of the same money,
                        read left to right the way the schedule page states them.
                        Stacked, they read as two unrelated facts. */}
                    {(d.budgetUsd != null || left) && <span className="dca-sub mono muted">
                      {d.budgetUsd != null && <Usd v={d.budgetUsd} />}
                      {d.budgetUsd != null && left ? ' · ' : ''}
                      {left && <span title="Left of the budget — what this order still has to spend">{left} left</span>}
                    </span>}
                  </>}
                </td>
                <td data-label="Filled" className="r">
                  <span className="dca-filled">
                    <ProgressRing pct={pct} size={18} stroke={8} title={pct == null ? 'Open-ended order — no balance to project against'
                      : projected ? `${pct.toFixed(1)}% of what it has spent plus what the owner’s balance still funds`
                        : `${pct.toFixed(1)}% of the budget spent`} />
                    <span className="mono">{pct != null ? `${projected ? '~' : ''}${Math.round(pct)}%` : '—'}</span>
                    <span className="dca-sub mono muted">{F.int(d.executionsDone)} {d.executionsDone === 1 ? 'trade' : 'trades'}</span>
                  </span>
                </td>
                <td data-label="Every" className="r mono" title={cadence.measured
                  ? 'Measured from the gaps between this order\u2019s own trades'
                  : 'Estimated from the chain\u2019s current block time'}>{cadence.measured ? '' : '~'}{fmtDuration(cadence.seconds)}
                  <span className="dca-sub dca-blocks mono muted">{F.int(d.period)} blocks</span>
                </td>
                <td data-label="Next trade" className="r mono"><DcaNextExec nextBlock={d.nextExecutionBlock} headBlock={headBlock} headTime={headTime} now={now} blockSec={blockSec} /></td>
                <td data-label="Runs out" className="r mono">
                  {runway && runway.trades > 0
                    ? <span title={runway.funded
                      ? 'Projected from the owner’s current balance of the sold asset — a top-up extends it'
                      : runway.estimated
                        ? 'Estimated from what this order has spent per trade so far — a Buy order fixes what it buys, not what it costs'
                        : 'At this order’s per-trade amount and cadence'}>
                      {runway.estimated ? '~' : ''}{fmtDuration(runway.seconds)}
                      <span className="dca-sub mono muted">{runway.estimated ? '~' : ''}{F.int(runway.trades)} to go</span>
                    </span>
                    : <span className="muted">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </>
  )
}

// How far through a partially-filled limit order we are, by the sold leg: what
// the partials have taken as a share of what was placed. Integer strings can
// exceed Number's exact range, so the ratio is taken as a ratio of two floats —
// display-only, and never an amount.
export function limitOrderFilledPct(amountIn: string, filledIn: string): number | null {
  const placed = Number(amountIn), filled = Number(filledIn)
  if (!Number.isFinite(placed) || !Number.isFinite(filled) || placed <= 0) return null
  return Math.max(0, Math.min(100, (filled / placed) * 100))
}

// Resting limit orders — unfilled swap intents. A separate table from the DCA one
// on purpose: a limit order has no period, no per-trade amount and no budget, so
// it answers different questions — what it sells, what it wants for it, at what
// price, and how much of it is still standing.
//
// `showOwner` is the asset page's variant (the page isn't the owner there); the
// profile pages use the defaults.
export function LimitOrdersTable({ orders, now, title, showOwner, emptyText }: {
  orders: OpenLimitOrder[]; now: number; title?: ReactNode; showOwner?: boolean; emptyText?: ReactNode
}) {
  if (!orders.length && !emptyText) return null
  return (
    <>
      <div className="sec-title">{title ?? <>Open limit orders · {orders.length}</>}</div>
      <div className="panel"><table className="tbl dca-tbl">
        <thead><tr>
          {showOwner && <th>Owner</th>}
          <th>Selling → Buying</th><th className="r">Selling</th><th className="r">For at least</th>
          <th className="r">Limit price</th><th className="r">Filled</th><th className="r">Placed</th>
        </tr></thead>
        <tbody>
          {!orders.length ? <EmptyRow cols={showOwner ? 7 : 6}>{emptyText}</EmptyRow> : orders.map(o => {
            const pct = limitOrderFilledPct(o.amountIn, o.filledIn)
            return (
              <tr key={o.intentId} {...rowNav(paths.intent(o.intentId))} data-intent-order={o.intentId}>
                {showOwner && <td data-label="Owner"><AddrPill account={o.who} noCopy /></td>}
                <td data-label="Selling → Buying">
                  <span className="asset-flow">
                    <span className="trade-leg"><AssetIcon assetId={o.assetIn.assetId} iconAssetId={o.assetIn.iconAssetId} iconAssetIds={o.assetIn.iconAssetIds} symbol={o.assetIn.symbol} size={20} parachainId={o.assetIn.parachainId} origin={o.assetIn.origin} /> <span className="mono">{o.assetIn.symbol}</span></span>
                    {' → '}
                    <span className="trade-leg"><AssetIcon assetId={o.assetOut.assetId} iconAssetId={o.assetOut.iconAssetId} iconAssetIds={o.assetOut.iconAssetIds} symbol={o.assetOut.symbol} size={20} parachainId={o.assetOut.parachainId} origin={o.assetOut.origin} /> <span className="mono">{o.assetOut.symbol}</span></span>
                    {!o.partial && <span className="dca-kind" title="All-or-nothing — the order only fills in full">all-or-none</span>}
                  </span>
                </td>
                {/* What is still resting, not what was placed: a partially filled
                    order's remainder is the position, and the placed size rides
                    underneath it so the two can be read together. */}
                <td data-label="Selling" className="r">
                  <AssetAmount asset={o.assetIn} raw={o.remainingIn} />
                  {o.valueUsd != null && <span className="dca-sub mono muted"><Usd v={o.valueUsd} /></span>}
                </td>
                <td data-label="For at least" className="r">
                  <AssetAmount asset={o.assetOut} raw={o.remainingOut} />
                </td>
                <td data-label="Limit price" className="r mono">
                  {o.limitPrice != null
                    ? <span title={`One ${o.assetIn.symbol} for ${o.limitPrice} ${o.assetOut.symbol}`}>
                      <Num v={o.limitPrice} /> <span className="muted">{o.assetOut.symbol}</span>
                      <span className="dca-sub mono muted">per {o.assetIn.symbol}</span>
                    </span>
                    : <Dash />}
                </td>
                <td data-label="Filled" className="r">
                  <span className="dca-filled">
                    <ProgressRing pct={pct} size={18} stroke={8} title={pct == null ? 'Nothing filled yet' : `${pct.toFixed(1)}% of the order filled`} />
                    <span className="mono">{pct != null ? `${Math.round(pct)}%` : '—'}</span>
                    <span className="dca-sub mono muted">{F.int(o.fills)} {o.fills === 1 ? 'fill' : 'fills'}</span>
                  </span>
                </td>
                <td data-label="Placed" className="r mono">
                  <MomentLink at={{ blockHeight: o.placedBlock, extrinsicIndex: o.placedIndex, timestamp: o.timestamp }} now={now} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </>
  )
}

/* ============ proxy & multisig ============ */
// A proxy type names the activity it is allowed to perform, so it takes that
// activity's colour. Any is the exception: it authorises everything, which is
// the dangerous one, so it keeps red.
const PROXY_TYPE_COLORS: Record<string, string> = {
  Any: 'var(--red)', CancelProxy: 'var(--text-low)', Governance: CAT.vote,
  Transfer: CAT.transfer, Liquidity: CAT.liquidity, LiquidityMining: CAT.liquidityCreate,
}
function ProxyTypeBadge({ type }: { type: string }) {
  const col = PROXY_TYPE_COLORS[type] ?? 'var(--text-medium)'
  return <span className="pill-badge" title={`Proxy type: ${type}`} style={{ color: col, background: `color-mix(in srgb, ${col} 14%, transparent)` }}>{type}</span>
}
// Delay in blocks rendered with its rough wall-clock equivalent, converted at
// the chain's measured pace (`blockSec`) — the pallet counts the announcement
// delay in blocks, and what that is worth in minutes changes with block time.
function proxyDelay(delay: number, blockSec?: number): string | null {
  if (delay <= 0) return null
  const s = blockSpanSeconds(delay, blockSec)
  const human = s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
  return `${F.int(delay)} blocks (~${human})`
}
function ProxyRelationRow({ rel, blockSec }: { rel: ProxyRelation; blockSec?: number }) {
  const delay = proxyDelay(rel.delay, blockSec)
  return (
    <span className="proxy-rel">
      <AddrPill account={rel.account} />
      <ProxyTypeBadge type={rel.proxyType} />
      {delay && <span className="muted mono" style={{ fontSize: 11 }} title="Announcement delay before the proxy call executes">delay {delay}</span>}
    </span>
  )
}

// Deployed-contract card for the Overview tab: creation provenance with honest
// labels (a factory child is "first seen", never "created"; missing evidence
// stays "Unknown"), verification status, and the on-chain code identity.
export function ContractSection({ contract, now }: { contract?: ContractInfo | null; now: number }) {
  if (!contract) return null
  const c = contract.creation
  const neutralBadge = { color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' } as const
  return (
    <div className="id-card">
      <div className="id-card-head">Contract</div>
      <div className="dl">
        {c.method === 'create' && (
          <>
            {c.deployer && (
              <>
                <div className="dt" title="The account whose CREATE transaction deployed this contract">Creator</div>
                <div className="dd proxy-dd">
                  <AddrPill account={c.deployer} />
                  {c.deployerWhitelisted && <span className="pill-badge" style={neutralBadge} title="In the EVMAccounts.ContractDeployer whitelist — advisory provenance only, the whitelist does not gate execution">whitelisted deployer</span>}
                </div>
              </>
            )}
            {c.timestamp && c.blockHeight != null && (
              <>
                <div className="dt">Created</div>
                <div className="dd proxy-dd"><span className="mono"><MomentLink at={{ blockHeight: c.blockHeight, extrinsicIndex: c.extrinsicIndex ?? null, timestamp: c.timestamp }} now={now} /></span></div>
              </>
            )}
          </>
        )}
        {c.method === 'factory' && c.factory && (
          <>
            <div className="dt" title="Internal creations emit no event — attributed from the transaction behind this contract's first log">Deployed by</div>
            <div className="dd proxy-dd"><AddrPill account={c.factory} /><span className="pill-badge" style={neutralBadge}>factory</span></div>
            {c.timestamp && c.blockHeight != null && (
              <>
                <div className="dt" title="Creation is not directly observable for factory children — this is the contract's first on-chain log">First seen</div>
                <div className="dd proxy-dd"><span className="mono"><MomentLink at={{ blockHeight: c.blockHeight, extrinsicIndex: null, timestamp: c.timestamp }} now={now} /></span></div>
              </>
            )}
          </>
        )}
        {c.method === 'unknown' && (
          <>
            <div className="dt">Created</div>
            <div className="dd"><span className="muted" title="Neither a top-level CREATE nor first-log factory evidence exists for this address">Unknown</span></div>
          </>
        )}
        <div className="dt">Verification</div>
        <div className="dd proxy-dd">{contract.verification?.status === 'verified'
          ? <>
              <span className="badge ok">✓ Verified{contract.verification.matchType === 'exact_match' ? ' (exact match)' : ' (match)'}</span>
              {contract.verification.supersededBytecode && <span className="pill-badge" style={neutralBadge} title="The code at this address changed after verification (CREATE2 redeploy) — the verified source describes the previous bytecode">superseded bytecode</span>}
            </>
          : <>
              <span className="badge" style={neutralBadge}>Unverified</span>
              <button type="button" className="hint-link" style={{ fontSize: 12 }} onClick={() => setQuery({ view: 'contract' })}>verify →</button>
            </>}</div>
        <div className="dt">Code</div>
        <div className="dd proxy-dd">
          <span className="mono">{F.int(contract.codeSize)} bytes</span>
          <span className="mono muted" title={contract.codeHash}>{F.shortHash(contract.codeHash)}</span>
          <Copy text={contract.codeHash} />
        </div>
      </div>
    </div>
  )
}

// Proxy & multisig relations for the Overview tab. Three cards, each rendered
// only when the account actually has such a relation: who can act for this
// account (its proxies) / whom it can act for, the multisig composition with
// pending operations, and multisig memberships on signer pages.
export function ProxyMultisigSection({ proxy, multisig, memberships, now, blockSec }: {
  proxy?: AccountProxyInfo | null
  multisig?: MultisigInfo | null
  memberships?: MultisigMembership[]
  now: number
  blockSec?: number
}) {
  if (!proxy && !multisig && !memberships?.length) return null
  return (
    <>
      {proxy && (
        <div className="id-card">
          <div className="id-card-head">Proxy</div>
          <div className="dl">
            {proxy.isPure && (
              <>
                <div className="dt">Pure proxy</div>
                <div className="dd proxy-dd">
                  <span className="muted">Keyless account created by</span>
                  <AddrPill account={proxy.isPure.creator} />
                  <span className="mono"><MomentLink at={proxy.isPure} now={now} /></span>
                </div>
              </>
            )}
            {proxy.delegates.length > 0 && (
              <>
                <div className="dt" title="Accounts allowed to submit calls on behalf of this account">Controlled by</div>
                <div className="dd proxy-dd">{proxy.delegates.map((r, i) => <ProxyRelationRow key={`${r.account.accountId}-${r.proxyType}-${i}`} rel={r} blockSec={blockSec} />)}</div>
              </>
            )}
            {proxy.delegatorOf.length > 0 && (
              <>
                <div className="dt" title="Accounts this account may submit calls for">Proxy for</div>
                <div className="dd proxy-dd">{proxy.delegatorOf.map((r, i) => <ProxyRelationRow key={`${r.account.accountId}-${r.proxyType}-${i}`} rel={r} blockSec={blockSec} />)}</div>
              </>
            )}
          </div>
        </div>
      )}

      {multisig && (
        <div className="id-card">
          <div className="id-card-head">Multisig · {multisig.threshold} of {multisig.signatories.length}</div>
          <div className="dl">
            <div className="dt" title={`Any ${multisig.threshold} of these ${multisig.signatories.length} accounts can act as this account`}>Signatories</div>
            <div className="dd proxy-dd">{multisig.signatories.map(s => <AddrPill key={s.accountId} account={s} />)}</div>
            {multisig.pending.length > 0 && (
              <>
                <div className="dt">Pending calls</div>
                <div className="dd proxy-dd" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                  {multisig.pending.map(p => (
                    <span key={p.callHash} className="proxy-rel">
                      <span className="mono" title={p.callHash}>{F.shortHash(p.callHash)}</span>
                      <span className="pill-badge" style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }}>{p.approvals.length}/{multisig.threshold} approved</span>
                      {p.approvals.map(a => <AddrPill key={a.accountId} account={a} noCopy />)}
                      <span className="muted mono" style={{ fontSize: 11 }}>since <Link className="hash" to={paths.block(p.sinceBlock)}>#{F.int(p.sinceBlock)}</Link></span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {!!memberships?.length && (
        <div className="id-card">
          <div className="id-card-head">Multisig member</div>
          <div className="dl">
            <div className="dt" title="Multisig accounts this account is a signatory of">Signatory of</div>
            <div className="dd proxy-dd">
              {memberships.map(m => (
                <span key={m.account.accountId} className="proxy-rel">
                  <AddrPill account={m.account} />
                  <span className="pill-badge" style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }}>{m.threshold} of {m.signatories}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
