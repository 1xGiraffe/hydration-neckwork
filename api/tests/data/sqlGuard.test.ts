import { describe, expect, it } from 'vitest'
import { assertNoShadowedAlias } from './sqlGuard.ts'

// The guard is pinned against the exact shapes that 500'd live, plus the
// legitimate self-alias idioms it must keep allowing.

describe('assertNoShadowedAlias', () => {
  it('rejects a String alias compared against the DateTime column it shadows', () => {
    expect(() => assertNoShadowedAlias(`
      SELECT toString(interval_start) AS interval_start, argMaxMerge(balance_state) AS balance
      FROM price_data.account_balance_hourly
      WHERE account_id = {account:String} AND interval_start < toDateTime({cursor:UInt32})
      GROUP BY account_id, asset_id, interval_start
      ORDER BY interval_start DESC`)).toThrow(/interval_start/)
  })

  it('rejects an aggregate alias reused as another aggregate’s argument', () => {
    expect(() => assertNoShadowedAlias(`
      SELECT id, argMax(block_height, block_height) AS block_height, argMax(asset_in, block_height) AS asset_in
      FROM price_data.dca_schedules WHERE who = {account:String} GROUP BY id`)).toThrow(/block_height/)
  })

  it('rejects a stringified column filtered against a typed parameter', () => {
    expect(() => assertNoShadowedAlias(`
      SELECT toString(asset_id) AS asset_id, sum(leg_count) AS legs
      FROM price_data.pool_swap_hourly
      WHERE asset_id = {assetId:UInt32} GROUP BY asset_id`)).toThrow(/asset_id/)
  })

  it('allows an alias that is never referenced again', () => {
    expect(() => assertNoShadowedAlias(`
      SELECT pool_id, argMax(asset_ids, block_height) AS asset_ids, max(block_height) AS block
      FROM price_data.stableswap_pool_state_history GROUP BY pool_id ORDER BY pool_id`)).not.toThrow()
  })

  it('allows the HAVING clause to target the alias', () => {
    expect(() => assertNoShadowedAlias(`
      SELECT chain, argMax(display, updated_at) AS display
      FROM price_data.account_identities WHERE account_id = {account:String}
      GROUP BY chain HAVING display != ''`)).not.toThrow()
  })

  it('treats a subquery as its own scope', () => {
    expect(() => assertNoShadowedAlias(`
      SELECT stream, month, toString(sum(revenue_usd)) AS revenue_usd
      FROM (
        SELECT account, stream, month, argMax(revenue_usd, computed_at) AS revenue_usd
        FROM price_data.account_revenue WHERE account IN {accounts:Array(String)}
        GROUP BY account, stream, month
      )
      GROUP BY stream, month ORDER BY month DESC, stream ASC`)).not.toThrow()
  })

  it('ignores bound parameters and string literals that happen to spell the name', () => {
    expect(() => assertNoShadowedAlias(`
      SELECT toString(cursor) AS cursor FROM t WHERE x < {cursor:UInt32} AND name = 'cursor'`)).not.toThrow()
  })
})
