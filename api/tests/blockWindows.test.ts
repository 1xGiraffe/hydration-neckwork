import { describe, it, expect } from 'vitest'
import { cutoffWindowSql, fallbackCutoffHeight } from '../src/services/explorerService.ts'

// Timestamp-derived cutoff heights back the "24h"/"7d" windows so they track
// wall-clock time as block production drifts (blocks now run ~5.6s, not the 6s
// the old fixed offsets assumed). These cover the two pure pieces of the helper.
describe('cutoffWindowSql', () => {
  it('queries the blocks table for the wall-clock interval', () => {
    const sql = cutoffWindowSql(24)
    expect(sql).toContain('INTERVAL 24 HOUR')
    expect(sql).toContain('min(block_height)')
    expect(sql).toContain('price_data.blocks')
    expect(sql).toContain('block_timestamp >= now()')
  })

  it('uses the requested window for 7d', () => {
    expect(cutoffWindowSql(168)).toContain('INTERVAL 168 HOUR')
  })

  it('coerces the hours to a safe positive integer literal', () => {
    expect(cutoffWindowSql(23.6)).toContain('INTERVAL 24 HOUR')
    expect(cutoffWindowSql(0)).toContain('INTERVAL 1 HOUR')
  })
})

describe('fallbackCutoffHeight', () => {
  it('reproduces the pre-fix 6s-block constants', () => {
    // 24h → 14400 blocks, 7d → 100800, 72h → 43200 (600 blocks/hour).
    expect(fallbackCutoffHeight(1_000_000, 24)).toBe(1_000_000 - 14_400)
    expect(fallbackCutoffHeight(1_000_000, 168)).toBe(1_000_000 - 100_800)
    expect(fallbackCutoffHeight(1_000_000, 72)).toBe(1_000_000 - 43_200)
  })

  it('never returns a negative height', () => {
    expect(fallbackCutoffHeight(100, 24)).toBe(0)
  })
})
