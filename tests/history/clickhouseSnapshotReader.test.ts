import { describe, expect, it } from 'vitest'
import {
  normalizeAssetIdList,
  normalizeEquivalenceList,
} from '../../src/history/clickhouseSnapshotReader.ts'
import {
  mergeRawRanges,
  missingRawCoverage,
} from '../../src/raw/ranges.ts'

describe('normalizeAssetIdList', () => {
  it('returns numeric arrays unchanged', () => {
    expect(normalizeAssetIdList([10, 18, 23, 21])).toEqual([10, 18, 23, 21])
  })

  it('decodes legacy hex-encoded asset id lists from historical snapshots', () => {
    expect(normalizeAssetIdList('0x0a121715')).toEqual([10, 18, 23, 21])
  })

  it('returns an empty list for empty hex payloads', () => {
    expect(normalizeAssetIdList('0x')).toEqual([])
  })

  it.each([1.5, -1, '12junk', BigInt(Number.MAX_SAFE_INTEGER) + 1n])(
    'rejects malformed numeric asset ids (case %#)',
    (value) => {
      expect(() => normalizeAssetIdList([value])).toThrow('Snapshot asset id')
    },
  )

  it('rejects unsupported scalar list encodings', () => {
    expect(() => normalizeAssetIdList(12)).toThrow('Unsupported snapshot asset id list')
  })

  it.each(['0x0', '0xgg'])('rejects malformed hex list %s', (value) => {
    expect(() => normalizeAssetIdList(value)).toThrow('Malformed hex snapshot asset id list')
  })
})

describe('normalizeEquivalenceList', () => {
  it('returns numeric pairs unchanged', () => {
    expect(normalizeEquivalenceList([[690, 69], [4200, 420]])).toEqual([
      [690, 69],
      [4200, 420],
    ])
  })

  it('decodes mixed legacy lp equivalence entries from historical snapshots', () => {
    expect(normalizeEquivalenceList(['0x6814', [690, 69], [4200, 420]])).toEqual([
      [104, 20],
      [690, 69],
      [4200, 420],
    ])
  })

  it('decodes multiple pairs from a single hex payload', () => {
    expect(normalizeEquivalenceList('0x68146e56')).toEqual([
      [104, 20],
      [110, 86],
    ])
  })

  it('rejects unpaired equivalence entries', () => {
    expect(() => normalizeEquivalenceList('0x010203')).toThrow('unpaired asset id')
  })
})

describe('raw range coverage helpers', () => {
  it('merges overlapping and adjacent completed ranges', () => {
    expect(mergeRawRanges([
      { fromBlock: 20, toBlock: 30 },
      { fromBlock: 1, toBlock: 10 },
      { fromBlock: 11, toBlock: 15 },
      { fromBlock: 14, toBlock: 18 },
    ])).toEqual([
      { fromBlock: 1, toBlock: 18 },
      { fromBlock: 20, toBlock: 30 },
    ])
  })

  it('finds uncovered intervals inside a requested range', () => {
    expect(missingRawCoverage(1, 30, [
      { fromBlock: 1, toBlock: 10 },
      { fromBlock: 15, toBlock: 20 },
      { fromBlock: 25, toBlock: 30 },
    ])).toEqual([
      { fromBlock: 11, toBlock: 14 },
      { fromBlock: 21, toBlock: 24 },
    ])
  })
})
