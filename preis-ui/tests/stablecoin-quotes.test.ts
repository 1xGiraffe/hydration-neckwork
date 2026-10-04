import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPairUrl,
  getDefaultPairs,
  normalizeQuoteAsset,
  pairDisplay,
  pairDocumentTitle,
  parseUrlPair,
  presentedQuote,
  readQuoteAsset,
  samePair,
  searchPairs,
} from '../src/utils/pairs'
import { fetchPriceSource, parsePriceSource } from '../src/api/priceSource'
import { fetchCandles } from '../src/api/candles'
import { parseFavorites } from '../src/hooks/useFavorites'
import type { Asset } from '../src/types'

// A pair quoted in a USD-pegged stablecoin by name (PRIMEUSDT) is a different
// chart from PRIME (USD) only while the API prices it by route; it shares the
// ids of the USD pair and is told apart by `?quote=asset` / `quoteAsset=1`.

const asset = (assetId: number, symbol: string, flags: { isStablecoin?: boolean; isUsdPegged?: boolean } = {}): Asset => ({
  assetId,
  symbol,
  name: `${symbol} name`,
  decimals: 6,
  isStablecoin: flags.isStablecoin ?? false,
  isUsdPegged: flags.isUsdPegged ?? false,
  parachainId: null,
})

const usd = { isStablecoin: true, isUsdPegged: true }
const HDX = asset(0, 'HDX')
const DOT = asset(5, 'DOT')
const USDT = asset(10, 'USDT', usd)
const USDC = asset(22, 'USDC', usd)
const USDT_WH = asset(23, 'USDT', usd)
const PRIME = asset(43, 'PRIME')
const EURC = asset(44, 'EURC', { isStablecoin: true })
const USDC_ETH = asset(1000766, 'USDC', usd)
const ASSETS = [HDX, DOT, USDT, USDC, USDT_WH, PRIME, EURC, USDC_ETH]

const labels = (query: string, stableQuotes?: boolean) =>
  searchPairs(query, ASSETS, stableQuotes == null ? undefined : { stableQuotes })
    .map(p => `${p.display}:${p.base.assetId}-${p.quote.assetId}${p.quoteAsset ? ':asset' : ''}`)

describe('stablecoin-quoted search results', () => {
  it('are absent unless offered, leaving the list exactly as before', () => {
    expect(labels('PRIME', false)).toEqual(labels('PRIME'))
    expect(labels('PRIME')).not.toContainEqual(expect.stringContaining(':asset'))
    expect(labels('PRIME')[0]).toBe('PRIMEUSD:43-10')
  })

  it('offer USDT and USDC by name when enabled, after the USD pair', () => {
    const results = labels('PRIME', true)
    expect(results[0]).toBe('PRIMEUSD:43-10')
    expect(results).toContain('PRIMEUSDT:43-10:asset')
    expect(results).toContain('PRIMEUSDC:43-22:asset')
    // Only the canonical Asset Hub ids, never the bridged copies.
    expect(results.filter(r => r.startsWith('PRIMEUSD') && r.endsWith(':asset'))).toHaveLength(2)
  })

  it('present the quote as a named, non-USD leg', () => {
    const row = searchPairs('PRIMEUSDC', ASSETS, { stableQuotes: true })[0]
    expect(row.quoteAsset).toBe(true)
    expect(row.quote.assetId).toBe(22)
    expect(row.quote.isUsdPegged).toBe(false)
    expect(pairDisplay(row.base, row.quote)).toBe('PRIMEUSDC')
  })

  it('leave the default list alone', () => {
    expect(getDefaultPairs(ASSETS).some(p => p.quoteAsset)).toBe(false)
  })
})

describe('labels and titles', () => {
  it('names the stablecoin only on a stablecoin-quoted pair', () => {
    expect(pairDisplay(PRIME, USDT)).toBe('PRIME')
    expect(pairDisplay(PRIME, USDT, true)).toBe('PRIMEUSDT')
    expect(pairDisplay(PRIME, USDC, true)).toBe('PRIMEUSDC')
    expect(pairDisplay(PRIME, presentedQuote(USDC, true))).toBe('PRIMEUSDC')
    // The flag means nothing on a quote that is already named.
    expect(pairDisplay(PRIME, DOT, true)).toBe('PRIMEDOT')
  })

  it('titles the tab with the named pair', () => {
    expect(pairDocumentTitle(pairDisplay(PRIME, USDT, true), null)).toBe('PRIMEUSDT')
    expect(pairDocumentTitle(pairDisplay(PRIME, USDT, true), 1.0605)).toMatch(/^PRIMEUSDT 1\.06/)
    expect(pairDocumentTitle(pairDisplay(PRIME, USDT), 1.0605)).toMatch(/^PRIME 1\.06/)
  })
})

describe('pair URLs', () => {
  it('keep the plain pair URL unchanged', () => {
    expect(buildPairUrl({ baseId: 43, quoteId: 10, quoteAsset: false }, '1h')).toBe('/43-10/1h')
    expect(buildPairUrl({ baseId: 43, quoteId: 10, quoteAsset: false }, '1h', 1_700_000_000)).toBe('/43-10/1h?inspect=1700000000')
  })

  it('mark a stablecoin-quoted pair with ?quote=asset', () => {
    expect(buildPairUrl({ baseId: 43, quoteId: 10, quoteAsset: true }, '1h')).toBe('/43-10/1h?quote=asset')
    expect(buildPairUrl({ baseId: 43, quoteId: 22, quoteAsset: true }, '4h', 1_700_000_000)).toBe('/43-22/4h?quote=asset&inspect=1700000000')
    expect(parseUrlPair('43-22')).toEqual({ baseId: 43, quoteId: 22 })
    expect(readQuoteAsset('?quote=asset')).toBe(true)
    expect(readQuoteAsset('?inspect=1&quote=asset')).toBe(true)
    expect(readQuoteAsset('')).toBe(false)
    expect(readQuoteAsset('?quote=usd')).toBe(false)
  })

  it('drop the flag where it changes nothing', () => {
    expect(normalizeQuoteAsset(USDT, true)).toBe(true)
    expect(normalizeQuoteAsset(DOT, true)).toBe(false)
    expect(normalizeQuoteAsset(EURC, true)).toBe(false)
    expect(normalizeQuoteAsset(undefined, true)).toBe(false)
    expect(normalizeQuoteAsset(USDT, false)).toBe(false)
  })

  it('tell the USD pair and the stablecoin pair apart', () => {
    expect(samePair({ baseId: 43, quoteId: 10, quoteAsset: false }, { baseId: 43, quoteId: 10, quoteAsset: true })).toBe(false)
    expect(samePair({ baseId: 43, quoteId: 10, quoteAsset: true }, { baseId: 43, quoteId: 10, quoteAsset: true })).toBe(true)
  })
})

describe('favorites', () => {
  it('read entries saved before the flag as plain pairs and keep the two apart', () => {
    const raw = JSON.stringify([
      { baseId: 43, quoteId: 10 },
      { baseId: 43, quoteId: 10, quoteAsset: true },
      { baseId: 43, quoteId: 10, quoteAsset: false },
      { baseId: 43, quoteId: 10, quoteAsset: true },
    ])
    expect(parseFavorites(raw)).toEqual([
      { baseId: 43, quoteId: 10 },
      { baseId: 43, quoteId: 10, quoteAsset: true },
    ])
  })
})

describe('price source', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads route only when the API says so', () => {
    expect(parsePriceSource({ priceSource: 'route' })).toBe('route')
    expect(parsePriceSource({ priceSource: 'usd-ratio' })).toBe('usd-ratio')
    expect(parsePriceSource({ priceSource: 'other' })).toBe('usd-ratio')
    expect(parsePriceSource([])).toBe('usd-ratio')
    expect(parsePriceSource(null)).toBe('usd-ratio')
  })

  it('falls back to usd-ratio when the route fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    await expect(fetchPriceSource()).resolves.toBe('usd-ratio')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    await expect(fetchPriceSource()).resolves.toBe('usd-ratio')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })))
    await expect(fetchPriceSource()).resolves.toBe('usd-ratio')
  })

  it('asks the candles price-source route', async () => {
    const fetchMock = vi.fn(async () => Response.json({ priceSource: 'route' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchPriceSource()).resolves.toBe('route')
    expect(fetchMock).toHaveBeenCalledWith('/api/candles/price-source', { signal: undefined })
  })

  it('still propagates a cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError') }))
    await expect(fetchPriceSource()).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('candle requests', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('ask for the quote asset only on a stablecoin-quoted pair', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => Response.json([]))
    vi.stubGlobal('fetch', fetchMock)
    const params = { baseId: 43, quoteId: 10, interval: '1h' as const, from: 1, to: 2 }
    await fetchCandles(params)
    await fetchCandles({ ...params, quoteAsset: true })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/candles?baseId=43&quoteId=10&interval=1h&from=1&to=2')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/candles?baseId=43&quoteId=10&interval=1h&from=1&to=2&quoteAsset=1')
  })
})
