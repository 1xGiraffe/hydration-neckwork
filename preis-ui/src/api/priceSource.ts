// How the API prices a pair quoted in a USD-pegged stablecoin when it is asked
// for that stablecoin by name (`quoteAsset=1`). 'usd-ratio' answers with the
// base's USD candles, so a PRIMEUSDT chart would repeat PRIME (USD); 'route'
// prices the pair along its on-chain trade route, which can leave the Omnipool
// and so differ from USD. The UI offers stablecoin-quoted pairs only for 'route'.
export type PairPriceSource = 'usd-ratio' | 'route'

export function parsePriceSource(body: unknown): PairPriceSource {
  return body != null && typeof body === 'object' && (body as { priceSource?: unknown }).priceSource === 'route'
    ? 'route'
    : 'usd-ratio'
}

/**
 * Anything but an explicit 'route' — an error status, a body that does not
 * parse, a missing route — reads as 'usd-ratio', the behaviour the app had
 * before the switch existed. Only a cancellation propagates.
 */
export async function fetchPriceSource(signal?: AbortSignal): Promise<PairPriceSource> {
  try {
    const res = await fetch('/api/candles/price-source', { signal })
    if (!res.ok) return 'usd-ratio'
    return parsePriceSource(await res.json())
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    return 'usd-ratio'
  }
}
