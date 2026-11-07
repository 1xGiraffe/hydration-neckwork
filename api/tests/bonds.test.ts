import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOND_FAMILIES, BOND_WAD, BONDS_POT_ACCOUNT, YEAR_MS, bondStatus, bondValueFactorWad, familyRounds, fillYield, otcFillFee, paysInFaceUnits,
  primaryOtcSaleKind, saleAnchor, saleProgress, salePriceWad, withBondPrices,
  type BondSale, type BondTerms,
} from '../src/services/bonds.ts'
import { otcBondSales } from '../src/services/bondSales.ts'
import {
  BOND_SALES, BOND_SALE_BY_ORDER, BOND_TERMS, BOND_UNDERLYING_ID, PRICE_ALIAS_ID, applyBondRegistry, bondRoundOf, currentPriceAssetId, currentPriceOf, priceAssetId,
} from '../src/services/explorerAssets.ts'
import { withDerivedSharePrices } from '../src/services/strategySharePrice.ts'
import {
  activityRowMatchesAction, activityTypeMatchesFamily, assetBondInfo, bondAdjustedClose, bondChange24h, bondSaleAction, bondSaleRefOf, otcRowFromEvent,
  type ActivityRow, type OtcPlacedLeg,
} from '../src/services/explorerService.ts'
import { assembleBondSnapshot, bondEvents, bondIssuerAccounts, bondSupplies } from '../src/services/bondState.ts'
import { bondDays, fillDaysOf, saleTerms } from '../src/services/bondService.ts'
import { isCustodyAccount, isCustodyH160, isUncountedHolding, uncountedHoldingSql } from '../src/services/valuation.ts'

// The second HOLLAR round as it is on chain: bond 1001353 over HOLLAR (222), maturing
// 2026-11-24 00:00 UTC, offered by governance on 2026-08-21 14:54:21 at 222,222 USDT
// (6 decimals) for 226,929.899543378995433789 bonds (18 decimals), its USDT offer pulled
// on 2026-10-15 09:59:48.
const HOLLAR = 222, BOND = 1_001_353, OLD_BOND = 1_001_351, USDT = 10
const MATURITY = Date.parse('2026-11-24T00:00:00Z')
const PLACED = Date.parse('2026-08-21T14:54:21Z')
const CLOSED = Date.parse('2026-10-15T09:59:48Z')
const PAID = 222_222_000_000n
const OFFERED = 226_929_899_543_378_995_433_789n
const PRICE = salePriceWad(PAID, 6, OFFERED, 18)!
const decimalsOf = (id: number) => (id === USDT ? 6 : 18)
const terms = (over: Partial<BondTerms> = {}): BondTerms => ({
  bondId: BOND, underlyingId: HOLLAR, issuer: '0x6d6f646c70792f74727372790000000000000000000000000000000000000000',
  maturityMs: MATURITY, createdBlock: 13_710_895, createdMs: Date.parse('2026-08-21T01:01:15Z'), issued: '917152679888412004089323',
  anchor: { priceWad: PRICE, openedMs: PLACED, closedMs: CLOSED }, ...over,
})
const sale = (over: Partial<BondSale> = {}): BondSale => ({
  venue: 'otc', id: '1546', bondId: BOND, kind: 'sale', paymentAssetId: USDT, issuerAccounts: [],
  offered: OFFERED.toString(), asked: PAID.toString(), openedBlock: 13_719_478, openedMs: PLACED, closedBlock: null, closedMs: null, fills: [], ...over,
})
const fill = (atMs: number, paid: bigint, bonds: bigint, taker = '0xa') =>
  ({ block: 1, eventIndex: 1, extrinsicIndex: 1, atMs, taker, paid: paid.toString(), bonds: bonds.toString(), fee: otcFillFee(bonds).toString(), partial: true })

afterEach(() => {
  BOND_TERMS.clear(); BOND_SALES.clear(); BOND_SALE_BY_ORDER.clear()
  for (const id of Object.keys(BOND_UNDERLYING_ID)) { delete BOND_UNDERLYING_ID[Number(id)]; delete PRICE_ALIAS_ID[Number(id)] }
})

describe('the sale terms', () => {
  it('takes the OTC fee as 0.1% of amountOut rounded up, as the pallet does', () => {
    expect(otcFillFee(1000n)).toBe(1n)
    expect(otcFillFee(1001n)).toBe(2n)
    expect(otcFillFee(36_652_300_497_078_009_515n)).toBe(36_652_300_497_078_010n) // a real fill of order 1548
  })

  it('reads a stablecoin as one face unit of a HOLLAR bond, and nothing else', () => {
    expect(paysInFaceUnits(10, HOLLAR)).toBe(true)
    expect(paysInFaceUnits(22, HOLLAR)).toBe(true)
    expect(paysInFaceUnits(5, HOLLAR)).toBe(false)
    expect(paysInFaceUnits(0, 0)).toBe(true)
  })

  // The chain's terms give 2.016438…% (the app's configured constant reads 2.0165): the
  // return is rounded half up to 1e-4 %, never truncated (1.725% for round 1 exactly).
  it('states the round\'s fixed yield from the order\'s own terms, rounded', () => {
    expect(Number(PRICE) / 1e18).toBeCloseTo(0.980234, 6)
    const y = fillYield({ paid: PAID, paidDecimals: 6, net: OFFERED - otcFillFee(OFFERED), bondDecimals: 18, atMs: PLACED, maturityMs: MATURITY })!
    expect(y.returnPct).toBe(2.0164)
    expect(y.aprPct!).toBeCloseTo(7.798, 3)
    expect(saleTerms(sale(), terms(), decimalsOf, false).fixedYieldPct).toBe(2.0164)
    const r1 = 226_281_611_111_111_111_111_111n
    expect(fillYield({ paid: PAID, paidDecimals: 6, net: r1 - otcFillFee(r1), bondDecimals: 18, atMs: PLACED, maturityMs: MATURITY })!.returnPct).toBe(1.725)
    // Half up: 1.99995% reads 2.0000%, not 1.9999%.
    expect(fillYield({ paid: 10n ** 18n * 100_000n, paidDecimals: 18, net: 101_999_950n * 10n ** 15n, bondDecimals: 18, atMs: 0, maturityMs: 1 })!.returnPct).toBe(2)
  })

  it('annualises a rollover from the later of the fill and the old bond\'s maturity', () => {
    const oldMaturity = Date.parse('2026-08-25T06:25:54Z')
    const y = fillYield({ paid: 10n ** 18n, paidDecimals: 18, net: 1_022_684n * 10n ** 12n, bondDecimals: 18, atMs: PLACED, maturityMs: MATURITY, paidMaturityMs: oldMaturity })!
    expect(y.returnPct).toBe(2.2684)
    expect(y.aprPct!).toBeCloseTo(2.2684 * YEAR_MS / (MATURITY - oldMaturity), 6)
  })
})

describe('a primary sale\'s progress and anchor', () => {
  it('is open, sold out or closed by one rule, with what went unsold', () => {
    const half = OFFERED / 2n
    expect(saleProgress(sale({ fills: [fill(PLACED + 1, PAID / 2n, half)] }), MATURITY, PLACED + 2).state).toBe('open')
    const pulled = saleProgress(sale({ fills: [fill(PLACED + 1, PAID / 2n, half)], closedMs: CLOSED }), MATURITY, CLOSED + 1)
    expect(pulled.state).toBe('closed')
    expect(pulled.unsold).toBe(OFFERED - half)
    expect(saleProgress(sale({ fills: [fill(PLACED + 1, PAID, OFFERED)] }), MATURITY, PLACED + 2).state).toBe('filled')
    // Still standing at maturity is closed: nothing worth selling remains.
    expect(saleProgress(sale(), MATURITY, MATURITY).state).toBe('closed')
  })

  it('anchors on the open offer\'s executable price, then on the volume-weighted price it sold at', () => {
    const open = saleAnchor([sale()], terms(), decimalsOf, PLACED + 10)!
    expect(open).toEqual({ priceWad: PRICE, openedMs: PLACED, closedMs: null })
    const sold = sale({ fills: [fill(PLACED + 1, PAID / 2n, OFFERED / 2n)], closedMs: CLOSED })
    const closed = saleAnchor([sold], terms(), decimalsOf, CLOSED + 10)!
    expect(closed.closedMs).toBe(CLOSED)
    expect(Number(closed.priceWad - PRICE)).toBeLessThan(1e9) // the VWAP of an at-price fill is the price
    // A rollover is no money sale: it anchors nothing.
    expect(saleAnchor([sale({ kind: 'rollover', paymentAssetId: OLD_BOND })], terms(), decimalsOf, PLACED)).toBeNull()
  })
})

describe('the bond valuation rule', () => {
  it('holds the sale price while the sale stands, then accretes continuously to face at maturity', () => {
    const t = terms()
    expect(bondValueFactorWad(t, PLACED)).toBe(PRICE)
    expect(bondValueFactorWad(t, CLOSED)).toBe(PRICE)
    const after = bondValueFactorWad(t, CLOSED + 1000)!
    expect(after >= PRICE && after - PRICE < 10n ** 12n).toBe(true) // continuous at the close
    const mid = bondValueFactorWad(t, CLOSED + (MATURITY - CLOSED) / 2)!
    expect(mid > PRICE && mid < BOND_WAD).toBe(true)
    expect(bondValueFactorWad(t, MATURITY)).toBe(BOND_WAD)
    // While an offer is open a buyer pays exactly what the bond is then worth — no instant gain.
    expect(bondValueFactorWad(terms({ anchor: { priceWad: PRICE, openedMs: PLACED, closedMs: null } }), MATURITY - 86_400_000)).toBe(PRICE)
  })

  it('states nothing for a bond before maturity that had no money sale', () => {
    expect(bondValueFactorWad(terms({ anchor: null }), PLACED)).toBeNull()
    expect(bondValueFactorWad(terms({ anchor: null }), MATURITY)).toBe(BOND_WAD)
  })

  it('prices a bond off its underlying, keeps a market of its own and drops what it cannot state', () => {
    const feeds = new Map<number, bigint>([[HOLLAR, 1_000_000_000_000n]])
    const now = CLOSED + (MATURITY - CLOSED) / 2
    const out = withBondPrices(feeds, [terms(), terms({ bondId: 7, anchor: null })], now, id => feeds.get(id))
    expect(out.get(BOND)).toBe(1_000_000_000_000n * bondValueFactorWad(terms(), now)! / BOND_WAD)
    expect(out.has(7)).toBe(false)
    expect(withBondPrices(new Map([...feeds, [BOND, 5n]]), [terms()], now, id => feeds.get(id)).get(BOND)).toBe(5n)
  })

  it('runs last in the shared current-price derivation, and the current lookup stops at a bond', () => {
    BOND_TERMS.set(BOND, terms()); BOND_UNDERLYING_ID[BOND] = HOLLAR; PRICE_ALIAS_ID[BOND] = HOLLAR
    const out = withDerivedSharePrices(new Map([[HOLLAR, 997_000_000_000n]]), null, [], () => 18, () => false, MATURITY)
    expect(out.get(BOND)).toBe(997_000_000_000n)
    expect(currentPriceAssetId(BOND)).toBe(BOND)
    expect(priceAssetId(BOND)).toBe(HOLLAR) // candles through the underlying, × the factor (bondAdjustedClose)
    expect(currentPriceOf(new Map([[HOLLAR, 1n]]), BOND)).toBeUndefined()
  })

  it('values history at the factor of the row\'s own time, and leaves every other asset\'s close alone', () => {
    BOND_TERMS.set(BOND, terms())
    expect(Number(bondAdjustedClose(BOND, '2026-09-01 00:00:00', '1.000000000000'))).toBe(Number((PRICE / 10n ** 6n).toString()) / 1e12)
    expect(Number(bondAdjustedClose(BOND, '2026-11-24 00:00:00', '0.997000000000'))).toBe(0.997)
    expect(bondAdjustedClose(HOLLAR, '2026-09-01 00:00:00', '0.997000000000')).toBe('0.997000000000')
    BOND_TERMS.set(BOND, terms({ anchor: null }))
    expect(bondAdjustedClose(BOND, '2026-09-01 00:00:00', '1.000000000000')).toBeUndefined()
  })

  it('moves a bond\'s 24h price by its underlying and its factor', () => {
    const t = terms()
    // Inside the sale the factor stands still: the bond moves with HOLLAR alone.
    expect(bondChange24h(t, 0.001, PLACED + 3 * 86_400_000)).toBeCloseTo(0.001, 9)
    // After it the accretion adds its day's share.
    expect(bondChange24h(t, 0, CLOSED + 10 * 86_400_000)!).toBeGreaterThan(0)
    expect(bondChange24h(terms({ anchor: null }), 0, PLACED)).toBeNull()
  })

  it('holds the Bonds pot in custody: the directory and every total value it at 0', () => {
    expect(isCustodyAccount(BONDS_POT_ACCOUNT)).toBe(true)
    expect(isUncountedHolding(BONDS_POT_ACCOUNT, HOLLAR)).toBe(true)
    expect(uncountedHoldingSql('a', 'b')).toContain(BONDS_POT_ACCOUNT)
    // Its HOLLAR is an ERC-20 pot keyed by its first 20 bytes: a tag's or a directory
    // row's ERC-20 read leaves it out too, not only the account page.
    expect(isCustodyH160(BONDS_POT_ACCOUNT.slice(0, 42))).toBe(true)
    expect(isCustodyH160('0x6a21891db0940491603f3cca0a9f4dba4c6e810c')).toBe(true) // the BIL vault
    const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
    expect(src).toContain("return h160 && !isCustodyH160(h160) ? [{ h160, simAccount }] : []")
    expect(src).toContain('erc20WalletHoldingsForAccounts(h160s.filter(h => !isCustodyH160(h)))')
  })
})

describe('the bond registry', () => {
  const created = [{ bondId: BOND, underlyingId: HOLLAR, issuer: '0xissuer', maturityMs: MATURITY, createdBlock: 13_710_895, createdMs: PLACED - 50_000_000 }]

  it('keeps every bond\'s previous anchor when the sale read fails, rather than unpricing them', () => {
    applyBondRegistry(created, new Map([[BOND, '1000']]), [sale({ fills: [fill(PLACED + 1, PAID, OFFERED)] })], CLOSED)
    const before = BOND_TERMS.get(BOND)!.anchor
    expect(before).not.toBeNull()
    applyBondRegistry(created, null, null, CLOSED + 1)
    expect(BOND_TERMS.get(BOND)!.anchor).toEqual(before)
    expect(BOND_TERMS.get(BOND)!.issued).toBe('1000')
    expect(BOND_SALE_BY_ORDER.get('1546')).toBeDefined()
  })

  it('numbers a family\'s rounds by issue, skipping a class issued nothing, and states an asset\'s bond facts', () => {
    applyBondRegistry([
      { bondId: OLD_BOND, underlyingId: HOLLAR, issuer: '0xissuer', maturityMs: MATURITY - 90 * 86_400_000, createdBlock: 12_529_271, createdMs: PLACED - 90 * 86_400_000 },
      { bondId: 1_001_352, underlyingId: HOLLAR, issuer: '0xuser', maturityMs: MATURITY, createdBlock: 13_000_000, createdMs: PLACED - 10 * 86_400_000 },
      ...created,
    ], new Map([[OLD_BOND, '5'], [1_001_352, '0'], [BOND, '5']]), [sale()], PLACED + 1)
    expect(familyRounds(BOND_TERMS.values(), HOLLAR).map(t => t.bondId)).toEqual([OLD_BOND, BOND])
    expect(bondRoundOf(BOND)).toEqual({ family: 'hollar', round: 2 })
    const info = assetBondInfo(BOND, PLACED + 1)!
    expect(info).toMatchObject({ family: 'hollar', round: 2, matured: false, saleOpen: true })
    expect(info.valueFactor).not.toBeNull()
    expect(assetBondInfo(HOLLAR)).toBeUndefined()
    expect(BOND_FAMILIES.map(f => f.key)).toContain('hollar')
  })
})

describe('the primary-sale rule and the bond family', () => {
  const isBond = (id: number) => id === BOND || id === OLD_BOND
  it('names a governance-placed order selling a bond a sale, or a rollover when it takes a bond', () => {
    expect(primaryOtcSaleKind({ governance: true, assetIn: USDT, assetOut: BOND }, isBond)).toBe('sale')
    expect(primaryOtcSaleKind({ governance: true, assetIn: OLD_BOND, assetOut: BOND }, isBond)).toBe('rollover')
    expect(primaryOtcSaleKind({ governance: false, assetIn: USDT, assetOut: BOND }, isBond)).toBeNull()
    expect(primaryOtcSaleKind({ governance: true, assetIn: BOND, assetOut: USDT }, isBond)).toBeNull()
  })

  it('reads the same rule from the Placed rows the shared sale read loads', () => {
    const placed = (orderId: number, extrinsic_index: number | null, assetIn: number) => ({ block_height: 10, event_index: orderId, extrinsic_index, ts: 1_790_000_000, event_name: 'OTC.Placed', args_json: JSON.stringify({ orderId, assetIn, assetOut: BOND, amountIn: '100', amountOut: '1000' }) })
    const ev = (event_name: string, args: Record<string, unknown>, block_height: number) => ({ block_height, event_index: 1, extrinsic_index: 2, ts: 1_790_000_000 + block_height, event_name, args_json: JSON.stringify(args) })
    const sales = otcBondSales([placed(1546, null, USDT), placed(999, 2, USDT), placed(1548, null, OLD_BOND)], [
      ev('OTC.Cancelled', { orderId: 1546 }, 30),
      ev('OTC.PartiallyFilled', { orderId: 1546, who: '0xT2', amountIn: '20', amountOut: '200', fee: '1' }, 20),
      ev('OTC.PartiallyFilled', { orderId: 1546, who: '0xT1', amountIn: '10', amountOut: '100', fee: '1' }, 15),
    ], isBond)
    expect(sales.map(s => [s.id, s.kind])).toEqual([['1546', 'sale'], ['1548', 'rollover']])
    expect(sales[0].fills.map(f => f.taker)).toEqual(['0xt1', '0xt2'])
    expect(sales[0].closedBlock).toBe(30)
  })

  it('makes a primary-sale OTC row a bond row too — one row in both families, never two rows', () => {
    BOND_UNDERLYING_ID[BOND] = HOLLAR; BOND_UNDERLYING_ID[OLD_BOND] = HOLLAR
    const leg = (over: Partial<OtcPlacedLeg>): OtcPlacedLeg => ({ assetIn: OLD_BOND, assetOut: BOND, amountIn: '1', amountOut: '1', partiallyFillable: true, maker: null, governance: true, ...over })
    const e = (event_name: string, args: Record<string, unknown>) => ({ block_height: 1, ts: '2026-08-26 12:00:00', event_index: 1, extrinsic_index: 2, event_name, args_json: JSON.stringify({ orderId: 1548, ...args }) })
    const fillEv = e('OTC.PartiallyFilled', { who: '0x' + '1'.repeat(64), amountIn: '1', amountOut: '1', fee: '0' })
    const rollover = otcRowFromEvent(fillEv, new Map(), new Map([['1548', leg({})]]))!
    expect(rollover.bondSale).toMatchObject({ venue: 'otc', kind: 'rollover', bondId: BOND })
    expect(bondSaleAction(rollover)).toBe('Rollover')
    const pulled = otcRowFromEvent(e('OTC.Cancelled', {}), new Map(), new Map([['1548', leg({ assetIn: USDT })]]))!
    expect(bondSaleAction(pulled)).toBe('SaleClose')
    const user = otcRowFromEvent(fillEv, new Map(), new Map([['1548', leg({ governance: false })]]))!
    expect(user.bondSale).toBeUndefined()
    expect(bondSaleRefOf(undefined)).toBeNull()
    // Parity: the bond family admits the annotated row and the OTC/Trade families keep
    // it, so `all` (no family filter) sees it once and each filter sees it once.
    const rows: ActivityRow[] = [rollover, user, { ...rollover, type: 'bond', bondSale: undefined, bondAction: 'Redeem' }]
    expect(rows.filter(r => activityTypeMatchesFamily(r, 'bond')).length).toBe(2)
    expect(rows.filter(r => activityTypeMatchesFamily(r, 'otc')).length).toBe(2)
    expect(rows.filter(r => activityTypeMatchesFamily(r, 'trade')).length).toBe(2)
    expect(rows.filter(r => activityTypeMatchesFamily(r, 'bond') && activityRowMatchesAction(r, 'Rollover')).length).toBe(1)
    expect(rows.filter(r => activityTypeMatchesFamily(r, 'bond') && activityRowMatchesAction(r, 'Redeem')).length).toBe(1)
    expect(activityRowMatchesAction(rollover, 'otc-fill')).toBe(true)
  })

  it('counts the bond type with the same sale rows the feed merges in', () => {
    const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
    // Both bond count paths add the primary-sale arm; the account plan reads OTC for `bond`.
    expect([...src.matchAll(/bondSaleDaily\(filters\.action, tokenIds \?\? null\)/g)]).toHaveLength(2)
    expect(src).toContain("otc: type === 'all' || type === 'otc' || type === 'trade' || type === 'bond' || wantTransfers")
  })
})

describe('the bond state', () => {
  const ev = (event_name: string, args: Record<string, unknown>, block_height: number) =>
    ({ block_height, event_index: 1, extrinsic_index: 2, ts: 1_780_000_000 + block_height, event_name, args_json: JSON.stringify(args) })
  const base = {
    block: 100, readAt: 1, bondIds: [BOND], underlyingOf: () => HOLLAR,
    eventRows: [ev('Bonds.Issued', { issuer: '0xIS', bondId: BOND, amount: '1000', fee: '0' }, 1), ev('Bonds.Redeemed', { who: '0xbb', bondId: BOND, amount: '400' }, 2)],
    sales: [sale({ offered: '1000', asked: '980' })],
    makers: new Map([['1546', '0xMAKER']]),
    balanceRows: [{ asset_id: String(BOND), account_id: '0xMAKER', bal: '100' }, { asset_id: String(BOND), account_id: '0xpub', bal: '500' }],
    potRows: [{ asset_id: '222', bal: '200' }, { asset_id: '222', bal: '400' }],
  }

  it('sums the pot over its Tokens side and its ERC-20 pot and checks it against the supply', () => {
    const s = assembleBondSnapshot(base)!
    expect(s.pot.get(HOLLAR)).toBe(600n)
    expect(s.potReconciled.get(HOLLAR)).toBe(true)
    expect(s.holdersReconciled.get(BOND)).toBe(true)
    expect([...bondIssuerAccounts(BOND, '0xis', s.sales)].sort()).toEqual(['0xis', '0xmaker'])
    expect(assembleBondSnapshot({ ...base, potRows: [{ asset_id: '222', bal: '599' }] })!.potReconciled.get(HOLLAR)).toBe(false)
    expect(assembleBondSnapshot({ ...base, potRows: [] })!.potReconciled.get(HOLLAR)).toBeNull()
  })

  it('flags holders that do not sum to the supply, and refuses a sale whose maker did not resolve', () => {
    expect(assembleBondSnapshot({ ...base, balanceRows: [{ asset_id: String(BOND), account_id: '0xpub', bal: '599' }] })!.holdersReconciled.get(BOND)).toBe(false)
    expect(assembleBondSnapshot({ ...base, makers: new Map() })).toBeNull()
  })

  it('decodes issues and redemptions and sums the supply per bond', () => {
    const { issues, redemptions } = bondEvents(base.eventRows)
    expect(bondSupplies(issues, redemptions).get(BOND)).toBe(600n)
  })

  it('weighs a day\'s yield by the bonds received, in exact units, and grids sales and redemptions per day', () => {
    const s = sale({ fills: [fill(PLACED + 3_600_000, 1_000_000_000n, 1_021_186_000_000_000_000_000n), fill(PLACED + 7_200_000, 3_000_000_000n, 3_063_558_000_000_000_000_000n, '0xb')] })
    const days = fillDaysOf([s], new Map([[BOND, terms()]]), decimalsOf)
    expect(days).toHaveLength(1)
    expect(days[0].fills).toBe(2)
    expect(days[0].returnPct).toBeCloseTo(2.0165, 3)
    const grid = bondDays([BOND], { sales: [s], redemptions: [{ bondId: BOND, block: 9, eventIndex: 1, extrinsicIndex: 1, atMs: PLACED + 2 * 86_400_000, who: '0xa', amount: '5' }] }, PLACED + 3 * 86_400_000)
    expect(grid.map(d => d.day)).toEqual(['2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24'])
    expect(grid[2].redeemed[String(BOND)]).toBe('5')
  })

  it('words the lifecycle: selling, active, matured while the public holds some, redeemed', () => {
    expect(bondStatus({ nowMs: 1, maturityMs: 2, openSale: true, publicOutstanding: 5n })).toBe('selling')
    expect(bondStatus({ nowMs: 1, maturityMs: 2, openSale: false, publicOutstanding: 5n })).toBe('active')
    expect(bondStatus({ nowMs: 2, maturityMs: 2, openSale: false, publicOutstanding: 5n })).toBe('matured')
    expect(bondStatus({ nowMs: 3, maturityMs: 2, openSale: false, publicOutstanding: 0n })).toBe('redeemed')
  })
})

describe('boot order', () => {
  it('reads the strategy states, then builds the bond pages, before the api listens', () => {
    const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
    const at = (s: string) => { const i = server.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
    const registry = at('await Promise.all([loadExplorerAssets(client)')
    const states = at("[['juicer', refreshJuicerState], ['bil', refreshBilState]]")
    const bonds = at('await initBondService()')
    const listen = at('await fastify.listen(')
    expect(registry).toBeLessThan(states)
    expect(states).toBeLessThan(bonds)
    expect(bonds).toBeLessThan(listen)
  })
})
