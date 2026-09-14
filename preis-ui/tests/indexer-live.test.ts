import { describe, expect, it } from 'vitest'
import { indexerLiveDot, type IndexerStatus } from '../src/api/indexer'

// The LIVE dot has to distinguish "following the chain" from "stalled". It cannot
// read that off blocksBehindHead: when the API's chain-head sample is unavailable it
// measures that against raw ingestion's own head, and both pipelines stall together,
// so it reports 0 — fully synced — exactly when the indicator matters.
const status = (over: Partial<IndexerStatus> = {}): IndexerStatus => ({
  blockHeight: 13_307_175,
  lagSeconds: 40,
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

  it('reads the age of the newest block, never the distance to the head', () => {
    // The response also carries blocksBehindHead, which a stalled pipeline
    // reports as 0 whenever the API could not sample the chain head. The dot
    // never reads it, so that zero cannot turn a stalled indexer green.
    expect(indexerLiveDot(status({ lagSeconds: 900 }))).toBe(false)
  })

  it('is not live before any status has loaded', () => {
    expect(indexerLiveDot(undefined)).toBe(false)
  })
})
