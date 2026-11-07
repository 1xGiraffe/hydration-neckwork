import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Bil } from '../src/pages/Bil'
import { BilPositions } from '../src/components/positions/BilPositions'
import { parseRoute, paths } from '../src/router'
import { NAV_CONFIG } from '../src/components/navConfig'
import { activityBadge, CAT } from '../src/components/activityColors'
import { activityLabel, activitySlug, SLUG_TYPES } from '../src/components/ActivityTable'
import type { AccountBil, ActivityRow, BilDashboard } from '../src/types'

const BIL = { assetId: 55, symbol: 'BIL', name: null, decimals: 18, parachainId: null }
const UBIL = { assetId: 550, symbol: 'uBIL', name: null, decimals: 18, parachainId: null }
const HOLLAR = { assetId: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachainId: null }
const acct = (h: string) => ({ accountId: '0x45544800' + h.slice(2) + '0'.repeat(16), address: h })
const VAULT = acct('0x6a21891db0940491603f3cca0a9f4dba4c6e810c')
const HOLDER = acct('0x00802d33ea8dc404acec0b89be4162fc5c6ded66')
const POOL = { accountId: '0x15304c8f6921694c608312a7a16948454a578df0915b0cfce6d71b1cf70c5613', address: '1Rd2…pool' }
const E18 = '000000000000000000'

function dashboard(over: Partial<BilDashboard> = {}): BilDashboard {
  return {
    generatedAt: '2026-11-07T16:31:31.534Z', asOfBlock: 16_735_681, launchBlock: 13_410_997, vault: VAULT,
    bilAsset: BIL, ubilAsset: UBIL, hollarAsset: HOLLAR, status: 'full',
    exchangeRate: '1048640271947916988', navUsd: 1.0458, tvl: '3317394' + E18, tvlUsd: 3_308_410, cap: '3285800' + E18, remaining: '0', remainingBinding: 'vault',
    sharesOutstanding: '3163555' + E18, bilSupply: '3161504' + E18, idleHollar: '0', investedPrincipal: '3272179' + E18, pendingInterest: '41' + E18, reservedHollar: '2114' + E18, minRedeem: '1' + E18,
    apyPct: 18, termDays: 60, withdrawalDelaySec: 3600,
    realized: { sinceLaunchPct: 18.05, launchDays: 98.4, d30Pct: 17.57, d30Days: 30, d7Pct: 17.71, d7Days: 10.1 },
    rateHistory: [{ day: '2026-08-01', rate: 1, source: 'deposit' }, { day: '2026-11-07', rate: 1.04864, source: 'live' }],
    ladder: { positions: 282, principal: '3272179' + E18, payout: '3368999' + E18, next: { at: '2026-11-08T02:10:18.000Z', payout: '1898' + E18 },
      buckets: [{ day: '2026-11-08', positions: 4, principal: '1844' + E18, payout: '1898' + E18, cumulative: '1898' + E18 }, { day: '2026-11-09', positions: 2, principal: '7026' + E18, payout: '7234' + E18, cumulative: '9132' + E18 }] },
    queue: {
      requests: [
        { requestId: 25, owner: HOLDER, controller: HOLDER, shares: '50' + E18, status: 'claimable', requestedAt: '2026-11-03T13:51:06Z', settledShares: '50' + E18, hollarOwed: '53' + E18, cancelledShares: '0', pendingShares: '0', claimableHollar: '53' + E18, worthHollar: '53' + E18, worthUsd: 53, wait: null, paidFromIdle: false, lastSettledAt: '2026-11-04T11:27:30Z' },
        // Queued behind a maturity that has already passed: awaiting processing, never a past time.
        { requestId: 27, owner: HOLDER, controller: HOLDER, shares: '10' + E18, status: 'queued', requestedAt: '2026-11-06T13:51:06Z', settledShares: '0', hollarOwed: '0', cancelledShares: '0', pendingShares: '10' + E18, claimableHollar: '0', worthHollar: '10' + E18, worthUsd: 10, wait: { maturesAt: '2020-01-01T00:00:00.000Z', from: '2020-01-01T18:00:00.000Z', to: '2020-01-03T06:00:00.000Z', matured: true }, paidFromIdle: false, lastSettledAt: null },
        { requestId: 28, owner: HOLDER, controller: HOLDER, shares: '10' + E18, status: 'queued', requestedAt: '2026-11-06T13:51:06Z', settledShares: '0', hollarOwed: '0', cancelledShares: '0', pendingShares: '10' + E18, claimableHollar: '0', worthHollar: '10' + E18, worthUsd: 10, wait: { maturesAt: '2099-01-01T00:00:00.000Z', from: '2099-01-01T18:00:00.000Z', to: '2099-01-03T06:00:00.000Z', matured: false }, paidFromIdle: false, lastSettledAt: null },
      ],
      pendingShares: '20' + E18, claimableHollar: '2114' + E18, quoteHollar: '1000' + E18, quoteWait: { maturesAt: '2099-01-01T00:00:00.000Z', from: '2099-01-01T18:00:00.000Z', to: '2099-01-03T06:00:00.000Z', matured: false }, quoteFromIdle: false, quoteCovered: true, maxWaitSec: 5_377_236,
      processing: { samples: 184, medianHours: 17.9, p90Hours: 53.7, maxHours: 99.9 },
    },
    borrowing: { borrowedHollar: '751070' + E18, bucketUsed: '743671' + E18, bucketCap: '950000' + E18, utilization: 0.790599, maxLtvPct: 50, liquidationThresholdPct: 85, borrowApyPct: 10.0, maxLeverage: 2, maxNetApyPct: 26.0 },
    rollover: { drawnHollar: '3338531' + E18, repaidHollar: '241776' + E18, paidToVaultHollar: '2278039' + E18, investedByVaultHollar: '5484737' + E18 },
    holders: 76, depositors: 86,
    positions: [{ account: HOLDER, totalHollar: '2730' + E18, totalUsd: 2_723, bil: '2603' + E18, ubil: '0', queuedShares: '0', claimableHollar: '0', share: 0.000823 }],
    pool: { poolId: 10055, account: POOL, bilReserve: '295062' + E18, hollarReserve: '304291' + E18, feePct: 0.1, amplification: 50, mid: 1.0478, peg: 1.0481, premiumVsNavPct: -0.08, sellQuote: { bil: '1000' + E18, hollar: '1046' + E18, price: 1.046, vsNavPct: -0.25 }, history: [] },
    totals: { deposits: 379, depositsUsd: 3_200_000, depositsHollar: '3200000' + E18, redeems: 27, cancels: 12, settlements: 47, settledHollar: '30000' + E18, claims: 12, claimedHollar: '28000' + E18, reinvests: 87, reinvestedHollar: '2207335' + E18, interestHollar: '90000' + E18, principalHollar: '2200000' + E18, drawsHollar: '3500000' + E18, repaysHollar: '450000' + E18, unpricedRows: 0 },
    perDay: [],
    contracts: [{ role: 'BIL vault (BILVault — the uBIL token, ERC-4626 + ERC-7540)', account: VAULT }],
    ...over,
  }
}
function render(data: BilDashboard): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['bil-dashboard'], data)
  return renderToStaticMarkup(<QueryClientProvider client={client}><Bil /></QueryClientProvider>)
}

describe('the /bil route', () => {
  it('is its own page under paths.bil', () => {
    expect(paths.bil()).toBe('/bil')
    expect(parseRoute('/bil')).toEqual({ name: 'bil' })
  })
  it('sits in the Assets menu directly after Juicer, in every layout', () => {
    for (const items of [NAV_CONFIG.ASSETS_GROUP.menuItems!, NAV_CONFIG.ASSETS_FOLD_GROUP.menuItems!, NAV_CONFIG.DRAWER_LINKS]) {
      const labels = items.map(i => i.label)
      expect(labels.indexOf('Brazilian Invoice Loans')).toBe(labels.indexOf('Juicer') + 1)
    }
  })
})

describe('the BIL page', () => {
  it('explains the strategy and its risks in the official app’s terms before any figure', () => {
    const html = render(dashboard())
    expect(html).toContain('Brazilian Invoice Loans')
    expect(html).toContain('18% APY over 60-day terms')
    expect(html).toContain('about 62 days')
    expect(html).toContain('<h1 class="page-title">Brazilian Invoice Loans')
    expect(html).toContain('<h2 class="sec-title">Redemption queue')
    expect(html).toContain('depend on their repayment')
    expect(html.indexOf('Terms on this page')).toBeLessThan(html.indexOf('Pool vs NAV'))
  })
  it('states NAV, the stated APY beside the realized one, a full vault and the measured processing delay', () => {
    const html = render(dashboard())
    expect(html).toContain('1.048640')
    expect(html).toContain('18.00%')
    expect(html).toContain('17.57%')
    expect(html).toContain('Vault is full')
    expect(html).toContain('17.9 – 53.7 h')
    expect(html).toContain('Claim ready')
    expect(html).toContain('−0.080% discount')
    expect(html).toContain('~62 days')
    expect(html).toContain('over the last 10.1 days')
  })
  it('states a queued request\'s wait as a window, and a passed maturity as awaiting processing, never a past time', () => {
    const html = render(dashboard())
    expect(html).toContain('matured, awaiting processing')
    expect(html).not.toContain('2020-01-0')
    expect(html).toContain('expected Thu 01 Jan 2099 · 18:00 UTC – Sat 03 Jan 2099 · 06:00 UTC')
    expect(html).not.toMatch(/ ,/)
    expect(html).toContain('href="#bil-request-25"')
  })
  it('states borrowing against BIL as the app does, and where the payouts come from', () => {
    const html = render(dashboard())
    expect(html).toContain('Borrowing against BIL')
    expect(html).toContain('79.06%')
    expect(html).toContain('50% · 85%')
    expect(html).toContain('26.00%')
    expect(html).toContain('liquidated')
    expect(html).toContain('Where payouts come from')
    expect(html).toContain('partly out of new deposits and reinvestment')
  })
  it('says when the current state is unavailable instead of showing zeros', () => {
    const html = render(dashboard({ asOfBlock: null, ladder: null, queue: null }))
    expect(html).toContain('current state is unavailable')
  })
})

describe('BIL activity rows', () => {
  const row = (bilAction: ActivityRow['bilAction'], extra: Partial<ActivityRow> = {}): ActivityRow => ({
    type: 'bil', blockHeight: 15_854_528, timestamp: '2026-10-16 09:24:48', eventIndex: 42, extrinsicIndex: 2,
    who: HOLDER, to: null, asset: HOLLAR, assetIn: null, assetOut: null, amount: '1', amountIn: null, amountOut: null, valueUsd: 2, bilAction, ...extra,
  })
  it('link each act to its own slug, which resolves back to the BIL rows', () => {
    expect(activitySlug(row('Deposit'))).toBe('bil-deposit')
    expect(activitySlug(row('Principal'))).toBe('bil-principal')
    expect(SLUG_TYPES['bil-settle']).toEqual(['bil'])
    expect(activityLabel('bil-redeem')).toBe('Redemption requested')
  })
  it('wear the BIL family’s shades, a partial settlement named as one', () => {
    expect(activityBadge(row('Deposit'))).toEqual({ label: 'BIL deposit', col: CAT.bil })
    expect(activityBadge(row('Settle', { bilPartial: true }))).toEqual({ label: 'Redemption partly settled', col: CAT.bilExit })
    expect(activityBadge(row('Draw')).col).toBe(CAT.bilKeeper)
    expect(activityBadge(row('Interest')).col).toBe(CAT.bilYield)
  })
})

describe('the Strategies tab’s BIL card', () => {
  const positions: AccountBil = {
    asOfBlock: 16_735_693, complete: true,
    position: { totalHollar: '2730' + E18, totalUsd: 2_723, bil: '2603' + E18, ubil: '0', queuedShares: '287' + E18, claimableHollar: '0', share: 0.000823,
      bilAsset: BIL, ubilAsset: UBIL, hollarAsset: HOLLAR, exchangeRate: '1048640449099327563', apyPct: 18, termDays: 60,
      requests: [{ requestId: 26, owner: HOLDER, controller: HOLDER, shares: '287' + E18, status: 'queued', requestedAt: '2026-11-06T15:41:06Z', settledShares: '0', hollarOwed: '0', cancelledShares: '0', pendingShares: '287' + E18, claimableHollar: '0', worthHollar: '300' + E18, worthUsd: 300, wait: { maturesAt: '2099-01-01T00:00:00.000Z', from: '2099-01-01T18:00:00.000Z', to: '2099-01-03T06:00:00.000Z', matured: false }, paidFromIdle: false, lastSettledAt: null }] },
  }
  it('leads with the whole position at NAV, says it is already in Value, and shows the queue', () => {
    const html = renderToStaticMarkup(<BilPositions positions={positions} />)
    expect(html).toContain('Brazilian Invoice Loans')
    expect(html).toContain('18.00%')
    expect(html).toContain('In queue')
    expect(html).toContain('Queued for redemption')
    expect(html).toContain('60-day')
    expect(html).toContain('does not add to it')
    expect(html).toContain('href="/bil#bil-request-26"')
  })
  // Request #25 of 1nVmc4…1Mwm: settled in full, unclaimed. Fixed HOLLAR, not in the queue,
  // earning nothing — so no APY and no vault share.
  it('states a fully settled request as claimable HOLLAR, with no APY or share', () => {
    const settled: AccountBil = {
      asOfBlock: 16_737_673, complete: true,
      position: { totalHollar: '53' + E18, totalUsd: 53, bil: '0', ubil: '0', queuedShares: '0', claimableHollar: '53' + E18, share: null,
        bilAsset: BIL, ubilAsset: UBIL, hollarAsset: HOLLAR, exchangeRate: '1048666667508092678', apyPct: null, termDays: 60,
        requests: [{ requestId: 25, owner: HOLDER, controller: HOLDER, shares: '50' + E18, status: 'claimable', requestedAt: '2026-11-03T13:51:06Z', settledShares: '50' + E18, hollarOwed: '53' + E18, cancelledShares: '0', pendingShares: '0', claimableHollar: '53' + E18, worthHollar: '53' + E18, worthUsd: 53, wait: null, paidFromIdle: false, lastSettledAt: '2026-11-04T11:27:30Z' }] },
    }
    const html = renderToStaticMarkup(<BilPositions positions={settled} />)
    expect(html).toContain('Settled, claimable')
    expect(html).not.toContain('Queued for redemption')
    expect(html).not.toContain('Vault share')
    expect(html).not.toContain('>APY<')
    expect(html).not.toContain('redemption queue')
  })
  it('says when the open requests could not be read', () => {
    const html = renderToStaticMarkup(<BilPositions positions={{ ...positions, complete: false }} />)
    expect(html).toContain('could not be read')
  })
})
