import type { Asset } from '../types'

export interface PairResult {
  base: Asset
  quote: Asset
  display: string       // "HDXUSD", "DOTETH", "USDTUSDC Tether | USDC (Ethereum native)"
  nameHint: string | null
}

export function pairDisplay(base: Asset, quote: Asset): string {
  return quote.isStablecoin ? base.symbol : base.symbol + quote.symbol
}

function pairNameHint(base: Asset, quote: Asset): string | null {
  const names = [base.name, quote.name].filter(Boolean)
  return names.length > 0 ? names.join(' | ') : null
}

export function getDefaultPairs(assets: Asset[]): PairResult[] {
  const usdt = assets.find(a => a.assetId === 10)
  if (!usdt) return []
  return assets
    .filter(a => !a.isStablecoin)
    .map(a => ({
      base: a,
      quote: usdt,
      display: a.symbol + 'USD',
      nameHint: a.name,
    }))
    .sort((a, b) => a.display.localeCompare(b.display))
}

export function displayLabel(display: string): string {
  return display.endsWith('USD') ? display.slice(0, -3) : display
}

function matchesPairQuery(label: string, baseSymbol: string, q: string): boolean {
  return label.toUpperCase().startsWith(q) || baseSymbol.toUpperCase().startsWith(q)
}

export function searchPairs(query: string, assets: Asset[]): PairResult[] {
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
      // Skip stablecoin quotes for non-stablecoins (covered by USD virtual pair)
      if (quote.isStablecoin && !base.isStablecoin) continue

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
  })
}

// Parse URL: "/0-10/1h" → { baseId: 0, quoteId: 10 }
export function parseUrlPair(slug: string): { baseId: number; quoteId: number } | null {
  const parts = slug.split('-')
  if (parts.length !== 2) return null
  const baseId = parseInt(parts[0], 10)
  const quoteId = parseInt(parts[1], 10)
  if (isNaN(baseId) || isNaN(quoteId)) return null
  return { baseId, quoteId }
}
