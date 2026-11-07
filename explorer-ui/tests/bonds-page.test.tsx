import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Bonds } from '../src/pages/Bonds'
import { BondPositions } from '../src/components/positions/BondPositions'
import { parseRoute, paths } from '../src/router'
import { NAV_CONFIG } from '../src/components/navConfig'
import { activityBadge, CAT } from '../src/components/activityColors'
import type { AccountBonds, ActivityRow, BondDashboard, BondRound } from '../src/types'

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
    }],
    offered: '452563' + E18, soldForMoney: '452563' + E18, rolledOver: '0', proceeds: [{ asset: USDT, raw: '444444000000' }],
    fixedYieldPct: 1.725, aprAtOpenPct: 7.17, salePrice: 0.983042, saleOpen: false, redeemed: '451847' + E18, redemptions: 20,
    firstRedemptionAt: '2026-08-25T06:27:06.000Z', lastRedemptionAt: '2026-09-10T19:30:36.000Z',
    outstanding: '716' + E18, issuerHeld: '686' + E18, publicOutstanding: '30' + E18, valueFactor: 1, publicUsd: 30, issuerUsd: 684,
    holders: { list: [{ rank: 1, account: null, tag: { tagId: 'treasury', name: 'Treasury', color: '', icon: '🏦', memberCount: 2 }, balance: '686' + E18, lastBlock: 1, valueUsd: 684, share: 0.958 }], total: 3, holderCount: 4, totalUsd: 714 },
    buyers: 33,
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
function render(data: BondDashboard): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['bond-dashboard', 'hollar'], data)
  return renderToStaticMarkup(<QueryClientProvider client={client}><Bonds family="hollar" /></QueryClientProvider>)
}

describe('the /hollar-bonds route', () => {
  it('routes the page and sits in the Assets menu directly after Brazilian Invoice Loans', () => {
    expect(parseRoute('/hollar-bonds')).toEqual({ name: 'bonds', family: 'hollar' })
    expect(paths.bonds('hollar')).toBe('/hollar-bonds')
    for (const list of [NAV_CONFIG.ASSETS_GROUP.menuItems!, NAV_CONFIG.ASSETS_GROUP.items, NAV_CONFIG.ASSETS_FOLD_GROUP.menuItems!, NAV_CONFIG.DRAWER_LINKS]) {
      const labels = list.map(i => i.label)
      expect(labels.indexOf('HOLLAR Bonds')).toBe(labels.indexOf('Brazilian Invoice Loans') + 1)
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
