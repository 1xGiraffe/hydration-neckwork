/* eslint-disable react-refresh/only-export-components -- shared account-section components + their count helper */
import { F, AssetIcon, AssetAmount, AreaChart, ChartCardSkeleton, healthFactorDisplay, AddrPill, MomentLink, ProgressRing, rowNav, Dash, EmptyRow, Copy } from './ui'
import type { ChartMarker, DetailTab } from './ui'
import { Link, paths, setQuery } from '../router'
import type { ActivitySlug } from '../router'
import { performancePoints } from './performance'
import { CAT } from './activityColors'
import { estimateBlockCountdown } from '../utils/blockCountdown'
import { blockSeconds, blockSpanSeconds, dcaAmountLeft, dcaCadence, dcaLeftUsd, dcaProgress, dcaRunway, fmtDuration } from '../utils/dca'
import type { MoneyMarketPosition, LpPosition, ActiveDca, AssetBalanceHistory, AccountProxyInfo, MultisigInfo, MultisigMembership, ProxyRelation, ValueEvent, ContractInfo } from '../types'
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
  const est = timing ? new Date(timing.etaMs) : null
  return (
    <span title={est ? `Est. ${est.toLocaleString()}` : `Approximately ${blocksAway} blocks away`}>
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
      <AssetIcon assetId={ev.assetIn.assetId} iconAssetId={ev.assetIn.iconAssetId} symbol={ev.assetIn.symbol} size={16} parachainId={ev.assetIn.parachainId} origin={ev.assetIn.origin} />
      {' '}<span className="mono">{ev.assetIn.symbol}</span>
      <span className="muted">{' → '}</span>
      <AssetIcon assetId={ev.assetOut.assetId} iconAssetId={ev.assetOut.iconAssetId} symbol={ev.assetOut.symbol} size={16} parachainId={ev.assetOut.parachainId} origin={ev.assetOut.origin} />
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
          <AssetIcon assetId={ev.asset.assetId} iconAssetId={ev.asset.iconAssetId} symbol={ev.asset.symbol} size={16} parachainId={ev.asset.parachainId} origin={ev.asset.origin} />
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
      <AssetIcon assetId={ev.assetIn.assetId} iconAssetId={ev.assetIn.iconAssetId} symbol={ev.assetIn.symbol} size={13} parachainId={ev.assetIn.parachainId} origin={ev.assetIn.origin} />
      <span className="mono">{ev.assetIn.symbol}</span>
      <span className="muted">→</span>
      <AssetIcon assetId={ev.assetOut.assetId} iconAssetId={ev.assetOut.iconAssetId} symbol={ev.assetOut.symbol} size={13} parachainId={ev.assetOut.parachainId} origin={ev.assetOut.origin} />
      <span className="mono">{ev.assetOut.symbol}</span>
    </span>
  }
  if (ev.asset) {
    return <span className="trade-leg">
      <AssetIcon assetId={ev.asset.assetId} iconAssetId={ev.asset.iconAssetId} symbol={ev.asset.symbol} size={13} parachainId={ev.asset.parachainId} origin={ev.asset.origin} />
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
export function PortfolioChart({ title, netUsd, series, dates: datesProp, balanceHistory, loading, valueEvents }: {
  title: string; netUsd: number; series: number[]; dates?: string[]; balanceHistory?: AssetBalanceHistory[]; loading?: boolean; valueEvents?: ValueEvent[] | null
}) {
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
  const markers = valueEvents?.length ? valueEvents.map(valueEventMarker) : undefined
  return (
    <>
      <div className="sec-title">{title}</div>
      <div className="pf-card">
        <div className="pf-head"><div className="pf-now">{F.usd(netUsd)}</div>{perfItems.length > 0 && <div className="perf-row">{perfItems.map(p => perf(p.label, p.value))}</div>}</div>
        <AreaChart data={series} h={180} dates={dates} markers={markers} />
      </div>
    </>
  )
}

// One count per isolated market: the API aggregates money market positions to
// one entry per market (core, GIGAHDX, BIL, …), and the Positions tab renders
// one card per entry — so the tab badge counts what the tab shows. Collapsing
// the family to 1 undercounted every multi-market account and tag.
export function mmPositionCount(markets: MoneyMarketPosition[]): number {
  return markets.length
}

export function moneyMarketDebtUsd(markets: MoneyMarketPosition[]): number {
  return markets.reduce((total, market) => total + Number(market.totalDebtBase) / 1e8, 0)
}

export function profileTabs(
  balanceCount: number,
  markets: MoneyMarketPosition[],
  dcaCount: number,
  liquidityPositionCount: number,
  // The activity list's own total. `activity.complete === false` means it counts
  // only the newest rows of a longer feed, which the badge marks with a `+` rather
  // than passing off as the account's whole history.
  activity?: ListCount,
  votesCount?: number,
  hasContract?: boolean,
): DetailTab[] {
  const positionCount = mmPositionCount(markets) + dcaCount + liquidityPositionCount
  return [
    { key: 'overview', label: 'Overview' },
    { key: 'balances', label: 'Balances', count: balanceCount },
    ...(positionCount > 0 ? [{ key: 'positions', label: 'Positions', count: positionCount }] : []),
    ...(hasContract ? [{ key: 'contract', label: 'Contract' }] : []),
    { key: 'activity', label: 'Activity', ...(activity?.total == null ? {} : { count: activity.total, countAtLeast: !activity.complete }) },
    ...(votesCount && votesCount > 0 ? [{ key: 'votes', label: 'Votes', count: votesCount }] : []),
  ]
}

export function ProfileStats({ tradingVolumeUsd, liquidationVolumeUsd, revenueUsd, valueUsd, valueHint }: {
  tradingVolumeUsd?: number | null
  liquidationVolumeUsd?: number | null
  // Protocol revenue earned from this account (fees paid, penalties, interest).
  revenueUsd?: number | null
  valueUsd: number
  valueHint?: ReactNode
}) {
  const trading = tradingVolumeUsd ?? 0
  const liquidation = liquidationVolumeUsd ?? 0
  const revenue = revenueUsd ?? 0
  return (
    <>
    <div className="acct-stats">
      {trading > 0 && <div className="acct-bal subtle">
        <div className="lab">Trading</div>
        <div className="amt">{F.usd(trading)}</div>
      </div>}
      {liquidation > 0 && <div className="acct-bal subtle">
        <div className="lab">Liquidation</div>
        <div className="amt">{F.usd(liquidation)}</div>
      </div>}
      {revenue > 0 && <div className="acct-bal subtle">
        <div className="lab">Revenue</div>
        <div className="amt">{F.usd(revenue)}</div>
      </div>}
      <div className="acct-bal">
        <div className="lab">Value</div>
        <div className="amt">{F.usd(valueUsd)}</div>
      </div>
    </div>
    {/* The money-market breakdown rides on its own full-width row below the
        stats, so it can run left under trading/liquidation instead of
        wrapping inside the value's narrow column. */}
    {valueHint && <div className="acct-stats-hint">{valueHint}</div>}
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
            <span className="trade-leg"><AssetIcon assetId={r.assetId} iconAssetId={r.iconAssetId} symbol={r.symbol} size={18} parachainId={r.parachainId} origin={r.origin} /> <span className="mono">{r.symbol}</span></span>
            <span className="mono">{F.amount(r.supplied, r.decimals)}</span>
            <span className="mono muted">{F.usd(r.suppliedUsd)}</span>
            {r.collateral ? <span className="badge ok mm-collateral-badge">collateral</span> : null}
          </div>
        ))}
        {!supplied.length && <div className="mm-empty">None</div>}
      </div>
      <div>
        <div className="mm-col-head">Borrowed</div>
        {borrowed.map(r => (
          <div className="mm-row" key={`d${r.assetId}`}>
            <span className="trade-leg"><AssetIcon assetId={r.assetId} iconAssetId={r.iconAssetId} symbol={r.symbol} size={18} parachainId={r.parachainId} origin={r.origin} /> <span className="mono">{r.symbol}</span></span>
            <span className="mono">{F.amount(r.debt, r.decimals)}</span>
            <span className="mono muted">{F.usd(r.debtUsd)}</span>
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
          <div className="mm-stat"><span className="k">Lent</span><span className="v">{F.usd(supplyUsd)}</span></div>
          <div className="mm-stat"><span className="k">Borrowed</span><span className="v">{debtUsd > 0 ? F.usd(debtUsd) : '—'}</span></div>
          <div className="mm-stat"><span className="k">Net worth</span><span className="v">{F.usd(supplyUsd - debtUsd)}</span></div>
          <div className="mm-stat"><span className="k">Available to borrow</span><span className="v">{F.usd(Number(mm.availableBorrowsBase) / 1e8)}</span></div>
          <div className="mm-stat"><span className="k">{mm.simAccount ? 'Lowest member health' : 'Health factor'}</span><span className={`v hf ${hf.cls}`}>{hf.label}</span></div>
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
        {agg.perDayUsd > 0 ? <><span className="mono">≈ {F.usd(agg.perDayUsd)}</span><span className="muted">/day</span></> : <Dash />}
        <span className="dca-sub mono muted">combined rate</span>
      </td>
      <td data-label="Budget" className="r">
        {agg.pricedOrders > 0 ? <>
          <span className="mono">≈ {F.usd(agg.budgetUsd)}</span>
          <span className="dca-sub mono muted">{F.usd(agg.leftUsd)} left</span>
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
          <th>Selling → Buying</th><th className="r">Per trade</th><th className="r">Budget</th>
          <th className="r">Filled</th><th className="r">Every</th><th className="r">Next trade</th><th className="r">Runs out</th>
        </tr></thead>
        <tbody>
          {/* A sum of one order would just repeat the order. */}
          {totals && dcas.length > 1 && <DcaTotalsRow dcas={dcas} showOwner={showOwner} headBlock={headBlock} headTime={headTime} now={now} blockSec={blockSec} />}
          {!dcas.length ? <EmptyRow cols={showOwner ? 8 : 7}>{emptyText}</EmptyRow> : dcas.map(d => {
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
            const left = leftUsd != null ? F.usd(leftUsd)
              : leftRaw != null ? `${F.amount(leftRaw, d.assetIn.decimals)} ${d.assetIn.symbol}`
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
              <tr key={d.id} {...rowNav(paths.dcaSchedule(d.id))} data-dca-schedule={d.id}>
                {showOwner && <td data-label="Owner">{d.who ? <AddrPill account={d.who} noCopy /> : <Dash />}</td>}
                <td data-label="Selling → Buying">
                  <span className="asset-flow">
                    <span className="trade-leg"><AssetIcon assetId={d.assetIn.assetId} iconAssetId={d.assetIn.iconAssetId} symbol={d.assetIn.symbol} size={20} parachainId={d.assetIn.parachainId} origin={d.assetIn.origin} /> <span className="mono">{d.assetIn.symbol}</span></span>
                    {' → '}
                    <span className="trade-leg"><AssetIcon assetId={d.assetOut.assetId} iconAssetId={d.assetOut.iconAssetId} symbol={d.assetOut.symbol} size={20} parachainId={d.assetOut.parachainId} origin={d.assetOut.origin} /> <span className="mono">{d.assetOut.symbol}</span></span>
                  </span>
                </td>
                <td data-label="Per trade" className="r">
                  <AssetAmount asset={perAsset} raw={d.amountPerTrade} />{isBuy ? <span className="muted"> bought</span> : null}
                  {d.valueUsd != null && <span className="dca-sub mono muted">{F.usd(d.valueUsd)}</span>}
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
                      {d.budgetUsd != null && F.usd(d.budgetUsd)}
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

// Venue → badge colour, so the LP products read apart at a glance: NFT-held
// Omnipool positions (bare / farmed) vs wallet-held stableswap pool shares. All
// three are liquidity, so they stay inside that family's blues rather than
// borrowing a hue that means something else elsewhere.
const LP_VENUE_COLORS: Record<string, string> = { Omnipool: CAT.liquidity, 'Omnipool Farm': CAT.liquidityCreate, Stablepool: 'var(--sky-deep)' }

export function LiquidityPositionsTable({ positions }: { positions: LpPosition[] }) {
  if (!positions.length) return null
  return (
    <>
      <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>Liquidity positions · {positions.length}
        <span className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>provided to pools & farms</span>
      </div>
      <div className="panel"><table className="tbl assets-tbl">
        <thead><tr><th>Pool asset</th><th>Venue</th><th className="r">Amount</th><th className="r">Value</th></tr></thead>
        <tbody>
          {positions.map(p => {
            const col = LP_VENUE_COLORS[p.venue] ?? CAT.liquidity
            return (
              <tr key={p.positionId} {...rowNav(paths.asset(p.asset.assetId))}>
                <td data-label="Pool asset">
                  <div className="asset-row">
                    <AssetIcon assetId={p.asset.assetId} iconAssetId={p.asset.iconAssetId} symbol={p.asset.symbol} size={30} parachainId={p.asset.parachainId} origin={p.asset.origin} />
                    <div className="ar-meta"><span className="ar-sym">{p.asset.symbol}</span><span className="ar-name">{p.venue === 'Stablepool' ? 'Pool shares' : `Position #${p.positionId}`}</span></div>
                  </div>
                </td>
                <td data-label="Venue"><span className="badge" style={{ background: `color-mix(in srgb, ${col} 14%, transparent)`, color: col }}>{p.venue}</span></td>
                <td data-label="Amount" className="r mono">
                  {F.amount(p.amount, p.asset.decimals)} {p.asset.symbol}
                  {p.hubAmount && <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>+ {F.amount(p.hubAmount, 12)} H2O</div>}
                </td>
                <td data-label="Value" className="r mono">{F.usd(p.valueUsd)}</td>
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
