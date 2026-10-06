import { describe, expect, it } from 'vitest'
import { custodySegments, foldMmEarned, mmCardFact, mmCustodyIndex, type MmEarnedFactRow } from '../src/services/mmEarned.ts'
import type { MmContract } from '../src/services/userRevenueMm.ts'
import { moneyMarketEarnedMarkets } from '../src/services/explorerService.ts'

// The Borrow card's per-market slice of the User Revenue facts (services/mmEarned.ts).

const GIGA = '0x6b9ac524ec8f08c49ec80176b138d16eb461c3d8'
const supply = (market: string, reserveAsset: number, aTokenAsset: number | null, contract: string): MmContract =>
  ({ contract, side: 'supply', reserve: `0xr${reserveAsset}`, pool: `0xp${market}`, market, reserveAsset, aTokenAsset })
const debt = (market: string, reserveAsset: number, contract: string): MmContract =>
  ({ contract, side: 'debt', reserve: `0xr${reserveAsset}`, pool: `0xp${market}`, market, reserveAsset, aTokenAsset: null })

const CONTRACTS: MmContract[] = [
  supply('core', 5, 1001, '0xadot'), debt('core', 5, '0xvddot'),
  supply('core', 15, 1005, '0xavdot'), debt('core', 15, '0xvdvdot'),
  supply('core', 690, 69, '0xgdot'),
  supply('core', 90001, 9001, '0xgsol'),
  supply('core', 10055, 11055, '0xa2bil'),
  // HOLLAR's aTokens are no registry asset: their custody kind is the contract.
  supply('core', 222, null, '0xahollarcore'), debt('core', 222, '0xvdhollarcore'),
  supply('gigahdx', 670, 67, GIGA), debt('gigahdx', 222, '0xvdhollargiga'),
  supply('bil', 550, 55, '0xbil'), debt('bil', 222, '0xvdhollarbil'),
]
const IDX = mmCustodyIndex(CONTRACTS, GIGA)
const card = (stream: string, pot: string, via: string) => {
  const c = mmCardFact({ stream, pot, via }, IDX)
  return c && { market: c.market, reserve: c.reserve.reserveAsset, side: c.side, category: c.category }
}

describe('mmCardFact — which market card a fact belongs to', () => {
  it('direct lending and borrow interest belong to the pot\'s market and reserve', () => {
    expect(card('mm_supply_interest', 'core:5', '')).toEqual({ market: 'core', reserve: 5, side: 'earned', category: 'lending' })
    expect(card('mm_borrow_interest', 'core:5', '')).toEqual({ market: 'core', reserve: 5, side: 'paid', category: 'lending' })
    expect(card('mm_borrow_interest', 'gigahdx:222', '')).toEqual({ market: 'gigahdx', reserve: 222, side: 'paid', category: 'lending' })
    expect(card('mm_borrow_interest', 'bil:222', '')).toEqual({ market: 'bil', reserve: 222, side: 'paid', category: 'lending' })
  })

  it('a fact whose LAST custody is an aToken is that aToken\'s market, however deep the path beneath it', () => {
    // vDOT accruing inside avDOT.
    expect(card('token_accrual', 'token:15', 'atoken:1005')).toEqual({ market: 'core', reserve: 15, side: 'earned', category: 'token' })
    // aDOT's lending interest and vDOT's accrual inside the GDOT pool, reached through the GDOT aToken.
    expect(card('mm_supply_interest', 'core:5', 'stableswap:690>atoken:69')).toEqual({ market: 'core', reserve: 690, side: 'earned', category: 'lending' })
    expect(card('token_accrual', 'token:15', 'stableswap:690>atoken:69')).toEqual({ market: 'core', reserve: 690, side: 'earned', category: 'token' })
    expect(card('lp_fee_stableswap', 'stableswap:690', 'atoken:69')).toEqual({ market: 'core', reserve: 690, side: 'earned', category: 'poolFees' })
    // uBIL inside BIL (the BIL market), and the same uBIL nested under a2-Pool-BIL (a primary-market aToken).
    expect(card('token_accrual', 'token:550', 'atoken:55')).toEqual({ market: 'bil', reserve: 550, side: 'earned', category: 'token' })
    expect(card('token_accrual', 'token:550', 'atoken:55>stableswap:10055>atoken:11055')).toEqual({ market: 'core', reserve: 10055, side: 'earned', category: 'token' })
    // A contract-named aToken custody (no registry id).
    expect(card('token_accrual', 'token:222', 'atoken:0xahollarcore')?.market).toBe('core')
  })

  it('the catch-up booking label is no custody: its accrual joins the same card', () => {
    expect(custodySegments('catchup-spread>stableswap:690>atoken:69')).toEqual(['stableswap:690', 'atoken:69'])
    expect(custodySegments('external-rate:hastra-nav>atoken:1043')).toEqual(['atoken:1043'])
    expect(custodySegments('external-rate:hastra-nav')).toEqual([])
    expect(card('token_accrual_catchup', 'token:15', 'catchup-spread>atoken:1005')).toEqual({ market: 'core', reserve: 15, side: 'earned', category: 'token' })
    // A catch-up on a token held in the wallet is nobody's card.
    expect(card('token_accrual_catchup', 'token:15', 'catchup-spread')).toBeNull()
  })

  it('GIGAHDX yield is booked on the GIGAHDX aToken\'s holders: the GIGAHDX market\'s token yield', () => {
    expect(card('gigahdx_yield', 'gigahdx', '')).toEqual({ market: 'gigahdx', reserve: 670, side: 'earned', category: 'token' })
  })

  it('anything not held through an aToken, incentives and governance rewards are no card\'s', () => {
    expect(card('mm_supply_interest', 'core:5', 'omnipool')).toBeNull() // an Omnipool LP in aDOT: the Liquidity tab
    expect(card('mm_supply_interest', 'core:5', 'stableswap:690')).toBeNull() // a wallet-held 2-Pool-GDOT share
    expect(card('token_accrual_catchup', 'token:40', 'catchup-spread>stableswap:90001>atoken:9001>omnipool')).toBeNull()
    expect(card('mm_incentives', 'core:69:69', '')).toBeNull() // stated apart as Incentives
    expect(card('gigahdx_voting', 'gigahdx-voting:408', '')).toBeNull()
    expect(card('farm_rewards', 'farm:omnipool:97', '')).toBeNull()
    expect(card('token_accrual', 'token:15', '')).toBeNull()
    expect(card('token_accrual', 'token:15', 'atoken:4242')).toBeNull() // an aToken no market lists
    expect(card('mm_supply_interest', 'core:5', 'atoken:1001>mm-before-b0')).toBeNull() // a cause, not a holding
    expect(card('', '', '')).toBeNull() // a fold marker
  })
})

describe('foldMmEarned — the cards are a slice of the facts', () => {
  const T = 1_000_000_000_000n
  const f = (stream: string, pot: string, via: string, net: bigint, holderClass: MmEarnedFactRow['holderClass'] = 'user', unpriced = 0): MmEarnedFactRow =>
    ({ stream, pot, via, assetId: 0, holderClass, net, unpriced })
  // The live account behind the request (131d4YS2…), its money-market-relevant facts in whole dollars.
  const facts: MmEarnedFactRow[] = [
    f('mm_supply_interest', 'core:15', '', 261n * T / 100n),
    f('mm_supply_interest', 'core:5', '', 1660n * T / 100n),
    f('mm_borrow_interest', 'core:5', '', -1454965n * T / 100n),
    f('mm_borrow_interest', 'core:15', '', -9924n * T / 100n),
    f('token_accrual', 'token:15', 'atoken:1005', 607430n * T / 100n),
    f('token_accrual_catchup', 'token:15', 'catchup-spread>atoken:1005', -5014n * T / 100n),
    f('token_accrual', 'token:15', 'stableswap:690>atoken:69', 915559n * T / 100n),
    f('token_accrual_catchup', 'token:15', 'catchup-spread>stableswap:690>atoken:69', 69703n * T / 100n),
    f('mm_supply_interest', 'core:5', 'stableswap:690>atoken:69', 294501n * T / 100n),
    f('lp_fee_stableswap', 'stableswap:690', 'atoken:69', 36530n * T / 100n),
    f('lp_fee_stableswap', 'stableswap:690', 'atoken:69', 26146n * T / 100n),
    f('gigahdx_yield', 'gigahdx', '', 385902n * T / 100n),
    f('mm_borrow_interest', 'gigahdx:222', '', -81660n * T / 100n),
    f('token_accrual', 'token:550', 'atoken:55', 71187n * T / 100n),
    // Not any card's:
    f('mm_supply_interest', 'core:5', 'omnipool', 6498n * T / 100n),
    f('mm_incentives', 'core:69:69', '', 452210n * T / 100n),
    f('staking_legacy', 'staking', '', 3540356n * T / 100n),
    // Another class never enters a user card.
    f('token_accrual', 'token:15', 'atoken:1005', 999n * T, 'protocol'),
  ]

  it('sums each market by category, with borrow interest apart', () => {
    const out = foldMmEarned(facts, IDX, 'user')
    expect([...out.keys()].sort()).toEqual(['bil', 'core', 'gigahdx'])
    const core = out.get('core')!
    expect(core.byCategory.lending).toBe((261n + 1660n + 294501n) * T / 100n)
    expect(core.byCategory.token).toBe((607430n - 5014n + 915559n + 69703n) * T / 100n)
    expect(core.byCategory.poolFees).toBe((36530n + 26146n) * T / 100n)
    expect(core.byCategory.other).toBe(0n)
    expect(core.earned).toBe(core.byCategory.lending + core.byCategory.token + core.byCategory.poolFees)
    expect(core.paid).toBe(-(1454965n + 9924n) * T / 100n)
    // Per reserve: avDOT's row carries vDOT's lending interest and its accrual; GDOT's everything inside the pool.
    expect(core.reserves.get(15)).toMatchObject({ earned: (261n + 607430n - 5014n) * T / 100n, paid: -9924n * T / 100n })
    expect(core.reserves.get(690)).toMatchObject({ earned: (915559n + 69703n + 294501n + 36530n + 26146n) * T / 100n, paid: 0n })
    expect(out.get('gigahdx')).toMatchObject({ earned: 385902n * T / 100n, paid: -81660n * T / 100n })
    expect(out.get('bil')).toMatchObject({ earned: 71187n * T / 100n, paid: 0n })
  })

  it('conserves: every user fact is in exactly one card or in none — never two', () => {
    const out = foldMmEarned(facts, IDX, 'user')
    const inCards = [...out.values()].reduce((s, m) => s + m.earned + m.paid, 0n)
    const notInCards = facts.filter(r => r.holderClass === 'user' && !mmCardFact(r, IDX)).reduce((s, r) => s + r.net, 0n)
    const all = facts.filter(r => r.holderClass === 'user').reduce((s, r) => s + r.net, 0n)
    expect(inCards + notInCards).toBe(all)
    const items = [...out.values()].flatMap(m => [...m.items.values()]).reduce((s, i) => s + i.net, 0n)
    expect(items).toBe(inCards)
  })

  it('folds a catch-up into its accrual\'s line and keeps the holding apart', () => {
    const core = foldMmEarned(facts, IDX, 'user').get('core')!
    const tokenLines = [...core.items.values()].filter(i => i.category === 'token')
    expect(tokenLines.map(i => [i.holding, i.net])).toEqual([
      ['atoken:1005', (607430n - 5014n) * T / 100n],
      ['atoken:69', (915559n + 69703n) * T / 100n],
    ])
    // Two fee legs of one pool are one line.
    expect([...core.items.values()].filter(i => i.category === 'poolFees')).toHaveLength(1)
  })

  it('reads one holder class: a protocol page folds its own facts', () => {
    const out = foldMmEarned(facts, IDX, 'protocol')
    expect([...out.keys()]).toEqual(['core'])
    expect(out.get('core')!.byCategory.token).toBe(999n * T)
  })

  it('renders signed, dust-snapped USD with borrow interest as a positive cost', () => {
    const [core, gigahdx, bil] = moneyMarketEarnedMarkets(foldMmEarned(facts, IDX, 'user'))
    expect([core.marketKey, gigahdx.marketKey, bil.marketKey]).toEqual(['core', 'gigahdx', 'bil'])
    expect(core.lendingUsd).toBeCloseTo(2.61 + 16.6 + 2945.01, 6)
    expect(core.tokenYieldUsd).toBeCloseTo(6074.3 - 50.14 + 9155.59 + 697.03, 6)
    expect(core.poolFeesUsd).toBeCloseTo(365.3 + 261.46, 6)
    expect(core.earnedUsd).toBeCloseTo(core.lendingUsd + core.tokenYieldUsd + core.poolFeesUsd, 6)
    expect(core.paidUsd).toBeCloseTo(14549.65 + 99.24, 6)
    expect(gigahdx.tokenYieldUsd).toBeCloseTo(3859.02, 6)
    expect(gigahdx.paidUsd).toBeCloseTo(816.6, 6)
    // The headline is Net earned: earned less interest paid, additive beside both.
    expect(core.netEarnedUsd).toBeCloseTo(core.earnedUsd - core.paidUsd, 6)
    expect(core.netEarnedUsd).toBeLessThan(core.earnedUsd)
    expect(gigahdx.netEarnedUsd).toBeCloseTo(3859.02 - 816.6, 6)
    // Largest first; the borrow lines are 'paid' with a positive amount.
    expect(core.items[0]).toMatchObject({ category: 'paid', stream: 'mm_borrow_interest' })
    expect(core.items[0].usd).toBeCloseTo(14549.65, 6)
    expect(core.items.find(i => i.stream === 'token_accrual' && i.via?.assetId === 1005)?.usd).toBeCloseTo(6074.3 - 50.14, 6)
    // A direct fact names no holding; GIGAHDX's own yield is not "in GIGAHDX".
    expect(core.items.find(i => i.category === 'lending' && i.asset.assetId === 15)?.via).toBeNull()
    expect(gigahdx.items.find(i => i.category === 'token')?.via).toBeNull()
    expect(core.reserves.find(r => r.reserveAssetId === 690)).toMatchObject({ aTokenAssetId: 69 })
  })

  it('names a HOLLAR loan\'s interest as every User Revenue surface does (HOLLAR interest, its display stream)', () => {
    const [core, gigahdx] = moneyMarketEarnedMarkets(foldMmEarned(facts, IDX, 'user'))
    expect(gigahdx.items.find(i => i.category === 'paid')).toMatchObject({ stream: 'mm_borrow_interest_hollar', label: 'HOLLAR interest' })
    expect(core.items.filter(i => i.category === 'paid').map(i => i.stream)).toEqual(['mm_borrow_interest', 'mm_borrow_interest'])
    expect(core.items[0].label).toMatch(/ borrow interest$/)
  })
})
