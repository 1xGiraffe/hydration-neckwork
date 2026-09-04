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
      nowHdx: { gigahdx: 4.2e8, vesting: 2.5e8, vote: 0 },
      gigaPending: {
        count: 12, totalHdx: 1.4e6, nextUnlockTs: '2026-07-16 00:00:00',
        maturedCount: 5, maturedHdx: 9e5,
      },
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

// Matured GIGAHDX unstakes have no future date, so they used to fall out of the
// dated buckets and be summed into a figure the page never rendered — 11.2M HDX
// of claimable balance simply absent. They belong in a leading "now" column,
// overlap-corrected like every other slice.
describe('HDX Upcoming unlocks — claimable-now column', () => {
  const render = (data: HdxDashboard) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['hdx-dashboard'], data)
    return renderToStaticMarkup(<QueryClientProvider client={queryClient}><Hdx /></QueryClientProvider>)
  }

  // Claimable-now balance is NOT a time bucket, and as a bar it was both a
  // category error and the largest column on the chart. It reads as stat cards
  // above the axis instead, GIGAHDX first because it is the actionable one.
  it('renders the claimable-now breakdown outside the chart', () => {
    const html = render(mockData())
    expect(html).toContain('Claimable now')
    expect(html).not.toContain('>now<')
  })

  it('leads the breakdown with GIGAHDX, ahead of the far larger lock kinds', () => {
    const html = render(mockData())
    const claimable = html.slice(html.indexOf('Claimable now'))
    expect(claimable.indexOf('GIGAHDX')).toBeLessThan(claimable.indexOf('Vesting'))
  })

  // It is context, not a headline: the same balance may sit there for years
  // (dormant vote locks, vested-but-unclaimed), so it must not carry the weight
  // of the stat-card grid the Locks section uses for real figures.
  it('renders claimable-now as a caption, not as stat cards', () => {
    const html = render(mockData())
    // Slice forward from the label to the NEXT chart, not the page's first one.
    const at = html.indexOf('Claimable now')
    const block = html.slice(at, html.indexOf('day-chart', at))
    expect(block.length).toBeGreaterThan(0)
    expect(block).not.toContain('hdx-card')
    expect(block).not.toContain('sec-title')
  })

  it('marks each kind with its series colour swatch', () => {
    const html = render(mockData())
    const at = html.indexOf('Claimable now')
    const block = html.slice(at, html.indexOf('day-chart', at))
    // mockData has gigahdx + vesting releasable, vote at zero — one dot each.
    expect(block.match(/border-radius:50%/g) ?? []).toHaveLength(2)
  })

  it('omits the claimable-now block when nothing is releasable', () => {
    const data = mockData()
    data.unlocks.nowHdx = { gigahdx: 0, vesting: 0, vote: 0 }
    expect(render(data)).not.toContain('Claimable now')
  })

  it('reports how much of the GIGAHDX pending pool has matured', () => {
    const html = render(mockData())
    expect(html).toContain('5 matured')
  })

  it('omits the matured note while every position is still cooling', () => {
    const data = mockData()
    data.unlocks.gigaPending.maturedCount = 0
    data.unlocks.gigaPending.maturedHdx = 0
    const html = render(data)
    expect(html).not.toContain('matured')
  })
})
