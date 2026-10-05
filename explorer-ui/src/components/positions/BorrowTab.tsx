import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { F, Amt, Usd, AssetIcon, AddrPill, healthFactorDisplay } from '../ui'
import { Link, paths } from '../../router'
import { useMoneyMarketEarned, useMoneyMarketHistories, useMoneyMarketHistory, useYields } from '../../hooks/usePositions'
import type { AccountRef, MoneyMarketEarned, MoneyMarketEarnedMarket, MoneyMarketHistory, MoneyMarketHistoryMarket, MoneyMarketPosition, ReserveYield } from '../../types'
import { YieldHover } from './YieldHover'
import { useRevenueHollarColor } from '../../hooks/useRevenueHollarColor'
import { yieldComponentRow, type YieldRow } from './yieldFormat'
import { BorrowHistoryCharts } from './BorrowHistory'
import { defisimSupportsMarket, defisimUrl } from '../../utils/defisim'
import { borrowCards, claimedIncentivesUsd, earnedRows, marketEarned, netApy, paidRows, rawHeld, reserveBorrowPct, reserveEarnedIndex, reserveRows, reserveSupplyPct } from './borrowMath'
import type { BorrowCardSpec } from './borrowMath'

// One holder's money-market footprint: the address its history is read by, the
// account pill a tag names it with, and its current per-market positions (empty
// when only history remains).
export interface BorrowArea {
  address: string
  account?: AccountRef
  markets: MoneyMarketPosition[]
  /** The address DefiSim opens this holder's markets for. */
  defisimAddress?: string
}

// Borrow tab: one card per (account × isolated market) — never blended across
// accounts or markets — with the current position, APYs, yield and incentives,
// and the area's history (supplied/borrowed, health factor, cumulative yield).
// A lone card opens with its details and history; with several, every card
// starts as its summary (header, LTV bar, KPIs) and opens on request. History is
// read per account and only for an open card — except an area with no current
// market, whose cards come from its history and so read it up front.
export function BorrowTab({ areas, showOwner }: { areas: BorrowArea[]; showOwner?: boolean }) {
  // The Interest paid hover marks HOLLAR interest in HOLLAR's resolved colour (paidRows).
  useRevenueHollarColor()
  const yields = useYields(areas.length > 0)
  const historyOnly = areas.map(a => !a.markets.length && !!a.address)
  const derived = useMoneyMarketHistories(areas.map((a, i) => (historyOnly[i] ? a.address : null)))
  // The collapse rule counts every card, so it waits for the history-derived ones:
  // deciding early would open a card that a late area then outnumbers.
  if (derived.some((q, i) => historyOnly[i] && q.isLoading)) {
    return <div className="bw-tab"><div className="bw-card bw-card-loading mm-card" aria-busy="true"><span className="muted">Loading money-market history…</span></div></div>
  }
  const perArea = areas.map((a, i) => borrowCards(a.markets, historyOnly[i] ? derived[i].data : undefined))
  const single = perArea.reduce((n, c) => n + c.length, 0) === 1
  return (
    <div className="bw-tab">
      {areas.map((a, i) => perArea[i].length > 0 && (
        <BorrowAreaCards key={a.address || `agg${i}`} area={a} cards={perArea[i]} yields={yields.data?.moneyMarket} yieldsLoading={yields.isLoading} showOwner={showOwner} defaultOpen={single} />
      ))}
    </div>
  )
}

function BorrowAreaCards({ area, cards, yields, yieldsLoading, showOwner, defaultOpen }: {
  area: BorrowArea
  cards: BorrowCardSpec[]
  yields: Record<string, Record<string, ReserveYield>> | undefined
  yieldsLoading: boolean
  showOwner?: boolean
  defaultOpen: boolean
}) {
  // Every market DefiSim knows gets its own link, opened on that market (each
  // is isolated, so a simulation is always about one). Closed markets (no
  // current position) have nothing to simulate.
  const defisimFor = (marketKey: string) => {
    const pos = area.markets.find(m => m.marketKey === marketKey && m.defiSimSupported)
    if (!pos || !defisimSupportsMarket(marketKey)) return undefined
    return pos.simAccount ?? area.defisimAddress
  }
  return (
    <>
      {cards.map(c => (
        <BorrowCard key={c.marketKey} spec={c} area={area} yields={yields?.[c.marketKey]} yieldsLoading={yieldsLoading}
          owner={showOwner ? area.account : undefined} defaultOpen={defaultOpen}
          defisimAddress={defisimFor(c.marketKey)} />
      ))}
    </>
  )
}

/**
 * A disclosure drawn as a quiet full-width rule with its label centred on it: the
 * whole row is the button, so it reads as a seam in the card rather than a
 * control bolted onto it. The chevron turns with the state.
 */
function DisclosureRule({ open, onToggle, controls, meta, sub, children }: {
  open: boolean
  onToggle: () => void
  controls: string
  meta?: ReactNode
  /** The nested variant (inside the details), a step quieter. */
  sub?: boolean
  children: ReactNode
}) {
  return (
    <button type="button" className={`bw-rule${sub ? ' bw-rule-sub' : ''}`} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <span className="bw-rule-pill">
        <span className="bw-rule-label">{children}</span>
        {meta && <span className="bw-rule-meta">{meta}</span>}
        <svg className="bw-rule-chev" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true" focusable="false">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  )
}

// Non-primary market labels that map to a registered asset get its CDN icon
// next to the label (GIGAHDX → asset 67, BIL → asset 55 — the token each
// market is named after).
const MARKET_ICON_ASSET: Record<string, number> = { gigahdx: 67, bil: 55 }

// Earned and Interest paid are the User Revenue facts of this market (the tab's
// and the header stat's own, sliced per market): what reached the account
// through an aToken it supplied here, plus the market's direct interest.
const EARNED_TITLE = 'Everything the positions supplied to this market earned, as User Revenue books it: the market\'s own lending interest, the yield of the supplied tokens themselves (the vDOT inside avDOT; the vDOT, aDOT interest and pool fees inside GDOT) and the fees of supplied pool shares. Net: a rate\'s give-back, and the accrual a borrowed yield-bearing token owes, count against it. Incentives are stated apart.'
const PAID_TITLE = 'Borrow interest on this market\'s debt, accrued hour by hour on each reserve\'s own index — the User Revenue tab\'s "HOLLAR interest" and "Borrow interest" for this market.'

function earnedBasis(e: MoneyMarketEarned | undefined, h: MoneyMarketHistory | undefined): string {
  if (!e) return ''
  const from = h?.reserveHistoryFrom?.time ? ` (${h.reserveHistoryFrom.time.slice(0, 10)})` : ''
  const asOf = e.asOf ? ` through ${e.asOf.slice(0, 16).replace('T', ' ')} UTC` : ''
  // The header's holder-class rule (userRevenueHolders.ts): User Revenue counts USER accounts only, so a
  // protocol or custody account's card states its own class's facts and says which class and why.
  const cls = e.holderClass === 'protocol'
    ? ' This is a protocol account (the protocol\'s own balance sheet: the Treasury, its pots, pallet accounts), so these figures are its own protocol-class facts — User Revenue counts only what user accounts earn.'
    : e.holderClass === 'unattributed'
      ? ' This is a custody account (a pool, contract, bridge or another chain\'s sovereign) whose income belongs to the users behind it, so these figures are unattributed-class facts — User Revenue counts them on those users where they can be resolved, never here.'
      : ''
  const partial = e.complete ? '' : ' Partial: not every month is published yet.'
  return ` All time since the money market's coverage start, block ${F.int(e.fromBlock)}${from},${asOf}; each hour at its own closing price.${cls}${partial}`
}

const UNCLAIMED_TITLE = 'Unclaimed: what claiming this market\'s lending incentives now would pay (the money market\'s own getAllUserRewards), at current prices. Already counted in the account value, never in Supplied.'
const CLAIMED_TITLE = 'Claimed: every RewardsClaimed of this market\'s incentive programmes, each valued at its own event-time price.'

function currentLtvPct(mm: MoneyMarketPosition): number {
  const collateral = Number(mm.totalCollateralBase)
  const debt = Number(mm.totalDebtBase)
  return collateral > 0 && debt > 0 ? debt / collateral * 100 : 0
}

// Current LTV against the liquidation threshold: the fill reaches the red mark
// exactly when the health factor reaches 1.
function BorrowRiskBar({ mm }: { mm: MoneyMarketPosition }) {
  const debtUsd = Number(mm.totalDebtBase) / 1e8
  if (debtUsd <= 0 || mm.healthFactor === 'unknown' || Number(mm.liquidationThreshold) <= 0) return null
  const ltvPct = currentLtvPct(mm)
  const liqPct = Number(mm.liquidationThreshold) / 100
  const fillPct = liqPct > 0 ? Math.min(100, ltvPct / liqPct * 100) : 0
  return (
    <div className="bw-risk">
      <div className="mm-bar-track" role="meter" aria-label={`${mm.market} current loan-to-value`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, ltvPct)}
        aria-valuetext={`${ltvPct.toFixed(1)}% current loan-to-value; liquidation threshold ${liqPct.toFixed(0)}%`}>
        <div className="mm-bar-fill" style={{ width: `${fillPct.toFixed(1)}%` }} />
        <div className="mm-bar-liq" />
      </div>
      <span className="bw-risk-lab"><span>LTV {ltvPct.toFixed(1)}%</span><span className="muted">liq. @ {liqPct.toFixed(0)}%</span></span>
    </div>
  )
}

function Stat({ k, title, children, className }: { k: string; title?: string; children: ReactNode; className?: string }) {
  return <div className={`mm-stat${className ? ` ${className}` : ''}`} title={title}><span className="k">{k}</span><span className="v">{children}</span></div>
}

type HistState = { data: MoneyMarketHistory | undefined; market: MoneyMarketHistoryMarket | undefined; loading: boolean; requested: boolean; error: boolean }
type EarnedState = { data: MoneyMarketEarned | undefined; market: MoneyMarketEarnedMarket | null | undefined; loading: boolean; requested: boolean; error: boolean }

// A history-backed figure before its history is read: a dash that says why,
// or an ellipsis while it loads.
function pending(h: HistState): ReactNode | null {
  if (h.loading) return <span className="muted">…</span>
  if (!h.requested) return <span className="muted" title="No history for this holder">—</span>
  return null
}

function BorrowCard({ spec, area, yields, yieldsLoading, owner, defaultOpen, defisimAddress }: {
  spec: BorrowCardSpec
  area: BorrowArea
  yields: Record<string, ReserveYield> | undefined
  yieldsLoading: boolean
  owner?: AccountRef
  defaultOpen: boolean
  defisimAddress?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  // Read whether or not the card is open: the KPI row (interest, claimed
  // incentives) is the collapsed card's summary and comes from the history, and
  // one read per account serves every market card of that account.
  const q = useMoneyMarketHistory(area.address || null)
  const hist: HistState = {
    data: q.data, market: q.data?.markets.find(m => m.marketKey === spec.marketKey),
    loading: q.isLoading && q.fetchStatus !== 'idle', requested: !!area.address, error: q.isError,
  }
  const eq = useMoneyMarketEarned(area.address || null)
  const earned: EarnedState = {
    data: eq.data, market: marketEarned(eq.data, spec.marketKey),
    loading: eq.isLoading && eq.fetchStatus !== 'idle', requested: !!area.address, error: eq.isError,
  }
  const mm = spec.current
  const isPrimary = spec.role === 'primary'
  const iconAsset = MARKET_ICON_ASSET[spec.marketKey]
  const headingId = `bw-${(area.address || 'agg').slice(-10)}-${spec.marketKey}`.replace(/[^a-z0-9_-]/gi, '-')
  const detailsId = useId()
  const hf = mm ? healthFactorDisplay(mm.healthFactor) : null
  // One zoom window per card, shared by its two history charts and carried in the
  // URL: `zmm-<market>`, plus the member on a tag so two members' windows stay apart.
  const zoomKey = `zmm-${spec.marketKey}${owner ? `-${area.address.slice(-6).toLowerCase()}` : ''}`
  return (
    <section className={`mm-market-section bw-card${mm ? '' : ' bw-closed'}`} aria-labelledby={headingId} data-market-key={spec.marketKey} data-address={area.address || undefined}>
      <header className="bw-head">
        {owner && <AddrPill account={owner} />}
        <h3 id={headingId} className="mm-title bw-title">{isPrimary ? spec.label : 'Money Market'}</h3>
        <span className="mm-title-note">
          {isPrimary ? 'primary' : <>{iconAsset != null && <AssetIcon assetId={iconAsset} symbol={spec.label} size={14} />} {spec.label}</>} · lend &amp; borrow
        </span>
        {spec.stakingBacked && <span className="mm-title-note bw-staking" title="Collateral is staked HDX — counted once, in the wallet balance">staked-HDX collateral</span>}
        {!!mm?.unstatedCollateral?.length && <span className="mm-title-note bw-unstated" title="The explorer reconstructs supplied reserves from the money market's own logs. This collateral is not in that reconstruction yet (it reached the account before the explorer's anchor block, outside its log coverage) or has no price here, so Supplied and the Value take the market's own collateral figure for it.">{mm.unstatedCollateral.map(a => a.symbol).join(', ')} collateral not stated per reserve</span>}
        <span className="bw-head-end">
          {mm && hf
            ? <span className="bw-hf" title={(mm.memberCount ?? 0) > 1 ? 'Lowest member health factor' : 'Health factor (the chain\'s own figure)'}>
                <span className="bw-hf-k">{(mm.memberCount ?? 0) > 1 ? 'Lowest HF' : 'HF'}</span><span className={`hf ${hf.cls}`}>{hf.label}</span>
              </span>
            : <span className="badge bw-closed-badge">closed</span>}
          {defisimAddress && <a className="ext-link bw-defisim" href={defisimUrl(defisimAddress, spec.marketKey)} target="_blank" rel="noopener noreferrer" title={`Simulate this ${spec.label} position in DefiSim`}>Open in DefiSim ↗</a>}
        </span>
      </header>
      <div className="mm-card bw-body">
        {mm && <BorrowRiskBar mm={mm} />}
        <BorrowKpis mm={mm} yields={yields} yieldsLoading={yieldsLoading} hist={hist} earned={earned} />
        <DisclosureRule open={open} onToggle={() => setOpen(o => !o)} controls={detailsId} meta={open ? undefined : detailsMeta(spec, hist)}>
          {open ? 'Hide' : 'Show'} {area.address ? 'details & history' : 'reserves'}
        </DisclosureRule>
        {open && (
          <div id={detailsId} className="bw-details">
            <BorrowReserves spec={spec} yields={yields} yieldsLoading={yieldsLoading} hist={hist} earned={earned} />
            {area.address && (
              <div className="bw-hist-body">
                {hist.loading ? <div className="bw-hist-loading muted" aria-busy="true">Loading history…</div>
                  : hist.error ? <div className="muted">History could not be loaded.</div>
                    : hist.data && hist.market ? <BorrowHistoryCharts history={hist.data} market={hist.market} address={area.address} zoomKey={zoomKey} />
                      : <div className="muted">No history for this market yet.</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

// What a collapsed card holds: its reserve count and, once read, how far back the
// market's history reaches.
function detailsMeta(spec: BorrowCardSpec, hist: HistState): string {
  const held = (spec.current?.reserves ?? []).filter(r => rawHeld(r.supplied) || rawHeld(r.debt)).length
  const past = held ? 0 : (hist.market?.reserves.length ?? 0)
  const parts: string[] = []
  if (held) parts.push(`${held} reserve${held === 1 ? '' : 's'}`)
  else if (past) parts.push(`${past} past reserve${past === 1 ? '' : 's'}`)
  const first = hist.market?.points[0]
  const since = first != null ? hist.data?.dates[first.i]?.slice(0, 10) : undefined
  if (since) parts.push(`since ${since}`)
  return parts.join(' · ')
}

// An earned-read figure before it is read: an ellipsis while it loads, a dash
// that says why otherwise (no account behind the card, or a failed read).
function earnedPending(e: EarnedState): ReactNode | null {
  if (e.loading) return <span className="muted">…</span>
  if (!e.requested) return <span className="muted" title="No account to read">—</span>
  if (e.error || !e.data) return <span className="muted" title="Could not be read">—</span>
  return null
}

// Unpriced hourly amounts are counted per side: the borrow lines' own on Interest paid, the rest on Earned.
function earnedMarks(e: EarnedState, side: 'earned' | 'paid'): ReactNode {
  const paidUnpriced = (e.market?.items ?? []).filter(i => i.category === 'paid').reduce((n, i) => n + i.unpriced, 0)
  const unpriced = side === 'paid' ? paidUnpriced : (e.market?.unpriced ?? 0) - paidUnpriced
  return <>
    {!e.data?.complete && <span className="bw-unpriced" title="Partial: not every month of the account facts is published yet">*</span>}
    {unpriced > 0 && <span className="bw-unpriced" title={`${unpriced} hourly amount${unpriced === 1 ? '' : 's'} without a price left out, as on the User Revenue tab`}> +{unpriced}?</span>}
  </>
}

/** Earned with its breakdown on hover: lending interest, token yield, pool fees, other — each line by what earned it. */
function EarnedValue({ e }: { e: EarnedState }) {
  const p = earnedPending(e)
  if (p) return p
  const m = e.market
  if (!m) return <Usd v={0} />
  const rows = earnedRows(m, (label, usd) => `${label} · ${F.usd(usd)}`)
  return <>
    <YieldHover total={m.earnedUsd} rows={rows} format={F.usd} title="Earned in this market"
      note="Net, from the User Revenue facts: each line is what earned it, “in” the supplied aToken it reached the account through." />
    {earnedMarks(e, 'earned')}
  </>
}

function PaidValue({ e }: { e: EarnedState }) {
  const p = earnedPending(e)
  if (p) return p
  const m = e.market
  if (!m) return <Usd v={0} />
  const rows = paidRows(m)
  return <>{rows.length > 1
    ? <YieldHover total={m.paidUsd} rows={rows} format={F.usd} title="Interest paid in this market" />
    : <Usd v={m.paidUsd} />}{earnedMarks(e, 'paid')}</>
}

function BorrowKpis({ mm, yields, yieldsLoading, hist, earned }: { mm: MoneyMarketPosition | null; yields: Record<string, ReserveYield> | undefined; yieldsLoading: boolean; hist: HistState; earned: EarnedState }) {
  const claimed = claimedIncentivesUsd(hist.market)
  const rewards = (mm?.unclaimedRewards ?? []).filter(r => rawHeld(r.claimable))
  const pricedRewards = rewards.filter(r => r.claimableUsd != null)
  const unclaimedUsd = pricedRewards.reduce((s, r) => s + (r.claimableUsd ?? 0), 0)
  const basis = earnedBasis(earned.data, hist.data)
  const supplyUsd = mm ? Number(mm.totalSuppliedBase ?? mm.totalCollateralBase) / 1e8 : null
  const debtUsd = mm ? Number(mm.totalDebtBase) / 1e8 : null
  const apy = mm ? netApy(mm.reserves ?? [], yields) : null
  const apyRows: YieldRow[] = apy && apy.netPct != null ? [
    { key: 'sb', label: 'Supply APY', pct: apy.supplyBasePct },
    ...(apy.supplyAccrualPct ? [{ key: 'sa', label: 'Token yield', note: 'accruing collateral', pct: apy.supplyAccrualPct }] : []),
    ...(apy.supplyIncentivePct ? [{ key: 'si', label: 'Supply incentives', pct: apy.supplyIncentivePct }] : []),
    ...(apy.borrowBasePct ? [{ key: 'bb', label: 'Borrow APY', pct: apy.borrowBasePct }] : []),
    ...(apy.borrowIncentivePct ? [{ key: 'bi', label: 'Borrow incentives', pct: apy.borrowIncentivePct }] : []),
  ] : []
  return (
    <div className="mm-summary bw-kpis">
      {mm && <>
        <Stat k="Supplied"><Usd v={supplyUsd} /></Stat>
        <Stat k="Borrowed">{debtUsd ? <Usd v={debtUsd} /> : '—'}</Stat>
        <Stat k="Net"><Usd v={supplyUsd! - debtUsd!} /></Stat>
        <Stat k="Net APY" title="Current rates on current balances, as the Hydration UI states it: Σ supplied × (supply APY + the supplied token's own yield + incentives) − Σ borrowed × (borrow APY − incentives), over net. Unknown when any held reserve lacks a rate or price.">
          {yieldsLoading ? <span className="muted">…</span>
            : <YieldHover total={apy?.netPct ?? null} rows={apyRows} title="Net APY on equity"
                note="Each part is weighted by the reserve's current USD and divided by net (supplied − borrowed)." />}
        </Stat>
      </>}
      <Stat k="Earned" title={EARNED_TITLE + basis} className="bw-kpi-earned"><EarnedValue e={earned} /></Stat>
      <Stat k="Interest paid" title={PAID_TITLE + basis} className="bw-kpi-paid"><PaidValue e={earned} /></Stat>
      <Stat k="Incentives" title={`${CLAIMED_TITLE} ${UNCLAIMED_TITLE}`} className="bw-kpi-inc">
        <span className="bw-inc">
          <span className="bw-inc-part"><span className="bw-inc-k">claimed</span>{pending(hist) ?? (claimed ? <><Usd v={claimed.usd} />{claimed.unpriced > 0 && <span className="bw-unpriced" title={`${claimed.unpriced} claim${claimed.unpriced === 1 ? '' : 's'} without a price left out`}> +{claimed.unpriced}?</span>}</> : '—')}</span>
          <span className="bw-inc-sep">/</span>
          <span className="bw-inc-part"><span className="bw-inc-k">unclaimed</span>{!mm ? '—' : pricedRewards.length ? <Usd v={unclaimedUsd} />
            : rewards.length ? rewards.map((r, i) => <span key={`${r.asset.assetId}-${i}`}>{i > 0 ? ' · ' : ''}<Amt raw={r.claimable} dec={r.asset.decimals} /> {r.asset.symbol}</span>) : <Usd v={0} />}</span>
        </span>
      </Stat>
    </div>
  )
}

function supplyRows(y: ReserveYield): YieldRow[] {
  // The full composition when the API states it: the reserve's rate, the
  // underlying's own accrual (token yield, a share's fee and legs) and incentives.
  if (y.supply) return y.supply.components.map((c, i) => ({ ...yieldComponentRow(c, i), ...(c.kind === 'mm-incentive' ? { group: 'Incentives' } : {}) }))
  return [
    { key: 'base', label: 'Supply APY', pct: y.supplyApyPct },
    ...y.supplyIncentives.map((inc, i) => ({ key: `inc${i}`, label: inc.rewardAsset.symbol, asset: inc.rewardAsset, pct: inc.aprPct, group: 'Incentives' })),
  ]
}
function borrowRows(y: ReserveYield): YieldRow[] {
  return [
    { key: 'base', label: 'Borrow APY', pct: y.borrowApyPct },
    ...y.borrowIncentives.map((inc, i) => ({ key: `inc${i}`, label: inc.rewardAsset.symbol, asset: inc.rewardAsset, pct: inc.aprPct == null ? null : -inc.aprPct, group: 'Incentives (offset the cost)' })),
  ]
}

function RateCell({ y, side, loading }: { y: ReserveYield | undefined; side: 'supply' | 'borrow'; loading: boolean }) {
  if (loading) return <span className="muted">…</span>
  if (!y) return <span className="muted" title="No rate published for this reserve">—</span>
  const incentives = side === 'supply' ? y.supplyIncentives : y.borrowIncentives
  const total = side === 'supply' ? reserveSupplyPct(y) : reserveBorrowPct(y)
  // A bare rate needs no card; incentives and accrual are what the breakdown is for.
  const composed = side === 'supply' && (y.supply?.components.length ?? 0) > 1
  if (!incentives.length && !composed) return <YieldHover total={total} rows={[]} />
  return <YieldHover total={total} rows={side === 'supply' ? supplyRows(y) : borrowRows(y)} icons={incentives.map(i => i.rewardAsset)}
    title={side === 'supply' ? 'Supply APY' : 'Borrow APY'}
    note={side === 'supply' ? 'The reserve\'s current supply APY, what the supplied token earns by itself (a yield-bearing token\'s current APY as the Hydration UI reads it — DeFiLlama, Kamino — else its on-chain 180-day rate; a pool share\'s fee and legs) and incentive programmes on its aToken.' : 'Variable borrow APY less incentives paid on the debt token.'} />
}

// Current reserves first; the ones held only in the past wait behind a toggle
// that always starts closed.
function BorrowReserves({ spec, yields, yieldsLoading, hist, earned }: { spec: BorrowCardSpec; yields: Record<string, ReserveYield> | undefined; yieldsLoading: boolean; hist: HistState; earned: EarnedState }) {
  const [showClosed, setShowClosed] = useState(false)
  const closedId = useId()
  const all = reserveRows(spec, hist.market, earned.data ? reserveEarnedIndex(earned.market) : undefined)
  if (!all.length) return null
  const closedCount = all.filter(r => r.closed).length
  const rows = all.filter(r => !r.closed || showClosed)
  const anySupply = rows.some(r => rawHeld(r.supplied))
  const anyDebt = rows.some(r => rawHeld(r.debt))
  const anyInterest = rows.some(r => r.interest != null)
  return (
    <div className="bw-reserves" id={closedId}>
      {rows.length > 0 && (
        <div className="bw-tbl-wrap">
        <table className="tbl bw-tbl">
          <thead>
            <tr>
              <th>Asset</th>
              {anySupply && <><th className="r">Supplied</th><th className="r">Supply APY</th><th>Collateral</th></>}
              {anyDebt && <><th className="r">Borrowed</th><th className="r">Borrow APY</th></>}
              {anyInterest && <th className="r" title={`Per reserve: ${EARNED_TITLE}${earnedBasis(earned.data, hist.data)} Paid: borrow interest on the reserve's debt.`}>Earned / Paid</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const y = yields?.[String(r.asset.assetId)]
              const hasS = rawHeld(r.supplied), hasD = rawHeld(r.debt)
              return (
                <tr key={r.asset.assetId} className={r.closed ? 'bw-row-closed' : undefined}>
                  <td data-label="Asset">
                    <Link to={paths.asset(r.asset.assetId)} className="trade-leg bw-asset">
                      <AssetIcon assetId={r.asset.assetId} iconAssetId={r.asset.iconAssetId} iconAssetIds={r.asset.iconAssetIds} symbol={r.asset.symbol} size={18} parachainId={r.asset.parachainId} origin={r.asset.origin} />
                      <span className="mono">{r.asset.symbol}</span>
                    </Link>
                    {r.closed && <span className="muted bw-closed-note">closed</span>}
                  </td>
                  {anySupply && <>
                    <td data-label="Supplied" className={`r mono${hasS ? '' : ' bw-nil'}`}>{hasS ? <><Amt raw={r.supplied} dec={r.asset.decimals} /> <span className="muted bw-usd"><Usd v={r.suppliedUsd} /></span></> : '—'}</td>
                    <td data-label="Supply APY" className={`r${hasS ? '' : ' bw-nil'}`}>{hasS ? <RateCell y={y} side="supply" loading={yieldsLoading} /> : '—'}</td>
                    <td data-label="Collateral" className={hasS ? undefined : 'bw-nil'}>{hasS ? (r.collateral ? <span className="badge ok mm-collateral-badge">collateral</span> : <span className="muted">no</span>) : '—'}</td>
                  </>}
                  {anyDebt && <>
                    <td data-label="Borrowed" className={`r mono${hasD ? '' : ' bw-nil'}`}>{hasD ? <><Amt raw={r.debt} dec={r.asset.decimals} /> <span className="muted bw-usd"><Usd v={r.debtUsd} /></span></> : '—'}</td>
                    <td data-label="Borrow APY" className={`r${hasD ? '' : ' bw-nil'}`}>{hasD ? <RateCell y={y} side="borrow" loading={yieldsLoading} /> : '—'}</td>
                  </>}
                  {anyInterest && (
                    <td data-label="Earned / Paid" className="r mono bw-interest"
                      title={r.interest ? `Earned ${F.usd(r.interest.earnedUsd)} · paid ${F.usd(r.interest.paidUsd)}` : undefined}>
                      {r.interest ? <>
                        <span className={r.interest.earnedUsd ? 'bw-earned' : 'muted'}><Usd v={r.interest.earnedUsd} /></span>
                        <span className="muted"> / </span>
                        <span className={r.interest.paidUsd ? 'bw-paid' : 'muted'}><Usd v={r.interest.paidUsd} /></span>
                      </> : '—'}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}
      {closedCount > 0 && (
        <DisclosureRule sub open={showClosed} onToggle={() => setShowClosed(v => !v)} controls={closedId}>
          {showClosed ? 'Hide closed reserves' : `Show ${closedCount} closed reserve${closedCount === 1 ? '' : 's'}`}
        </DisclosureRule>
      )}
    </div>
  )
}
