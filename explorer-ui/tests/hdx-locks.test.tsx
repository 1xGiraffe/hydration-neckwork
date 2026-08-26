import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Hdx } from '../src/pages/Hdx'
import type { HdxDashboard } from '../src/types'

function mockData(): HdxDashboard {
  const bucket = (i: number) => ({
    label: `wk ${i + 1}`,
    fromTs: `2026-07-${14 + i} 00:00:00`,
    toTs: `2026-07-${15 + i} 00:00:00`,
    gigahdx: 1e6, vesting: 2e6, vote: 5e5,
  })
  return {
    price: 0.0217,
    change24h: -1.2,
    supply: { totalHdx: 6.5e9, protocolHdx: 2.6e9, userHdx: 3.9e9, holders: 41_000 },
    cohorts: [
      { key: 'whale', label: 'Whale', minPct: 0.1, minHdx: 6.5e6, accounts: 40, totalHdx: 2.4e9 },
      { key: 'shrimp', label: 'Shrimp', minPct: 0, minHdx: 0, accounts: 39_000, totalHdx: 1.5e9 },
    ],
    locks: {
      types: [
        { key: 'staking', label: 'Staking', accounts: 9_000, totalHdx: 1.2e9 },
        // schedule-derived: only HDX still vesting at the head, not the raw ormlvest lock
        { key: 'vesting', label: 'Vesting', accounts: 5_131, totalHdx: 5.87e8 },
      ],
      totalLockedHdx: 1.7e9,
      lockedPctOfUser: 43.6,
      vestedUnclaimedHdx: 2.31e8,
      snapshotAt: '2026-07-14 10:00:00',
    },
    unlocks: {
      buckets: Array.from({ length: 8 }, (_, i) => bucket(i)),
      laterHdx: { gigahdx: 9.2e7, vesting: 4.6e8, vote: 1.4e8 },
      unlockableNowHdx: 6.7e8,
      activeVoteHdx: 7.8e8,
      stakingAnytimeHdx: 1.2e9,
      gigaPending: { count: 12, totalHdx: 1.4e6, nextUnlockTs: '2026-07-16 00:00:00' },
    },
    flows: {
      daily: [{ date: '2026-07-13', buyHdx: 2e6, sellHdx: 1e6, buyers: 300, sellers: 200 }],
      dca: { buy: { orders: 46, hdxPerDay: 2.1e6 }, sell: { orders: 13, hdxPerDay: 6.4e5 } },
    },
    churn: { weekly: [{ weekStart: '2026-07-06', newHolders: 220, exitedHolders: 180 }] },
    structure: {
      weeks: ['2026-06-29', '2026-07-06'],
      ownership: {
        treasury: [2.1e9, 2.1e9], protocol: [3.1e8, 3.1e8], kraken: [2.4e8, 2.4e8],
        top10: [1.0e9, 1.0e9], top11to100: [1.3e9, 1.3e9], top101to1000: [9.6e8, 9.6e8], rest: [4.4e8, 4.4e8],
      },
      effectiveHolders: [84, 85],
      hodl: { under3m: [9.9e7, 9.9e7], m3to12: [1.7e8, 1.7e8], y1to2: [7.7e8, 7.7e8], over2y: [2.66e9, 2.66e9] },
      backfilledAllocationHdx: 0,
      trends: {
        months: ['2026-06-01', '2026-07-01', '2026-08-01'],
        stakedClassic: [1.94e9, 1.07e9, 8.3e8],
        stakedGiga: [null, 1.0e9, 1.28e9],
        liquidFloat: [1.75e9, 1.62e9, 1.58e9],
        realizedPrice: [0.0093, 0.0092, 0.009],
        marketPrice: [0.0038, 0.0082, 0.0107],
        top100Share: [62.7, 63.4, 64.1],
        krakenHdx: [2.81e8, 2.52e8, 2.43e8],
        buybackHdx: [4.19e8, 4.63e8, 4.86e8],
        traders: [471, 641, 551],
        gov: { quarters: ['2026-04-01', '2026-07-01'], capital: [9.39e8, 1.14e9], voters: [373, 478] },
      },
    },
    topMovers: { accumulators: [], distributors: [] },
    gigaMarket: null,
    gigaLiquidations: null,
  }
}

describe('HDX Locks section — vesting shows only HDX still on schedule', () => {
  it('renders scheduled vesting separately from vested-but-unclaimed HDX', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['hdx-dashboard'], mockData())
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Hdx /></QueryClientProvider>)

    expect(html).toContain('587M')
    expect(html).toContain('231M')
    expect(html).toContain('vested but unclaimed')
  })

  it('omits the unclaimed callout when nothing is pending a claim', () => {
    const data = mockData()
    data.locks.vestedUnclaimedHdx = 0
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['hdx-dashboard'], data)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Hdx /></QueryClientProvider>)
    expect(html).not.toContain('vested but unclaimed')
  })
})
