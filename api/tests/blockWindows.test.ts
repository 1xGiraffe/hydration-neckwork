import { describe, it, expect } from 'vitest'
import {
  SPARKLINE_BUCKETS, SPARKLINE_BUCKET_HOURS, SPARKLINE_WINDOW_HOURS,
  STATS_COUNTS_CACHE_MS, STATS_COUNTS_SQL,
  cutoffWindowSql, fallbackCutoffHeight, feedWindowBoundSql,
} from '../src/services/explorerService.ts'
import { blocksPerHour } from '../src/services/blockTime.ts'

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
    // 24h → 14400 blocks, 7d → 100800, 72h → 43200 (600 blocks/hour) — the
    // final fallback when the chain cannot be measured either.
    expect(fallbackCutoffHeight(1_000_000, 24)).toBe(1_000_000 - 14_400)
    expect(fallbackCutoffHeight(1_000_000, 168)).toBe(1_000_000 - 100_800)
    expect(fallbackCutoffHeight(1_000_000, 72)).toBe(1_000_000 - 43_200)
  })

  // The estimate is only reached when the blocks table itself failed, so it has
  // to carry the migration on its own: a measured pace makes it track real
  // production instead of a slot time it has no way to notice changing.
  it('uses the measured pace when one is available', () => {
    // ~5.59s/block, the live Aug 2026 pace: 24h is ~15 460 blocks, not 14 400.
    expect(fallbackCutoffHeight(1_000_000, 24, blocksPerHour(5_588))).toBe(1_000_000 - 15_462)
    // 2s blocks: 24h is 43 200.
    expect(fallbackCutoffHeight(1_000_000, 24, blocksPerHour(2_000))).toBe(1_000_000 - 43_200)
    expect(fallbackCutoffHeight(1_000_000, 168, blocksPerHour(2_000))).toBe(1_000_000 - 302_400)
  })

  it('never returns a negative height', () => {
    expect(fallbackCutoffHeight(100, 24)).toBe(0)
    expect(fallbackCutoffHeight(100, 24, blocksPerHour(2_000))).toBe(0)
  })

  // A zero/NaN rate is a broken measurement, not "no blocks an hour". Collapsing
  // the cutoff to the head would silently return an EMPTY 24h window, so the
  // nominal is used instead — the same answer as passing no rate at all.
  it('falls back to the nominal rate rather than collapsing the window', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(fallbackCutoffHeight(1_000_000, 24, bad)).toBe(1_000_000 - 14_400)
    }
    expect(fallbackCutoffHeight(1_000_000, 168, 0)).toBe(fallbackCutoffHeight(1_000_000, 168))
  })
})

// The unfiltered feeds' recency window used to be `head − 100 800`, i.e. "7
// days" only while a block is 6s. It is now the same wall-clock resolution the
// cutoff helpers use, so it stays 7 days through the 2s upgrade.
describe('feedWindowBoundSql', () => {
  it('bounds the scan by a seven-day wall-clock window', () => {
    const sql = feedWindowBoundSql()
    expect(sql).toContain('INTERVAL 168 HOUR')
    expect(sql).toContain('price_data.blocks')
    expect(sql).toContain('min(block_height)')
  })

  it('stays a block_height predicate so the sort key still prunes', () => {
    expect(feedWindowBoundSql().startsWith('block_height > (')).toBe(true)
    expect(feedWindowBoundSql()).not.toContain('100800')
  })
})

// The assets-list sparkline buckets by wall clock (4-hour intervals over 7
// days) rather than a 2400-block stride, and keeps the 42-point series shape
// the list has always rendered.
describe('sparkline bucket shape', () => {
  it('divides the seven-day window into 42 four-hour buckets', () => {
    expect(SPARKLINE_WINDOW_HOURS).toBe(168)
    expect(SPARKLINE_BUCKET_HOURS).toBe(4)
    expect(SPARKLINE_BUCKETS).toBe(42)
    expect(SPARKLINE_BUCKETS * SPARKLINE_BUCKET_HOURS).toBe(SPARKLINE_WINDOW_HOURS)
  })

  it('resolves its window through the same helper as every other 7d window', () => {
    expect(cutoffWindowSql(SPARKLINE_WINDOW_HOURS)).toContain('INTERVAL 168 HOUR')
  })
})

describe('explorer stats count isolation', () => {
  it('keeps the live head out of the briefly shared 24h count query', () => {
    expect(STATS_COUNTS_CACHE_MS).toBe(30_000)
    expect(STATS_COUNTS_SQL).toContain('transfers_24h')
    expect(STATS_COUNTS_SQL).toContain('extrinsics_24h')
    expect(STATS_COUNTS_SQL).toContain('active_accounts_24h')
    expect(STATS_COUNTS_SQL).not.toContain('head_block')
    expect(STATS_COUNTS_SQL).not.toContain('max(block_height)')
  })

  it('deduplicates replayable identities before counting', () => {
    expect(STATS_COUNTS_SQL).toContain('uniqExact((block_height, event_index))')
    expect(STATS_COUNTS_SQL).toContain('uniqExact((block_height, extrinsic_index))')
    expect(STATS_COUNTS_SQL).toContain('uniqExact(account_id)')
  })
})
