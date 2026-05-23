export interface IndexerStatus {
  blockHeight: number
  blockTimestamp: string
  lagSeconds: number
  chainBlockHeight: number
  blocksBehindHead: number
}

export async function fetchIndexerStatus(): Promise<IndexerStatus> {
  const res = await fetch('/api/indexer')
  if (!res.ok) throw new Error(`Failed to fetch indexer status: ${res.status}`)
  return res.json()
}
