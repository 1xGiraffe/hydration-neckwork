import { describe, expect, it } from 'vitest'
import {
  MAX_EXACT_BLOCKS, MISSING_LIST_CAP, SNAPSHOT_GRID_BLOCKS,
  alignToAssets, bucketKeyOf, bucketSlots, countSlots, gridSlots, headerAssetIds, missingSlots,
  normalizeStride, resolutionDescriptor, snapshotRequestProblem, snapshotSemantics, strideFor,
} from '../src/services/poolSnapshots.ts'

// The pure half of /explorer/pool/:poolId/snapshots. Every rule here is one a
// simulation calibrating on the series would otherwise have to guess at: where
// the points land, how a window is thinned, what "missing" counts, and how an
// observation is laid under the header's asset columns.

const G = SNAPSHOT_GRID_BLOCKS

describe('grid arithmetic', () => {
  it('counts and lists the multiples of a step inside an inclusive window', () => {
    expect(countSlots(0, 1_800, G)).toBe(4)
    expect(gridSlots(0, 1_800, G)).toEqual([0, 600, 1_200, 1_800])
    // Bounds off the grid round INWARD: the first slot is the first multiple at
    // or after `from`, the last the last multiple at or before `to`.
    expect(gridSlots(601, 1_799, G)).toEqual([1_200])
    expect(countSlots(601, 1_799, G)).toBe(1)
    expect(gridSlots(601, 1_199, G)).toEqual([])
    expect(countSlots(601, 1_199, G)).toBe(0)
    expect(countSlots(10, 5, G)).toBe(0)
  })

  it('rounds a caller\'s stride UP to the grid so every point is an observation', () => {
    expect(normalizeStride(1)).toBe(G)
    expect(normalizeStride(600)).toBe(G)
    expect(normalizeStride(601)).toBe(2 * G)
    expect(normalizeStride(1_200)).toBe(2 * G)
  })

  it('picks the smallest grid multiple that fits the window into the point budget', () => {
    // 6,063 grid slots (pool 143's life) into 50 points: ceil(6063 / 50) = 122.
    expect(strideFor(11_434_800, 15_072_000, 50)).toBe(122 * G)
    expect(countSlots(11_434_800, 15_072_000, 122 * G)).toBeLessThanOrEqual(50)
    // A window that already fits keeps the grid itself.
    expect(strideFor(15_069_000, 15_072_000, 48)).toBe(G)
    // Absolute alignment: the same block answers the same point in any window.
    expect(gridSlots(11_434_800, 15_072_000, 122 * G)[0] % (122 * G)).toBe(0)
  })
})

describe('coverage', () => {
  it('names missing slots up to the cap and counts the rest', () => {
    const expected = gridSlots(0, 600 * 99, G)   // 100 slots
    const present = expected.filter(b => b % 1_200 === 0)   // every other one
    const { missingCount, missing } = missingSlots(expected, present)
    expect(missingCount).toBe(50)
    expect(missing).toHaveLength(MISSING_LIST_CAP)
    expect(missing[0]).toBe(600)
    expect(missing).not.toContain(0)
    // Nothing missing when everything is there — and never a zero standing in.
    expect(missingSlots([0, 600], [600, 0])).toEqual({ missingCount: 0, missing: [] })
  })

  it('judges buckets by the same keys the points carry', () => {
    const t = Date.parse('2026-09-24T23:47:36Z') / 1000
    expect(bucketKeyOf('day', t)).toBe('2026-09-24')
    expect(bucketKeyOf('hour', t)).toBe('2026-09-24 23:00:00')
    expect(bucketSlots('day', t, Date.parse('2026-09-26T21:32:24Z') / 1000)).toEqual(['2026-09-24', '2026-09-25', '2026-09-26'])
    expect(bucketSlots('hour', t, t + 3_600)).toEqual(['2026-09-24 23:00:00', '2026-09-25 00:00:00'])
    expect(bucketSlots('day', t, t - 1)).toEqual([])
  })
})

describe('alignment', () => {
  it('lays an observation under the header order and leaves an absent leg null, never zero', () => {
    expect(alignToAssets([43, 222], [222, 43], ['b', 'a'])).toEqual(['a', 'b'])
    expect(alignToAssets([43, 222, 5], [43, 222], ['a', 'b'])).toEqual(['a', 'b', null])
    expect(alignToAssets([43], [43, 222], ['a'])).toEqual(['a'])
  })

  it('takes the newest observation\'s order and appends what older ones carried', () => {
    expect(headerAssetIds([{ assetIds: [5, 43] }, { assetIds: [43, 222] }])).toEqual([43, 222, 5])
    expect(headerAssetIds([])).toEqual([])
  })
})

describe('request rules', () => {
  it('accepts a well-formed request in every resolution', () => {
    expect(snapshotRequestProblem({ resolution: 'grid', limit: 10 })).toBeNull()
    expect(snapshotRequestProblem({ resolution: 'grid', fromBlock: 1, toBlock: 2, stepBlocks: 600, limit: 10 })).toBeNull()
    expect(snapshotRequestProblem({ resolution: 'day', fromTs: 1, toTs: 2, limit: 10 })).toBeNull()
    expect(snapshotRequestProblem({ resolution: 'block', fromBlock: 1, toBlock: 2, limit: 10 })).toBeNull()
  })

  it('refuses an inverted window, a time-addressed replay and a stride off the grid resolution', () => {
    expect(snapshotRequestProblem({ resolution: 'grid', fromBlock: 2, toBlock: 1, limit: 10 })).toMatch(/fromBlock/)
    expect(snapshotRequestProblem({ resolution: 'grid', fromTs: 2, toTs: 1, limit: 10 })).toMatch(/fromTs/)
    expect(snapshotRequestProblem({ resolution: 'block', fromTs: 1, limit: 10 })).toMatch(/fromBlock\/toBlock/)
    expect(snapshotRequestProblem({ resolution: 'day', stepBlocks: 600, limit: 10 })).toMatch(/grid/)
  })
})

describe('semantics', () => {
  it('states exactness, the grid and the thinning, and never promises a carried value', () => {
    const grid = snapshotSemantics('stableswap', 'grid', 1_200)
    expect(grid.points).toContain('exactly the block it names')
    expect(grid.points).toContain('every 2th grid block')
    expect(grid.points).toContain('not constant')
    expect(grid.missing).toContain('never zero')
    expect(grid.missing).toContain('coverage.nextFromBlock')
    expect(grid.fee).toContain('parts per MILLION')
    const day = snapshotSemantics('stableswap', 'day', null)
    expect(day.points).toContain('LAST grid observation at or before its end')
    expect(day.missing).toContain('calendar buckets')
    const block = snapshotSemantics('xyk', 'block', 1)
    expect(block.points).toContain('every block')
    // An aToken leg is named, with what its figure leaves out; a pool without one says nothing of the kind.
    expect(grid.reserves).not.toContain('aToken')
    const aToken = snapshotSemantics('stableswap', 'grid', 600, [{ assetId: 1003, symbol: 'aUSDC', decimals: 6 } as never])
    expect(aToken.reserves).toContain('aUSDC (#1003) is a money-market aToken')
    expect(aToken.reserves).toContain('NOT included')
    expect(block.issuance).toContain('last supply change at or before')
    expect(block.fee).toContain('3000 = 0.3%')
  })

  it('describes the resolution with the numbers a reader needs', () => {
    expect(resolutionDescriptor('grid', 1_200)).toEqual({ kind: 'grid', stepBlocks: 1_200, stepSec: null, gridBlocks: G })
    expect(resolutionDescriptor('day', null)).toEqual({ kind: 'day', stepBlocks: null, stepSec: 86_400, gridBlocks: G })
    expect(resolutionDescriptor('hour', null).stepSec).toBe(3_600)
    expect(resolutionDescriptor('block', null).stepBlocks).toBe(1)
    expect(MAX_EXACT_BLOCKS).toBe(200)
  })
})
