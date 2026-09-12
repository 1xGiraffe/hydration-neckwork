import type { AssetBookEntry, AssetLimitOrderBook } from '../types'

// Pure arithmetic behind an asset's limit-order book, kept out of the component
// so both can be read — and tested — on their own.

// A row's depth bar: its resting size as a share of the LARGEST on its side, so
// one glance says where the size sits. Share of the biggest rather than of the
// side's total — two orders would otherwise always read as two half-full bars
// however lopsided they actually are.
export function depthShare(entry: Pick<AssetBookEntry, 'sizeUsd'>, max: number): number {
  if (!(max > 0)) return 0
  const v = entry.sizeUsd ?? 0
  return Math.max(0, Math.min(1, v / max))
}

export function maxSideSizeUsd(entries: Pick<AssetBookEntry, 'sizeUsd'>[]): number {
  return entries.reduce((m, e) => Math.max(m, e.sizeUsd ?? 0), 0)
}

// The gap between the best bid and the best ask, in dollars and as a share of
// their midpoint — the one figure a book has that neither ladder holds. Absent
// unless BOTH sides have a priced top, because a spread against nothing is not a
// spread; the best priced order is taken rather than the first row, since an
// order whose counter asset has no feed sorts last and is not a top of book.
//
// `absUsd` may come out negative. A crossed book is not an error here: the two
// orders can be quoted in different assets, and the solver fills against the AMM
// as well, so a crossing pair simply has not been matched yet.
export function bookSpread(book: AssetLimitOrderBook): { absUsd: number; pct: number; midUsd: number } | null {
  const bid = book.bids.find(b => b.priceUsd != null)?.priceUsd
  const ask = book.asks.find(a => a.priceUsd != null)?.priceUsd
  if (bid == null || ask == null) return null
  const midUsd = (bid + ask) / 2
  if (!(midUsd > 0)) return null
  return { absUsd: ask - bid, pct: ((ask - bid) / midUsd) * 100, midUsd }
}
