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
  xykTotalSharesStalePoolsSql,
  keptXykPoolRowsSql,
  xykPoolPartition,
  runXykTotalShares,
  XYK_LP_SHARE_WATERMARKS_TABLE,
  XYK_POOLS_PER_PARTITION,
  partitionsNeedingRebuild,
  poolSwapHourlyInsertSql,
  uniswapV3LegsInsertSql,
  uniswapV3SwapHoursSql,
  uniswapV3LegInputsFingerprintSql,
  runUniswapV3Legs,
  hourlyFoldStaleHoursSql,
  hourlyFoldCutSql,
  bucketsToFold,
  bucketsByPartition,
  hourPartition,
  runHourlyFold,
  accountTradeVolumeStaleBucketsSql,
  keptTradeRowsSql,
  runAccountTradeVolume,
  ACCOUNT_TRADE_VOLUME_WATERMARKS_TABLE,
  INGEST_SETTLE_SECONDS,
  POOL_SWAP_HOURLY_FOLD,
  POOL_VOLUME_HOURLY_FOLD,
  PRICED_FLOOR_SQL,
  REVENUE_EVENT_STREAMS_INSERTED,
  REVENUE_HOUR_WATERMARKS_TABLE,
  POOL_SWAP_HOUR_WATERMARKS_TABLE,
  xcmArrivalsChunks,
  xcmArrivalsStaleMonthsSql,
  xcmArrivalsPendingBlocksSql,
  ACCOUNT_REVENUE_ATTRIBUTED_STREAMS,
  accountRevenueEventfulInsertSql,
  accountRevenueKeyCollisionsSql,
  accountRevenueStaleMonthsSql,
  accountRevenueV3AccruedSql,
  hollarWeightsEndSeconds,
  keptRevenueRowsSql,
  revenueEventsInsertSql,
  revenueEventsStaleHoursSql,
  revenueHoursPredicate,
  revenuePriceParams,
  runRevenueEvents,
  stagingBusySql,
} from './jobs.ts'
import { AAVE_COLLECTOR, TREASURY_H160, buildRevenueEventRowsSql, reserveAssetIdSql } from '../services/revenueStreams.ts'
import { uniswapV3RealizationsSql } from '../services/uniswapV3Attribution.ts'
import { accountTradeVolumeSourceAssetsSql, accountTradeVolumeSourceFilterSql } from '../services/accountTradeVolume.ts'
import { hourLegsPredicate } from '../services/volumeHourly.ts'
import { valuationRegistryFingerprintSql } from '../services/valuation.ts'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../services/explorerAssets.ts'

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

// The total-shares fold windows over balance observations. Only 0.48% of them
// belong to an XYK share token, but an MV predicate is evaluated per inserted row
// and cannot join the pool set, which arrives from a different pipeline and may
// arrive later. So the projection filters on a static superset — the asset
// registry's sequential id range, where the XYK pallet's share tokens are minted —
// and the fold re-filters to the real set.
describe('xyk_lp_share_observations projection', () => {
  const mv = schemaStatement('003_materialized_views.sql', 'xyk_lp_share_observations_mv')
  const table = schemaStatement('001_tables.sql', 'price_data.xyk_lp_share_observations')
  const insert = xykTotalSharesInsertSql(['1000045'], 'price_data.t_staging', '2026-10-02 12:00:00')

  it('filters on a static join-free superset, never on a set that can arrive later', () => {
    expect(mv).toContain(`>= ${XYK_SHARE_ASSET_ID_FLOOR}`)
    expect(mv).toContain("asset_kind = 'substrate'")
    for (const lateBound of ['XYK.PoolCreated', 'xyk_pool_registry', 'dictGet', 'dictHas', 'joinGet']) {
      expect(mv).not.toContain(lateBound)
    }
  })

  it('is ordered exactly as the fold window partitions and sorts', () => {
    expect(table).toContain('ORDER BY (asset_id, account_id, block_height, observation_id)')
    expect(insert).toContain('PARTITION BY asset_id, account_id ORDER BY block_height, observation_id')
  })

  it('is read through FINAL and re-filtered to the real share-token set', () => {
    // FINAL: raw_balance_observations is replayable, and the projection inherits
    // its replacement key; the pool predicate keeps FINAL bounded.
    expect(insert).toContain('price_data.xyk_lp_share_observations FINAL')
    expect(insert).not.toContain('price_data.raw_balance_observations')
    expect(insert).toContain('WHERE asset_id IN (1000045)')
    expect(xykTotalSharesStalePoolsSql()).toContain('WHERE asset_id IN (SELECT DISTINCT lp_asset_id AS lp FROM price_data.xyk_pool_registry FINAL)')
  })

  it('fails loudly if a share token is ever minted below the projection floor', () => {
    const sql = xykShareTokensBelowFloorSql()
    expect(sql).toContain('price_data.xyk_pool_registry')
    expect(sql).toContain(`lp < ${XYK_SHARE_ASSET_ID_FLOOR}`)
  })
})

// The fold's bucket is a pool, found through a per-share-token watermark an MV
// keeps over the projection: max() is replay-idempotent, so the index is safe to
// maintain on insert, and it is ~1k rows where the projection is 37M.
describe('xyk_lp_share_watermarks', () => {
  const table = schemaStatement('001_tables.sql', `${XYK_LP_SHARE_WATERMARKS_TABLE} (`)
  const mv = schemaStatement('003_materialized_views.sql', 'xyk_lp_share_watermarks_mv')

  it('is a merge-safe max per share token', () => {
    expect(table).toContain('`src_ingest` SimpleAggregateFunction(max, DateTime)')
    expect(table).toContain('ENGINE = AggregatingMergeTree')
    expect(table).toContain('ORDER BY asset_id')
  })

  it('watches exactly the projection the fold reads', () => {
    expect(mv).toContain(`TO ${XYK_LP_SHARE_WATERMARKS_TABLE}`)
    expect(mv).toContain('max(ingested_at) AS src_ingest FROM price_data.xyk_lp_share_observations GROUP BY asset_id')
  })

  // A throwing MV fails the raw insert that fed it (see the revenue watermarks'
  // Nullable guard below); the projection's one Nullable column is `total`, which
  // this MV must never output.
  it('outputs no Nullable source column', () => {
    const outputs = mv.slice(mv.indexOf(' AS SELECT '), mv.indexOf(' FROM price_data.xyk_lp_share_observations'))
    const source = schemaStatement('001_tables.sql', 'TABLE IF NOT EXISTS price_data.xyk_lp_share_observations (')
    const nullable = [...source.matchAll(/`(\w+)` Nullable\(/g)].map(m => m[1])
    expect(nullable).toEqual(['total'])
    for (const column of nullable) expect(outputs).not.toMatch(new RegExp(`\\b${column}\\b`))
  })
})

describe('xyk_lp_total_shares_history fold', () => {
  const live = schemaStatement('001_tables.sql', 'EXISTS price_data.xyk_lp_total_shares_history (')

  it('partitions the table by the pool group the job republishes', () => {
    expect(live).toContain(`PARTITION BY intDiv(lp_asset_id, ${XYK_POOLS_PER_PARTITION})`)
    expect(live).toContain('ORDER BY (lp_asset_id, block_height)')
    expect(xykPoolPartition('1000045')).toBe('10000')
    expect(xykPoolPartition('1001126')).toBe('10011')
  })

  it('names a pool stale from its share token\'s watermark against its own computed_at', () => {
    const flat = xykTotalSharesStalePoolsSql('price_data.t').replace(/\s+/g, ' ')
    expect(flat).toContain(`FROM ${XYK_LP_SHARE_WATERMARKS_TABLE}`)
    expect(flat).toContain('SELECT lp_asset_id AS bucket, count() AS n, max(computed_at) AS der_computed FROM price_data.t GROUP BY lp_asset_id')
    expect(flat).toContain(`src.src_ingest > der.der_computed - INTERVAL ${INGEST_SETTLE_SECONDS} SECOND`)
    expect(flat).not.toContain('price_data.xyk_lp_share_observations')
  })

  it('keeps a group\'s other pools whole and none of the recomputed pools\' old rows', () => {
    expect(keptXykPoolRowsSql('l', 's', '10000', ['1000045', '1000046']).replace(/\s+/g, ' '))
      .toBe('INSERT INTO s SELECT * FROM l WHERE intDiv(lp_asset_id, 100) = 10000 AND lp_asset_id NOT IN (1000045, 1000046)')
  })

  it('reconstructs issuance as the running sum of per-holder balance deltas', () => {
    const sql = xykTotalSharesInsertSql(['1000045'], 'price_data.t_staging', '2026-10-02 12:00:00')
    expect(sql).toContain('INSERT INTO price_data.t_staging (lp_asset_id, block_height, total_shares_raw, computed_at)')
    expect(sql).toContain('lagInFrame(toInt256(assumeNotNull(total)), 1, toInt256(0))')
    expect(sql).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')
    expect(sql).toContain("toDateTime('2026-10-02 12:00:00') AS computed_at")
    expect(() => xykTotalSharesInsertSql(['1; DROP'], 's', '2026-10-02 12:00:00')).toThrow()
    expect(() => xykTotalSharesInsertSql([], 's', '2026-10-02 12:00:00')).toThrow()
  })

  function fakeClient(stale: Array<Record<string, unknown>>, below = '0') {
    const commands: string[] = []
    const client = {
      query: async ({ query }: { query: string }) => ({
        json: async () => {
          if (query.includes('system.processes')) return [{ n: '0' }]
          if (query.includes(`lp < ${XYK_SHARE_ASSET_ID_FLOOR}`)) return [{ n: below }]
          if (query.startsWith('SELECT toString(now())')) return [{ t: '2026-10-02 12:00:00' }]
          return stale
        },
      }),
      command: async ({ query }: { query: string }) => { commands.push(query.replace(/\s+/g, ' ').trim()); return { summary: { written_rows: '3' } } },
    }
    return { client: client as unknown as Parameters<typeof runXykTotalShares>[0], commands }
  }
  const pool = (bucket: string) => ({ bucket, src_ingest: '2026-10-02 11:00:00', fingerprint: '0', empty: 0, settled: 1 })

  it('republishes each touched pool group from its kept pools plus the recomputed ones, stamped with the read time', async () => {
    const { client, commands } = fakeClient([pool('1000045'), pool('1000046'), pool('1001126')])
    const result = await runXykTotalShares(client, 'price_data.t')
    expect(result).toEqual({ model: 'xyk_total_shares', rows: 6 })
    expect(commands.slice(0, 2)).toEqual([
      'ALTER TABLE price_data.t_staging DROP PARTITION 10000',
      'INSERT INTO price_data.t_staging SELECT * FROM price_data.t WHERE intDiv(lp_asset_id, 100) = 10000 AND lp_asset_id NOT IN (1000045, 1000046)',
    ])
    expect(commands[2]).toContain('INSERT INTO price_data.t_staging (lp_asset_id')
    expect(commands[2]).toContain('WHERE asset_id IN (1000045, 1000046)')
    expect(commands[2]).toContain("toDateTime('2026-10-02 12:00:00') AS computed_at")
    expect(commands.slice(3, 5)).toEqual([
      'ALTER TABLE price_data.t REPLACE PARTITION 10000 FROM price_data.t_staging',
      'ALTER TABLE price_data.t_staging DROP PARTITION 10000',
    ])
    expect(commands[6]).toBe('INSERT INTO price_data.t_staging SELECT * FROM price_data.t WHERE intDiv(lp_asset_id, 100) = 10011 AND lp_asset_id NOT IN (1001126)')
    expect(commands[7]).toContain('WHERE asset_id IN (1001126)')
    expect(commands).toHaveLength(10)
    // Nothing is ever deleted from or appended to the live table in place.
    expect(commands.filter(c => c.startsWith('INSERT INTO price_data.t ') || c.includes('DELETE') || c.includes('EXCHANGE'))).toEqual([])
  })

  it('writes nothing on a cycle with no stale pool', async () => {
    const { client, commands } = fakeClient([])
    expect(await runXykTotalShares(client, 'price_data.t')).toEqual({ model: 'xyk_total_shares', rows: 0 })
    expect(commands).toEqual([])
  })

  it('refuses to publish when a share token sits below the projection floor', async () => {
    const { client, commands } = fakeClient([pool('1000045')], '1')
    await expect(runXykTotalShares(client, 'price_data.t')).rejects.toThrow(/below asset id/)
    expect(commands).toEqual([])
  })
})

// account_trade_volume's staleness reads per-bucket watermarks an MV keeps over
// every raw row the netting consumes. Asking raw_events for them would aggregate
// the whole table every cycle; max() and groupUniqArray are replay-idempotent, so
// an MV can maintain them instead.
describe('account_trade_volume_watermarks projection', () => {
  const mv = schemaStatement('003_materialized_views.sql', 'account_trade_volume_watermarks_mv TO')
  const v3 = schemaStatement('003_materialized_views.sql', 'account_trade_volume_watermarks_v3_mv')
  const table = schemaStatement('001_tables.sql', 'price_data.account_trade_volume_watermarks (`')

  // ClickHouse re-prints a stored MV's SELECT from its AST, so the schema file
  // carries the service's SQL with normalised spacing and parentheses.
  const bare = (sql: string): string => sql.replace(/[\s()]/g, '')

  it('watches exactly the raw rows the netting consumes, with the assets they value', () => {
    expect(bare(mv)).toContain(bare(accountTradeVolumeSourceFilterSql()))
    expect(bare(mv)).toContain(bare(`groupUniqArrayArray(${accountTradeVolumeSourceAssetsSql()}) AS assets`))
    expect(mv).toContain('FROM price_data.raw_events')
    // Every raw row behind an MV projection the netting reads, not only the swaps.
    for (const name of ['DCA.TradeExecuted', 'OTC.Filled', 'Intent.DcaCompleted', 'Currencies.Transferred']) {
      expect(accountTradeVolumeSourceFilterSql()).toContain(`'${name}'`)
    }
  })

  it('keys the watermarks on the 1800-block bucket', () => {
    for (const statement of [mv, v3]) expect(statement).toContain('intDiv(block_height, 1800) AS bucket')
    expect(table).toContain('ORDER BY bucket')
  })

  it('carries only watermarks a replayed insert cannot inflate', () => {
    // max() of a re-inserted row is the same value; a sum or count would double.
    expect(table).toContain('SimpleAggregateFunction(max, DateTime)')
    expect(table).toContain('SimpleAggregateFunction(max, UInt32)')
    expect(table).toContain('SimpleAggregateFunction(min, DateTime)')
    expect(table).toContain('SimpleAggregateFunction(groupUniqArrayArray, Array(UInt32))')
    expect(table).not.toContain('SimpleAggregateFunction(sum')
    expect(table).not.toContain('AggregateFunction(count')
  })

  // A direct EVM swap in a concentrated-liquidity pool has no Broadcast row; the
  // netting's v3_direct arm reads the pool's Swap log, so a bucket whose only new
  // swap was one of those must still re-mark, and is flagged for the v3 inputs'
  // fingerprint.
  it('watches the pool Swap topic the v3_direct netting arm consumes, from raw_evm_logs, into the same index', () => {
    const swapTopic = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
    expect(v3).toContain('TO price_data.account_trade_volume_watermarks')
    expect(v3).toContain('FROM price_data.raw_evm_logs')
    expect(v3).toContain(`topic0 = '${swapTopic}'`)
    expect(v3).toContain('toUInt8(1) AS v3')
    expect(mv).toContain('toUInt8(0) AS v3')
    for (const col of ['max(ingested_at) AS src_ingest', 'max(block_height) AS src_maxb', 'min(block_timestamp) AS src_min_ts', 'max(block_timestamp) AS src_max_ts']) {
      expect(v3).toContain(col)
      expect(mv).toContain(col)
    }
    const v3EventsMv = schemaStatement('010_uniswap_v3.sql', 'uniswap_v3_pool_events_mv')
    expect(v3EventsMv).toContain(`topic0 = '${swapTopic}', 'Swap'`)
  })
})

describe('accountTradeVolumeStaleBucketsSql', () => {
  const sql = accountTradeVolumeStaleBucketsSql()

  it('keeps a merge-safe per-bucket aggregate projection on both publication twins', () => {
    const live = schemaStatement('001_tables.sql', 'price_data.account_trade_volume (`')
    const staging = schemaStatement('001_tables.sql', 'price_data.account_trade_volume_staging (`')
    for (const table of [live, staging]) {
      expect(table).toContain('PROJECTION computed_by_bucket (SELECT intDiv(block_height, 1800) AS bucket, count() AS n, max(computed_at) AS der_computed, min(registry_fp) AS fp_min, max(registry_fp) AS fp_max GROUP BY bucket)')
      expect(table).toContain("deduplicate_merge_projection_mode = 'rebuild'")
    }
    // The derived side is that projection's exact shape, so it is read key-sized.
    expect(sql.replace(/\s+/g, ' ')).toContain('SELECT intDiv(block_height, 1800) AS bucket, count() AS n, max(computed_at) AS der_computed, min(registry_fp) AS fp_min, max(registry_fp) AS fp_max FROM price_data.account_trade_volume GROUP BY bucket')
  })

  it('diffs the bucket watermark index against each bucket of the model, never raw', () => {
    expect(sql).toContain(`FROM ${ACCOUNT_TRADE_VOLUME_WATERMARKS_TABLE}`)
    expect(sql).not.toContain('price_data.raw_events')
    expect(sql).toContain(`src.src_ingest > der.der_computed - INTERVAL ${INGEST_SETTLE_SECONDS} SECOND`)
    expect(sql).toContain('der.n = 0')
    expect(sql).not.toContain('IS NULL')
    expect(sql.trimEnd().endsWith('ORDER BY src.bucket')).toBe(true)
  })

  // An order indexed after its fill (backward backfill reaches the fill first)
  // changes what the fill's bucket nets to, and only a join can find that bucket.
  it('re-marks a fill\'s bucket when its intent order lands later', () => {
    const flat = sql.replace(/\s+/g, ' ')
    expect(flat).toContain('SELECT intDiv(f.block_height, 1800) AS bucket, max(o.order_ingest) AS dep_ingest')
    expect(flat).toContain('SELECT intent_id, max(ingested_at) AS order_ingest FROM price_data.intent_orders GROUP BY intent_id')
    expect(flat).toContain('greatest(wm.wm_ingest, lo.dep_ingest) AS src_ingest')
  })

  it('re-values a bucket whose registry fingerprint moved, the v3 inputs included where it holds direct v3 swaps', () => {
    expect(sql).toContain(`SELECT a, ${valuationRegistryFingerprintSql('a')} AS h`)
    expect(sql).toContain('groupUniqArrayArray(assets) AS bucket_assets')
    const current = 'bitXor(fp.fp, if(src.v3 = 1, (SELECT fp FROM v3_inputs), toUInt64(0)))'
    expect(sql).toContain(`toString(${current}) AS fingerprint`)
    expect(sql).toContain(`OR der.fp_min != ${current} OR der.fp_max != ${current}`)
    expect(sql).toContain('FROM price_data.uniswap_v3_pools')
  })

  // Valuing a bucket before its candles exist would bake its trades as dropped
  // (HAVING volume_usd > 0) with no later signal to re-mark it.
  it('gates every bucket on price coverage', () => {
    expect(sql).toContain('src.src_min_ts >= priced_from AND priced_to >= src.src_maxb')
    expect(sql).toContain(`${PRICED_FLOOR_SQL} AS priced_from`)
    expect(sql).toContain('(SELECT max(block_height) FROM price_data.blocks) AS priced_to')
  })
})

// The replacement semantics, end to end against a fake client: a month holding a
// stale bucket is reassembled in the twin from the live month's OTHER buckets plus
// the recomputed ones and swapped in whole, so a trade key that vanished from a
// recomputed bucket is gone with it (its old row is never copied).
describe('runAccountTradeVolume publication', () => {
  const stale = [
    { bucket: '8496', src_ingest: '2026-10-02 10:00:00', fingerprint: '11', empty: 0, settled: 1, src_max_ts: '2026-10-02 09:59:58' },
    { bucket: '8497', src_ingest: '2026-10-02 11:59:00', fingerprint: '12', empty: 0, settled: 0, src_max_ts: '2026-10-02 11:58:58' },
  ]
  function fakeClient() {
    const commands: string[] = []
    const client = {
      query: async ({ query }: { query: string }) => ({
        json: async () => {
          if (query.includes('system.processes')) return [{ n: '0' }]
          if (query.startsWith('SELECT toString(now())')) return [{ t: '2026-10-02 12:00:00' }]
          return stale
        },
      }),
      command: async ({ query }: { query: string }) => { commands.push(query.replace(/\s+/g, ' ').trim()); return { summary: { written_rows: '5' } } },
    }
    return { client: client as unknown as Parameters<typeof runAccountTradeVolume>[0], commands }
  }

  it('republishes the month from its kept buckets plus the recomputed ones, stamped with the read time', async () => {
    await loadExplorerAssets({ query: async () => ({ json: async () => [{ asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12 }] }) } as never)
    try {
      const { client, commands } = fakeClient()
      const result = await runAccountTradeVolume(client, 'price_data.test_atv')
      expect(result).toEqual({ model: 'account_trade_volume', rows: 5 })
      const p = '197510'
      expect(commands[0]).toBe(`ALTER TABLE price_data.test_atv_staging DROP PARTITION ${p}`)
      expect(commands[1]).toBe(keptTradeRowsSql('price_data.test_atv', 'price_data.test_atv_staging', p, ['8496', '8497']).replace(/\s+/g, ' '))
      expect(commands[1]).toContain('AND intDiv(block_height, 1800) NOT IN (8496, 8497)')
      expect(commands[2]).toContain('INSERT INTO price_data.test_atv_staging')
      expect(commands[2]).toContain('intDiv(block_height, 1800) IN (8496, 8497)')
      expect(commands[2]).toContain("toDateTime('2026-10-02 12:00:00') AS computed_at")
      expect(commands[2]).toContain("interval_start <= (toDateTime('2026-10-02 11:58:58') - toIntervalHour(1))")
      expect(commands.slice(3)).toEqual([
        `ALTER TABLE price_data.test_atv REPLACE PARTITION ${p} FROM price_data.test_atv_staging`,
        `ALTER TABLE price_data.test_atv_staging DROP PARTITION ${p}`,
      ])
      expect(commands.filter(c => c.startsWith('INSERT INTO price_data.test_atv ') || c.includes('DELETE'))).toEqual([])
    } finally {
      stopExplorerAssetsRefresh()
    }
  })

  it('keeps the month\'s other buckets by the table\'s own partition expression', () => {
    expect(keptTradeRowsSql('l', 's', '202610', ['8496']).replace(/\s+/g, ' '))
      .toBe('INSERT INTO s SELECT * FROM l WHERE toYYYYMM(toDateTime(block_height * 12)) = 202610 AND intDiv(block_height, 1800) NOT IN (8496)')
  })
})

// A month whose rebuild writes zero derived rows leaves the staleness LEFT JOIN
// missing forever, so it would be rebuilt on every cycle to write nothing.
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
// partitioning without an error. Both sides are declared in clickhouse/schema —
// the single source of truth for every table, so no job may create one — which
// leaves this test as the only place their equality can be enforced.
describe('staging twins', () => {
  const TWINNED: Array<[string, string]> = [
    ['price_data.account_trade_volume', '001_tables.sql'],
    ['price_data.omnipool_position_owner_intervals', '001_tables.sql'],
    ['price_data.xyk_farm_principal_intervals', '001_tables.sql'],
    ['price_data.xyk_lp_total_shares_history', '001_tables.sql'],
    ['price_data.pool_swap_hourly', '006_public.sql'],
    ['price_data.pool_volume_hourly', '006_public.sql'],
    ['price_data.asset_volume_hourly', '006_public.sql'],
    ['price_data.routed_volume_hourly', '006_public.sql'],
  ]

  // Statements are separated by `;` but may be preceded by comment lines, so the
  // DDL is taken from CREATE onwards.
  function declaration(name: string, file: string): string {
    const sql = readFileSync(SCHEMA_DIR + file, 'utf8')
    const statement = sql.split(';').find(s => s.includes(`EXISTS ${name} (`))
    if (!statement) throw new Error(`${name} is not declared in clickhouse/schema/${file}`)
    return statement.slice(statement.indexOf('CREATE ')).trim()
  }

  it.each(TWINNED)('%s has a declared twin with identical DDL', (live, file) => {
    const twin = declaration(`${live}_staging`, file).replace(`${live}_staging`, live)

    expect(twin).toBe(declaration(live, file))
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

// revenue_events (clickhouse/schema/008_revenue.sql) is a progressive bucket fold
// whose bucket is a chain-time hour, on the shared staleBucketsSql +
// republishBuckets mechanism. What is particular to it — and pinned here — is
// how the four kinds of input that reach ACROSS an hour still re-mark exactly the
// hours they change: the 'debt' kind cascades forward (cumulative state), a late
// ICE order re-marks its fill's hour, the v3 inputs are fingerprinted on v3
// hours, the money market's chain state per reserve asset and the internal-payer
// tags on every hour.
describe('revenue_hour_watermarks projection', () => {
  const sql = readFileSync(SCHEMA_DIR + '008_revenue.sql', 'utf8')
  const table = schemaStatement('008_revenue.sql', 'price_data.revenue_hour_watermarks (')
  const mvs = sql.split(';').filter(s => s.includes('MATERIALIZED VIEW'))

  it('carries only watermarks a replayed insert cannot inflate, keyed by hour', () => {
    expect(table).toContain('`src_ingest` SimpleAggregateFunction(max, DateTime)')
    expect(table).toContain('`src_minb` SimpleAggregateFunction(min, UInt32)')
    expect(table).toContain('`src_maxb` SimpleAggregateFunction(max, UInt32)')
    expect(table).toContain('`assets` SimpleAggregateFunction(groupUniqArrayArray, Array(UInt32))')
    expect(table).toContain('ORDER BY (hour, kind)')
    expect(table).not.toContain('SimpleAggregateFunction(sum')
    expect(table).not.toContain('AggregateFunction(count')
  })

  it('is fed by one MV per source, each keyed on the chain-time hour', () => {
    expect(mvs).toHaveLength(6)
    for (const mv of mvs) {
      expect(mv).toContain('TO price_data.revenue_hour_watermarks')
      expect(mv).toContain('toStartOfHour(block_timestamp) AS hour')
      expect(mv).toContain('max(ingested_at) AS src_ingest')
      expect(mv).toContain('min(block_height) AS src_minb')
    }
  })

  // The builders read a long list of raw_events and raw_extrinsics shapes (fee
  // events, debits, deposits, dust, EVM markers and logs, XCM barriers and run
  // events, …); watching every row of both tables is what keeps a builder change
  // from silently outgrowing the watermark.
  it('watches every raw_events and raw_extrinsics row, and the raw_evm_logs the builders read', () => {
    const events = mvs.find(mv => mv.includes('FROM price_data.raw_events'))!
    const extrinsics = mvs.find(mv => mv.includes('FROM price_data.raw_extrinsics'))!
    expect(events).not.toContain('WHERE')
    expect(extrinsics).not.toContain('WHERE')
    const logs = mvs.find(mv => mv.includes('FROM price_data.raw_evm_logs'))!
    expect(logs).toContain(`'${AAVE_COLLECTOR}'`)
    expect(logs).toContain(`'${TREASURY_H160}'`)
    expect(logs).toContain("topic0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'")
    expect(logs).toContain("max(toUInt8(ifNull(event_name, '') != 'BalanceTransfer')) AS v3")
    expect(mvs.find(mv => mv.includes('FROM price_data.raw_money_market_events'))).toContain("WHERE event_name = 'LiquidationCall'")
  })

  // An MV insert THROWS on a NULL bound for an ordinary column (an INSERT … SELECT
  // would quietly write the default instead), and a throwing MV fails the raw
  // insert that fed it: raw_evm_logs.event_name is Nullable — a v3 Swap log has
  // none — and a bare `event_name != 'BalanceTransfer'` stalled raw ingestion for
  // 40 minutes. So every Nullable source column an output expression reads must be
  // wrapped in ifNull; WHERE may read it bare (NULL is simply false there).
  it('reads every Nullable source column through ifNull in its outputs', () => {
    for (const mv of mvs) {
      const source = /FROM (price_data\.\w+)/.exec(mv.slice(mv.indexOf(' AS SELECT ')))![1]
      const columns = [...schemaStatement('001_tables.sql', `TABLE IF NOT EXISTS ${source} (`).matchAll(/`(\w+)` Nullable\(/g)].map(m => m[1])
      const outputs = mv.slice(mv.indexOf(' AS SELECT '), mv.indexOf(` FROM ${source}`))
      for (const column of columns) {
        const bare = outputs.replaceAll(`ifNull(${column}, `, '')
        expect(bare, `${source}.${column} in ${outputs.slice(0, 80)}`).not.toMatch(new RegExp(`\\b${column}\\b`))
      }
    }
    // The guard has teeth: the two Nullable reads the outputs make are there, guarded.
    expect(mvs.join()).toContain("ifNull(event_name, '')")
    expect(mvs.join()).toContain("ifNull(reserve_address, '')")
  })

  it('classifies cumulative-state sources as debt and every other source as events', () => {
    const debt = mvs.filter(mv => mv.includes("'debt' AS kind"))
    expect(debt).toHaveLength(2)
    expect(debt.join()).toContain('FROM price_data.atoken_scaled_deltas')
    expect(debt.join()).toContain("FROM price_data.raw_money_market_reserves WHERE event_name IN ('MintedToTreasury', 'ReserveDataUpdated')")
    expect(mvs.filter(mv => mv.includes("'events' AS kind"))).toHaveLength(4)
  })

  // The asset set feeds the registry fingerprint, so it must name the asset the
  // stream's row is valued in: the reserve's registry id, by the stream's own rule.
  it('names a reserve row by the asset the stream values it in', () => {
    const flat = (s: string) => s.replace(/\s+/g, ' ')
    expect(flat(mvs.find(mv => mv.includes('FROM price_data.raw_money_market_reserves'))!))
      .toContain(flat(`groupUniqArray(${reserveAssetIdSql("ifNull(reserve_address, '')")}) AS assets`))
    expect(flat(mvs.find(mv => mv.includes('FROM price_data.raw_money_market_events'))!))
      .toContain(flat(`groupUniqArray(${reserveAssetIdSql("lower(JSONExtractString(decoded_args_json, 'collateralAsset'))")}) AS assets`))
  })
})

describe('revenueEventsStaleHoursSql', () => {
  const sql = revenueEventsStaleHoursSql()
  const flat = sql.replace(/\s+/g, ' ')

  it('keeps a merge-safe per-hour aggregate projection on both publication twins', () => {
    const live = schemaStatement('008_revenue.sql', 'price_data.revenue_events (`')
    const staging = schemaStatement('008_revenue.sql', 'price_data.revenue_events_staging (`')
    for (const t of [live, staging]) {
      expect(t).toContain('PROJECTION computed_by_hour (SELECT toStartOfHour(block_timestamp) AS hour, count() AS n, max(computed_at) AS der_computed, min(registry_fp) AS fp_min, max(registry_fp) AS fp_max GROUP BY hour)')
      expect(t).toContain("deduplicate_merge_projection_mode = 'rebuild'")
    }
    expect(flat).toContain('SELECT toStartOfHour(block_timestamp) AS bucket, count() AS n, max(computed_at) AS der_computed, min(registry_fp) AS fp_min, max(registry_fp) AS fp_max FROM price_data.revenue_events GROUP BY bucket')
  })

  it('diffs the hour watermark indexes against each hour of the model, never raw', () => {
    expect(sql).toContain(`FROM ${REVENUE_HOUR_WATERMARKS_TABLE}`)
    expect(sql).toContain(`FROM ${POOL_SWAP_HOUR_WATERMARKS_TABLE}`)
    for (const raw of ['price_data.raw_events', 'price_data.raw_evm_logs', 'price_data.raw_extrinsics', 'price_data.pool_swap_legs']) {
      expect(sql).not.toContain(raw)
    }
    expect(sql).toContain(`src.src_ingest > der.der_computed - INTERVAL ${INGEST_SETTLE_SECONDS} SECOND`)
    expect(sql.trimEnd().endsWith('ORDER BY src.bucket')).toBe(true)
  })

  // A backfilled debt-token delta or reserve-index row changes the opening state of
  // every later hour: hollar_borrow differences each observation against the
  // previous one however far back, asset_reserve weighs the interest since the
  // previous mint. Marking only its own hour would leave every later one wrong.
  it('cascades debt-kind staleness forward across hours', () => {
    expect(flat).toContain("maxIf(src_ingest, kind = 'debt') AS debt_own")
    expect(flat).toContain('max(debt_own) OVER (ORDER BY hour ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS debt_ingest')
    expect(flat).toContain('greatest(w.ev_ingest, w.debt_ingest, l.legs_ingest, lo.dep_ingest) AS src_ingest')
  })

  it('re-marks an ICE fill\'s hour when its intent order lands later', () => {
    expect(flat).toContain('SELECT toStartOfHour(f.block_timestamp) AS hour, max(o.order_ingest) AS dep_ingest')
    expect(flat).toContain('SELECT intent_id, max(ingested_at) AS order_ingest FROM price_data.intent_orders GROUP BY intent_id')
  })

  it('re-values an hour whose registry, chain-state, tag or v3 fingerprint moved', () => {
    // The reserve map and the B0 anchors are folded into their asset's fingerprint
    // (built against the registry as it stands now, as the expectation is).
    expect(revenueEventsStaleHoursSql().replace(/\s+/g, ' '))
      .toContain(`SELECT x.a AS a, bitXor(${valuationRegistryFingerprintSql('x.a')}, ai.fp) AS h`.replace(/\s+/g, ' '))
    expect(flat).toContain('LEFT JOIN reserve_inputs AS ai ON ai.a = x.a')
    expect(flat).toContain('FROM price_data.atoken_reserve_map FINAL')
    expect(flat).toContain('FROM price_data.atoken_scaled_anchor AS x FINAL')
    const current = 'bitXor(fp.fp, bitXor((SELECT fp FROM internal_payers), if(src.v3 = 1, (SELECT fp FROM v3_revenue_inputs), toUInt64(0))))'
    expect(sql).toContain(`toString(${current}) AS fingerprint`)
    expect(sql).toContain(`OR der.fp_min != ${current} OR der.fp_max != ${current}`)
    expect(flat).toContain('FROM price_data.account_tags FINAL')
    expect(flat).toContain("FROM price_data.uniswap_v3_events AS e FINAL WHERE kind = 'pool' AND event_name = 'SetFeeProtocol'")
    expect(flat).toContain('FROM price_data.uniswap_v3_vaults FINAL')
    expect(flat).toContain('FROM price_data.uniswap_v3_pools')
  })

  // Valuing an hour before its candles exist would bake its rows at 0 USD with no
  // later signal to re-mark it; an open hour is still filling; an hour whose rows
  // are still landing is held until they settle, so each change is folded once.
  it('folds only closed, priced, settled hours, oldest first', () => {
    expect(sql).toContain(`${hourlyFoldCutSql({ watermarks: REVENUE_HOUR_WATERMARKS_TABLE, valued: true })} AS cut`)
    expect(sql).toContain(`${PRICED_FLOOR_SQL} AS floor`)
    expect(sql).toContain(`WHERE src.bucket < cut AND src.bucket >= floor AND src.src_ingest <= now() - INTERVAL ${INGEST_SETTLE_SECONDS} SECOND`)
  })

  it('hands each hour its sources\' block span and whether a HOLLAR index moved in it', () => {
    expect(sql).toContain('toString(src.minb) AS minb, toString(src.maxb) AS maxb, src.hollar AS hollar')
    expect(flat).toContain("maxIf(has(assets, 222), kind = 'debt') AS hollar")
  })
})

describe('revenueHoursPredicate', () => {
  const hour = (bucket: string, minb: number, maxb: number) =>
    ({ bucket, src_ingest: '', fingerprint: '1', empty: 0, settled: 1, minb: String(minb), maxb: String(maxb), hollar: 0 })

  it('narrows to the month, the hours\' block span, and the hours as runs', () => {
    const sql = revenueHoursPredicate('202609', [
      hour('2026-09-02 04:00:00', 300, 399), hour('2026-09-02 03:00:00', 200, 299), hour('2026-09-03 00:00:00', 900, 999),
    ]).replace(/\s+/g, ' ')
    expect(sql).toBe("toYYYYMM(block_timestamp) = 202609 AND block_height >= 200 AND block_height <= 999 AND ((block_timestamp >= toDateTime('2026-09-02 03:00:00') AND block_timestamp < toDateTime('2026-09-02 05:00:00')) OR (block_timestamp >= toDateTime('2026-09-03 00:00:00') AND block_timestamp < toDateTime('2026-09-03 01:00:00')))")
  })

  // The predicate reaches every source read of a builder, so a month of hours must
  // stay one range rather than 720 literals repeated a dozen times.
  it('states a whole month as one range', () => {
    const month = Array.from({ length: 30 * 24 }, (_, i) => hour(new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString().slice(0, 19).replace('T', ' '), i, i))
    const sql = revenueHoursPredicate('202609', month)
    expect(sql.match(/block_timestamp >= /g)).toHaveLength(1)
    expect(sql).toContain("block_timestamp < toDateTime('2026-10-01 00:00:00')")
  })

  it('refuses a partition, an hour of another month, or a broken block span', () => {
    expect(() => revenueHoursPredicate('2026-09', [hour('2026-09-02 03:00:00', 1, 2)])).toThrow()
    expect(() => revenueHoursPredicate('202609', [hour('2026-10-02 03:00:00', 1, 2)])).toThrow()
    expect(() => revenueHoursPredicate('202609', [hour('2026-09-02 03:30:00', 1, 2)])).toThrow()
    expect(() => revenueHoursPredicate('202609', [hour('2026-09-02 03:00:00', 5, 2)])).toThrow()
    expect(() => revenueHoursPredicate('202609', [])).toThrow()
  })
})

describe('revenueEventsInsertSql', () => {
  const hours = [
    { bucket: '2026-08-14 19:00:00', src_ingest: '', fingerprint: '11', empty: 0, settled: 1, minb: '100', maxb: '200', hollar: 1 },
    { bucket: '2026-08-14 20:00:00', src_ingest: '', fingerprint: '12', empty: 0, settled: 1, minb: '201', maxb: '300', hollar: 0 },
  ]

  it('targets the staging twin with an explicit column list, the fingerprint and the read time', () => {
    const sql = revenueEventsInsertSql('network_fee', '202608', hours, '2026-08-14 21:05:00')
    expect(sql).toContain('INSERT INTO price_data.revenue_events_staging (stream, block_height, block_timestamp, event_index, leg_index, dest, account, asset_id, amount, internal_payer, amount_usd, registry_fp, computed_at)')
    expect(sql.replace(/\s+/g, ' ')).toContain("transform(toStartOfHour(block_timestamp), [toDateTime('2026-08-14 19:00:00'), toDateTime('2026-08-14 20:00:00')], [toUInt64(11), toUInt64(12)], toUInt64(0)) AS registry_fp")
    expect(sql).toContain("toDateTime('2026-08-14 21:05:00') AS computed_at")
    expect(() => revenueEventsInsertSql('network_fee', '202608', hours, 'now()')).toThrow()
  })

  // The builder is the one the public fees API and the explorer's tail run; the job
  // only wraps it, so the stream means the same thing in the cold table and the tail.
  it('runs every stream\'s shared builder verbatim, narrowed to exactly the hours it folds', () => {
    for (const stream of REVENUE_EVENT_STREAMS_INSERTED) {
      const sql = revenueEventsInsertSql(stream, '202608', hours, '2026-08-14 21:05:00')
      expect(sql).toContain(buildRevenueEventRowsSql(stream, revenueHoursPredicate('202608', hours)))
      expect(sql).toContain('AND block_height >= 100 AND block_height <= 300')
    }
  })

  // asset_reserve is deliberately absent: a MintedToTreasury lump names no
  // payer, so the protocol's own share of it is carved out against the
  // attribution weights in TS (insertAssetReserveRows) rather than by an
  // INSERT … SELECT that cannot see them. hollar_borrow is out for the same
  // reason plus its hourly TS accrual.
  it('covers every eventful stream except the two the payer split is computed for', () => {
    expect(REVENUE_EVENT_STREAMS_INSERTED).toEqual([
      'omnipool_asset_fee', 'omnipool_protocol_fee', 'liquidation_penalty',
      'pepl_liquidation_profit', 'hsm_revenue', 'ice_matched_fee', 'uniswap_v3_fee', 'network_fee',
      'xcm_execution_fee',
    ])
    expect(REVENUE_EVENT_STREAMS_INSERTED).not.toContain('asset_reserve')
    expect(REVENUE_EVENT_STREAMS_INSERTED).not.toContain('hollar_borrow')
  })
})

// The replacement semantics, end to end against a fake client: a month holding a
// stale hour is reassembled in the twin from the live month's OTHER hours plus the
// recomputed ones — every stream's rows of those hours — and swapped in whole, so
// a row that vanished from a recomputed hour is gone with it.
describe('runRevenueEvents publication', () => {
  const stale = [
    { bucket: '2026-09-02 03:00:00', src_ingest: '2026-09-02 04:00:01', fingerprint: '21', empty: 0, settled: 1, minb: '1000', maxb: '1599', hollar: 0 },
    { bucket: '2026-09-02 04:00:00', src_ingest: '2026-09-02 04:59:59', fingerprint: '22', empty: 0, settled: 0, minb: '1600', maxb: '2199', hollar: 0 },
  ]
  function fakeClient() {
    const commands: string[] = []
    const queries: string[] = []
    const inserts: Array<{ table: string; values: unknown[] }> = []
    const client = {
      query: async ({ query }: { query: string }) => {
        queries.push(query)
        return {
          json: async () => {
            if (query.includes('system.processes')) return [{ n: '0' }]
            if (query.startsWith('SELECT toString(now())')) return [{ t: '2026-09-02 05:10:00' }]
            if (query.trimStart().startsWith('SELECT toString(least(')) return [{ cut: '2026-09-02 05:00:00' }]
            if (query.includes('src.src_ingest > der.der_computed')) return stale
            // The asset_reserve rows of the hours, and the mint windows behind them.
            if (query.includes('-- rev:asset_reserve')) return [{ block_height: 1700, block_timestamp: '2026-09-02 04:12:00', event_index: 3, asset_id: 5, amount: '1000', amount_usd: '2.000000000000' }]
            return []
          },
        }
      },
      command: async ({ query }: { query: string }) => { commands.push(query.replace(/\s+/g, ' ').trim()); return { summary: { written_rows: '3' } } },
      insert: async (args: { table: string; values: unknown[] }) => { inserts.push(args) },
    }
    return { client: client as unknown as Parameters<typeof runRevenueEvents>[0], commands, queries, inserts }
  }

  it('republishes the month from its kept hours plus every stream\'s recomputed rows, stamped with the read time', async () => {
    await loadExplorerAssets({ query: async () => ({ json: async () => [{ asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12 }] }) } as never)
    try {
      const { client, commands, queries, inserts } = fakeClient()
      const result = await runRevenueEvents(client, 'price_data.test_rev')
      expect(result).toEqual({ model: 'revenue_events', rows: REVENUE_EVENT_STREAMS_INSERTED.length * 3 + 1 })
      expect(commands[0]).toBe('ALTER TABLE price_data.test_rev_staging DROP PARTITION 202609')
      expect(commands[1]).toBe("INSERT INTO price_data.test_rev_staging SELECT * FROM price_data.test_rev WHERE toYYYYMM(block_timestamp) = 202609 AND toStartOfHour(block_timestamp) NOT IN (toDateTime('2026-09-02 03:00:00'), toDateTime('2026-09-02 04:00:00'))")
      const streamInserts = commands.slice(2, 2 + REVENUE_EVENT_STREAMS_INSERTED.length)
      for (const [i, stream] of REVENUE_EVENT_STREAMS_INSERTED.entries()) {
        expect(streamInserts[i]).toContain('INSERT INTO price_data.test_rev_staging (stream,')
        expect(streamInserts[i]).toContain(`-- rev:${stream}`)
        expect(streamInserts[i]).toContain("toDateTime('2026-09-02 05:10:00') AS computed_at")
        expect(streamInserts[i]).toContain('block_height >= 1000 AND block_height <= 2199')
      }
      expect(commands.slice(2 + REVENUE_EVENT_STREAMS_INSERTED.length)).toEqual([
        'ALTER TABLE price_data.test_rev REPLACE PARTITION 202609 FROM price_data.test_rev_staging',
        'ALTER TABLE price_data.test_rev_staging DROP PARTITION 202609',
      ])
      // The TS-built asset_reserve row lands in the twin with its hour's stamp.
      expect(inserts).toHaveLength(1)
      expect(inserts[0].table).toBe('price_data.test_rev_staging')
      expect(inserts[0].values[0]).toMatchObject({ stream: 'asset_reserve', leg_index: 0, registry_fp: '22', computed_at: '2026-09-02 05:10:00' })
      // No hour moved a HOLLAR index, so the hollar walk never runs.
      expect(queries.some(q => q.includes('money_market_reserve_state_history'))).toBe(false)
      // Nothing is ever deleted from or appended to the live table in place.
      expect(commands.filter(c => c.startsWith('INSERT INTO price_data.test_rev ') || c.includes('DELETE'))).toEqual([])
    } finally {
      stopExplorerAssetsRefresh()
    }
  })

  it('keeps the month\'s other hours by the table\'s own partition expression', () => {
    expect(keptRevenueRowsSql('l', 's', '202609', ['2026-09-02 03:00:00']).replace(/\s+/g, ' '))
      .toBe("INSERT INTO s SELECT * FROM l WHERE toYYYYMM(block_timestamp) = 202609 AND toStartOfHour(block_timestamp) NOT IN (toDateTime('2026-09-02 03:00:00'))")
  })

  // The candle window must not depend on which hours of the month are folded, or a
  // dead feed's staleness edge would value the same row two ways.
  it('values a month against one candle window whichever hours are folded', () => {
    expect(revenuePriceParams('202609', Date.UTC(2026, 8, 2, 5) / 1000)).toEqual({ anchor: '2026-09-02 05:00:00', hours: 31 })
    expect(revenuePriceParams('202608', Date.UTC(2026, 8, 2, 5) / 1000)).toEqual({ anchor: '2026-09-01 00:00:00', hours: 746 })
  })
})

// Direct EVM swaps in the concentrated-liquidity pools reach pool_swap_legs through
// this job. Three rules make it honest: a swap whose extrinsic already has a
// Router-routed uniswapv3 leg is NOT re-booked (the route counts it once, with its
// op_key), a token neither the registry nor the precompile rule can name drops the
// swap rather than booking it as asset 0, and the fee leg is the pool fee taken from
// the input.
// pool_swap_hourly exists to keep the pool/stats/DefiLlama reads off a 65 M-leg scan. Its
// correctness rests on things a unit test can pin without a database: the
// deduplication happens BEFORE the sum, and it reads exactly the hours it folds.
describe('poolSwapHourlyInsertSql', () => {
  const hours = [{ hour: '2026-08-03 10:00:00', fingerprint: '0' }, { hour: '2026-08-03 11:00:00', fingerprint: '0' }]
  const sql = poolSwapHourlyInsertSql('202608', hours, 'price_data.pool_swap_hourly_staging')

  // The whole reason this is a job and not a materialized view. pool_swap_legs is
  // ReplacingMergeTree(ingested_at), so a replayed range holds two copies of every
  // leg; summing before collapsing them would double a replayed hour, which is the
  // additive-over-replayable-raw failure AGENTS.md forbids.
  it('collapses the leg identity before summing, on the source table ORDER BY', () => {
    const dedup = sql.indexOf('GROUP BY venue, pool_key, block_height, event_index, leg_kind, leg_index')
    const fold = sql.indexOf('GROUP BY venue, pool_key, asset_id, leg_kind, fee_dest, fee_recipient, hour')
    expect(dedup, 'leg identity GROUP BY').toBeGreaterThan(-1)
    expect(fold, 'hourly fold GROUP BY').toBeGreaterThan(dedup)
    // Every non-key column is taken at the newest ingestion, never summed twice.
    for (const column of ['asset_id', 'amount', 'fee_dest', 'fee_recipient']) {
      expect(sql, column).toContain(`argMax(${column}, ingested_at)`)
    }
  })

  // The sum is the only arithmetic here and an hour of 18-decimal legs passes
  // 2^64, so it runs in Decimal256 and is stored as a string.
  it('sums in Decimal256 and stores a string', () => {
    expect(sql).toContain('toString(sum(toDecimal256(amount, 0)))')
    expect(sql).not.toMatch(/toUInt64\(\s*amount/)
    expect(sql).not.toMatch(/toFloat\d*\(\s*amount/)
  })

  // The source's own partition plus the hour set: a recompute reads one month
  // partition, and of it only the hours being folded.
  it('reads exactly the hours it folds, inside their one source month', () => {
    expect(sql).toContain(hourLegsPredicate('202608', hours.map(h => h.hour)))
    expect(sql).toContain('INSERT INTO price_data.pool_swap_hourly_staging')
  })

  it('aggregates in order', () => {
    expect(sql).toContain('optimize_aggregation_in_order = 1')
  })
})

describe('hourLegsPredicate', () => {
  it('prunes to the month and the hour span, then keeps exactly the hour set', () => {
    const sql = hourLegsPredicate('202608', ['2026-08-03 11:00:00', '2026-08-01 00:00:00'])
    expect(sql).toContain('toYYYYMM(block_timestamp) = 202608')
    expect(sql).toContain("block_timestamp >= toDateTime('2026-08-01 00:00:00')")
    expect(sql).toContain("block_timestamp < toDateTime('2026-08-03 11:00:00') + INTERVAL 1 HOUR")
    expect(sql).toContain("toStartOfHour(block_timestamp) IN (toDateTime('2026-08-01 00:00:00'), toDateTime('2026-08-03 11:00:00'))")
  })

  it('refuses a partition, an hour of another month, or anything not an hour literal', () => {
    expect(() => hourLegsPredicate('2026-08', ['2026-08-01 00:00:00'])).toThrow()
    expect(() => hourLegsPredicate('202608', ['2026-09-01 00:00:00'])).toThrow()
    expect(() => hourLegsPredicate('202608', ['2026-08-01 00:30:00'])).toThrow()
    expect(() => hourLegsPredicate('202608', ["2026-08-01 00:00:00') OR 1 --"])).toThrow()
    expect(() => hourLegsPredicate('202608', [])).toThrow()
  })
})

describe('pool_swap_hour_watermarks projection', () => {
  const table = schemaStatement('006_public.sql', 'price_data.pool_swap_hour_watermarks (`hour`')
  const mv = schemaStatement('006_public.sql', 'pool_swap_hour_watermarks_mv')

  it('stores one replay-idempotent max watermark and asset set per chain-time hour', () => {
    expect(table).toContain('SimpleAggregateFunction(max, DateTime)')
    expect(table).toContain('SimpleAggregateFunction(groupUniqArrayArray, Array(UInt32))')
    expect(table).toContain('ORDER BY hour')
    expect(mv).toContain('toStartOfHour(block_timestamp) AS hour')
    expect(mv).toContain('max(ingested_at) AS src_ingest')
    expect(mv).toContain('groupUniqArray(asset_id) AS assets')
    expect(mv).toContain('FROM price_data.pool_swap_legs')
    expect(mv).not.toMatch(/\bsum\s*\(/i)
    expect(mv).not.toMatch(/\bcount\s*\(/i)
  })
})

describe('hourlyFoldStaleHoursSql', () => {
  const raw = hourlyFoldStaleHoursSql(POOL_SWAP_HOURLY_FOLD)
  const valued = hourlyFoldStaleHoursSql(POOL_VOLUME_HOURLY_FOLD)

  // Ingest-time watermarks per hour, never row counts (a fold is a strict
  // reduction) and never a forward block cursor (blind under backward backfill).
  // The source is the MV-fed hourly index, never a scan of pool_swap_legs.
  it('diffs the hourly watermark index against each hour of the fold, never source legs', () => {
    for (const sql of [raw, valued]) {
      expect(sql).toContain('FROM price_data.pool_swap_hour_watermarks')
      expect(sql).toContain('max(computed_at) AS der_computed')
      expect(sql).toContain('ON der.bucket = src.bucket')
      expect(sql).not.toContain('FROM price_data.pool_swap_legs')
      expect(sql).not.toMatch(/block_height/)
    }
  })

  // A leg landing in the second its hour was folded, or a v3 leg stamped after a
  // fold that ran without it, is caught by the settle margin rather than lost.
  it('re-marks an hour whose newest leg is not clearly older than its fold', () => {
    expect(INGEST_SETTLE_SECONDS).toBe(300)
    expect(raw).toContain('src.src_ingest > der.der_computed - INTERVAL 300 SECOND')
  })

  it('recognises a never-folded hour under ClickHouse default join semantics', () => {
    expect(raw).toContain('der.n = 0')
    expect(raw).not.toContain('IS NULL')
  })

  it('folds only closed hours below the cut, oldest first', () => {
    expect(raw).toContain(`WITH ${hourlyFoldCutSql(POOL_SWAP_HOURLY_FOLD)} AS cut`)
    expect(raw).toContain('WHERE src.bucket < cut')
    expect(raw.trimEnd().endsWith('ORDER BY src.bucket')).toBe(true)
  })

  // Neither a price row nor a candle has an ingest time, so an hour folded below
  // the price pipeline's floor would stay unpriced forever: it waits instead.
  it('holds a valued fold above the price floor, leaving the epoch rows out; a raw fold has none', () => {
    expect(valued).toContain(`${PRICED_FLOOR_SQL} AS floor`)
    expect(valued).toContain('WHERE src.bucket < cut AND src.bucket >= floor')
    expect(PRICED_FLOOR_SQL).toContain("(SELECT min(block_timestamp) FROM price_data.blocks WHERE _partition_id != '197001')")
    // A candle is usable from its close.
    expect(PRICED_FLOOR_SQL).toContain("(SELECT min(interval_start) FROM price_data.ohlc_1h WHERE _partition_id != '197001') + INTERVAL 1 HOUR")
    expect(raw).not.toContain('floor')
  })

  it('re-marks a valued hour whose registry fingerprint moved; a raw fold carries none', () => {
    // Built here, against the registry the expectation is built against.
    const valuedNow = hourlyFoldStaleHoursSql(POOL_VOLUME_HOURLY_FOLD)
    expect(valuedNow).toContain(`SELECT a, ${valuationRegistryFingerprintSql('a')} AS h`)
    expect(valued).toContain('groupUniqArrayArray(assets) AS bucket_assets')
    expect(valued).toContain('groupBitXor(f.h) AS fp')
    expect(valued).toContain('OR der.fp_min != fp.fp OR der.fp_max != fp.fp')
    expect(raw).not.toContain('registry_fp')
    expect(raw).toContain('toUInt64(0) AS fp')
  })
})

describe('hourlyFoldCutSql', () => {
  it('cuts a raw fold at the newest leg hour', () => {
    expect(hourlyFoldCutSql(POOL_SWAP_HOURLY_FOLD)).toBe('(SELECT max(hour) FROM price_data.pool_swap_hour_watermarks)')
  })

  // The price head is the older of the newest block and the newest price row,
  // read from part metadata and the 1h candle MV instead of the 190 M-row prices.
  it('also cuts a valued fold at the price head', () => {
    const flat = hourlyFoldCutSql(POOL_VOLUME_HOURLY_FOLD).replace(/\s+/g, ' ')
    expect(flat).toBe('least((SELECT max(hour) FROM price_data.pool_swap_hour_watermarks), toStartOfHour((SELECT max(block_timestamp) FROM price_data.blocks)), (SELECT max(interval_start) FROM price_data.ohlc_1h))')
    expect(flat).not.toContain('price_data.prices')
  })
})

describe('bucketsToFold / bucketsByPartition', () => {
  const h = (bucket: string, src: string, empty = 0, settled = 1, fingerprint = '0') => ({ bucket, src_ingest: src, fingerprint, empty, settled })

  it('skips an empty bucket this process already folded at the same watermark and fingerprint, and nothing else', () => {
    const folded = new Map([
      ['2026-08-01 00:00:00', 'A|0'], ['2026-08-01 01:00:00', 'A|0'], ['2026-08-01 02:00:00', 'A|0'], ['2026-08-01 04:00:00', 'A|0'],
    ])
    const kept = bucketsToFold([
      h('2026-08-01 00:00:00', 'A', 1), // empty, same watermark: skipped
      h('2026-08-01 01:00:00', 'B', 1), // empty, a leg moved it: folded
      h('2026-08-01 02:00:00', 'A', 0), // rows, stale on its own terms: folded
      h('2026-08-01 03:00:00', 'A', 1, 0), // empty but still settling: folded
      h('2026-08-01 04:00:00', 'A', 1, 1, '9'), // empty, the registry moved: folded
    ], folded)
    expect(kept.map(k => k.bucket)).toEqual(['2026-08-01 01:00:00', '2026-08-01 02:00:00', '2026-08-01 03:00:00', '2026-08-01 04:00:00'])
  })

  it('groups buckets into month partitions, oldest month first', () => {
    const months = bucketsByPartition([h('2026-09-02 00:00:00', 'A'), h('2026-08-31 23:00:00', 'A'), h('2026-09-01 00:00:00', 'A')], b => b.bucket, hourPartition)
    expect(months.map(([p, hs]) => [p, hs.map(x => x.bucket)])).toEqual([
      ['202608', ['2026-08-31 23:00:00']],
      ['202609', ['2026-09-02 00:00:00', '2026-09-01 00:00:00']],
    ])
  })
})

// The replacement semantics, end to end against a fake client: a month holding a
// stale hour is reassembled in the twin from the live month's OTHER hours plus
// the recomputed ones and swapped in whole. So a key that vanished from a
// recomputed hour is gone (its old row is never copied), the untouched hours keep
// their rows and their computed_at, and no reader ever sees the month half-built.
describe('runHourlyFold publication', () => {
  function fakeClient(stale: Array<Record<string, unknown>>) {
    const commands: string[] = []
    const client = {
      query: async ({ query }: { query: string }) => ({
        json: async () => {
          if (query.includes('system.processes')) return [{ n: '0' }]
          if (query.includes('AS cut') && query.trimStart().startsWith('SELECT toString(')) return [{ cut: '2026-09-02 05:00:00' }]
          return stale
        },
      }),
      command: async ({ query }: { query: string }) => { commands.push(query.replace(/\s+/g, ' ').trim()); return { summary: { written_rows: '7' } } },
    }
    return { client: client as unknown as Parameters<typeof runHourlyFold>[0], commands }
  }
  const stale = [
    { bucket: '2026-08-31 23:00:00', src_ingest: '2026-09-01 00:00:05', fingerprint: '0', empty: 0, settled: 1 },
    { bucket: '2026-09-02 03:00:00', src_ingest: '2026-09-02 04:00:01', fingerprint: '0', empty: 0, settled: 1 },
    { bucket: '2026-09-02 04:00:00', src_ingest: '2026-09-02 04:59:59', fingerprint: '0', empty: 0, settled: 0 },
  ]
  const fold = { ...POOL_SWAP_HOURLY_FOLD, table: 'price_data.test_fold' }

  it('republishes each touched month from its kept hours plus its recomputed ones, oldest month first', async () => {
    const { client, commands } = fakeClient(stale)
    const result = await runHourlyFold(client, fold)
    expect(result).toEqual({ model: 'pool_swap_hourly', rows: 14 })
    const august = [
      'ALTER TABLE price_data.test_fold_staging DROP PARTITION 202608',
      "INSERT INTO price_data.test_fold_staging SELECT * FROM price_data.test_fold WHERE toYYYYMM(hour) = 202608 AND hour NOT IN (toDateTime('2026-08-31 23:00:00'))",
    ]
    expect(commands.slice(0, 2)).toEqual(august)
    expect(commands[2]).toContain('INSERT INTO price_data.test_fold_staging (venue, pool_key')
    expect(commands[2]).toContain("toStartOfHour(block_timestamp) IN (toDateTime('2026-08-31 23:00:00'))")
    expect(commands.slice(3, 5)).toEqual([
      'ALTER TABLE price_data.test_fold REPLACE PARTITION 202608 FROM price_data.test_fold_staging',
      'ALTER TABLE price_data.test_fold_staging DROP PARTITION 202608',
    ])
    expect(commands[6]).toBe("INSERT INTO price_data.test_fold_staging SELECT * FROM price_data.test_fold WHERE toYYYYMM(hour) = 202609 AND hour NOT IN (toDateTime('2026-09-02 03:00:00'), toDateTime('2026-09-02 04:00:00'))")
    expect(commands[7]).toContain("toStartOfHour(block_timestamp) IN (toDateTime('2026-09-02 03:00:00'), toDateTime('2026-09-02 04:00:00'))")
    expect(commands[8]).toBe('ALTER TABLE price_data.test_fold REPLACE PARTITION 202609 FROM price_data.test_fold_staging')
    expect(commands).toHaveLength(10)
    // Nothing is ever deleted from or appended to the live table in place.
    expect(commands.filter(c => c.startsWith('INSERT INTO price_data.test_fold ') || c.includes('DELETE'))).toEqual([])
  })

  it('passes a valued fold its month candle window, anchored on the cycle cut', async () => {
    const calls: Array<{ query: string; query_params?: unknown }> = []
    const { client } = fakeClient(stale.slice(1, 2))
    const spy = client as unknown as { command: (a: { query: string; query_params?: unknown }) => Promise<unknown> }
    const inner = spy.command
    spy.command = async args => { calls.push(args); return inner(args) }
    await loadExplorerAssets({ query: async () => ({ json: async () => [{ asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12 }] }) } as never)
    try {
      await runHourlyFold(client, { ...POOL_VOLUME_HOURLY_FOLD, table: 'price_data.test_fold' })
    } finally {
      stopExplorerAssetsRefresh()
    }
    const insert = calls.find(c => c.query.includes('INSERT INTO price_data.test_fold_staging (venue'))
    expect(insert?.query_params).toEqual({ anchor: '2026-09-02 05:00:00', hours: 29 })
    expect(insert?.query).toContain('toUInt64(0)) AS registry_fp')
  })
})

// The v3 legs job writes only what changed, so a quiet cycle writes nothing and
// re-marks no downstream hour; and its change detection is per hour of ingest
// time, so a backfilled swap below the head is legged on the next cycle.
describe('uniswapV3SwapHoursSql / uniswapV3LegInputsFingerprintSql', () => {
  it('reads the Swap logs\' own ingest time per hour, never a block cursor', () => {
    const sql = uniswapV3SwapHoursSql()
    expect(sql).toContain('max(ingested_at) AS log_ingest')
    expect(sql).toContain("WHERE kind = 'pool' AND event_name = 'Swap'")
    expect(sql).toContain('toStartOfHour(block_timestamp) AS log_hour')
    expect(sql).toContain(`greatest(s.log_ingest, h.hop_ingest) <= now() - INTERVAL ${INGEST_SETTLE_SECONDS} SECOND AS settled`)
    expect(sql).not.toMatch(/block_height/)
  })

  // A routed hop's op_key and swapper come from its Broadcast.Swapped3, so a
  // raw_events repair of the hop must re-examine the hour on its own.
  it('raises an hour\'s watermark by its routed hops\' ingest time, from their MV-fed index', () => {
    const sql = uniswapV3SwapHoursSql()
    expect(sql).toContain('FROM price_data.uniswap_v3_hop_hour_watermarks')
    expect(sql).toContain('toString(greatest(s.log_ingest, h.hop_ingest)) AS src_ingest')
    expect(sql).not.toContain('price_data.raw_events')
    const mv = schemaStatement('010_uniswap_v3.sql', 'uniswap_v3_hop_hour_watermarks_mv')
    expect(mv).toContain("FROM price_data.raw_events WHERE (event_name = 'Broadcast.Swapped3') AND (JSONExtractString(args_json, 'fillerType', '__kind') = 'UniswapV3')")
    expect(mv).toContain('toStartOfHour(block_timestamp) AS hour, max(ingested_at) AS src_ingest')
    // The legs job reads exactly those hops.
    expect(uniswapV3LegsInsertSql('202609', ['2026-09-10 10:00:00'])).toContain("WHERE event_name = 'Broadcast.Swapped3'")
  })

  it('fingerprints every pool\'s tokens, fee tier and resolved assets', () => {
    const sql = uniswapV3LegInputsFingerprintSql()
    expect(sql).toContain('groupBitXor(cityHash64(p.pool_address, p.token0, p.token1, p.fee,')
    expect(sql).toContain("FROM price_data.assets WHERE evm_address != ''")
    expect(sql).toContain('FROM price_data.uniswap_v3_pools GROUP BY pool_address')
  })
})

describe('runUniswapV3Legs change detection', () => {
  function fakeClient(state: { fingerprint: string; hours: Array<{ hour: string; src_ingest: string; settled: number }> }) {
    const inserts: string[] = []
    const client = {
      query: async ({ query }: { query: string }) => ({
        json: async () => (query.includes('groupBitXor') ? [{ fingerprint: state.fingerprint }]
          : query.includes('toString(now())') ? [{ t: '2026-10-02 09:00:00' }]
          : query.includes('SELECT count() AS n') ? [{ n: '3' }]
          : state.hours),
      }),
      // The summary also counts the rows the MVs over pool_swap_legs wrote.
      command: async ({ query }: { query: string }) => { inserts.push(query); return { summary: { written_rows: '8' } } },
    }
    return { client: client as unknown as Parameters<typeof runUniswapV3Legs>[0], inserts }
  }
  const hoursIn = (sql: string) => [...sql.matchAll(/toStartOfHour\(block_timestamp\) IN \(([^)]*\))*\)/g)][0]?.[0] ?? ''

  it('examines every hour first, then only hours whose logs moved or are still settling, and all again when an input moves', async () => {
    const state = {
      fingerprint: 'F1',
      hours: [
        { hour: '2026-09-10 10:00:00', src_ingest: '2026-09-10 10:30:00', settled: 1 },
        { hour: '2026-10-01 10:00:00', src_ingest: '2026-10-01 10:30:00', settled: 1 },
        { hour: '2026-10-02 08:00:00', src_ingest: '2026-10-02 08:59:00', settled: 0 },
      ],
    }
    const { client, inserts } = fakeClient(state)
    await runUniswapV3Legs(client)
    expect(inserts).toHaveLength(2) // 202609 and 202610, every hour
    inserts.length = 0

    // A backfilled log raises an old hour's watermark; the live hour still settles.
    state.hours[0] = { ...state.hours[0], src_ingest: '2026-10-02 09:00:00' }
    const second = await runUniswapV3Legs(client)
    expect(inserts).toHaveLength(2)
    expect(hoursIn(inserts[0])).toContain("toDateTime('2026-09-10 10:00:00')")
    expect(hoursIn(inserts[1])).toContain("toDateTime('2026-10-02 08:00:00')")
    expect(hoursIn(inserts[1])).not.toContain("toDateTime('2026-10-01 10:00:00')")
    expect(second.rows).toBe(6)
    inserts.length = 0

    state.hours[2] = { ...state.hours[2], settled: 1 }
    await runUniswapV3Legs(client)
    expect(inserts).toHaveLength(1) // the live hour, once more now it has settled
    inserts.length = 0
    await runUniswapV3Legs(client)
    expect(inserts).toHaveLength(0)

    state.fingerprint = 'F2' // a pool or token mapping moved
    await runUniswapV3Legs(client)
    expect(inserts).toHaveLength(2)
  })
})

describe('uniswapV3LegsInsertSql', () => {
  const sql = uniswapV3LegsInsertSql('202608', ['2026-08-03 10:00:00'])

  // The Broadcast MV leaves the venue to this job (its filler is the router, not the
  // pool), so a routed hop is booked HERE with the route's Router id — matched to the
  // hop's UniswapV3 Swapped3 by extrinsic and input amount — and nets with its
  // siblings; a direct swap gets one op_key of its own.
  it('keys a routed hop on its Router id and a direct swap on its own log', () => {
    expect(sql).toContain("JSONExtractString(args_json, 'fillerType', '__kind') = 'UniswapV3'")
    expect(sql).toMatch(/extractGroups\(args_json, '.*Router.*'\)\[1\]\) AS router_id/)
    expect(sql).toContain("if(router_id > 0, toString(router_id), concat('evm:', toString(block_height), ':', toString(event_index))) AS op_key")
  })

  it('reads the pool tokens from the pools projection and drops an unresolvable token', () => {
    expect(sql).toContain('INNER JOIN pools AS p ON p.pool_address = e.contract_address')
    expect(sql).toContain("FROM price_data.assets WHERE evm_address != ''")
    expect(sql).toContain('asset0 != 4294967295 AND asset1 != 4294967295')
  })

  it('books in, out and the LP fee leg off the input amount, for exactly the hours it examines', () => {
    expect(sql).toContain("tuple(toUInt8(3), asset_in, intDiv(amount_in * toUInt256(s.fee), toUInt256(1000000)), 'account', pool_account)")
    expect(sql).toContain("CAST(legs[leg_i].1 AS Enum8('in' = 1, 'out' = 2, 'fee' = 3)) AS leg_kind")
    expect(sql).toContain('INSERT INTO price_data.pool_swap_legs (venue, pool_key, block_height, event_index, leg_index, leg_kind, asset_id, amount, fee_dest, fee_recipient, swapper, op_key, extrinsic_index, block_timestamp, ingested_at)')
    const span = hourLegsPredicate('202608', ['2026-08-03 10:00:00'])
    expect(sql).toContain(`WHERE kind = 'pool' AND event_name = 'Swap' AND ${span}`)
    expect(sql).toContain(`WHERE event_name = 'Broadcast.Swapped3' AND ${span}`)
    expect(sql).toContain('AND block_height IN (SELECT block_height FROM swap_logs)')
    expect(sql).not.toMatch(/block_height > \d/)
  })

  // Only a leg that is missing or differs from its newest written version is
  // inserted, so an unchanged leg is never re-stamped; a written leg is stamped
  // now(), which outranks the version it corrects and post-dates every fold that
  // ran without it.
  it('inserts only legs whose content differs from their newest written version', () => {
    expect(sql).toContain("FROM price_data.pool_swap_legs AS l\n  WHERE l.venue = 'uniswapv3'")
    expect(sql).toMatch(/argMax\(cityHash64\(l\.asset_id, l\.amount, toString\(l\.fee_dest\), l\.fee_recipient, l\.swapper, l\.op_key,\s+ifNull\(l\.extrinsic_index, 4294967295\), l\.block_timestamp\), l\.ingested_at\) AS content/)
    expect(sql).toMatch(/WHERE w\.content != cityHash64\(c\.asset_id, c\.amount, toString\(c\.fee_dest\), c\.fee_recipient, c\.swapper, c\.op_key,\s+ifNull\(c\.extrinsic_index, 4294967295\), c\.block_timestamp\)/)
    expect(sql).toContain('now() AS ingested_at')
  })

  it('bounds the pass before it runs', () => {
    expect(sql).toContain('max_memory_usage = 2000000000')
    expect(sql).toContain('max_threads = 4')
  })

  it('names the swapper in the ETH-prefixed account form and never a raw H160', () => {
    expect(sql).toContain("concat('0x45544800', substring(recipient, 3, 40), '0000000000000000')")
  })

  // A routed hop's Swap log names the SwapRouter as its recipient, so the log alone
  // credits every routed fill to the router's own pallet account — measured live,
  // 612 of 614 fee legs. The Broadcast the hop is already matched to for its Router
  // id carries the account the router traded FOR, which is the real trader; the log's
  // recipient stands only for a direct EVM swap, which has no Broadcast at all.
  it('takes a routed hop’s swapper from its Broadcast, not from the router it filled through', () => {
    expect(sql).toContain("JSONExtractString(args_json, 'swapper') AS swapper")
    expect(sql).toMatch(/routed_swapper != ''/)
  })

  // A DCA execution runs in on_initialize, so its Swap log carries NO extrinsic
  // index; the match key `ext` must be a plain column on both sides (measured: 0 of
  // 139 hook-phase hops matched their Broadcast when it was not). They then kept the
  // router as swapper AND took an `evm:` op_key, which reads as a direct swap and
  // breaks the route's netting.
  it('matches a hook-phase hop, whose Swap log has no extrinsic index', () => {
    expect(sql).toContain('ifNull(extrinsic_index, 4294967295) AS ext')
    expect(sql).toContain('ON h.block_height = s.block_height AND h.ext = s.ext')
  })
})

describe('revenue staging twins', () => {
  function declaration(name: string): string {
    const sql = readFileSync(SCHEMA_DIR + '008_revenue.sql', 'utf8')
    const statement = sql.split(';').find(s => s.includes(`EXISTS ${name} (`))
    if (!statement) throw new Error(`${name} is not declared in clickhouse/schema/008_revenue.sql`)
    return statement.slice(statement.indexOf('CREATE ')).trim()
  }

  it.each(['price_data.revenue_events', 'price_data.account_revenue'])('%s has a declared twin with identical DDL', live => {
    const twin = declaration(`${live}_staging`).replace(`${live}_staging`, live)
    expect(twin).toBe(declaration(live))
  })
})

describe('accountRevenueStaleMonthsSql', () => {
  const sql = accountRevenueStaleMonthsSql()
  const flat = sql.replace(/\s+/g, ' ')

  // revenue_events' hour staleness already folds in the forward-cascading debt
  // sources and every fingerprint, so following its publication per month is
  // what keeps the per-account split in step with the booked totals.
  it('keys staleness on the month\'s revenue_events publication, through the per-hour projection', () => {
    expect(flat).toContain('SELECT toStartOfHour(block_timestamp) AS hour, max(computed_at) AS der_computed FROM price_data.revenue_events GROUP BY hour')
    expect(flat).toContain('SELECT toYYYYMM(hour) AS p, max(der_computed) AS rev_ingest')
    expect(sql).toContain('der.der_computed = toDateTime(0) OR src.eff_ingest > der.der_computed')
    expect(sql).not.toContain('IS NULL')
  })

  // The v3 split's WEIGHTS come from pool_swap_legs over a realization's window,
  // which opens at the previous realization — routinely in an earlier month — so a
  // corrected leg must re-mark every later month, not only its own.
  it('follows the v3 legs the per-account split is weighted by, cascading forward', () => {
    expect(sql).toContain("venue = 'uniswapv3'")
    expect(sql).toContain('price_data.pool_swap_legs')
    expect(flat).toContain('max(v3_ingest) OVER (ORDER BY p ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)')
  })

  // A leg past the last published hour weighs no realization yet; following it
  // would rebuild the live month on every cycle the v3 legs job writes.
  it('follows only the legs of published hours', () => {
    expect(flat).toContain('AND block_timestamp < (SELECT toStartOfHour(max(block_timestamp)) + INTERVAL 1 HOUR FROM price_data.revenue_events)')
  })

  // A rebuild reads only published hours (the hollar weights end at the stream's
  // mark), so nothing gates or throttles the live month.
  it('rebuilds a month when its publication moves, on no clock of its own', () => {
    expect(sql).not.toContain('now()')
    expect(sql).not.toContain('SECOND')
    expect(sql).not.toContain('toYYYYMM(now())')
  })

  it('orders candidates oldest first', () => {
    expect(sql.trimEnd().endsWith('ORDER BY src.p')).toBe(true)
  })
})

describe('hollarWeightsEndSeconds', () => {
  const monthEnd = Date.UTC(2026, 9, 1) / 1000
  it('ends a closed month at its end and the live month at the stream\'s mark', () => {
    expect(hollarWeightsEndSeconds(monthEnd, monthEnd + 86_400)).toBe(monthEnd)
    expect(hollarWeightsEndSeconds(monthEnd, monthEnd - 7_200)).toBe(monthEnd - 7_200)
    expect(hollarWeightsEndSeconds(monthEnd, null)).toBe(monthEnd)
  })
})

describe('accountRevenueEventfulInsertSql', () => {
  const sql = accountRevenueEventfulInsertSql('202608')

  it('targets the staging twin with an explicit column list', () => {
    expect(sql).toContain('INSERT INTO price_data.account_revenue_staging (account, stream, month, revenue_usd)')
    expect(accountRevenueEventfulInsertSql('202608', 's', 'r')).toContain('INSERT INTO s (account')
    expect(accountRevenueEventfulInsertSql('202608', 's', 'r')).toContain('FROM r\n')
  })

  it('folds only protocol revenue and leaves the attributed streams to the accumulator', () => {
    expect(sql).toContain("stream NOT IN ('hollar_borrow', 'asset_reserve', 'uniswap_v3_fee')")
    // The shared protocol predicate: lp/burned/unknown omnipool asset-fee legs
    // exist only for the public destination matrix and are never account revenue.
    expect(sql).toContain("(stream != 'omnipool_asset_fee' OR dest IN ('protocol', 'burned', 'pol')) AND dest != 'lp'")
    expect(sql).toContain('GROUP BY account, stream')
    expect(sql).toContain('toYYYYMM(block_timestamp) = 202608')
  })

  // account_revenue is a ReplacingMergeTree over (account, stream, month), so a
  // key written by two statements of one build is not two addends: the next merge
  // keeps one row and the other's revenue is gone. Measured live before this was
  // pinned: uniswap_v3_fee's accrued rows were inserted here AND its realization
  // shares by the batch, 194 of 195 accounts collided, and the month read $10
  // under FINAL against the $868 the rows summed to. The exclusion list must be
  // the accumulator's own, with no stream re-admitted for "part" of its rows.
  it('excludes every accumulator stream whole, uniswap_v3_fee included', () => {
    for (const stream of ACCOUNT_REVENUE_ATTRIBUTED_STREAMS) {
      expect(sql).toContain(`'${stream}'`)
    }
    expect(ACCOUNT_REVENUE_ATTRIBUTED_STREAMS).toContain('uniswap_v3_fee')
    expect(sql).not.toContain("stream = 'uniswap_v3_fee'")
    expect(sql).not.toContain("account != ''")
  })
})

describe('accountRevenueV3AccruedSql', () => {
  const sql = accountRevenueV3AccruedSql('202609')

  // The accrued half is READ, not inserted: it joins the realization shares in the
  // accumulator so an account that has both gets one row for the month.
  it('reads the accrued rows per account for the accumulator, never inserting', () => {
    expect(sql.trimStart().startsWith('-- rev:account-revenue:v3-accrued\nSELECT')).toBe(true)
    expect(sql).not.toContain('INSERT')
    expect(sql).toContain('toString(sum(amount_usd)) AS usd')
    expect(sql).toContain('GROUP BY account')
  })

  // The stream's two arms are told apart by dest, never by whether the payer is
  // named: a blanked swapper's accrual (a pallet's own swap) is still an accrued
  // row and must land on account '' as unattributed, not vanish from the model.
  it('selects the per-swap accruals of the partition by dest, whatever the payer', () => {
    expect(sql).toContain("stream = 'uniswap_v3_fee' AND dest = 'accrued'")
    expect(sql).toContain('toYYYYMM(block_timestamp) = 202609')
    expect(sql).toContain("(stream != 'omnipool_asset_fee' OR dest IN ('protocol', 'burned', 'pol')) AND dest != 'lp'")
    expect(sql).not.toContain("account != ''")
  })
})

describe('uniswapV3RealizationsSql', () => {
  // The treasury's Transfer logs are read at the realization rows' own keys, a
  // primary-key point read, never as a scan of every transfer it ever received.
  it('reads the treasury transfers only at the realizations\' own keys, from the given revenue table', () => {
    const sql = uniswapV3RealizationsSql('price_data.r')
    expect(sql.replace(/\s+/g, ' ')).toContain("AND (l.block_height, l.event_index) IN ( SELECT block_height, event_index FROM price_data.r WHERE stream = 'uniswap_v3_fee' AND dest = '' )")
    expect(sql).toContain('FROM price_data.r AS r')
    expect(sql).not.toContain('price_data.revenue_events')
  })
})

describe('accountRevenueKeyCollisionsSql', () => {
  // The guard the build runs on its staged month before REPLACE PARTITION: any
  // key held twice means a second writer for a stream, and the month stays
  // unpublished rather than losing revenue at its next merge.
  it('counts the staged month\'s doubled (account, stream) keys exactly', () => {
    const sql = accountRevenueKeyCollisionsSql('202609')
    expect(sql).toBe('SELECT count() - uniqExact(account, stream) AS n FROM price_data.account_revenue_staging WHERE month = 202609')
  })
})

describe('xcm_arrivals', () => {
  // The stored model must not restate the feed's walk. A SQL restatement was measured
  // against it and drifted four ways (barrier set, credit set, reserved-account
  // prefixes, and the crossable events the run steps over), so the job calls
  // xcmInboundCreditsForBlocks instead. This pins that it still does.
  it('derives arrivals from the feed walk, not from its own SQL', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./jobs.ts', import.meta.url)), 'utf8')
    const section = src.slice(src.indexOf('xcm_arrivals ──'))
    expect(section).toContain('xcmInboundCreditsForBlocks')
    // No second copy of the classification: these are the constants the SQL version
    // carried, and their absence is what keeps the two from diverging again.
    expect(section).not.toContain('Tokens.Deposited')
    expect(section).not.toContain('0x6d6f646c')
    expect(section).not.toContain('ROWS BETWEEN')
  })

  // Walking history in one pass would hold every block's events at once; chunks bound
  // both the ClickHouse reads and the rows in memory.
  it('splits a block list into bounded chunks covering it exactly', () => {
    expect(xcmArrivalsChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(xcmArrivalsChunks([100], 50)).toEqual([[100]])
    expect(xcmArrivalsChunks([], 50)).toEqual([])
    const blocks = Array.from({ length: 1_000 }, (_, i) => i * 7)
    expect(xcmArrivalsChunks(blocks, 100).flat()).toEqual(blocks)
  })

  // A block range between the derived table's own min and max cannot express this
  // model's coverage: a walked block that decoded to nothing leaves no row, so the
  // first chunk of a low-end fill dropped the derived minimum to the source minimum
  // and everything between was treated as covered for good — and a raw row corrected
  // INSIDE the range was never recomputed at all. Both are silent.
  describe('coverage is an ingest-time watermark per month, never a block range', () => {
    const sql = xcmArrivalsStaleMonthsSql()

    it('compares the raw ingest clock against the derived publication clock', () => {
      expect(sql).toContain('max(ingested_at) AS src_ingest')
      expect(sql).toContain('max(computed_at) AS der_computed')
      expect(sql).toContain('src.src_ingest > der.der_computed')
    })

    it('reads no block-height bound on either side', () => {
      expect(sql).not.toContain('min(block_height)')
      expect(sql).not.toContain('max(block_height)')
    })

    it('keys both sides on the same month partition', () => {
      expect(sql.match(/toYYYYMM\(block_timestamp\) AS p/g)).toHaveLength(2)
    })

    it('recognises a missing derived month under ClickHouse default join semantics', () => {
      expect(sql).toContain('der.der_computed = toDateTime(0)')
      expect(sql).not.toContain('IS NULL')
    })

    // Within a stale month only the blocks whose raw rows moved are re-walked, so a
    // correction is picked up wherever it sits while the live month stays cheap.
    it('re-walks a month by ingest time, and bounds the pass before it runs', () => {
      const blocks = xcmArrivalsPendingBlocksSql()
      expect(blocks).toContain('toYYYYMM(block_timestamp) = {partition:UInt32}')
      expect(blocks).toContain('ingested_at > {since:DateTime}')
      expect(blocks).toContain('max_memory_usage = 2000000000')
      expect(blocks).toContain('max_threads = 4')
    })
  })
})

// Every pass over history is bounded BEFORE it runs: unbounded, a full-history read
// reaches ~84 GiB RSS and the next allocation trips the kernel's global OOM killer,
// taking ClickHouse and every service on the box with it.
describe('full-history reads', () => {
  it.each([
    ['omnipool lifecycle', omnipoolLifecycleSelectSql()],
    ['xyk farm lifecycle', xykFarmLifecycleSelectSql()],
  ])('%s is memory- and thread-bounded', (_name, sql) => {
    expect(sql).toContain('max_memory_usage = 2000000000')
    expect(sql).toContain('max_threads = 4')
  })
})
