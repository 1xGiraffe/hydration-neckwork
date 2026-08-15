import { describe, expect, it } from 'vitest'
import {
  assertSnapshotEveryNBlocks,
  MV_SNAPSHOT_GRID_BLOCKS,
  retainsSnapshotAtHeight,
  snapshotEveryNBlocksFromEnvironment,
  validSnapshotCadences,
} from '../../src/raw/snapshotCadence.ts'

// raw_block_snapshots is the largest table in the database (36% of all growth) and
// the only ingestion volume lever that is pure config. The thing that makes it
// dangerous is invisible: three pool-history MVs sample it at block_height % 600,
// and a cadence that does not divide 600 silently stops feeding them.
describe('raw snapshot cadence', () => {
  it('defaults to one row per block', () => {
    expect(snapshotEveryNBlocksFromEnvironment(undefined)).toBe(1)
    expect(snapshotEveryNBlocksFromEnvironment('')).toBe(1)
    expect(retainsSnapshotAtHeight(13_587_781, 1)).toBe(true)
    expect(retainsSnapshotAtHeight(13_587_782, 1)).toBe(true)
  })

  it('rejects a cadence that would starve the % 600 pool-history grid', () => {
    expect(() => assertSnapshotEveryNBlocks(7)).toThrow(/does not divide/)
    expect(() => assertSnapshotEveryNBlocks(9)).toThrow(/does not divide/)
    expect(() => snapshotEveryNBlocksFromEnvironment('7')).toThrow(/does not divide/)
  })

  it('rejects a non-positive or non-integer cadence rather than falling back', () => {
    expect(() => assertSnapshotEveryNBlocks(0)).toThrow(/positive integer/)
    expect(() => assertSnapshotEveryNBlocks(-3)).toThrow(/positive integer/)
    expect(() => assertSnapshotEveryNBlocks(1.5)).toThrow(/positive integer/)
    expect(() => snapshotEveryNBlocksFromEnvironment('three')).toThrow(/positive integer/)
  })

  // 3 is the value the migration runbook names: it holds snapshot volume flat
  // across a 6s → 2s change.
  it('keeps every MV grid height for every accepted cadence', () => {
    for (const cadence of validSnapshotCadences()) {
      expect(assertSnapshotEveryNBlocks(cadence)).toBe(cadence)
      for (const grid of [0, 600, 1_200, 13_587_600]) {
        expect(retainsSnapshotAtHeight(grid, cadence)).toBe(true)
      }
      expect(MV_SNAPSHOT_GRID_BLOCKS % cadence).toBe(0)
    }
    expect(validSnapshotCadences()).toContain(3)
  })

  it('thins by exactly the configured factor, on absolute heights', () => {
    const retained = []
    for (let height = 1_000; height < 1_030; height++) {
      if (retainsSnapshotAtHeight(height, 3)) retained.push(height)
    }
    expect(retained).toEqual([1_002, 1_005, 1_008, 1_011, 1_014, 1_017, 1_020, 1_023, 1_026, 1_029])
  })
})
