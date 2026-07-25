import { describe, it, expect } from 'vitest'
import { xykTotalSharesInsertSql, stalePartitionsSql, partitionsNeedingRebuild } from './jobs.ts'
import { swapEventFilterSql } from '../services/accountTradeVolume.ts'

describe('xykTotalSharesInsertSql', () => {
  it('is a single idempotent INSERT keyed by run id, targeting the staging twin', () => {
    const sql = xykTotalSharesInsertSql(12345)
    // Writes land in the staging table; the live table is only updated by the
    // atomic EXCHANGE in runXykTotalShares (see jobs.ts atomicFullReplace).
    expect(sql).toContain('INSERT INTO price_data.xyk_lp_total_shares_history_staging')
    expect(sql).toContain('12345 AS run_id')
  })

  it('reconstructs total shares from balance deltas via a windowed cumulative sum', () => {
    const sql = xykTotalSharesInsertSql(1)
    // Approach A: share issuance == cumulative net balance deltas of the shareToken.
    expect(sql).toContain('price_data.raw_balance_observations')
    expect(sql).toContain("event_name='XYK.PoolCreated'")
    expect(sql).toContain('lagInFrame')
    expect(sql).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')
  })
})

describe('stalePartitionsSql', () => {
  it('selects stale partitions by ingest-time watermark, not a count comparison', () => {
    const sql = stalePartitionsSql()
    // Ingest-time comparison: max raw ingested_at vs max derived computed_at.
    expect(sql).toContain('max(ingested_at)')
    expect(sql).toContain('max(computed_at)')
    // No derived rows OR newer raw than derived → rebuild.
    expect(sql).toContain('der.der_computed IS NULL')
    expect(sql).toContain('src.src_ingest > der.der_computed')
    // Must NOT use the old (subset-broken) block/row count metric.
    expect(sql).not.toContain('uniqExact')
    expect(sql).not.toMatch(/\bcount\s*\(/i)
  })

  it('scopes the raw side to the service swap-row filter (single source of truth)', () => {
    expect(stalePartitionsSql()).toContain(swapEventFilterSql())
  })

  it('reads from the source and derived tables and matches the table partition key', () => {
    const sql = stalePartitionsSql()
    expect(sql).toContain('price_data.raw_events')
    expect(sql).toContain('price_data.account_trade_volume')
    expect(sql).toContain('toYYYYMM(toDateTime(block_height * 12))')
  })

  it('gates candidates on price coverage so unpriced partitions are never baked', () => {
    const sql = stalePartitionsSql()
    // The priced range (main pipeline's blocks) must span the partition: from
    // at-or-below its first block to at-or-past its last source swap block.
    // Computing earlier would drop unpriced trades (HAVING volume_usd > 0)
    // with no later signal to re-mark the partition stale.
    expect(sql).toContain('price_data.blocks')
    expect(sql).toContain('pc.priced_from <=')
    expect(sql).toContain('pc.priced_to >= src.src_maxb')
    // Partition → first-block inversion of toYYYYMM(toDateTime(h * 12)).
    expect(sql).toContain("parseDateTimeBestEffort(concat(toString(src.p), '01'))")
  })
})

// A partition whose valuation nets to nothing writes zero derived rows, so the
// staleness LEFT JOIN misses forever and the partition is rebuilt on every cycle —
// three pre-2026 pseudo-partitions read terabytes per cycle to write nothing.
describe('partitionsNeedingRebuild', () => {
  it('rebuilds a candidate the process has not built yet', () => {
    const candidates = [{ p: '197008', src_ingest: '2026-07-01 00:00:00' }]

    expect(partitionsNeedingRebuild(candidates, new Map())).toEqual(['197008'])
  })

  it('skips a candidate whose source has not advanced since its rebuild', () => {
    const candidates = [{ p: '197008', src_ingest: '2026-07-01 00:00:00' }]
    const built = new Map([['197008', '2026-07-01 00:00:00']])

    expect(partitionsNeedingRebuild(candidates, built)).toEqual([])
  })

  it('rebuilds again once a backfilled row raises the source watermark', () => {
    const candidates = [{ p: '197008', src_ingest: '2026-07-02 00:00:00' }]
    const built = new Map([['197008', '2026-07-01 00:00:00']])

    expect(partitionsNeedingRebuild(candidates, built)).toEqual(['197008'])
  })

  it('keeps the live month moving while empty history stays skipped', () => {
    const candidates = [
      { p: '197008', src_ingest: '2026-07-01 00:00:00' },
      { p: '197501', src_ingest: '2026-07-25 09:00:00' },
    ]
    const built = new Map([['197008', '2026-07-01 00:00:00'], ['197501', '2026-07-25 08:00:00']])

    expect(partitionsNeedingRebuild(candidates, built)).toEqual(['197501'])
  })
})
