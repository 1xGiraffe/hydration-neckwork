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
