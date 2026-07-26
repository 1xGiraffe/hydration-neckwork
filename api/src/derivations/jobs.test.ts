import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  OMNIPOOL_EVENT_KIND,
  XYK_FARM_EVENT_KIND,
  XYK_SHARE_ASSET_ID_FLOOR,
  omnipoolLifecycleSelectSql,
  xykFarmLifecycleSelectSql,
  xykShareTokensBelowFloorSql,
  xykTotalSharesInsertSql,
  stalePartitionsSql,
  partitionsNeedingRebuild,
  stagingBusySql,
} from './jobs.ts'
import { swapEventFilterSql } from '../services/accountTradeVolume.ts'

// The declarative schema is the only place a table or MV is defined, so the
// coupling these jobs depend on — "the MV carries exactly the rows my WHERE
// selects" — can only be asserted against the schema file itself.
const SCHEMA_DIR = fileURLToPath(new URL('../../../clickhouse/schema/', import.meta.url))

function schemaStatement(file: string, name: string): string {
  const sql = readFileSync(SCHEMA_DIR + file, 'utf8')
  const statement = sql.split(';').find(s => s.includes(name))
  if (!statement) throw new Error(`${name} is not declared in clickhouse/schema/${file}`)
  return statement
}

// Both LP reconstructions read the decoded lp_lifecycle_events projection instead
// of filtering and JSON-decoding raw_events themselves. That only stays correct
// while the MV's predicate covers every event kind and collection the jobs act on.
describe('lp_lifecycle_events projection', () => {
  const mv = schemaStatement('003_materialized_views.sql', 'lp_lifecycle_events_mv')

  it('is the only source the two lifecycle reconstructions read', () => {
    for (const sql of [omnipoolLifecycleSelectSql(), xykFarmLifecycleSelectSql()]) {
      expect(sql).toContain('price_data.lp_lifecycle_events')
      expect(sql).not.toContain('price_data.raw_events')
      // Replayed raw ranges re-fire the MV, so the projection is deduplicated on
      // its (block_height, event_index) replacement key before the lifecycle walk.
      expect(sql).toContain('FINAL')
    }
  })

  it('carries every lifecycle event kind either job dispatches on', () => {
    for (const eventName of [...Object.keys(OMNIPOOL_EVENT_KIND), ...Object.keys(XYK_FARM_EVENT_KIND)]) {
      expect(mv).toContain(`'${eventName}'`)
    }
  })

  it('carries the NFT collections of both farms and drops every other collection', () => {
    // 1337/2584 are the Omnipool position and deposit collections, 5389 the XYK
    // farm deposit collection; a Uniques event outside them is noise for both jobs.
    expect(mv).toContain("IN ('1337', '2584', '5389')")
    expect(omnipoolLifecycleSelectSql()).toContain("collection IN ('1337','2584')")
    expect(xykFarmLifecycleSelectSql()).toContain("collection='5389'")
  })

  it('decodes the JSON fields once, at insert time', () => {
    for (const field of ['collection', 'item', 'positionId', 'depositId', 'owner', 'from', 'to', 'lpToken', 'amount']) {
      expect(mv).toContain(`args_json, '${field}'`)
    }
    for (const sql of [omnipoolLifecycleSelectSql(), xykFarmLifecycleSelectSql()]) {
      expect(sql).not.toContain('JSONExtract')
    }
  })
})

// The total-shares reconstruction windows over balance observations. Only 0.48%
// of them belong to an XYK share token, but an MV predicate is evaluated per
// inserted row and cannot join the pool set, which arrives from a different
// pipeline and may arrive later. So the projection filters on a static superset —
// the asset registry's sequential id range, where the XYK pallet's share tokens
// are minted — and the job re-filters to the real set.
describe('xyk_lp_share_observations projection', () => {
  const mv = schemaStatement('003_materialized_views.sql', 'xyk_lp_share_observations_mv')
  const table = schemaStatement('001_tables.sql', 'price_data.xyk_lp_share_observations')

  it('filters on a static join-free superset, never on a set that can arrive later', () => {
    expect(mv).toContain(`>= ${XYK_SHARE_ASSET_ID_FLOOR}`)
    expect(mv).toContain("asset_kind = 'substrate'")
    for (const lateBound of ['XYK.PoolCreated', 'xyk_pool_registry', 'dictGet', 'dictHas', 'joinGet']) {
      expect(mv).not.toContain(lateBound)
    }
  })

  it('is ordered exactly as the reconstruction window partitions and sorts', () => {
    expect(table).toContain('ORDER BY (asset_id, account_id, block_height, observation_id)')
    expect(xykTotalSharesInsertSql(1))
      .toContain('PARTITION BY asset_id, account_id ORDER BY block_height, observation_id')
  })

  it('reads the projection and re-filters it to the real share-token set', () => {
    const sql = xykTotalSharesInsertSql(1)
    // FINAL: raw_balance_observations is replayable, and the projection inherits
    // its replacement key; the share-token predicate keeps FINAL bounded.
    expect(sql).toContain('price_data.xyk_lp_share_observations FINAL')
    expect(sql).not.toContain('price_data.raw_balance_observations')
    expect(sql).toContain('asset_id IN (SELECT lp FROM lps)')
  })

  it('fails loudly if a share token is ever minted below the projection floor', () => {
    const sql = xykShareTokensBelowFloorSql()
    expect(sql).toContain('price_data.xyk_pool_registry')
    expect(sql).toContain(`lp < ${XYK_SHARE_ASSET_ID_FLOOR}`)
  })
})

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
    // Approach A: share issuance == cumulative net balance deltas of the
    // shareToken, read through the xyk_lp_share_observations projection and
    // scoped to the pools the xyk_pool_registry MV knows.
    expect(sql).toContain('price_data.xyk_lp_share_observations')
    expect(sql).toContain('price_data.xyk_pool_registry')
    expect(sql).toContain('lagInFrame')
    expect(sql).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')
  })
})

// The source side of the staleness check is a per-partition max over every swap
// row ever indexed. ClickHouse cannot invert the derived table's synthetic
// toYYYYMM(toDateTime(block_height * 12)) partition key into a block range, and
// raw_events is partitioned on real block_timestamp, so asking raw_events for it
// read the whole table every cycle. max() is replay-idempotent, so an MV can
// maintain the watermarks instead.
describe('swap_source_partition_watermarks projection', () => {
  const mv = schemaStatement('003_materialized_views.sql', 'swap_source_partition_watermarks_mv')
  const table = schemaStatement('001_tables.sql', 'price_data.swap_source_partition_watermarks')

  // ClickHouse re-prints a stored MV's SELECT from its AST, so the schema file
  // carries the service's filter with normalised spacing and parentheses.
  const bare = (sql: string): string => sql.replace(/[\s()]/g, '')

  it('watches exactly the swap rows the netting consumes', () => {
    expect(bare(mv)).toContain(bare(swapEventFilterSql()))
  })

  it('keys the watermarks on the derived table partition expression', () => {
    expect(mv).toContain('toYYYYMM(toDateTime(block_height * 12))')
  })

  it('carries only watermarks a replayed insert cannot inflate', () => {
    // max() of a re-inserted row is the same value; a sum or count would double.
    expect(table).toContain('SimpleAggregateFunction(max, DateTime)')
    expect(table).toContain('SimpleAggregateFunction(max, UInt32)')
    expect(table).not.toContain('SimpleAggregateFunction(sum')
    expect(table).not.toContain('AggregateFunction(count')
  })
})

describe('stalePartitionsSql', () => {
  it('selects stale partitions by ingest-time watermark, not a count comparison', () => {
    const sql = stalePartitionsSql()
    // Ingest-time comparison: max raw ingested_at vs max derived computed_at.
    expect(sql).toContain('max(src_ingest)')
    expect(sql).toContain('max(computed_at)')
    // No derived rows OR newer raw than derived → rebuild.
    expect(sql).toContain('der.der_computed IS NULL')
    expect(sql).toContain('src.src_ingest > der.der_computed')
    // Must NOT use the old (subset-broken) block/row count metric.
    expect(sql).not.toContain('uniqExact')
    expect(sql).not.toMatch(/\bcount\s*\(/i)
  })

  it('reads the watermark projection, never raw_events', () => {
    const sql = stalePartitionsSql()
    expect(sql).toContain('price_data.swap_source_partition_watermarks')
    expect(sql).not.toContain('price_data.raw_events')
  })

  it('carries the price window the rebuild bounds its valuation candles with', () => {
    expect(stalePartitionsSql()).toContain('src_max_ts')
  })

  it('reads from the source and derived tables and matches the table partition key', () => {
    const sql = stalePartitionsSql()
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

// A publication swaps a staging twin into place with EXCHANGE TABLES or REPLACE
// PARTITION, neither of which checks that the two sides agree. A twin whose DDL
// drifted from its parent would therefore publish the wrong engine, ORDER BY or
// partitioning without an error. The twins used to be created on demand with
// `CREATE TABLE <t>_staging AS <t>`, which made drift impossible but put a table
// definition in application code; now that they are declared, the equality has to
// be asserted here.
describe('staging twins', () => {
  const TWINNED = [
    'price_data.account_trade_volume',
    'price_data.omnipool_position_owner_intervals',
    'price_data.xyk_farm_principal_intervals',
    'price_data.xyk_lp_total_shares_history',
  ]

  // Statements are separated by `;` but may be preceded by comment lines, so the
  // DDL is taken from CREATE onwards.
  function declaration(name: string): string {
    const sql = readFileSync(SCHEMA_DIR + '001_tables.sql', 'utf8')
    const statement = sql.split(';').find(s => s.includes(`EXISTS ${name} (`))
    if (!statement) throw new Error(`${name} is not declared in clickhouse/schema/001_tables.sql`)
    return statement.slice(statement.indexOf('CREATE ')).trim()
  }

  it.each(TWINNED)('%s has a declared twin with identical DDL', live => {
    const twin = declaration(`${live}_staging`).replace(`${live}_staging`, live)

    expect(twin).toBe(declaration(live))
  })

  // clickhouse/schema is the single source of truth for every table, so the jobs
  // must not fall back to creating one when a twin is missing — that would mask a
  // schema the bootstrap never applied.
  it('are never created from the jobs module', () => {
    const jobs = readFileSync(fileURLToPath(new URL('./jobs.ts', import.meta.url)), 'utf8')

    expect(jobs).not.toMatch(/CREATE TABLE/i)
  })
})

// Concurrent publications into the same twin silently truncate each other, so
// every publication path probes for one first.
describe('stagingBusySql', () => {
  it('finds another process writing the twin without matching itself', () => {
    const sql = stagingBusySql()

    expect(sql).toContain('system.processes')
    expect(sql).toContain('{staging:String}')
    // The probe is itself a SELECT naming the twin; without this filter it would
    // always report the twin as busy.
    expect(sql).toContain("query_kind != 'Select'")
  })
})
