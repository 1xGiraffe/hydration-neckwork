import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BOND_FAMILIES, BOND_WAD, BONDS_POT_ACCOUNT, LBP_MAX_WEIGHT, fillPaidFace, isMoneySale, lbpPaymentWeight, lbpReplay, lbpSpotWad, saleAnchor, saleProgress,
  type BondSale, type BondSaleFill,
} from '../src/services/bonds.ts'
import { lbpBondSale, lbpFeeOf, lbpFillRowEvents, lbpPoolsOf } from '../src/services/bondSales.ts'
import { buyerStatsOf, fillDaysOf } from '../src/services/bondService.ts'
import {
  activityRowMatchesAction, activityRowMatchesFilters, activityTypeMatchesFamily, bondSaleAction, bondSaleRowInScope, lbpBondFillCounts, type ActivityRow,
} from '../src/services/explorerService.ts'
import { applyBondRegistry, loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'
import { hdxPotAttribution, hdxStructureAttribution, hdxStructureSql } from '../src/services/hdxService.ts'
import { bondSaleActPage } from '../src/routes/seo.ts'

// The HDX bonds' first round as it is on chain: bond 1000010 over HDX (0, 12 decimals),
// sold for DOT (5, 10 decimals) through the LBP pool 0x13bd…124b — created by
// governance at block 3,681,428 with 10,857 DOT and 50,000,000 bonds, DOT weight 15% →
// 60% over relay blocks 17,863,200 → 17,877,600, a 1/200 fee in DOT.
const HDX = 0, DOT = 5, BOND = 1_000_010
const POOL = '0x13bd3914a8887011d44e85e99181193f9024f3f58d352d5ad01a4dc024c4124b'
const TREASURY = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const ALICE = '0x' + 'aa'.repeat(32), BOB = '0x' + 'bb'.repeat(32)
const MATURITY = 1_729_779_742_000
const decimalsOf = (id: number) => (id === DOT ? 10 : 12)
const ev = (block: number, idx: number, name: string, args: unknown, ts = 1_698_156_000, x: number | null = null) =>
  ({ block_height: block, event_index: idx, extrinsic_index: x, ts, event_name: name, args_json: JSON.stringify(args) })
const poolData = { owner: TREASURY, assets: [DOT, BOND], initialWeight: 15_000_000, finalWeight: 60_000_000, weightCurve: { __kind: 'Linear' }, fee: '0x01c8', feeCollector: TREASURY, repayTarget: '0' }
const rows = [
  ev(3_681_428, 15, 'LBP.PoolCreated', { pool: POOL, data: poolData }),
  ev(3_681_428, 23, 'LBP.LiquidityAdded', { who: POOL, assetA: DOT, assetB: BOND, amountA: '108570000000000', amountB: '50000000000000000000' }),
  ev(3_681_429, 0, 'LBP.PoolUpdated', { pool: POOL, data: { ...poolData, start: 17_863_200, end: 17_877_600 } }),
  // A buy (DOT in): 19.9 DOT into the pool, 0.1 DOT fee to the collector, 22,881.26 bonds out.
  ev(3_682_568, 31, 'LBP.SellExecuted', { who: ALICE, assetIn: DOT, assetOut: BOND, amount: '199000000000', salePrice: '22881259825952534', feeAsset: DOT, feeAmount: '1000000000' }, 1_698_166_944, 2),
  // A buy by amount out (BuyExecuted: `amount` is what went in, `buyPrice` what came out).
  ev(3_684_309, 13, 'LBP.BuyExecuted', { who: BOB, assetOut: BOND, assetIn: DOT, amount: '2696150731', buyPrice: '425000000000000', feeAsset: DOT, feeAmount: '13548496' }, 1_698_188_478, 2),
  // A sell back (bonds in): the pool pays out 2.38 DOT and its fee.
  ev(3_685_885, 13, 'LBP.SellExecuted', { who: ALICE, assetIn: BOND, assetOut: DOT, amount: '2000000000000', salePrice: '23766960', feeAsset: DOT, feeAmount: '119431' }, 1_698_207_390, 2),
  // Another pool's trade: not this sale's.
  ev(3_685_886, 1, 'LBP.SellExecuted', { who: BOB, assetIn: 7, assetOut: 8, amount: '1', salePrice: '1', feeAsset: 7, feeAmount: '0' }),
]

describe('the HDX bond family', () => {
  it('is a bond family of its own, after HOLLAR, over HDX', () => {
    expect(BOND_FAMILIES.map(f => f.key)).toEqual(['hollar', 'hdx'])
    expect(BOND_FAMILIES.find(f => f.key === 'hdx')?.underlyingId).toBe(HDX)
  })
})

describe('the LBP sale source', () => {
  it('decodes the pallet fee as the indexer writes it: bytes in hex, or a pair', () => {
    expect(lbpFeeOf('0x01c8')).toEqual([1, 200])
    expect(lbpFeeOf('0x0132')).toEqual([1, 50])
    expect(lbpFeeOf([2, 1000])).toEqual([2, 1000])
    expect(lbpFeeOf('0x01')).toBeNull()
  })

  it('normalizes a pool\'s trades both ways, with the event-time face value of each payment', () => {
    const [p] = lbpPoolsOf(rows)
    expect(p.pool).toBe(POOL)
    expect(p.trades).toHaveLength(3)
    // 1 DOT = 1,000 HDX at every fill (a face rate of 1,000 whole bonds per whole DOT).
    const faceRate = () => 1_000n * 10n ** 12n
    const s = lbpBondSale(p, { isBond: id => id === BOND, underlyingOf: () => HDX }, {
      relayOf: b => 17_863_200 + (b - 3_681_850), window: r => ({ block: 3_681_000 + r - 17_862_000, ms: (r - 17_000_000) * 6_000 }), faceRate, paymentDecimals: decimalsOf,
    })!
    expect(s).toMatchObject({ venue: 'lbp', id: POOL, bondId: BOND, kind: 'sale', paymentAssetId: DOT, issuerAccounts: [POOL], offered: '50000000000000000000', asked: null, facedAtEventTime: true })
    expect(s.lbp).toMatchObject({ fee: [1, 200], initialWeight: 15_000_000, finalWeight: 60_000_000, startRelay: 17_863_200, endRelay: 17_877_600, seed: { payment: '108570000000000', bonds: '50000000000000000000' } })
    const [a, b, c] = s.fills
    // A buy paid what went into the pool plus the fee; a sell received what came out.
    expect(a).toMatchObject({ side: 'buy', taker: ALICE, paid: '200000000000', paymentFee: '1000000000', bonds: '22881259825952534', fee: '0', paidFace: '20000000000000000' })
    expect(b).toMatchObject({ side: 'buy', taker: BOB, paid: '2709699227', bonds: '425000000000000' })
    expect(c).toMatchObject({ side: 'sell', taker: ALICE, paid: '23766960', bonds: '2000000000000', paymentFee: '119431' })
    expect(isMoneySale(s, HDX)).toBe(true)
    // The sale closes at its end relay block, not when the owner empties the pool.
    expect(s.closedMs).toBe((17_877_600 - 17_000_000) * 6_000)
  })

  it('leaves a pool that sells no bond alone', () => {
    const [p] = lbpPoolsOf(rows)
    expect(lbpBondSale(p, { isBond: () => false, underlyingOf: () => HDX }, { relayOf: () => null, window: () => null, faceRate: () => null, paymentDecimals: decimalsOf })).toBeNull()
  })
})

const fill = (over: Partial<BondSaleFill>): BondSaleFill => ({ block: 1, eventIndex: 1, extrinsicIndex: 2, atMs: 1_698_200_000_000, taker: ALICE, paid: '0', bonds: '0', fee: '0', partial: false, ...over })
const lbpSale = (fills: BondSaleFill[], over: Partial<BondSale> = {}): BondSale => ({
  venue: 'lbp', id: POOL, bondId: BOND, kind: 'sale', paymentAssetId: DOT, issuerAccounts: [POOL], offered: '1000000000000000', asked: null,
  openedBlock: 1, openedMs: 1_698_156_000_000, closedBlock: 2, closedMs: 1_698_242_000_000, fills, facedAtEventTime: true, ...over,
})

describe('an LBP sale\'s progress, price and APR', () => {
  // 1,000 bonds offered; Alice buys 600 for 4 DOT (worth 400 HDX then), sells 100 back
  // for 0.6 DOT (60 HDX); Bob buys 200 for 1.5 DOT (150 HDX).
  const fills = [
    fill({ paid: '40000000000', bonds: '600000000000000', paidFace: '400000000000000' }),
    fill({ side: 'sell', paid: '6000000000', bonds: '100000000000000', paidFace: '60000000000000', atMs: 1_698_210_000_000 }),
    fill({ taker: BOB, paid: '15000000000', bonds: '200000000000000', paidFace: '150000000000000', atMs: 1_698_220_000_000 }),
  ]
  it('nets the sells back out of what was sold and paid', () => {
    const p = saleProgress(lbpSale(fills), MATURITY, MATURITY - 1)
    expect(p).toMatchObject({ sold: 700_000_000_000_000n, net: 700_000_000_000_000n, paid: 49_000_000_000n, state: 'closed', unsold: 300_000_000_000_000n })
  })

  it('anchors on the volume-weighted face price, and states none when a fill is unpriced', () => {
    const a = saleAnchor([lbpSale(fills)], { underlyingId: HDX, maturityMs: MATURITY }, decimalsOf, MATURITY - 1)!
    // (400 − 60 + 150) HDX for 700 bonds.
    expect(a.priceWad).toBe(490n * BOND_WAD / 700n)
    expect(a.closedMs).toBe(1_698_242_000_000)
    expect(saleAnchor([lbpSale([...fills, fill({ paid: '1', bonds: '1', paidFace: null })])], { underlyingId: HDX, maturityMs: MATURITY }, decimalsOf, MATURITY - 1)).toBeNull()
    // Still selling: the price so far, still standing.
    expect(saleAnchor([lbpSale(fills, { closedMs: null, closedBlock: null })], { underlyingId: HDX, maturityMs: MATURITY }, decimalsOf, 1_698_230_000_000)?.closedMs).toBeNull()
  })

  it('states a payment in face units only through its event-time value', () => {
    expect(fillPaidFace(lbpSale(fills), fills[0], HDX, decimalsOf)).toBe(400_000_000_000_000n)
    expect(fillPaidFace(lbpSale(fills), fill({ paid: '5', paidFace: undefined }), HDX, decimalsOf)).toBeNull()
  })

  it('weighs the day\'s APR over purchases only, in HDX at each purchase\'s time', () => {
    const terms = new Map([[BOND, { bondId: BOND, underlyingId: HDX, issuer: TREASURY, maturityMs: MATURITY, createdBlock: 1, createdMs: 0, issued: '0', anchor: null }]])
    const [day] = fillDaysOf([lbpSale(fills)], terms, decimalsOf)
    expect(day.fills).toBe(3)
    expect(day.bonds).toBe('700000000000000')
    // Alice's 600 at 0.6667 (+50%) and Bob's 200 at 0.75 (+33.33%), bonds-weighted.
    expect(day.returnPct).toBeCloseTo((50 * 600 + 33.3333 * 200) / 800, 3)
  })

  it('ranks the buyers by bonds kept, and counts who sold back', () => {
    const st = buyerStatsOf([lbpSale(fills)], decimalsOf)
    expect(st).toMatchObject({ buyers: 2, sellers: 1, purchases: 2, largestPurchase: '600000000000000', medianPurchase: '200000000000000' })
    expect(st.top.map(b => [b.account, b.bonds])).toEqual([[ALICE, '500000000000000'], [BOB, '200000000000000']])
    expect(st.top10SharePct).toBe(100)
  })
})

describe('the LBP pool arithmetic', () => {
  it('moves the payment weight linearly over the relay-block window, clamped', () => {
    const t = { initialWeight: 15_000_000, finalWeight: 60_000_000, startRelay: 100, endRelay: 200 }
    expect(lbpPaymentWeight(t, 50)).toBe(15_000_000)
    expect(lbpPaymentWeight(t, 150)).toBe(37_500_000)
    expect(lbpPaymentWeight(t, 250)).toBe(60_000_000)
  })

  it('prices a bond at the weighted reserve ratio', () => {
    // 10,857 DOT at 15% against 50M bonds at 85%: 0.00123 DOT per bond.
    const spot = lbpSpotWad(108_570_000_000_000n, 50_000_000_000_000_000_000n, 15_000_000, 10, 12)!
    expect(Number(spot) / 1e18).toBeCloseTo(10_857 / 0.15 / (50_000_000 / 0.85), 9)
    expect(lbpSpotWad(0n, 1n, LBP_MAX_WEIGHT / 2, 10, 12)).toBeNull()
  })

  it('replays the reserves through every fill and lands on what the owner took back', () => {
    const fills = [
      fill({ paid: '200000000000', paymentFee: '1000000000', bonds: '22881259825952534' }),
      fill({ side: 'sell', paid: '23766960', paymentFee: '119431', bonds: '2000000000000' }),
    ]
    const payment = 108_570_000_000_000n + 199_000_000_000n - 23_766_960n - 119_431n
    const bonds = 50_000_000_000_000_000_000n - 22_881_259_825_952_534n + 2_000_000_000_000n
    const terms = { pool: POOL, owner: TREASURY, feeCollector: TREASURY, fee: [1, 200] as [number, number], initialWeight: 15_000_000, finalWeight: 60_000_000, startRelay: 100, endRelay: 200, startMs: 1, endMs: 3, seed: { block: 1, payment: '108570000000000', bonds: '50000000000000000000' }, fillRelay: [120, 160], faceRate: { start: null, end: null, fills: [null, null] } }
    const ok = lbpReplay(lbpSale(fills, { lbp: { ...terms, returned: { block: 9, atMs: 9, payment: payment.toString(), bonds: bonds.toString() } } }), decimalsOf)!
    expect(ok.reconciled).toBe(true)
    // The start, a before/after pair per fill, the end.
    expect(ok.points.map(p => p.fill)).toEqual([null, 0, 1, null])
    // A buy moves the spot up; a sell back moves it down.
    expect(ok.points[1].afterWad! > ok.points[1].beforeWad!).toBe(true)
    expect(ok.points[2].afterWad! < ok.points[2].beforeWad!).toBe(true)
    const off = lbpReplay(lbpSale(fills, { lbp: { ...terms, returned: { block: 9, atMs: 9, payment: (payment + 1n).toString(), bonds: bonds.toString() } } }), decimalsOf)!
    expect(off.reconciled).toBe(false)
  })
})

describe('an LBP purchase in the activity families', () => {
  const row = (side: 'buy' | 'sell'): ActivityRow => ({
    type: 'trade', blockHeight: 1, timestamp: '2023-10-24 14:34:06', eventIndex: 3, extrinsicIndex: 2, who: null, to: null, asset: null,
    assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null,
    bondSale: { venue: 'lbp', kind: 'sale', side, bondId: BOND, family: 'hdx', round: 1, maturityAt: null },
  })
  it('is a trade and a bond row, a purchase or a sell back', () => {
    expect(activityTypeMatchesFamily(row('buy'), 'trade')).toBe(true)
    expect(activityTypeMatchesFamily(row('buy'), 'bond')).toBe(true)
    expect(bondSaleAction(row('buy'))).toBe('Purchase')
    expect(bondSaleAction(row('sell'))).toBe('SellBack')
    expect(activityRowMatchesAction(row('buy'), 'Purchase')).toBe(true)
    expect(activityRowMatchesAction(row('sell'), 'SellBack')).toBe(true)
    expect(activityRowMatchesAction(row('buy'), 'swap')).toBe(true)
    expect(activityRowMatchesAction(row('sell'), 'Purchase')).toBe(false)
  })
})

describe('an LBP fill as the trade row it is', () => {
  const ev = (event_index: number, event_name: string, extrinsic_index: number | null, who = '') => ({ block_height: 7, event_index, extrinsic_index, event_name, who })
  it('names two routed fills batched in one extrinsic each by the net summary that closes its own route', () => {
    const events = [ev(3, 'LBP.SellExecuted', 2), ev(4, 'Router.Executed', 2), ev(8, 'Omnipool.SellExecuted', 2), ev(9, 'LBP.SellExecuted', 2), ev(10, 'Router.Executed', 2)]
    expect(lbpFillRowEvents({ block: 7, eventIndex: 3, extrinsicIndex: 2 }, ALICE, events)).toEqual([4])
    expect(lbpFillRowEvents({ block: 7, eventIndex: 9, extrinsicIndex: 2 }, ALICE, events)).toEqual([10])
  })
  it('names a direct fill by its own event, an unrouted tail by its newest swap', () => {
    expect(lbpFillRowEvents({ block: 7, eventIndex: 13, extrinsicIndex: 2 }, ALICE, [ev(13, 'LBP.SellExecuted', 2)])).toEqual([13])
    const tail = [ev(4, 'Router.Executed', 2), ev(6, 'LBP.SellExecuted', 2), ev(8, 'XYK.SellExecuted', 2)]
    expect(lbpFillRowEvents({ block: 7, eventIndex: 6, extrinsicIndex: 2 }, ALICE, tail)).toEqual([8])
  })
  it('names an unsigned (DCA) routed fill by its net summary and the TradeExecuted after it', () => {
    const router = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'
    const events = [ev(20, 'LBP.SellExecuted', null, router), ev(21, 'Router.Executed', null), ev(22, 'DCA.TradeExecuted', null)]
    expect(lbpFillRowEvents({ block: 7, eventIndex: 20, extrinsicIndex: null }, router, events)).toEqual([21, 22])
  })
})

describe('an LBP prices a buy on its gross amount', () => {
  // Round 1's first fill (block 3,681,850, relay 17,863,305): 104,144,616,278 into the
  // pool and a 523,339,780 fee, against the seed of 10,857 DOT and 50M bonds. pallet-lbp
  // computes the bonds out from the GROSS amount, and they are 8,721,207,687,887,822.
  const out = (amountIn: number) => {
    const w = lbpPaymentWeight({ initialWeight: 15_000_000, finalWeight: 60_000_000, startRelay: 17_863_200, endRelay: 17_877_600 }, 17_863_305)
    const rIn = 108_570_000_000_000, rOut = 50_000_000_000_000_000_000
    return rOut * -Math.expm1(w / (LBP_MAX_WEIGHT - w) * -Math.log1p(amountIn / rIn))
  }
  it('lands on the chain\'s bonds out from the gross, and not from the net', () => {
    const chain = 8_721_207_687_887_822
    expect(Math.abs(out(104_144_616_278 + 523_339_780) - chain) / chain).toBeLessThan(1e-12)
    expect(Math.abs(out(104_144_616_278) - chain) / chain).toBeGreaterThan(1e-3)
  })
})

describe('the HDX supply\'s Bonds pot', () => {
  it('attributes the pot to the bonds only while the bond state reconciles it, and keeps it whole otherwise', () => {
    expect(hdxPotAttribution(true, ['1000010', '1000013']).bonds).toEqual(['1000010', '1000013'])
    expect(hdxPotAttribution(false, ['1000010']).bonds).toEqual([])
    expect(hdxPotAttribution(null, ['1000010']).bonds).toEqual([])
    expect(hdxPotAttribution(true, []).bonds).toEqual([])
  })
  it('moves the pot onto the bonds in the history only when a bond is known', () => {
    expect(hdxStructureAttribution(['1000010'])).toEqual({ pot: BONDS_POT_ACCOUNT, bonds: ['1000010'] })
    expect(hdxStructureAttribution([])).toEqual({ pot: '', bonds: [] })
  })
  it('reads each (account, asset) balance and sums an account\'s HDX and bonds, its ages on HDX alone', () => {
    for (const sql of [hdxStructureSql('weekly'), hdxStructureSql('hourly')]) {
      // both weekly reads (the generation's and raw's), and the hourly one
      expect(sql.match(/\(\(asset_id = '0' AND account_id != \{pot:String\}\) OR asset_id IN \{bonds:Array\(String\)\}\)/g)?.length).toBe(sql.includes('account_balance_hourly') ? 3 : 2)
      expect(sql).toContain('GROUP BY account_id, asset_id')
      expect(sql).toMatch(/sumIf\(hbal, cls = 'user' AND i > 0 AND dateDiff\('day', anchor, ref\) < 91\)/)
      expect(sql).toContain("countIf(asset_id = '0' AND toUInt256OrZero(wbal) > 0) AS nzn")
    }
  })
})

describe('the bond feed\'s scope and count', () => {
  const trade = (assetIn: number, assetOut: number): ActivityRow => ({
    type: 'trade', blockHeight: 1, timestamp: '2024-01-05 10:00:00', eventIndex: 3, extrinsicIndex: 2, who: null, to: null, asset: null,
    assetIn: { assetId: assetIn, symbol: 'x', decimals: 12 } as ActivityRow['assetIn'], assetOut: { assetId: assetOut, symbol: 'y', decimals: 12 } as ActivityRow['assetOut'],
    amount: null, amountIn: '1', amountOut: '1', valueUsd: null,
    bondSale: { venue: 'lbp', kind: 'sale', side: 'buy', bondId: 1_000_013, family: 'hdx', round: 2, maturityAt: null },
  })
  // The token filter resolves through the registry: HDX, DOT and both rounds' bonds.
  beforeAll(async () => {
    const row = (asset_id: number, symbol: string, decimals: number) => ({ asset_id, symbol, name: symbol, decimals, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null })
    await loadExplorerAssets({ query: vi.fn(async () => ({ json: async () => [row(0, 'HDX', 12), row(5, 'DOT', 10), row(1_000_010, 'HDXb', 12), row(1_000_013, 'HDXb', 12)] })) } as never)
  })
  afterAll(() => stopExplorerAssetsRefresh())
  it('scopes a sale row by the assets it references, as type=all does, not by the bond it sells', () => {
    // Round 2 bought with round-1 bonds is on round 1's page under either type.
    const r = trade(1_000_010, 1_000_013)
    expect(bondSaleRowInScope(r, {}, 1_000_010)).toBe(true)
    expect(bondSaleRowInScope(trade(5, 1_000_013), {}, 1_000_010)).toBe(false)
    for (const row of [r, trade(5, 1_000_013), trade(0, 1_000_013)]) {
      for (const token of ['1000010', '1000013', '5', '0']) {
        const all = activityTypeMatchesFamily(row, 'bond') && activityRowMatchesFilters(row, { token })
        expect(bondSaleRowInScope(row, { token }), `${row.assetIn?.assetId}→${row.assetOut?.assetId} ${token}`).toBe(all)
      }
    }
  })
  it('counts an account\'s LBP fills by window and action, and states no exact count under a token filter', () => {
    const fills = [fill({ block: 10, atMs: Date.parse('2024-01-05T10:00:00Z') }), fill({ block: 11, side: 'sell', atMs: Date.parse('2024-01-05T11:00:00Z') }), fill({ block: 12, taker: BOB, atMs: Date.parse('2024-01-05T12:00:00Z') })]
    const s = [lbpSale(fills)]
    expect([...lbpBondFillCounts(s, [ALICE], undefined, undefined, undefined, null)!]).toEqual([[10, 1], [11, 1]])
    expect([...lbpBondFillCounts(s, [ALICE], undefined, undefined, 'SellBack', null)!]).toEqual([[11, 1]])
    expect([...lbpBondFillCounts(s, [ALICE], '2024-01-06', undefined, undefined, null)!]).toEqual([])
    expect(lbpBondFillCounts(s, [ALICE], undefined, undefined, undefined, [5])).toBeNull()
    expect([...lbpBondFillCounts(s, [ALICE], '2024-01-06', undefined, undefined, [5])!]).toEqual([])
  })
})

describe('the server-rendered title of a bond sale\'s trade', () => {
  it('names an LBP purchase by its trade row\'s event and by its extrinsic', () => {
    const s = lbpSale([fill({ block: 4_198_163, eventIndex: 14, extrinsicIndex: 2, rowEvents: [15] }), fill({ block: 4_198_200, eventIndex: 5, extrinsicIndex: 1, side: 'sell', rowEvents: [5] })])
    applyBondRegistry([{ bondId: BOND, underlyingId: HDX, issuer: TREASURY, maturityMs: MATURITY, createdBlock: 1, createdMs: 0 }], new Map([[BOND, '1']]), [s], MATURITY - 1)
    expect(bondSaleActPage('swap', '4198163-e15')?.label).toBe('Bond purchase')
    expect(bondSaleActPage('swap', '4198163-2')?.label).toBe('Bond purchase')
    expect(bondSaleActPage('swap', '4198200-e5')?.label).toBe('Bond sold back')
    expect(bondSaleActPage('swap', '4198163-e14')).toBeNull()
    expect(bondSaleActPage('swap', '4198164-2')).toBeNull()
  })
})
