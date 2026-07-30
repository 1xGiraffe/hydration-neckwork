import type { Asset } from '../types'

export async function fetchAssets(signal?: AbortSignal): Promise<Asset[]> {
  const res = await fetch('/api/assets', { signal })
  if (!res.ok) {
    throw new Error(`Failed to fetch assets: ${res.status}`)
  }
  return res.json()
}
