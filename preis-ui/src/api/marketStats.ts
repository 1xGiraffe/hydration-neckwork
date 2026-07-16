import type { AssetMarketStats } from '../types'

export async function fetchMarketStats(signal?: AbortSignal): Promise<AssetMarketStats[]> {
  const res = await fetch('/api/market-stats', { signal })
  if (!res.ok) {
    throw new Error(`Failed to fetch market stats: ${res.status}`)
  }
  return res.json()
}
