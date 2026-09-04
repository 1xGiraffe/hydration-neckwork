import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Hollar, hourlyPegRefine } from '../src/pages/Hollar'
import type { HollarDashboard } from '../src/types'

const aUSDC = { assetId: 1003, symbol: 'aUSDC', name: 'Aave USDC', decimals: 6, parachainId: null }
const sUSDe = { assetId: 1000625, symbol: 'sUSDe', name: 'Savings USDe', decimals: 18, parachainId: null }
const USDC = { assetId: 22, symbol: 'USDC', name: 'USD Coin', decimals: 6, parachainId: 1000 }
const USDT = { assetId: 10, symbol: 'USDT', name: 'Tether USD', decimals: 6, parachainId: 1000 }

function mockData(): HollarDashboard {
  return {
    price: 1.0013,
    change24h: 0.0006,
    pegDeviationBps: 13,
    peg: {
      hourly: [
        { ts: '2026-06-10 00:00:00', close: 0.999 },
        { ts: '2026-07-09 23:00:00', close: 1.0013 },
      ],
      within25bpsPct: 96.4,
      maxDevBps: -32,
      min30d: 0.9968,
      max30d: 1.0021,
    },
    supply: { total: 10_300_000, holders: 4_215, inStablepools: 9_045_000, inOmnipool: 410_000, other: 845_000 },
    hsm: {
      totalHoldingsUsd: 272_790,
      collaterals: [
        { asset: aUSDC, poolId: 110, holdings: '0', holdingsUsd: 0, purchaseFeePct: 0.3, buyBackFeePct: 0.01, maxBuyPrice: 0.995, buybackRatePct: 0.01, maxInHolding: null, lastArbTs: '2026-07-08 14:32:00', lastArbDirection: 'out' },
        { asset: sUSDe, poolId: 113, holdings: (193_000n * 10n ** 18n).toString(), holdingsUsd: 198_790, purchaseFeePct: 0.3, buyBackFeePct: 0.01, maxBuyPrice: 0.995, buybackRatePct: 0.01, maxInHolding: null, lastArbTs: '2026-07-08 20:05:00', lastArbDirection: 'in' },
      ],
      reserveHistory: {
        days: ['2026-07-08', '2026-07-09', '2026-07-10'],
        series: [
          { asset: sUSDe, values: [180_000, 191_000, 193_000] },
          { asset: aUSDC, values: [42_000, 12_000, 0] },
        ],
      },
      arbitrageDaily: Array.from({ length: 60 }, (_, i) => ({
        date: new Date(Date.parse('2026-07-10') - (59 - i) * 86_400_000).toISOString().slice(0, 10),
        hollarIn: i === 40 ? 8_400 : 0,
        hollarOut: i === 20 ? 5_100 : 0,
      })),
      tradesDaily: Array.from({ length: 60 }, (_, i) => ({
        date: new Date(Date.parse('2026-07-10') - (59 - i) * 86_400_000).toISOString().slice(0, 10),
        bought: 1_200,
        sold: 900,
      })),
      lastArb: { ts: '2026-07-08 20:05:00', direction: 'in', asset: sUSDe, hollarAmount: 4_200 },
    },
    pools: [
      {
        poolId: 105, tvlUsd: 510_842.75, hollar: { amount: 255_000, usd: 255_330 },
        partners: [{ asset: USDC, amount: 128_000, usd: 128_000 }, { asset: USDT, amount: 127_500, usd: 127_512.75 }],
        hollarSharePct: 49.98,
      },
      {
        poolId: 110, tvlUsd: 12_056_000, hollar: { amount: 6_000_000, usd: 6_006_000 },
        partners: [{ asset: aUSDC, amount: 6_050_000, usd: 6_050_000 }],
        hollarSharePct: 49.8,
      },
    ],
    trends: {
      weeks: ['2025-09-22', '2025-09-29', '2025-10-06'],
      composition: {
        stableswap: [2.4e6, 2.9e6, 3.1e6], omnipool: [0, 0, 4e5], protocol: [1.5e5, 1.6e5, 1.7e5],
        bridged: [0, 0, 1e6], wallets: [2e4, 3e4, 5e4],
      },
      holders: [57, 63, 70],
      peg: { close: [0.9985, 0.999, 0.9992], low: [0.997, 0.9982, 0.9985], high: [1.0002, 1.0004, 1.0001] },
      debt: [2.0e6, 2.4e6, 2.9e6],
      borrowers: [118, 130, 141],
      revenueCumUsd: [1_400, 3_200, 5_400],
      depth: { stableswap: [2.4e6, 2.9e6, 3.1e6], omnipool: [null, null, 4e5] },
      months: ['2025-09-01', '2025-10-01'],
      stableSharePct: [5.1, 8.9],
      pegStats: { uptime50Pct: 97.9, uptime25Pct: 81.4, maxAbsDevBps: 97.5 },
      rates: [{ label: 'Core market', pct: 4.402, prevPct: 4.879, since: '2026-03-03' }],
    },
  }
}

describe('Hollar dashboard page', () => {
  it('renders the ribbon, Peg, Stability Module and Liquidity sections from mock data', () => {
    const data = mockData()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['hollar-dashboard'], data)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Hollar /></QueryClientProvider>)

    // section titles
    expect(html).toContain('Peg')
    expect(html).toContain('Stability Module')
    expect(html).toContain('Liquidity')
    expect(html).toContain('Arbitrage')
    expect(html).toContain('HSM trades')

    // ribbon values
    expect(html).toContain('$1.00') // F.priceUsd rounds stablecoin prices to 2dp
    expect(html).toContain('+13 bps') // peg deviation, amber band (>10, <=50)
    expect(html).toContain('10.3M HOLLAR') // total supply
    expect(html).toContain('4,215') // holders
    expect(html).toContain('$273k') // HSM reserves USD
    expect(html).toContain('$12.6M') // stablepool TVL (sum of pool tvlUsd)

    // HSM collateral table and multi-partner pool labelling.
    expect(html).toContain('aUSDC')
    expect(html).toContain('sUSDe')
    expect(html).toContain('HOLLAR / USDC + USDT')
    expect(html).toContain('Balanced ≈ 33.3%')
  })

  it('charts the stability module reserves, one band per collateral it has held', () => {
    const data = mockData()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['hollar-dashboard'], data)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Hollar /></QueryClientProvider>)

    expect(html).toContain('Reserves')
    expect(html).toContain('collateral held by the module, since launch')
    // The head of the stack is the module's reserves today: 193k + 0.
    expect(html).toContain('The module holds 193k tokens of collateral today')
  })

  it('renders one peg section: the full-era chart with a filled intraweek range', () => {
    const data = mockData()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['hollar-dashboard'], data)
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Hollar /></QueryClientProvider>)

    // The 30-day chart is gone; its numbers live on as the section's 30-day card.
    expect(html).not.toContain('Peg since launch')
    expect(html).not.toContain('of hourly closes')
    expect(html).toContain('Last 30 days')
    expect(html).toContain('$0.9968 – $1.0021')
    expect(html).toContain('96.4% within ±25 bps')
    // Since-launch stats stay.
    expect(html).toContain('81.4%')
    expect(html).toContain('98 bps')

    // The weekly low/high pair draws as one filled envelope, not two full lines.
    expect(html).toContain('Weekly range')
    expect(html).toContain('fill-opacity="0.2"')
    // The close line is neutral ink rather than the accent hue.
    expect(html).toContain('stroke="var(--text-high)"')
  })

  it('shows the loading skeleton (not the failure message) while data is pending', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Hollar /></QueryClientProvider>)
    expect(html).toContain('chart-skeleton')
    expect(html).not.toContain('Failed to load')
  })
})

// The dashboard already carries 30 days of hourly closes, so zooming inside them
// refines locally. A window reaching back further must NOT refine: one month of
// detail drawn across a year of plot would leave most of the chart empty.
describe('hourlyPegRefine', () => {
  const at = (iso: string) => Math.floor(Date.parse(iso + 'Z') / 1000)
  const hourly = Array.from({ length: 48 }, (_, i) => ({
    ts: new Date(Date.parse('2026-07-08T00:00:00Z') + i * 3_600_000).toISOString().replace('T', ' ').slice(0, 19),
    close: 1 + i / 100_000,
  }))

  it('returns an hourly grid for a window inside the coverage', async () => {
    const refine = hourlyPegRefine(hourly)!
    const grid = await refine(at('2026-07-08T06:00:00'), at('2026-07-09T06:00:00'))
    expect(grid?.buckets.length).toBeGreaterThan(20)
    expect(grid?.series[0].values.length).toBe(grid?.buckets.length)
  })

  it('refuses a window that starts before the hourly coverage', async () => {
    const refine = hourlyPegRefine(hourly)!
    expect(await refine(at('2026-01-01T00:00:00'), at('2026-07-09T00:00:00'))).toBeNull()
  })

  it('has nothing to offer without hourly points', () => {
    expect(hourlyPegRefine([])).toBeUndefined()
  })
})
