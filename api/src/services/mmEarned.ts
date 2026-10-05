// What an account's money-market positions EARNED and PAID, per isolated market —
// the Borrow tab card's "Earned" and "Interest paid". It is a per-market VIEW of
// the User Revenue account facts (account_user_revenue_daily, read through
// userRevenueRead.ts), never a second computation: every fact either belongs to
// exactly one market's card or to none, so a card's figures are a slice of the
// User Revenue tab's and the header stat's, and nothing is counted twice.
//
// THE RULE (mmCardFact) — which fact is a market's:
//
//   A fact's `via` is its custody path, innermost holding first: the income arose
//   on a holding, and each custody it passed through on its way to the account
//   appended its kind ('stableswap:690' then 'atoken:69' = aDOT in pool 690,
//   whose shares the GDOT aToken holds, whose holders are the accounts). So the
//   LAST segment is the account's own holding. A leading booking label
//   ('catchup-spread', a token's dated-back catch-up) is no custody and is skipped.
//
//   1. The account's holding is an aToken of market M (last segment
//      `atoken:<registry id | contract>`, the fold's own custody kind from
//      loadMmContracts): the fact is M's — whatever stream it is and however deep
//      the path beneath the aToken goes (token accrual of the vDOT an avDOT
//      holds, the lending interest of the aDOT and the fees of the pool inside
//      GDOT). Its reserve row is that aToken's reserve.
//   2. A DIRECT money-market fact (via '' — booked on the account's own aToken or
//      debt-token balance): mm_supply_interest / mm_borrow_interest on pot
//      `<market>:<reserve asset>` is that market's, on that reserve.
//   3. GIGAHDX yield (via '') is booked pro rata over the GIGAHDX aToken's own
//      holders (buildGigahdxYield), so it is a direct fact of that aToken: the
//      GIGAHDX market's token yield.
//   Everything else is no market's: mm_incentives (the card states incentives
//   apart, from the controller's own claims and claimable), and any fact whose
//   holding is not an aToken (a wallet-held pool share, an Omnipool position, a
//   token in the wallet) — those are the Liquidity tab's and the wallet's.
//
// Categories: lending interest (mm_supply_interest), token yield (token_accrual,
// its catch-up, GIGAHDX yield), pool fees (lp_fee_*), other. Borrow interest
// (mm_borrow_interest) is the card's "Interest paid". Amounts are signed: a
// borrower of a yield-bearing reserve owes its accrual too (the aToken's claims
// rule books it negative on the debt holder, on the same aToken custody), and a
// rate's give-back is negative — so Earned is net, never a gross that hides a
// cost the facts state.
//
// Time basis: all time through the account fold's cut. Every fact a card holds
// starts at the money market's coverage floor (B0, MM_COVERAGE_FROM_BLOCK): the
// direct interest is booked from B0 and an aToken custody passes nothing before
// it (`mm-before-b0`, unattributed), so the card reads "since B0", as its
// history does. Each fact is valued at its own hour's closed candle.

import type { MmContract } from './userRevenueMm.ts'
import { CATCHUP_VIA, isExternalRateVia } from './userRevenueTokens.ts'
import type { HolderClass } from './userRevenueStreams.ts'

export type MmEarnedCategory = 'lending' | 'token' | 'poolFees' | 'other'
export const MM_EARNED_CATEGORIES: readonly MmEarnedCategory[] = ['lending', 'token', 'poolFees', 'other']

/** The aToken custody kinds and reserves of every market (from the fold's own contract list). */
export interface MmCustodyIndex {
  /** Custody kind ('atoken:69', 'atoken:0x…') → its market and reserve. */
  byKind: ReadonlyMap<string, MmReserveRef>
  /** `<market>:<reserve asset>` → its market and reserve. */
  byPot: ReadonlyMap<string, MmReserveRef>
  /** The kind GIGAHDX yield is booked on (its aToken's holders). */
  gigahdxKind: string | null
}
export interface MmReserveRef { market: string; reserveAsset: number; aTokenAsset: number | null; aTokenContract: string }

/** The custody kind the fold names an aToken holding by (userRevenueWindow.aTokenClaimsCustody). */
export const aTokenCustodyKind = (c: Pick<MmContract, 'aTokenAsset' | 'contract'>): string => `atoken:${c.aTokenAsset ?? c.contract}`

export function mmCustodyIndex(contracts: readonly MmContract[], gigahdxAToken: string): MmCustodyIndex {
  const byKind = new Map<string, MmReserveRef>()
  const byPot = new Map<string, MmReserveRef>()
  let gigahdxKind: string | null = null
  for (const c of contracts) {
    if (c.side !== 'supply') continue
    const ref: MmReserveRef = { market: c.market, reserveAsset: c.reserveAsset, aTokenAsset: c.aTokenAsset, aTokenContract: c.contract.toLowerCase() }
    byKind.set(aTokenCustodyKind(c), ref)
    byPot.set(`${c.market}:${c.reserveAsset}`, ref)
    if (c.contract.toLowerCase() === gigahdxAToken.toLowerCase()) gigahdxKind = aTokenCustodyKind(c)
  }
  // A debt-only reserve (no aToken row would be unusual, but the pot must still resolve).
  for (const c of contracts) {
    if (c.side !== 'debt' || byPot.has(`${c.market}:${c.reserveAsset}`)) continue
    byPot.set(`${c.market}:${c.reserveAsset}`, { market: c.market, reserveAsset: c.reserveAsset, aTokenAsset: null, aTokenContract: '' })
  }
  return { byKind, byPot, gigahdxKind }
}

export interface MmCardFact {
  market: string
  reserve: MmReserveRef
  /** 'paid' = the card's Interest paid (borrow interest); otherwise an Earned category. */
  side: 'earned' | 'paid'
  category: MmEarnedCategory
  /** The account's own holding: the aToken custody kind, or '' for a direct fact. */
  holding: string
}

export function mmEarnedCategoryOf(stream: string): MmEarnedCategory {
  if (stream === 'mm_supply_interest') return 'lending'
  if (stream === 'token_accrual' || stream === 'token_accrual_catchup' || stream === 'gigahdx_yield') return 'token'
  if (stream.startsWith('lp_fee_')) return 'poolFees'
  return 'other'
}

/** The custody segments of a via, the booking label (catch-up, an external rate) dropped. */
export function custodySegments(via: string): string[] {
  const segs = via ? via.split('>') : []
  return segs[0] === CATCHUP_VIA || (segs[0] !== undefined && isExternalRateVia(segs[0])) ? segs.slice(1) : segs
}

/** Pure: the market card a fact belongs to under THE RULE above, or null. */
export function mmCardFact(f: { stream: string; pot: string; via: string }, idx: MmCustodyIndex): MmCardFact | null {
  if (f.stream === '' || f.stream === 'mm_incentives') return null
  const segs = custodySegments(f.via)
  if (segs.length) {
    const ref = idx.byKind.get(segs[segs.length - 1])
    if (!ref) return null
    return { market: ref.market, reserve: ref, side: 'earned', category: mmEarnedCategoryOf(f.stream), holding: segs[segs.length - 1] }
  }
  // A via of only a booking label is a token in the wallet — no market's.
  if (f.via !== '') return null
  if (f.stream === 'mm_supply_interest' || f.stream === 'mm_borrow_interest') {
    const ref = idx.byPot.get(f.pot)
    if (!ref) return null
    return { market: ref.market, reserve: ref, side: f.stream === 'mm_borrow_interest' ? 'paid' : 'earned', category: 'lending', holding: '' }
  }
  if (f.stream === 'gigahdx_yield' && idx.gigahdxKind) {
    const ref = idx.byKind.get(idx.gigahdxKind)
    if (!ref) return null
    return { market: ref.market, reserve: ref, side: 'earned', category: 'token', holding: idx.gigahdxKind }
  }
  return null
}

export interface MmEarnedFactRow { stream: string; pot: string; via: string; assetId: number; holderClass: HolderClass; net: bigint; unpriced: number }

/** One market's slice, in exact 1e-12 USD (never dust-snapped: the renderer snaps each shown figure once). */
export interface MmEarnedMarketSums {
  market: string
  earned: bigint
  byCategory: Record<MmEarnedCategory, bigint>
  /** Borrow interest as booked: ≤ 0 (a cost). */
  paid: bigint
  unpriced: number
  /** Per reserve (keyed `<reserve asset>`). */
  reserves: Map<number, { reserve: MmReserveRef; earned: bigint; paid: bigint }>
  /** Per (category, pot, holding): the hover's lines. A catch-up joins its regular accrual's line. */
  items: Map<string, { category: MmEarnedCategory; side: 'earned' | 'paid'; stream: string; pot: string; holding: string; reserve: MmReserveRef; net: bigint; unpriced: number }>
}

const displayStream = (stream: string): string => (stream === 'token_accrual_catchup' ? 'token_accrual' : stream)

/** Pure: the facts of ONE holder class → per-market sums. Facts of other classes are ignored. */
export function foldMmEarned(rows: readonly MmEarnedFactRow[], idx: MmCustodyIndex, holderClass: HolderClass): Map<string, MmEarnedMarketSums> {
  const out = new Map<string, MmEarnedMarketSums>()
  for (const r of rows) {
    if (r.holderClass !== holderClass) continue
    const card = mmCardFact(r, idx)
    if (!card) continue
    let m = out.get(card.market)
    if (!m) {
      m = { market: card.market, earned: 0n, byCategory: { lending: 0n, token: 0n, poolFees: 0n, other: 0n }, paid: 0n, unpriced: 0, reserves: new Map(), items: new Map() }
      out.set(card.market, m)
    }
    m.unpriced += r.unpriced
    const res = m.reserves.get(card.reserve.reserveAsset) ?? m.reserves.set(card.reserve.reserveAsset, { reserve: card.reserve, earned: 0n, paid: 0n }).get(card.reserve.reserveAsset)!
    if (card.side === 'paid') { m.paid += r.net; res.paid += r.net } else {
      m.earned += r.net; m.byCategory[card.category] += r.net; res.earned += r.net
    }
    const stream = displayStream(r.stream)
    const key = `${card.side}\u0000${card.category}\u0000${stream}\u0000${r.pot}\u0000${card.holding}`
    const item = m.items.get(key)
    if (item) { item.net += r.net; item.unpriced += r.unpriced } else {
      m.items.set(key, { category: card.category, side: card.side, stream, pot: r.pot, holding: card.holding, reserve: card.reserve, net: r.net, unpriced: r.unpriced })
    }
  }
  return out
}
