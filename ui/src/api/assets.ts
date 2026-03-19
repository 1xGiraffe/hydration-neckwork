import type { Asset } from '../types'

export async function fetchAssets(): Promise<Asset[]> {
  const res = await fetch('/api/assets')
  if (!res.ok) {
    throw new Error(`Failed to fetch assets: ${res.status}`)
  }
  return res.json()
}
