import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../src/api/explorer'
import { useIceDashboard } from '../src/hooks/useExplorerData'
import { Ice } from '../src/pages/Ice'
import { parseRoute, paths } from '../src/router'
import { mockSync } from './fixtures/mockApi'
import type { IceDashboard } from '../src/types'

const DOT = { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null }
const USDT = { assetId: 10, symbol: 'USDT', name: 'Tether USD', decimals: 6, parachainId: 1000 }

function fixture(): IceDashboard {
  const data = mockSync<IceDashboard>('/explorer/ice')
  if (!data) throw new Error('no ice fixture')
  return data
}

function render(data: IceDashboard): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['ice-dashboard'], data)
  return renderToStaticMarkup(<QueryClientProvider client={client}><Ice /></QueryClientProvider>)
}

describe('the /ice route', () => {
  it('is its own page under paths.ice', () => {
    expect(paths.ice()).toBe('/ice')
    expect(parseRoute('/ice')).toEqual({ name: 'ice' })
    expect(parseRoute(paths.ice())).toEqual({ name: 'ice' })
  })
})

describe('api.ice and useIceDashboard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks /explorer/ice and returns the dashboard', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(fixture()), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const data = await api.ice()
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/explorer/ice'])
    expect(data.status.solverMode).toBe('V4')
  })

  it('caches under the key the page test seeds', () => {
    const client = new QueryClient()
    function Probe() { useIceDashboard(); return null }
    renderToStaticMarkup(<QueryClientProvider client={client}><Probe /></QueryClientProvider>)
    expect(client.getQueryCache().getAll().map(q => q.queryKey)).toEqual([['ice-dashboard']])
  })
})

describe('the ICE dashboard before any intent exists', () => {
  const data = fixture()
  const html = render(data)

  it('is the launch state: no orders, no fills, no fees, no migrations', () => {
    expect(data.openOrders.total).toBe(0)
    expect(data.fillsPerDay.every(d => d.fills === 0 && d.solutions === 0)).toBe(true)
    expect(data.feeRevenue.perDay.every(d => d.usd === 0)).toBe(true)
    expect(data.migration.migrated + data.migration.cancelled).toBe(0)
  })
  it('reads the governance status off the strip: V4 solver, 0.02% fee, migration off', () => {
    expect(html).toContain('V4')
    expect(html).toContain('0.02%')
    expect(html).toMatch(/DCA migration[\s\S]{0,200}?>off</)
    expect(html).toContain('not set')
  })
  it('says so honestly instead of drawing empty charts', () => {
    expect(html).toContain('No intents yet — the ICE venue went live at block 14362830.')
    expect(html).not.toContain('Failed to load')
  })
  it('keeps every section on the page with its own empty line', () => {
    for (const title of ['Open orders', 'Fills', 'Execution quality', 'Fee revenue', 'DCA migration', 'Top pairs']) expect(html).toContain(title)
    expect(html).toContain('No open orders')
    expect(html).toContain('No fills')
    expect(html).toContain('No fee revenue')
    expect(html).toContain('No migrations')
  })
})

describe('the ICE dashboard with activity', () => {
  const base = fixture()
  const days = base.fillsPerDay.map(d => d.day)
  const last = days[days.length - 1]
  const data: IceDashboard = {
    ...base,
    status: { ...base.status, dcaMigrationEnabled: true, uniswapV3: { factory: '0xf1', swapRouter: '0xf2', quoter: '0xf3' }, asOfBlock: 14_400_000 },
    openOrders: {
      total: 3, limit: 2, dca: 1,
      byAsset: [
        { asset: DOT, reserved: '2500000000000', reservedUsd: 1110.55, orders: 2 },
        { asset: USDT, reserved: '400000000', reservedUsd: 400, orders: 1 },
      ],
    },
    fillsPerDay: base.fillsPerDay.map(d => d.day === last ? { day: d.day, fills: 4, solutions: 2, usd: 1200, matchedUsd: 800, routedUsd: 400 } : d),
    quality: { medianTimeToFillSec: 95, partialShare: 0.25, cancelRate: 0.1, expiryRate: 0.05, priceVsLimitBp: { p10: -2, p50: 3.5, p90: 12 } },
    feeRevenue: {
      perDay: base.feeRevenue.perDay.map(d => d.day === last ? { day: d.day, usd: 0.16 } : d),
      potHoldings: [{ asset: USDT, amount: '160000', valueUsd: 0.16 }],
    },
    migration: {
      migrated: 12, cancelled: 3, byReason: [{ reason: 'BuyOrder', count: 2 }, { reason: 'BudgetBelowTrade', count: 1 }], remainingSchedules: 40,
      perDay: base.migration.perDay.map(d => d.day === last ? { day: d.day, migrated: 12, cancelled: 3 } : d),
    },
    topPairs: [{ assetIn: DOT, assetOut: USDT, fills: 4, usd: 1200 }],
  }
  const html = render(data)

  it('drops the launch notice and shows the figures', () => {
    expect(html).not.toContain('No intents yet')
    expect(html).toMatch(/DCA migration[\s\S]{0,200}?>on</)
    expect(html).toContain('0xf1')
    expect(html).toContain('14,400,000')
    expect(html).toContain('$1.11k')            // DOT reserved
    expect(html).toContain('1m 35s')            // median time to fill
    expect(html).toContain('25.0%')             // partial share
    expect(html).toContain('+3.5 bp')           // p50 price vs limit
    expect(html).toContain('BuyOrder')
    expect(html).toContain('40')                // schedules remaining
    expect(html).toContain('DOT')
    expect(html).toContain('USDT')
  })
  it('stacks matched against routed volume and charts the fee line', () => {
    expect(html).toContain('Matched')
    expect(html).toContain('Routed')
    expect(html).toContain('$1.2k')
  })
})
