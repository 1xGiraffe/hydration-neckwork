import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../src/api/explorer'
import { useIceDashboard } from '../src/hooks/useExplorerData'
import { Intents } from '../src/pages/Intents'
import { parseRoute, paths } from '../src/router'
import { NAV_CONFIG } from '../src/components/navConfig'
import { mockSync } from './fixtures/mockApi'
import type { IceDashboard, IceOpenIntents } from '../src/types'

const DOT = { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null }
const USDT = { assetId: 10, symbol: 'USDT', name: 'Tether USD', decimals: 6, parachainId: 1000 }
const ADOT = { assetId: 1001, symbol: 'aDOT', name: 'aDOT', decimals: 10, parachainId: null }
const OWNER = { accountId: '0x' + '11'.repeat(32), address: '12xLgPQunSsPkwMJ3vAgfac7mtU3Xw6R4fbHQcCp2QqXzdtu' }

function fixture(): IceDashboard {
  const data = mockSync<IceDashboard>('/explorer/ice')
  if (!data) throw new Error('no ice fixture')
  return data
}

function render(data: IceDashboard, open?: IceOpenIntents): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['ice-dashboard'], data)
  if (open) client.setQueryData(['open-intents'], open)
  return renderToStaticMarkup(<QueryClientProvider client={client}><Intents /></QueryClientProvider>)
}

describe('the /intents route', () => {
  it('is its own page under paths.intents', () => {
    expect(paths.intents()).toBe('/intents')
    expect(parseRoute('/intents')).toEqual({ name: 'intents' })
  })
  it('keeps the first URL, /ice, working as a redirect', () => {
    expect(parseRoute('/ice')).toEqual({ name: 'legacy', to: '/intents' })
  })
  it('sends a malformed order id to the intents page, where intents are listed', () => {
    expect(parseRoute('/intent/not-a-number')).toEqual({ name: 'legacy', to: '/intents' })
  })
  it('sits in the Chain menu directly above Contracts, and lights for an order page too', () => {
    const chain = NAV_CONFIG.NAV_ENTRIES.find(e => e.kind === 'group' && e.group.label === 'Chain')
    if (!chain || chain.kind !== 'group') throw new Error('no Chain group')
    const labels = (chain.group.menuItems ?? chain.group.items).map(i => i.label)
    expect(labels.indexOf('Intents')).toBe(labels.indexOf('Contracts') - 1)
    const item = chain.group.items.find(i => i.label === 'Intents')
    expect(item?.to).toBe('/intents')
    expect(item?.match).toEqual(['intents', 'intent'])
  })
})

describe('api.ice, api.openIntents and useIceDashboard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks /explorer/ice and returns the dashboard', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(fixture()), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const data = await api.ice()
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/explorer/ice'])
    expect(data.status.solverMode).toBe('V4')
  })

  it('asks /explorer/intents/open for the live book', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(mockSync('/explorer/intents/open')), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const data = await api.openIntents()
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/explorer/intents/open'])
    expect(data.limitOrdersTotal).toBe(0)
  })

  it('caches under the key the page test seeds', () => {
    const client = new QueryClient()
    function Probe() { useIceDashboard(); return null }
    renderToStaticMarkup(<QueryClientProvider client={client}><Probe /></QueryClientProvider>)
    expect(client.getQueryCache().getAll().map(q => q.queryKey)).toEqual([['ice-dashboard']])
  })
})

describe('the intents page with no activity', () => {
  const data = fixture()
  const html = render(data)

  it('keeps every section on the page with its own empty line', () => {
    for (const title of ['Fills', 'Execution quality', 'Top traders', 'Top pairs', 'Open orders', 'Intent activity', 'Protocol fee revenue', 'Solver settings']) expect(html).toContain(title)
    expect(html).toContain('No fills')
    expect(html).toContain('No protocol fee revenue')
    expect(html).not.toContain('Couldn’t load')
  })
  it('reads the governance status: V4 solver, 0.02% fee, migration off', () => {
    expect(html).toContain('V4')
    expect(html).toContain('0.02%')
    expect(html).toContain('not set')
    expect(html).toContain('has not switched on the migration')
  })
})

describe('the intents page with activity', () => {
  const base = fixture()
  const days = base.fillsPerDay.map(d => d.day)
  const last = days[days.length - 1]
  const data: IceDashboard = {
    ...base,
    status: {
      ...base.status, dcaMigrationEnabled: true, uniswapV3: { factory: '0xf1', swapRouter: '0xf2', quoter: '0xf3' }, asOfBlock: 14_400_000,
      routing: [
        { kind: 'StableswapPool', assets: [[{ ...USDT, assetId: 100, symbol: '4-Pool' }]], contracts: [], state: 'Excluded', block: 15_891_816 },
        { kind: 'AaveWraps', assets: [[DOT, ADOT]], contracts: [], state: 'Included', block: 15_141_465 },
      ],
    },
    allTime: { intents: 120, limit: 100, dca: 20, owners: 33 },
    openOrders: {
      total: 3, limit: 2, dca: 1,
      byAsset: [
        { asset: DOT, reserved: '2500000000000', reservedUsd: 1110.55, orders: 2 },
        { asset: USDT, reserved: '400000000', reservedUsd: 400, orders: 1 },
      ],
    },
    fillsPerDay: base.fillsPerDay.map(d => d.day === last ? { day: d.day, fills: 4, solutions: 2, usd: 1200, matchedUsd: 800, routedUsd: 400 } : d),
    traders: 2,
    unpricedFills: 1,
    topTraders: [{ account: OWNER, fills: 3, usd: 900 }],
    quality: {
      medianTimeToFillSec: 2.2, medianBlocksToFill: 1, partialShare: 0.25, cancelRate: 0.1, expiryRate: 0.05, priceVsLimitBp: { p10: -2, p50: 3.5, p90: 12 },
      priceVsLimitBpImmediate: { p10: 49, p50: 99.9, p90: 100.2, fills: 30 }, priceVsLimitBpResting: { p10: 0, p50: 3.5, p90: 12, fills: 7 },
    },
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

  it('leads with the headline strip', () => {
    expect(html).toContain('$1.51k')            // reserved
    expect(html).toContain('$1.2k')             // volume
    expect(html).toContain('66.7%')             // matched share
    expect(html).toContain('33 ever')           // owners all time
  })
  it('reads time to fill in blocks, with its seconds at the chain pace', () => {
    expect(html).toContain('1 block')
    expect(html).toContain('~2.2s')
    expect(html).toContain('+99.9 bp')         // market-style fills: the app's slippage allowance
    expect(html).toContain('+3.5 bp')          // resting orders
    expect(html).toContain('25.0%')
  })
  it('names the traders, the pairs and the fills it could not value', () => {
    expect(html).toContain('$900')
    expect(html).toContain('1 fill has no price at settlement')
    expect(html).toContain('DOT')
    expect(html).toContain('USDT')
  })
  it('lists the routing overrides and the migration once it has run', () => {
    expect(html).toContain('Stableswap pool')
    expect(html).toContain('excluded')
    expect(html).toContain('Aave wraps')
    expect(html).toContain('15,891,816')
    expect(html).toContain('BuyOrder')
    expect(html).toContain('0xf1')
    expect(html).toContain('14,400,000')
    expect(html).toContain('40')
  })
  it('prefers the live book over the dashboard fold once it answers', () => {
    const live: IceOpenIntents = {
      summary: { total: 7, limit: 6, dca: 1, byAsset: [{ asset: DOT, reserved: '1', reservedUsd: 5000, orders: 7 }] },
      limitOrders: [], limitOrdersTotal: 6, dcaIntents: [], dcaIntentsTotal: 1, generatedAt: base.generatedAt,
    }
    const withLive = render(data, live)
    expect(withLive).toContain('$5k')
    expect(withLive).toMatch(/Limit orders <span class="cnt">6</)
  })
})

describe('the intents page reads for a non-expert and on a phone', () => {
  const base = fixture()
  const days = base.fillsPerDay.map(d => d.day)
  const USDC22 = { assetId: 22, symbol: 'USDC', name: 'USDC (Polkadot)', decimals: 6, parachainId: 1000 }
  const USDC21 = { assetId: 21, symbol: 'USDC', name: 'USDC (Ethereum)', decimals: 6, parachainId: null }
  const wraps = Array.from({ length: 9 }, (_, i) => [{ ...DOT, assetId: 100 + i, symbol: `T${i}` }, { ...DOT, assetId: 200 + i, symbol: `aT${i}` }])
  const data: IceDashboard = {
    ...base,
    status: { ...base.status, routing: [{ kind: 'AaveWraps', assets: wraps, contracts: [], state: 'Included', block: 15_141_465 }] },
    fillsPerDay: base.fillsPerDay.map((d, i) => i === 10 ? { ...d, fills: 5, usd: 700, matchedUsd: 690, routedUsd: 10 }
      : i === 11 || i === 12 ? { ...d, fills: 2, usd: 20, matchedUsd: 5, routedUsd: 15 } : d),
    topPairs: [{ assetIn: USDC22, assetOut: USDC21, fills: 3, usd: 300 }],
  }
  const html = render(data)

  it('says what an intent is before the figures, with a glossary of the terms it uses', () => {
    expect(html).toContain('An intent is an order that says what you want')
    for (const term of ['<dt>Intent</dt>', '<dt>ICE</dt>', '<dt>Solver</dt>', '<dt>Matched</dt>', '<dt>Routed</dt>']) expect(html).toContain(term)
    expect(html).not.toMatch(/submit_solution|set_solver_mode/)
  })
  it('calls out a window whose matched volume is one day', () => {
    expect(html).toContain(`$690 of the $700 matched came on`)
    expect(html).toContain('on a typical day with any match it was $5.00')
    expect(days[10]).toBeDefined()
  })
  it('tells two assets that share a symbol apart by id', () => {
    expect(html).toContain('#22')
    expect(html).toContain('#21')
  })
  it('folds a long routing target behind a button any input can open', () => {
    expect(html).toMatch(/<button[^>]*class="ice-more"[^>]*aria-expanded="false"[^>]*>\+3 more<\/button>/)
  })
  it('gives the open book real tabs with a labelled panel', () => {
    expect(html).toMatch(/role="tab" id="ice-book-tab-limit" aria-controls="ice-book-panel-limit" aria-selected="true"/)
    expect(html).toMatch(/role="tabpanel" id="ice-book-panel-limit" aria-labelledby="ice-book-tab-limit"/)
  })
  it('states how fresh the 30-day figures are', () => {
    expect(html).toContain('30-day figures as of')
  })
})
