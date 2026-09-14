// The payload carries the whole ingestion picture; preis renders two of it —
// the height in the indexer chip and the lag behind the LIVE dot. Declaring
// only those keeps the app's read of the API honest about what it depends on.
export interface IndexerStatus {
  blockHeight: number
  lagSeconds: number
}

// The green LIVE dot means "following the chain", which is a question about how
// recent the newest indexed block is. Hydration produces a block every ~6s today
// (2s planned) and the price pipeline trails raw ingestion by a handful of
// blocks, so a two-minute window covers normal operation while a stall — whose
// block timestamp stops advancing — goes amber. blocksBehindHead cannot carry
// this on its own: without a chain-head sample the API measures it against raw
// ingestion's own head, and both pipelines stall together, so it reads 0 exactly
// when the indicator matters most.
const LIVE_LAG_SECONDS = 120

export function indexerLiveDot(status: IndexerStatus | undefined): boolean {
  return status != null && status.lagSeconds <= LIVE_LAG_SECONDS
}

export async function fetchIndexerStatus(signal?: AbortSignal): Promise<IndexerStatus> {
  const res = await fetch('/api/indexer', { signal })
  if (!res.ok) throw new Error(`Failed to fetch indexer status: ${res.status}`)
  return res.json()
}
