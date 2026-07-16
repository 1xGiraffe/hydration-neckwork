import { describe, expect, it } from 'vitest'
import { parseBlockHeight, validateBlockRange } from '../src/blockRange.ts'

describe('block range validation', () => {
  it.each([
    ['0', 0],
    ['123', 123],
    ['4294967295', 4_294_967_295],
  ])('parses valid block height %s', (raw, expected) => {
    expect(parseBlockHeight(raw, '--from-block')).toBe(expected)
  })

  it.each(['', '-1', '1.5', '1e3', '12junk', '4294967296'])(
    'rejects invalid block height %s',
    (raw) => {
      expect(() => parseBlockHeight(raw, '--from-block')).toThrow(RangeError)
    },
  )

  it('accepts an ordered inclusive range', () => {
    expect(() => validateBlockRange({ fromBlock: 10, toBlock: 10 })).not.toThrow()
    expect(() => validateBlockRange({ fromBlock: 10, toBlock: 20 })).not.toThrow()
  })

  it('rejects reversed and programmatically invalid ranges', () => {
    expect(() => validateBlockRange({ fromBlock: 20, toBlock: 10 })).toThrow(
      '--to-block (10) must be greater than or equal to --from-block (20)',
    )
    expect(() => validateBlockRange({ fromBlock: Number.NaN })).toThrow(RangeError)
    expect(() => validateBlockRange({ toBlock: -1 })).toThrow(RangeError)
  })
})
