import { describe, it, expect } from 'vitest'
import { xykTotalSharesInsertSql } from './jobs.ts'

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
