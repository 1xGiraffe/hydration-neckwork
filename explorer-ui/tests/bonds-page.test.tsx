import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Bonds } from '../src/pages/Bonds'
import { BondPositions } from '../src/components/positions/BondPositions'
import { parseRoute, paths } from '../src/router'
import { NAV_CONFIG } from '../src/components/navConfig'
import { activityBadge, CAT } from '../src/components/activityColors'
import type { AccountBonds, ActivityRow, BondDashboard, BondRound, BondSale } from '../src/types'

const HOLLAR = { assetId: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachainId: null }
const USDT = { assetId: 10, symbol: 'USDT', name: 'Tether', decimals: 6, parachainId: null }
const bondAsset = (id: number) => ({ assetId: id, symbol: 'HOLLARb', name: 'Hydrated Dollar Bond', decimals: 18, parachainId: null })
const acct = (id: string) => ({ accountId: id, address: id })
const TREASURY = acct('0x6d6f646c70792f74727372790000000000000000000000000000000000000000')
const E18 = '000000000000000000'

function round(n: number, bondId: number, over: Partial<BondRound> = {}): BondRound {
  return {
    round: n, bondId, asset: bondAsset(bondId), status: 'matured', issuer: TREASURY,
    createdAt: '2026-05-27T19:34:42.000Z', createdBlock: 12_529_271, maturityAt: '2026-08-25T06:25:54.000Z',
    issued: '452563' + E18, issueFee: '0',
    sales: [{
      venue: 'otc', id: '1488', kind: 'sale', paymentAsset: USDT, fromRound: null, issuerAccounts: [TREASURY], openedAt: '2026-05-29T11:00:36.000Z', openedBlock: 12_546_921,
      endedAt: '2026-06-14T10:47:03.000Z', state: 'filled',
      offered: '226281' + E18, sold: '226281' + E18, paid: '222222000000', net: '226055' + E18, remaining: '0', unsold: '0', fills: 16, buyers: 12,
      price: 0.983042, discountPct: 1.6957, fixedYieldPct: 1.725, aprAtOpenPct: 7.17, avgPrice: 0.983042,
      avgFacePrice: 0.983042, avgAprPct: 7.6, facedAtEventTime: false, lbp: null,
    }],
    offered: '452563' + E18, soldForMoney: '452563' + E18, rolledOver: '0', proceeds: [{ asset: USDT, raw: '444444000000' }],
    fixedYieldPct: 1.725, aprAtOpenPct: 7.17, salePrice: 0.983042, saleOpen: false, redeemed: '451847' + E18, redemptions: 20,
    firstRedemptionAt: '2026-08-25T06:27:06.000Z', lastRedemptionAt: '2026-09-10T19:30:36.000Z',
    outstanding: '716' + E18, issuerHeld: '686' + E18, publicOutstanding: '30' + E18, valueFactor: 1, publicUsd: 30, issuerUsd: 684,
    holders: { list: [{ rank: 1, account: null, tag: { tagId: 'treasury', name: 'Treasury', color: '', icon: '🏦', memberCount: 2 }, balance: '686' + E18, lastBlock: 1, valueUsd: 684, share: 0.958 }], total: 3, holderCount: 4, totalUsd: 714 },
    buyers: 33, discountPct: 1.6957, avgAprPct: 8.37,
    buyerStats: {
      buyers: 33, sellers: 0, purchases: 42, medianPurchase: '75' + E18, largestPurchase: '202595' + E18, top10SharePct: 98.856,
      top: [{ account: acct('0x' + 'aa'.repeat(32)), fills: 3, bonds: '202595' + E18, paid: [{ asset: USDT, raw: '199000000000' }], facePrice: 0.983042, returnPct: 1.725, aprPct: 7.6 }],
    },
    ...over,
  }
}
function dashboard(over: Partial<BondDashboard> = {}): BondDashboard {
  return {
    generatedAt: '2026-11-07T18:00:00.000Z', asOfBlock: 16_739_044, family: { key: 'hollar', title: 'HOLLAR Bonds', appUrl: 'https://app.hydration.net/strategies/hollar-bonds' }, underlying: HOLLAR,
    rounds: [round(1, 1_001_351), round(2, 1_001_353, { status: 'active', maturityAt: '2099-11-24T00:00:00.000Z', redeemed: '0', redemptions: 0, firstRedemptionAt: null, lastRedemptionAt: null, valueFactor: 0.9965, fixedYieldPct: 2.0164, aprAtOpenPct: 7.798 })],
    fillDays: [
      { day: '2026-05-29', bondId: 1_001_351, kind: 'sale', fills: 2, bonds: '112' + E18, paid: '110000000', returnPct: 1.7249, aprPct: 7.17 },
      { day: '2026-08-22', bondId: 1_001_353, kind: 'rollover', fills: 1, bonds: '10' + E18, paid: '10' + E18, returnPct: 2.27, aprPct: 9.13 },
    ],
    days: [
      { day: '2026-05-29', sold: { 1001351: '112' + E18 }, redeemed: {} },
      { day: '2026-08-25', sold: {}, redeemed: { 1001351: '400000' + E18 } },
      { day: '2026-08-26', sold: {}, redeemed: {} },
    ],
    totals: { issued: '1369715' + E18, soldForMoney: '843012' + E18, rolledOver: '241813' + E18, redeemed: '451847' + E18, outstanding: '917868' + E18, publicOutstanding: '631660' + E18, publicUsd: 624_831, holders: 65, buyers: 84, fills: 153 },
    pot: { account: acct('0x6d6f646c706c74626f6e64730000000000000000000000000000000000000000'), balance: '917868' + E18, outstanding: '917868' + E18, reconciled: true },
    accounts: [{ role: 'Issuer — issued the bonds against its own underlying', account: TREASURY }],
    ...over,
  }
}
function render(data: BondDashboard, family = 'hollar'): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['bond-dashboard', family], data)
  return renderToStaticMarkup(<QueryClientProvider client={client}><Bonds family={family} /></QueryClientProvider>)
}

describe('the bond family routes', () => {
  it('routes each family\'s page and lists them in the Assets menu after Brazilian Invoice Loans: HOLLAR, then HDX', () => {
    expect(parseRoute('/hollar-bonds')).toEqual({ name: 'bonds', family: 'hollar' })
    expect(parseRoute('/hdx-bonds')).toEqual({ name: 'bonds', family: 'hdx' })
    expect(paths.bonds('hollar')).toBe('/hollar-bonds')
    expect(paths.bonds('hdx')).toBe('/hdx-bonds')
    for (const list of [NAV_CONFIG.ASSETS_GROUP.menuItems!, NAV_CONFIG.ASSETS_GROUP.items, NAV_CONFIG.ASSETS_FOLD_GROUP.menuItems!, NAV_CONFIG.DRAWER_LINKS]) {
      const labels = list.map(i => i.label)
      expect(labels.indexOf('HOLLAR Bonds')).toBe(labels.indexOf('Brazilian Invoice Loans') + 1)
      expect(labels.indexOf('HDX Bonds')).toBe(labels.indexOf('HOLLAR Bonds') + 1)
    }
  })
})

describe('the HOLLAR Bonds page', () => {
  it('has one h1 and the section outline under it', () => {
    const html = render(dashboard())
    expect(html.match(/<h1/g)?.length).toBe(1)
    for (const t of ['Rounds', 'Implied yield', 'Sales per day', 'Redemption timeline', 'Holders', 'Activity', 'Accounts']) expect(html).toContain(t)
    // One page-level round selector, not one per section.
    expect(html.match(/aria-label="Round shown below"/g)?.length).toBe(1)
    expect(html).toMatch(/<h2[^>]*>Rounds/)
  })

  it('states each round newest first, with its status, terms and the outstanding split', () => {
    const html = render(dashboard())
    expect(html.indexOf('Round 2')).toBeLessThan(html.indexOf('Round 1'))
    expect(html).toContain('Matured · redeemable')
    // The fixed yield is the headline, its APR beside it, counted from the sale's opening.
    expect(html).toContain('2.0164%')
    expect(html).toContain('7.80% APR')
    expect(html).toContain('face held outside the Treasury')
    expect(html).toContain('Owed to holders')
    expect(html).toContain('The Treasury’s own')
    expect(html).toContain('rolled')
  })

  it('withholds the public split when the holders do not reconcile, rather than guessing', () => {
    const html = render(dashboard({ rounds: [round(1, 1_001_351, { publicOutstanding: null, issuerHeld: null })] }))
    expect(html).toContain('the split is withheld')
  })

  it('says when the pot does not hold the outstanding supply', () => {
    expect(render(dashboard())).toContain('exactly the')
    expect(render(dashboard({ pot: { ...dashboard().pot, reconciled: false } }))).toContain('do <b>not</b> match')
  })
})

describe('a bond sale through the OTC venue', () => {
  const row = (over: Partial<ActivityRow>): ActivityRow => ({ type: 'otc', blockHeight: 1, timestamp: '2026-08-22 00:00:00', who: null, to: null, asset: null, assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null, ...over } as ActivityRow)
  const sale = (kind: 'sale' | 'rollover') => ({ venue: 'otc' as const, kind, bondId: 1_001_353, family: 'hollar', round: 2, maturityAt: '2026-11-24T00:00:00.000Z' })
  it('reads as the bond act it is, in the bond family\'s teal, and as an OTC act otherwise', () => {
    expect(activityBadge(row({ otcAction: 'Fill', bondSale: sale('sale') }))).toEqual({ label: 'Bond purchase', col: CAT.bond })
    expect(activityBadge(row({ otcAction: 'Fill', bondSale: sale('rollover') })).label).toBe('Bond rollover')
    expect(activityBadge(row({ otcAction: 'Pull', bondSale: sale('sale') }))).toEqual({ label: 'Bond sale closed', col: CAT.bondOffer })
    expect(activityBadge(row({ otcAction: 'Fill' })).label).toBe('OTC order filled')
  })
})

describe('the Strategies tab bonds card', () => {
  it('lists each bond with its maturity, worth and what the sale cost', () => {
    const bonds: AccountBonds = {
      asOfBlock: 16_739_044,
      positions: [{
        family: 'hollar', familyTitle: 'HOLLAR Bonds', round: 2, bondId: 1_001_353, asset: bondAsset(1_001_353), underlying: HOLLAR,
        balance: '1000' + E18, maturityAt: '2026-11-24T00:00:00.000Z', status: 'active', redeemable: false,
        valueUsd: 996, faceUsd: 999.5, valueFactor: 0.9965,
        bought: { bonds: '1000' + E18, paid: [{ asset: USDT, raw: '980000000' }], returnPct: 2.0164, aprPct: 8.1, fills: 1 },
      }],
    }
    const html = renderToStaticMarkup(<BondPositions bonds={bonds} />)
    expect(html).toContain('/hollar-bonds')
    expect(html).toContain('24 Nov 2026')
    expect(html).toContain('0.9965 of face')
    expect(html).toContain('8.10% APR')
    expect(html).toMatch(/face 1(\.00)?k HOLLAR/)
    expect(renderToStaticMarkup(<BondPositions bonds={{ asOfBlock: 1, positions: [] }} />)).toBe('')
  })
})

// The HDX bonds' first round, trimmed: sold for DOT through an LBP pool, every price in
// HDX at the purchase's own time.
const HDX = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null }
const DOT = { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null }
const E12 = '000000000000'
const POOL = { ...acct('0x13bd3914a8887011d44e85e99181193f9024f3f58d352d5ad01a4dc024c4124b'), displayName: 'HDX Bonds LBP · round 1' }
const T0 = Date.parse('2023-10-24T14:23:42Z'), T1 = Date.parse('2023-10-25T14:29:12Z')
function lbpSale(over: Partial<BondSale> = {}): BondSale {
  return {
    venue: 'lbp', id: POOL.accountId, kind: 'sale', paymentAsset: DOT, fromRound: null, issuerAccounts: [POOL], openedAt: '2023-10-24T14:23:42.000Z', openedBlock: 3_681_799,
    endedAt: '2023-10-25T14:29:12.000Z', state: 'closed', offered: '50000000' + E12, sold: '27304108' + E12, paid: '196844533332726', net: '27304108' + E12,
    remaining: '0', unsold: '22695892' + E12, fills: 319, buyers: 65, price: 0.72, discountPct: 28.0022, fixedYieldPct: 38.8931, aprAtOpenPct: 38.79,
    avgPrice: 0.000720933, avgFacePrice: 0.719978, avgAprPct: 40.27, facedAtEventTime: true,
    lbp: {
      pool: POOL, feePct: 0.5, paymentWeightStart: 15, paymentWeightEnd: 60, startAt: '2023-10-24T14:23:42.000Z', endAt: '2023-10-25T14:29:12.000Z',
      seed: { payment: '108570000000000', bonds: '50000000' + E12 }, returned: { at: '2023-11-05T12:25:54.000Z', block: 3_765_600, payment: '304235268058166', bonds: '22695892' + E12 },
      fees: '1179265274560', sellBacks: 1, soldBack: '2532' + E12, reconciled: true,
      curve: [{ t: T0, pay: 0.00123, face: 1.19 }, { t: T0 + 3_600_000, pay: 0.0012, face: 1.16 }, { t: T0 + 3_600_000, pay: 0.00121, face: 1.17 }, { t: T1, pay: 0.0007, face: 0.7 }],
      fills: [{ t: T0 + 3_600_000, side: 'buy', bonds: 8721, pay: 0.0012, face: 1.16 }, { t: T0 + 7_200_000, side: 'sell', bonds: 2532, pay: 0.0009, face: 0.88 }],
    },
    ...over,
  }
}
function hdxRound(over: Partial<BondRound> = {}): BondRound {
  return round(1, 1_000_010, {
    asset: { assetId: 1_000_010, symbol: 'HDXb', name: 'Hydration Bond', decimals: 12, parachainId: null },
    createdAt: '2023-10-24T13:07:42.000Z', maturityAt: '2024-10-24T14:22:22.000Z', issued: '50000000820000000000', issueFee: '1020408180000000000',
    sales: [lbpSale()], offered: '50000000' + E12, soldForMoney: '27304108' + E12, proceeds: [{ asset: DOT, raw: '196844533332726' }],
    fixedYieldPct: 38.8931, aprAtOpenPct: 38.79, salePrice: 0.719978, discountPct: 28.0022, avgAprPct: 40.27,
    redeemed: '49837200' + E12, redemptions: 85, outstanding: '162800' + E12, issuerHeld: '0', publicOutstanding: '162800' + E12,
    buyerStats: { buyers: 65, sellers: 12, purchases: 299, medianPurchase: '59862' + E12, largestPurchase: '908253' + E12, top10SharePct: 86.34,
      top: [{ account: acct('0x' + 'bb'.repeat(32)), fills: 12, bonds: '5133210' + E12, paid: [{ asset: DOT, raw: '35627962734114' }], facePrice: 0.683928, returnPct: 46.2, aprPct: 47.61 }] },
    ...over,
  })
}
function hdxDashboard(over: Partial<BondDashboard> = {}): BondDashboard {
  return dashboard({
    family: { key: 'hdx', title: 'HDX Bonds', appUrl: null }, underlying: HDX, rounds: [hdxRound()],
    fillDays: [{ day: '2023-10-24', bondId: 1_000_010, kind: 'sale', fills: 108, bonds: '4158280' + E12, paid: '27845601233284', returnPct: 57.8, aprPct: 57.69 }],
    days: [{ day: '2023-10-24', sold: { 1000010: '4158280' + E12 }, redeemed: {} }, { day: '2024-10-24', sold: {}, redeemed: { 1000010: '40000000' + E12 } }],
    totals: { issued: '50000000' + E12, soldForMoney: '27304108' + E12, rolledOver: '0', redeemed: '49837200' + E12, outstanding: '162800' + E12, publicOutstanding: '162800' + E12, publicUsd: 1117, holders: 51, buyers: 65, fills: 319 },
    pot: { account: acct('0x6d6f646c706c74626f6e64730000000000000000000000000000000000000000'), balance: '162800' + E12, outstanding: '162800' + E12, reconciled: true },
    ...over,
  })
}

describe('the HDX Bonds page (LBP sales)', () => {
  it('explains the LBP mechanics and states prices in HDX at each purchase\'s time', () => {
    const html = render(hdxDashboard(), 'hdx')
    expect(html.match(/<h1/g)?.length).toBe(1)
    expect(html).toContain('liquidity bootstrapping pool')
    expect(html).toContain('15% → 60% DOT')
    expect(html).toContain('at the moment of each purchase')
    expect(html).not.toContain('OTC fee of 0.1%')
    // No Open-in-app link: the app no longer lists these.
    expect(html).not.toContain('Open in the Hydration app')
  })

  it('states each round by its discount, average price, APR as bought and what went unsold', () => {
    const html = render(hdxDashboard(), 'hdx')
    expect(html).toContain('28.00%')
    expect(html).toContain('0.7200 HDX paid per bond on average')
    expect(html).toContain('40.27% APR as bought')
    expect(html).toContain('Unsold')
    expect(html).toContain('5 Nov 2023')
    expect(html).toContain('2% issue fee')
    expect(html).toContain('for DOT in LBP sales')
    expect(html).toContain('LBP sale for')
    expect(html).toContain('weight 15% → 60%')
  })

  it('draws each LBP sale as a price curve with its fills, and no fixed-price yield chart', () => {
    const html = render(hdxDashboard(), 'hdx')
    expect(html).toContain('LBP sales')
    expect(html).toMatch(/<path d="M[^"]+"/)
    expect(html.match(/<circle /g)?.length).toBe(2)
    expect(html).toContain('face · 1 HDX')
    expect(html).not.toContain('Implied yield')
    // A curve whose replay does not reconcile is withheld, never drawn.
    const off = render(hdxDashboard({ rounds: [hdxRound({ sales: [lbpSale({ lbp: { ...lbpSale().lbp!, reconciled: false } })] })] }), 'hdx')
    expect(off).toContain('price curve is withheld')
    expect(off).not.toMatch(/<path d="M/)
  })

  it('lists the buyers and offers a sells-back filter, and no rollover one', () => {
    const html = render(hdxDashboard(), 'hdx')
    expect(html).toContain('Buyers')
    expect(html).toContain('86.3%')
    expect(html).toContain('47.61%')
    expect(html).toContain('Sells back')
    expect(html).not.toContain('Rollovers')
    expect(html).toContain('Bonds kept')
    // An OTC family has no sell-back and states bonds bought.
    const otc = render(dashboard())
    expect(otc).not.toContain('Sells back')
    expect(otc).not.toContain('Bonds kept')
    expect(otc).not.toContain('sold some back')
    expect(otc).toContain('Bonds bought')
  })

  it('leaves out the per-day sales chart an LBP sale of a day or two would make', () => {
    expect(render(hdxDashboard(), 'hdx')).not.toContain('Sales per day')
  })
})
