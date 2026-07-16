export interface IndexerStatus {
  blockHeight: number
  blockTimestamp: string
  lagSeconds: number
  chainBlockHeight: number
  blocksBehindHead: number
  rawFinalizedRangeCount: number
  rawFinalizedFromBlock: number
  rawFinalizedToBlock: number
}

export async function fetchIndexerStatus(signal?: AbortSignal): Promise<IndexerStatus> {
  const res = await fetch('/api/indexer', { signal })
  if (!res.ok) throw new Error(`Failed to fetch indexer status: ${res.status}`)
  return res.json()
}
