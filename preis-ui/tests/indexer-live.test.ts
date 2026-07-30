import { describe, expect, it } from 'vitest'
import { indexerLiveDot, type IndexerStatus } from '../src/api/indexer'

// The LIVE dot has to distinguish "following the chain" from "stalled". It cannot
// read that off blocksBehindHead: when the API's chain-head sample is unavailable it
// measures that against raw ingestion's own head, and both pipelines stall together,
// so it reports 0 — fully synced — exactly when the indicator matters.
const status = (over: Partial<IndexerStatus> = {}): IndexerStatus => ({
  blockHeight: 13_307_175,
  blockTimestamp: '2026-07-25 00:00:00',
  lagSeconds: 40,
  chainBlockHeight: 13_307_179,
  blocksBehindHead: 4,
  chainHeadSampled: true,
  rawFinalizedRangeCount: 1,
  rawFinalizedFromBlock: 1,
  rawFinalizedToBlock: 13_307_175,
  ...over,
})

describe('indexer live dot', () => {
  it('is live while the newest indexed block is recent', () => {
    expect(indexerLiveDot(status())).toBe(true)
    expect(indexerLiveDot(status({ lagSeconds: 74 }))).toBe(true)
  })

  it('is not live once the indexed block goes stale', () => {
    expect(indexerLiveDot(status({ lagSeconds: 121 }))).toBe(false)
    expect(indexerLiveDot(status({ lagSeconds: 3_600 }))).toBe(false)
  })

  it('does not trust a synthesised zero lag behind an unsampled chain head', () => {
    // A stalled pipeline keeps blocksBehindHead at 0 when the chain head is unknown.
    expect(indexerLiveDot(status({ chainHeadSampled: false, blocksBehindHead: 0, lagSeconds: 900 }))).toBe(false)
  })

  it('is not live before any status has loaded', () => {
    expect(indexerLiveDot(undefined)).toBe(false)
  })
})
