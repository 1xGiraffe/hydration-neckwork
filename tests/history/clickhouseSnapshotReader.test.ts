import { describe, expect, it } from 'vitest'
import {
  normalizeAssetIdList,
  normalizeEquivalenceList,
} from '../../src/history/clickhouseSnapshotReader.ts'

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
})
