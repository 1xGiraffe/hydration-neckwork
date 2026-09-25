import type { AssetRef, MmReserve, MoneyMarketHistory, MoneyMarketHistoryMarket, MoneyMarketHistoryReserve, MoneyMarketPosition, ReserveYield } from '../../types'
import { sumPct } from './yieldFormat'

// Pure arithmetic behind the Borrow tab — rates, health factors and history
// series — kept apart from the markup so it is unit-testable. Display only:
// every figure here is already a rendered wire number (USD floats, percent
// floats); nothing feeds back into a sum another surface states.

/** A raw integer amount that holds nothing ("0", "000", "0.0" all qualify). */
export const rawHeld = (raw: string | null | undefined): boolean => !!raw && /[1-9]/.test(raw)

/**
 * A reserve's supply side, the Hydration UI's total supply APY: the reserve's rate,
 * the incentives on its aToken and what the underlying accrues by itself (the API's
 * `supply` composition); without one, rate plus incentives. Null when a term is unknown.
 */
export function reserveSupplyPct(y: ReserveYield | undefined): number | null {
  if (!y) return null
  if (y.supply) return y.supply.totalAprPct
  return sumPct([y.supplyApyPct, ...y.supplyIncentives.map(i => i.aprPct)])
}

/** The supply side split: the reserve's own rate, the underlying's accrual, the incentives. */
export function supplyParts(y: ReserveYield | undefined): { base: number; accrual: number; incentives: number } | null {
  const total = reserveSupplyPct(y)
  if (!y || total == null || y.supplyApyPct == null) return null
  const incentives = y.supply
    ? sumPct(y.supply.components.filter(c => c.kind === 'mm-incentive').map(c => c.aprPct))
    : sumPct(y.supplyIncentives.map(i => i.aprPct))
  if (incentives == null) return null
  return { base: y.supplyApyPct, accrual: total - y.supplyApyPct - incentives, incentives }
}

/** A reserve's borrow cost: variable APY less the incentives paid on its debt token; null when any term is unknown. */
export function reserveBorrowPct(y: ReserveYield | undefined): number | null {
  if (!y) return null
  const incentives = sumPct(y.borrowIncentives.map(i => i.aprPct))
  return y.borrowApyPct == null || incentives == null ? null : y.borrowApyPct - incentives
}

export interface NetApyParts {
  /** The position's net APY in percent; null when a held side lacks a rate or a price, or net ≤ 0. */
  netPct: number | null
  supplyBasePct: number
  /** What the supplied underlyings accrue by themselves (token yield, a share's fee and legs). */
  supplyAccrualPct: number
  supplyIncentivePct: number
  borrowBasePct: number
  borrowIncentivePct: number
}

/**
 * Net APY on equity, the Hydration UI's definition: Σ supplied USD × total supply
 * APY (the reserve's rate + the underlying's own accrual + incentives) − Σ debt USD ×
 * (borrow APY − borrow incentives), over net
 * (supplied − debt). Each part is returned already divided by net, so the hover
 * adds up to the headline. A held side with no rate or no USD makes the whole
 * figure unknown — a sum missing a term is not a smaller sum.
 */
export function netApy(reserves: MmReserve[], yields: Record<string, ReserveYield> | undefined): NetApyParts {
  const out: NetApyParts = { netPct: null, supplyBasePct: 0, supplyAccrualPct: 0, supplyIncentivePct: 0, borrowBasePct: 0, borrowIncentivePct: 0 }
  let supplied = 0, debt = 0, sBase = 0, sAcc = 0, sInc = 0, dBase = 0, dInc = 0
  let known = true
  let held = 0
  for (const r of reserves) {
    const y = yields?.[String(r.assetId)]
    if (rawHeld(r.supplied)) {
      held++
      const parts = supplyParts(y)
      if (r.suppliedUsd == null || parts == null) { known = false; continue }
      supplied += r.suppliedUsd; sBase += r.suppliedUsd * parts.base; sAcc += r.suppliedUsd * parts.accrual; sInc += r.suppliedUsd * parts.incentives
    }
    if (rawHeld(r.debt)) {
      held++
      const inc = y ? sumPct(y.borrowIncentives.map(i => i.aprPct)) : null
      if (r.debtUsd == null || y?.borrowApyPct == null || inc == null) { known = false; continue }
      debt += r.debtUsd; dBase += r.debtUsd * y.borrowApyPct; dInc += r.debtUsd * inc
    }
  }
  const net = supplied - debt
  if (!known || !held || !(net > 0)) return out
  out.supplyBasePct = sBase / net
  out.supplyAccrualPct = sAcc / net
  out.supplyIncentivePct = sInc / net
  out.borrowBasePct = -dBase / net
  out.borrowIncentivePct = dInc / net
  out.netPct = out.supplyBasePct + out.supplyAccrualPct + out.supplyIncentivePct + out.borrowBasePct + out.borrowIncentivePct
  return out
}

/** Health factors drawn above this sit at it (a debt-free position's is unbounded). */
export const HF_CAP = 3

/**
 * An observation's health factor (1e18 fixed point) as a chart number: the
 * chain's value, capped at HF_CAP — a position with no debt (the contract's
 * uint256 max, or any huge figure) reads as the cap, never as a gap. `capped`
 * tells the caller to mark it. Unparseable input is null.
 */
export function parseHealthFactor(hf: string | null | undefined, totalDebtBase?: string): { value: number | null; capped: boolean } {
  if (totalDebtBase === '0') return { value: HF_CAP, capped: true }
  if (hf == null || hf === '' || hf === 'unknown') return { value: null, capped: false }
  if (hf === 'inf') return { value: HF_CAP, capped: true }
  const v = Number(hf) / 1e18
  if (!Number.isFinite(v)) return { value: null, capped: false }
  return v >= HF_CAP ? { value: HF_CAP, capped: true } : { value: v, capped: false }
}

/** One card's identity: which market, and whether a current position backs it. */
export interface BorrowCardSpec {
  marketKey: string
  label: string
  role: 'primary' | 'supplemental'
  stakingBacked: boolean
  current: MoneyMarketPosition | null
}

/** Primary market first, then the rest in the API's order — the one order every money-market surface uses. */
export function orderMarkets<T extends { role: string; marketKey: string }>(markets: T[]): T[] {
  const primary = markets.find(m => m.role === 'primary') ?? markets.find(m => m.marketKey === 'core')
  return primary ? [primary, ...markets.filter(m => m !== primary)] : [...markets]
}

/**
 * The cards an area gets: one per current market, or — when only history remains
 * (every position closed) — one "closed" card per market the history knows.
 */
export function borrowCards(current: MoneyMarketPosition[], history: MoneyMarketHistory | null | undefined): BorrowCardSpec[] {
  if (current.length) {
    return orderMarkets(current).map(m => ({ marketKey: m.marketKey, label: m.market, role: m.role, stakingBacked: !!m.stakingBacked, current: m }))
  }
  return orderMarkets(history?.markets ?? []).map(m => ({ marketKey: m.marketKey, label: m.market, role: m.role, stakingBacked: m.stakingBacked, current: null }))
}

export interface BorrowSeries {
  /** Dates of the drawn window: from the market's first point to the grid's end. */
  dates: string[]
  supplied: (number | null)[]
  borrowed: (number | null)[]
  /**
   * Before the reserve coverage floor: the market's own collateral and debt totals
   * from the observation (getUserAccountData, 8-decimal USD base) — null from the
   * floor on, so they are never blended with the reserve-based lines above.
   */
  collateralChain: (number | null)[]
  debtChain: (number | null)[]
  /** The lowest health factor in force during each bucket. */
  hf: (number | null)[]
  hfCapped: boolean
}

/**
 * One market's history on the grid. Market points are sparse (a bucket is listed
 * only while something was held, open or owed): a missing bucket at or after the
 * coverage floor is an empty position (0 supplied/borrowed); before the floor
 * every reserve amount is null — unknown, never zero — and the chain's own
 * collateral/debt totals stand in as separate series. The health factor is the
 * lowest the chain observed in the bucket (a dip inside a day is not hidden by a
 * recovered close), so a bucket without an observation is a gap.
 */
export function marketSeries(history: MoneyMarketHistory, market: MoneyMarketHistoryMarket): BorrowSeries {
  const n = history.dates.length
  const byI = new Map(market.points.map(p => [p.i, p]))
  const first = market.points.reduce((lo, p) => Math.min(lo, p.i), n)
  const stated = (i: number) => history.suppliedUsd[i] != null
  const base = (v: string) => { const x = Number(v) / 1e8; return Number.isFinite(x) ? x : null }
  const out: BorrowSeries = { dates: [], supplied: [], borrowed: [], collateralChain: [], debtChain: [], hf: [], hfCapped: false }
  for (let i = Math.min(first, n); i < n; i++) {
    const p = byI.get(i)
    const o = p?.observation ?? null
    out.dates.push(history.dates[i])
    const preFloor = !stated(i)
    out.collateralChain.push(preFloor && o ? base(o.totalCollateralBase) : null)
    out.debtChain.push(preFloor && o ? base(o.totalDebtBase) : null)
    if (p) {
      out.supplied.push(p.suppliedUsd)
      out.borrowed.push(p.borrowedUsd)
      // No debt-at-close shortcut here: the bucket may have owed debt before a
      // repay, and a debt-free lowest is the contract's uint256 max, which caps.
      const hf = o ? parseHealthFactor(o.lowestHealthFactor) : { value: null, capped: false }
      out.hf.push(hf.value)
      if (hf.capped) out.hfCapped = true
    } else if (!preFloor) {
      out.supplied.push(0); out.borrowed.push(0); out.hf.push(null)
    } else {
      out.supplied.push(null); out.borrowed.push(null); out.hf.push(null)
    }
  }
  return out
}

/** Σ claimed incentives' USD, with the claims that carry no price counted aloud. */
export function claimedIncentivesUsd(market: MoneyMarketHistoryMarket | undefined): { usd: number; unpriced: number } | null {
  const rows = market?.claimedIncentives
  if (!rows) return null
  let usd = 0, unpriced = 0
  for (const r of rows) {
    if (r.valueUsd != null) usd += r.valueUsd
    unpriced += r.unpricedClaims
  }
  return { usd, unpriced }
}

export interface InterestTotals { earnedUsd: number | null; paidUsd: number | null; earnedRaw?: string; paidRaw?: string; incomplete: boolean; unpriced: number }

/** A market's cumulative interest at the grid's end (the market's own totals). */
export function marketInterest(market: MoneyMarketHistoryMarket | undefined): InterestTotals | null {
  if (!market) return null
  return { earnedUsd: market.interestEarnedUsd, paidUsd: market.interestPaidUsd, incomplete: false, unpriced: market.interestUnpriced }
}

/**
 * One reserve's cumulative interest: the totals at the grid's last bucket, which
 * include what a closed reserve accrued after its last point.
 */
export function reserveInterest(reserve: MoneyMarketHistoryReserve | undefined): InterestTotals | null {
  if (!reserve) return null
  const t = reserve.interest
  return { earnedUsd: t.interestEarnedUsd, paidUsd: t.interestPaidUsd, earnedRaw: t.interestEarned, paidRaw: t.interestPaid, incomplete: t.interestIncomplete, unpriced: 0 }
}

export interface ReserveRowModel {
  asset: AssetRef
  supplied: string
  debt: string
  suppliedUsd: number | null
  debtUsd: number | null
  collateral: boolean
  interest: InterestTotals | null
  /** Held only in the past: its interest remains, its balance is gone. */
  closed: boolean
}

// A current row names a supplied reserve by the aToken held (aDOT) and a debt-only
// one by the asset owed (DOT), while the history files a reserve under its
// underlying and carries the aToken beside it — so a history reserve answers to
// both ids, and a reserve is "closed" only when no current row claimed it.
export function reserveRows(spec: BorrowCardSpec, market: MoneyMarketHistoryMarket | undefined): ReserveRowModel[] {
  type HistoryReserve = MoneyMarketHistoryMarket['reserves'][number]
  const byAsset = new Map<number, HistoryReserve>()
  for (const h of market?.reserves ?? []) {
    byAsset.set(h.asset.assetId, h)
    if (h.aToken) byAsset.set(h.aToken.assetId, h)
  }
  const claimed = new Set<HistoryReserve>()
  const rows: ReserveRowModel[] = (spec.current?.reserves ?? []).filter(r => rawHeld(r.supplied) || rawHeld(r.debt)).map(r => {
    const h = byAsset.get(r.assetId)
    if (h) claimed.add(h)
    return {
      asset: { assetId: r.assetId, iconAssetId: r.iconAssetId, iconAssetIds: r.iconAssetIds, symbol: r.symbol, name: null, decimals: r.decimals, parachainId: r.parachainId ?? null, origin: r.origin },
      supplied: r.supplied, debt: r.debt, suppliedUsd: r.suppliedUsd, debtUsd: r.debtUsd, collateral: r.collateral,
      interest: reserveInterest(h), closed: false,
    }
  })
  for (const h of market?.reserves ?? []) {
    if (claimed.has(h)) continue
    rows.push({ asset: h.asset, supplied: '0', debt: '0', suppliedUsd: null, debtUsd: null, collateral: false, interest: reserveInterest(h), closed: true })
  }
  return rows
}
