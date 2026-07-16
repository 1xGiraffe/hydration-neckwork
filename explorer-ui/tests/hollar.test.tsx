import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Hollar } from '../src/pages/Hollar'
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
    expect(html).toContain('$272.8k') // HSM reserves USD
    expect(html).toContain('$12.57M') // stablepool TVL (sum of pool tvlUsd)

    // HSM collateral table and multi-partner pool labelling.
    expect(html).toContain('aUSDC')
    expect(html).toContain('sUSDe')
    expect(html).toContain('HOLLAR / USDC + USDT')
    expect(html).toContain('Balanced ≈ 33.3%')
  })

  it('shows the loading skeleton (not the failure message) while data is pending', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><Hollar /></QueryClientProvider>)
    expect(html).toContain('chart-skeleton')
    expect(html).not.toContain('Failed to load')
  })
})
