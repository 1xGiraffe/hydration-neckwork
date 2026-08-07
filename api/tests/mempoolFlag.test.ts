import { describe, expect, it } from 'vitest'
import { envFlag, mempoolEnabled, mempoolGeneration, mempoolTxs, findMempoolTx } from '../src/services/pendingHeadService.ts'

// Reading the transaction pool is opt-in per deployment (EXPLORER_MEMPOOL). Off
// is the default because the layer needs a node answering
// author_pendingExtrinsics plus the DryRunApi, and because it publishes
// projections rather than chain facts.
describe('EXPLORER_MEMPOOL flag', () => {
  it('accepts the usual affirmative spellings and nothing else', () => {
    for (const on of ['on', 'ON', '1', 'true', 'TRUE', 'yes', ' on ']) expect(envFlag(on), on).toBe(true)
    for (const off of [undefined, '', ' ', '0', 'false', 'no', 'off', 'maybe']) expect(envFlag(off), String(off)).toBe(false)
  })

  // The suite runs without the variable set, which is also the shipped default.
  it('is off unless the deployment sets it', () => {
    expect(process.env.EXPLORER_MEMPOOL).toBeUndefined()
    expect(mempoolEnabled()).toBe(false)
  })

  // Off, every merge must see an empty layer — the feeds are then byte-for-byte
  // what they were before the pool existed, with no extra guard at each call site.
  it('reads empty everywhere when off, so the feed merges are no-ops', () => {
    expect(mempoolTxs()).toEqual([])
    expect(mempoolGeneration()).toBe(0)
    expect(findMempoolTx('0x' + 'ab'.repeat(32))).toBeNull()
  })
})
