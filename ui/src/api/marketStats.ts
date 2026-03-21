import type { AssetMarketStats } from '../types'

export async function fetchMarketStats(): Promise<AssetMarketStats[]> {
  const res = await fetch('/api/market-stats')
  if (!res.ok) {
    throw new Error(`Failed to fetch market stats: ${res.status}`)
  }
  return res.json()
}
