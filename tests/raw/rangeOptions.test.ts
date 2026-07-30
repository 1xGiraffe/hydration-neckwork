import { describe, expect, it } from 'vitest'
import { boundedRawRangeFromOptions } from '../../src/raw/indexer.ts'

describe('boundedRawRangeFromOptions', () => {
  it('returns null for unbounded raw runs', () => {
    expect(boundedRawRangeFromOptions({})).toBeNull()
    expect(boundedRawRangeFromOptions({ fromBlock: 100 })).toBeNull()
  })

  it('requires an explicit from block for finalized raw ranges', () => {
    expect(() => boundedRawRangeFromOptions({ toBlock: 200 })).toThrow(
      '--from-block is required when --to-block is used for raw range finalization',
    )
  })

  it('returns explicit raw range bounds', () => {
    expect(boundedRawRangeFromOptions({ fromBlock: 100, toBlock: 200 })).toEqual({
      fromBlock: 100,
      toBlock: 200,
    })
  })

  it('rejects invalid bounds before opening the database', () => {
    expect(() => boundedRawRangeFromOptions({ fromBlock: 201, toBlock: 200 })).toThrow(
      '--to-block (200) must be greater than or equal to --from-block (201)',
    )
    expect(() => boundedRawRangeFromOptions({ fromBlock: -1, toBlock: 200 })).toThrow(RangeError)
  })
})
