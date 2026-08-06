import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../src/api/explorer'
import { useAddressHistory, useAssetFilterOptions, useAssets } from '../src/hooks/useExplorerData'
import { tokenFilterOptions } from '../src/components/Filters'
import { mockSync } from './fixtures/mockApi'
import type { AccountHistoryResponse, AssetFilterItem, AssetListItem } from '../src/types'

// Two endpoints serve a narrowed shape on request: the account history without the
// per-asset balance history (98-99% of it, read only by the Balances treemap), and
// the asset directory without prices or sparklines (57% of it, read only by the
// Assets page). Both are opt-in query parameters, so what these pin is that a
// caller who does not opt in still gets exactly the response it got before, and
// that the two shapes can never be served to each other out of the client cache.
const ADDRESS = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('narrowing is opt-in on the wire', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('leaves the default requests parameterless', async () => {
    const fetchMock = stubFetch()
    await api.addressHistory(ADDRESS)
    await api.assets()
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      `/api/explorer/address/${ADDRESS}/history`,
      '/api/explorer/assets',
    ])
  })

  it('adds exactly one parameter for each narrowed variant', async () => {
    const fetchMock = stubFetch()
    await api.addressHistorySeries(ADDRESS)
    await api.assetFilterOptions()
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      `/api/explorer/address/${ADDRESS}/history?series=1`,
      '/api/explorer/assets?fields=filter',
    ])
  })
})

describe('the two shapes of one endpoint get their own cache entries', () => {
  // Sharing a key would let whichever tab a reader opened first decide the shape:
  // an Overview-first visit would hand the treemap a response whose balanceHistory
  // is empty by design, and an Activity-first visit would hand the Assets table
  // rows with no price, TVL or sparkline.
  function keysFor(render: () => void): unknown[][] {
    const client = new QueryClient()
    function Probe() { render(); return null }
    renderToStaticMarkup(<QueryClientProvider client={client}><Probe /></QueryClientProvider>)
    return client.getQueryCache().getAll().map(query => query.queryKey as unknown[])
  }

  it('keys the account history on the shape as well as the address', () => {
    expect(keysFor(() => {
      useAddressHistory(ADDRESS, true)
      useAddressHistory(ADDRESS, false)
    })).toEqual([
      ['address-history', ADDRESS, 'series'],
      ['address-history', ADDRESS, 'full'],
    ])
  })

  it('keys the asset directory apart from its filter projection', () => {
    expect(keysFor(() => {
      useAssets()
      useAssetFilterOptions()
    })).toEqual([['assets'], ['assets-filter']])
  })

  it('does not serve a cached series-only history to a full-history reader', () => {
    const client = new QueryClient()
    const light: AccountHistoryResponse = { portfolioSeries: [1, 2], portfolioDates: ['2026-07-01', '2026-07-02'], balanceHistory: [] }
    client.setQueryData(['address-history', ADDRESS, 'series'], light)
    let seen: AccountHistoryResponse | undefined
    function Probe() { seen = useAddressHistory(ADDRESS, false).data; return null }
    renderToStaticMarkup(<QueryClientProvider client={client}><Probe /></QueryClientProvider>)
    expect(seen).toBeUndefined()
  })
})

describe('the token filter offers the same options from either asset shape', () => {
  const full = mockSync<AssetListItem[]>('/explorer/assets')!
  const projected = mockSync<AssetFilterItem[]>('/explorer/assets?fields=filter')!

  it('projects every row, in order, and nothing else', () => {
    expect(full).toHaveLength(12)
    expect(projected).toHaveLength(12)
    expect(projected.map(a => a.assetId)).toEqual(full.map(a => a.assetId))
    for (const asset of projected) expect(Object.keys(asset)).toEqual(['assetId', 'symbol', 'name'])
  })

  it('builds an identical option list from the projection', () => {
    const options = tokenFilterOptions(projected)
    expect(options).toEqual(tokenFilterOptions(full))
    expect(options).toHaveLength(12)
  })

  it('names a deep-linked token id, so ?token=<id> never renders as a bare number', () => {
    // The rejected alternative — fetching options only when the combo opens — left a
    // shared /activity?token=5 link showing "5" instead of "DOT" until it was opened.
    const options = tokenFilterOptions(projected)
    expect(options.find(option => option.value === '5')?.label).toBe('DOT')
    expect(options.find(option => option.value === '0')?.label).toBe('HDX')
    // Duplicate symbols stay distinguishable because the id is the option value.
    expect(new Set(options.map(option => option.value)).size).toBe(12)
  })
})
