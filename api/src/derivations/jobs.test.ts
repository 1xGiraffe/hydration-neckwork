import { describe, it, expect } from 'vitest'
import { xykTotalSharesInsertSql, stalePartitionsSql } from './jobs.ts'
import { swapEventFilterSql } from '../services/accountTradeVolume.ts'

describe('xykTotalSharesInsertSql', () => {
  it('is a single idempotent INSERT keyed by run id', () => {
    const sql = xykTotalSharesInsertSql(12345)
    expect(sql).toContain('INSERT INTO price_data.xyk_lp_total_shares_history')
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
})
