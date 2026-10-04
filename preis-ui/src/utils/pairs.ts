import type { Asset } from '../types'
import { formatPrice } from './format'

export interface PairResult {
  base: Asset
  // Already the presented quote: for a stablecoin-quoted pair this is
  // `namedQuote(asset)`, so every consumer reads it as a cross pair.
  quote: Asset
  display: string       // "HDXUSD", "DOTETH", "USDTUSDC Tether | USDC (Ethereum native)"
  nameHint: string | null
  // Priced against the quote asset itself rather than read as USD.
  quoteAsset?: boolean
}

/**
 * A pair's identity. A USD-pegged quote normally stands in for USD, so
 * `/43-10` is PRIME (USD). With `quoteAsset` the same ids name PRIME priced
 * against USDT itself — which the API prices by trade route when its pair price
 * source is 'route', so the two charts differ there.
 */
export interface PairKey {
  baseId: number
  quoteId: number
  quoteAsset: boolean
}

// The stablecoins a pair can be quoted in by name: the Asset Hub USDT and USDC,
// by far the most traded of their registry ids. The bridged copies (21, 23,
// 1000766, 1000767) are left out: they would only add near-identical rows.
// Non-USD quotes (HOLLAR, DOT, EURC, …) need no entry — they are ordinary
// cross pairs already.
export const STABLE_QUOTE_IDS: readonly number[] = [10, 22]

/** The flag only means something on a USD-pegged quote; elsewhere it is dropped. */
export function normalizeQuoteAsset(quote: Asset | undefined, quoteAsset: boolean): boolean {
  return quoteAsset && (quote?.isUsdPegged ?? false)
}

/**
 * The quote as a stablecoin-quoted pair presents it: the same asset, no longer
 * standing in for USD, so labels, icons, price formatting and the change all
 * follow the cross-pair path.
 */
export function namedQuote(quote: Asset): Asset {
  return quote.isUsdPegged ? { ...quote, isUsdPegged: false } : quote
}

/** The quote as the UI presents it for this pair. */
export function presentedQuote(quote: Asset, quoteAsset: boolean): Asset {
  return quoteAsset ? namedQuote(quote) : quote
}

export function samePair(a: PairKey, b: PairKey): boolean {
  return a.baseId === b.baseId && a.quoteId === b.quoteId && a.quoteAsset === b.quoteAsset
}

export function pairKeyString(key: PairKey): string {
  return `${key.baseId}-${key.quoteId}${key.quoteAsset ? '-asset' : ''}`
}

// A USD-pegged quote is implied by the bare base symbol ("HDX" = HDX/USD); any
// other quote, EURC included, has to be named — and so does a USD-pegged one
// the pair is priced against by name ("PRIMEUSDT").
export function pairDisplay(base: Asset, quote: Asset, quoteAsset = false): string {
  return presentedQuote(quote, quoteAsset).isUsdPegged ? base.symbol : base.symbol + quote.symbol
}

function pairNameHint(base: Asset, quote: Asset): string | null {
  const names = [base.name, quote.name].filter(Boolean)
  return names.length > 0 ? names.join(' | ') : null
}

/**
 * The USD pairs shown before anything is typed. `volumeUsd24h` ranks them when
 * the caller can look a 24h volume up by asset id; without it the list is
 * alphabetical.
 */
export function getDefaultPairs(assets: Asset[], volumeUsd24h?: (assetId: number) => number): PairResult[] {
  const usdt = assets.find(a => a.assetId === 10)
  if (!usdt) return []
  const list: PairResult[] = assets
    .filter(a => !a.isStablecoin)
    .map(a => ({
      base: a,
      quote: usdt,
      display: a.symbol + 'USD',
      nameHint: a.name,
    }))
  if (volumeUsd24h) {
    list.sort((a, b) => {
      const va = volumeUsd24h(a.base.assetId)
      const vb = volumeUsd24h(b.base.assetId)
      if (va !== vb) return vb - va
      return a.display.localeCompare(b.display)
    })
  } else {
    list.sort((a, b) => a.display.localeCompare(b.display))
  }
  return list
}

export function displayLabel(display: string): string {
  return display.endsWith('USD') ? display.slice(0, -3) : display
}

function matchesPairQuery(label: string, baseSymbol: string, q: string): boolean {
  return label.toUpperCase().startsWith(q) || baseSymbol.toUpperCase().startsWith(q)
}

// Every asset against every asset is quadratic, and a one-character query
// matches hundreds of pairs — each of which renders two CDN-backed icons and a
// sparkline. Nothing below the fold is read before the query narrows, so the
// list is cut after the ranking, never before it.
const MAX_SEARCH_RESULTS = 100

export interface SearchOptions {
  // Offer pairs quoted in STABLE_QUOTE_IDS by name. Only worth offering while
  // the API prices them differently from USD (price source 'route'); otherwise
  // each would be a second copy of the USD chart.
  stableQuotes?: boolean
}

export function searchPairs(query: string, assets: Asset[], options: SearchOptions = {}): PairResult[] {
  const q = query.trim().toUpperCase()
  if (!q) return getDefaultPairs(assets)

  const results: PairResult[] = []
  const seen = new Set<string>()
  const usdt = assets.find(a => a.assetId === 10)

  for (const base of assets) {
    // USD pair (using USDT id=10 as quote)
    if (usdt && base.assetId !== usdt.assetId) {
      const display = base.symbol + 'USD'
      const label = displayLabel(display)
      const key = `${base.assetId}-${usdt.assetId}`
      if (!seen.has(key) && matchesPairQuery(label, base.symbol, q)) {
        seen.add(key)
        results.push({ base, quote: usdt, display, nameHint: base.name })
      }
    }

    // Cross pairs
    for (const quote of assets) {
      if (base.assetId === quote.assetId) continue
      if (options.stableQuotes && STABLE_QUOTE_IDS.includes(quote.assetId)) {
        const named = namedQuote(quote)
        const display = base.symbol + named.symbol
        const key = `${base.assetId}-${quote.assetId}-asset`
        if (!seen.has(key) && matchesPairQuery(display, base.symbol, q)) {
          seen.add(key)
          results.push({ base, quote: named, display, nameHint: pairNameHint(base, named), quoteAsset: true })
        }
        continue
      }
      // Skip USD-pegged quotes for non-stablecoins (covered by the USD virtual pair)
      if (quote.isUsdPegged && !base.isStablecoin) continue

      const display = base.symbol + quote.symbol
      const label = displayLabel(display)
      const key = `${base.assetId}-${quote.assetId}`
      if (!seen.has(key) && matchesPairQuery(label, base.symbol, q)) {
        seen.add(key)
        results.push({ base, quote, display, nameHint: pairNameHint(base, quote) })
      }
    }
  }

  return results.sort((a, b) => {
    const aLabel = displayLabel(a.display).toUpperCase()
    const bLabel = displayLabel(b.display).toUpperCase()
    // Exact match on displayed label first
    const aExact = aLabel === q ? 0 : 1
    const bExact = bLabel === q ? 0 : 1
    if (aExact !== bExact) return aExact - bExact
    // Label starts with query
    const aStarts = aLabel.startsWith(q) ? 0 : 1
    const bStarts = bLabel.startsWith(q) ? 0 : 1
    if (aStarts !== bStarts) return aStarts - bStarts
    // Shorter label = closer match
    if (aLabel.length !== bLabel.length) return aLabel.length - bLabel.length
    return aLabel.localeCompare(bLabel)
  }).slice(0, MAX_SEARCH_RESULTS)
}

/** The tab title: the pair's label, then its last close once candles are in. */
export function pairDocumentTitle(display: string, lastClose: number | null): string {
  return lastClose != null ? `${display} ${formatPrice(lastClose, false)}` : display
}

const QUOTE_QUERY_PARAM = 'quote'
const QUOTE_ASSET_VALUE = 'asset'
export const INSPECTION_QUERY_PARAM = 'inspect'

/** `?quote=asset` marks a stablecoin-quoted pair; anything else is the plain pair. */
export function readQuoteAsset(search: string): boolean {
  return new URLSearchParams(search).get(QUOTE_QUERY_PARAM) === QUOTE_ASSET_VALUE
}

/** "/43-10/1h", "/43-10/1h?quote=asset", "/43-10/1h?quote=asset&inspect=…". */
export function buildPairUrl(key: PairKey, interval: string, inspectionTime: number | null = null): string {
  const path = `/${key.baseId}-${key.quoteId}/${interval}`
  const params = new URLSearchParams()
  if (key.quoteAsset) params.set(QUOTE_QUERY_PARAM, QUOTE_ASSET_VALUE)
  if (inspectionTime != null) params.set(INSPECTION_QUERY_PARAM, String(inspectionTime))
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

// Parse URL: "/0-10/1h" → { baseId: 0, quoteId: 10 }
export function parseUrlPair(slug: string): { baseId: number; quoteId: number } | null {
  const match = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(slug)
  if (!match) return null
  const baseId = Number(match[1])
  const quoteId = Number(match[2])
  if (!Number.isSafeInteger(baseId) || !Number.isSafeInteger(quoteId) || baseId === quoteId) return null
  return { baseId, quoteId }
}
