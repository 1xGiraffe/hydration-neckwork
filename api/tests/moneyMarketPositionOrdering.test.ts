import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

const explorerService = read('../src/services/explorerService.ts')
const tables = read('../../clickhouse/schema/001_tables.sql')
const materializedViews = read('../../clickhouse/schema/003_materialized_views.sql')

const ddl = tables
  .split('\n')
  .find(line => line.startsWith('CREATE TABLE IF NOT EXISTS price_data.account_money_market_position_history ')) ?? ''
const mv = materializedViews
  .split('\n')
  .find(line => line.startsWith('CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.account_money_market_position_history_mv ')) ?? ''

// The 180-bucket money-market pass in getAccountHistoryShared spans an account's whole
// life, so raw_money_market_positions' ORDER BY (block_height, user_address, ...) cannot
// serve its per-account predicate: every call read the entire 17.7M-row table (6,967,470
// rows / 1.25 GiB / 118 ms / 250 MiB peak), 7.28 TiB across 8,129 calls per 3h.
// account-first the same call reads 40,960 rows / 6.57 MiB / 8 ms / 3.54 MiB.
describe('money-market position history ordering', () => {
  // Two `mmRes` bindings exist; anchor on the bucket pass's own preamble.
  const bucketStart = explorerService.indexOf(
    '  const mmRes = await client.query({',
    explorerService.indexOf('// account_money_market_position_history is raw_money_market_positions reordered'))
  const bucketQuery = explorerService.slice(
    bucketStart, explorerService.indexOf("format: 'JSONEachRow'", bucketStart))

  it('locates exactly one bucket query', () => {
    expect(bucketStart).toBeGreaterThan(-1)
    expect(bucketQuery.length).toBeGreaterThan(200)
    expect(bucketQuery.length).toBeLessThan(900)
    // This source carries no timestamp, so it is the one bucketed through the
    // wall-clock boundaries in block space rather than from a DateTime column.
    expect(bucketQuery).toContain("${bk.ofHeight('block_height')}")
  })

  it('reads the bucket pass account-first', () => {
    expect(bucketQuery).toContain('FROM price_data.account_money_market_position_history')
    expect(bucketQuery).not.toContain('FROM price_data.raw_money_market_positions')
  })

  // pool_address is stored lowercase, so re-lowering it would hide the column behind a
  // function and forfeit the second key column.
  it('does not wrap the key columns in functions', () => {
    expect(bucketQuery).toContain('pool_address AS pool')
    expect(bucketQuery).toContain('AND pool_address IN (')
    expect(bucketQuery).not.toContain('lower(pool_address)')
  })

  // block_height < minb prunes almost perfectly against a block-first key (203,717 rows
  // / 5.6 ms); account-first the same carry-in degrades to 1,738,112 rows / 470 ms.
  it('leaves the carry-in query on the block-first raw table', () => {
    const carry = explorerService.slice(explorerService.indexOf('const carryRes = await client.query({')).slice(0, 900)

    expect(carry).toContain('FROM price_data.raw_money_market_positions')
    expect(carry).toContain('block_height < ${rng.minb}')
    expect(carry).not.toContain('FROM price_data.account_money_market_position_history')
  })
})

describe('account_money_market_position_history schema', () => {
  it('is declared alongside its materialized view', () => {
    expect(ddl).not.toBe('')
    expect(mv).not.toBe('')
  })

  it('orders account-first so a per-account predicate hits the primary index', () => {
    expect(ddl).toContain('ORDER BY (account_id, pool_address, block_height, observation_id)')
  })

  // Raw ranges get re-indexed. Replacing on the same identity the raw table replaces on
  // (block_height, user_address -> account_id, pool_address, observation_id) with the same
  // ingested_at version keeps a replay collapsing instead of accumulating.
  it('replaces on the raw table s identity so replay is idempotent', () => {
    expect(ddl).toContain('ENGINE = ReplacingMergeTree(ingested_at)')
    expect(mv).not.toMatch(/\bGROUP BY\b/)
  })

  // argMax in the reader breaks ties on observation_id and ingested_at, so the columns
  // feeding moneyMarketPositionOrderSql have to survive the copy verbatim.
  it('carries every column the reader s argMax tie-break needs', () => {
    for (const column of ['block_height', 'observation_id', 'ingested_at', 'total_collateral_base', 'total_debt_base']) {
      expect(ddl, column).toContain(`\`${column}\``)
      expect(mv, column).toContain(column)
    }
  })

  it('stores account_id non-nullable and pool_address canonically lowercase', () => {
    expect(ddl).toContain('`account_id` String')
    expect(mv).toContain("ifNull(account_id, '') AS account_id")
    expect(mv).toContain('lower(pool_address) AS pool_address')
  })
})
