// Idempotent, range-aware recompute jobs for the read models that a plain
// materialized view cannot express (they need cross-row netting, joins,
// valuation or a stateful lifecycle walk). The runner (derivations/runner.ts)
// calls each every cycle; every function here is safe to call repeatedly.
//
//   - account_trade_volume               block-bucket fold: recomputes only the stale buckets, registry fingerprint
//   - uniswap_v3_legs                    per-hour change detection, inserts only new or changed legs
//   - pool_swap_hourly                   hourly fold: recomputes only the stale hours
//   - pool_volume_hourly                 hourly fold, priced-head cut, registry fingerprint
//   - asset_volume_hourly                hourly fold, priced-head cut, registry fingerprint
//   - routed_volume_hourly               hourly fold, priced-head cut, registry fingerprint
//   - omnipool_position_owner_intervals  bounded full recompute, atomic staging swap
//   - xyk_farm_principal_intervals       bounded full recompute, atomic staging swap
//   - xyk_lp_total_shares_history        per-pool fold: recomputes only the stale pools
//   - revenue_events                     hourly fold, priced-head cut, registry and chain-state fingerprint
//   - account_revenue                    month rebuild following revenue_events' publication
//   - xcm_arrivals                       month rebuild by ingest-time watermark, over the feed's own walk
//   - pair_route_ohlc                    hourly fold over per-block pool snapshots, per-hour replacement inserts, bounded slice per cycle
//
// Every publication into a model this module owns goes through its
// `<table>_staging` twin and is atomic, so a reader never sees a gap or a
// half-written model: a bounded full recompute swapped in by EXCHANGE TABLES
// (atomicFullReplace), or a partition swapped in by REPLACE PARTITION — a month
// rebuilt whole (publishPartitions, account_revenue), or a month or pool group
// reassembled from its untouched buckets plus its recomputed ones (the progressive
// bucket folds, republishBuckets). Three jobs write without a twin: pair_route_ohlc
// publishes a recomputed hour as one replacement-keyed insert (with is_deleted rows
// for the keys it no longer holds), xcm_arrivals
// inserts arrivals keyed for replacement per (block_height, event_index), and
// uniswap_v3_legs inserts replacement-keyed legs into the shared pool_swap_legs,
// a table it does not own. Every live table and every staging twin is declared in
// clickhouse/schema (001_tables.sql, 006_public.sql for the hourly folds,
// 008_revenue.sql for the two revenue models, 012_xcm_arrivals.sql); nothing here
// creates a table.
//
// Whichever shape a job takes, it decides what to recompute from an INGEST-TIME
// watermark — the source's newest ingested_at against when the derived bucket was
// last computed — never from a forward high-water block cursor, which goes blind
// to every block a backward backfill fills beneath it (AGENTS.md, Schema and
// derivations).

import type { ClickHouseClient } from '../db/client.ts'
import {
  ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS,
  ICE_MIN_BLOCK,
  INTENT_FILL_EVENTS,
  accountTradeVolumeInsertSql,
  bucketPartition,
} from '../services/accountTradeVolume.ts'
import {
  ASSET_VOLUME_HOURLY_TABLE,
  POOL_VOLUME_HOURLY_TABLE,
  ROUTED_VOLUME_HOURLY_TABLE,
  assetVolumeHourlyInsertSql,
  hourLegsPredicate,
  poolVolumeHourlyInsertSql,
  routedVolumeHourlyInsertSql,
  type FoldHour,
} from '../services/volumeHourly.ts'
import { V3_POOLS_CTE, V3_TOKEN_ASSETS_CTE, v3TokenAssetSql } from '../services/revenueStreams.ts'
import { valuationRegistryFingerprintSql } from '../services/valuation.ts'
import { allExplorerAssets, assetDescriptor } from '../services/explorerAssets.ts'
import { chTimestamp } from '../services/clickhouseTime.ts'
import {
  PAIR_ROUTE_RESERVE_PAIRS_SQL,
  PAIR_ROUTE_TABLES,
  PAIR_ROUTE_WATERMARKS_TABLE,
  foldHour,
  loadFoldHourInputs,
  pairRouteBlocksSql,
  pairRouteDailyRowsSql,
  pairRouteLatestSql,
  pairRoutePricedSql,
  type PairRouteRow,
} from '../services/pairRouteFold.ts'
import { ROUTE_RULE_BASE, ROUTE_RULE_OMNI_SLIP, ROUTE_RULE_V3 } from '../services/pairRoutes.ts'
import { PAIR_VOLUME_5MIN_TABLE, pairVolume5minInsertSql } from '../services/pairVolume.ts'
// The feed's own inbound-XCM walk. Imported, not reimplemented: see the xcm_arrivals
// section below for the four ways a SQL restatement of it drifted.
import { xcmInboundCreditsForBlocks, type XcmInboundCredit } from '../services/explorerService.ts'
import { XCM_BARRIER_EVENTS } from '../services/xcmWalkEvents.ts'
import {
  buildOmnipoolOwnerIntervals,
  type OwnerLifecycleEvent,
  type OwnerLifecycleKind,
} from '../services/omnipoolOwnerIntervals.ts'
import {
  buildXykFarmIntervals,
  type XykFarmLifecycleEvent,
  type XykFarmLifecycleKind,
} from '../services/xykFarmIntervals.ts'

export interface DerivationResult {
  model: string
  rows: number
}

// ───────────────────── staging publication guard ─────────────────────
// Every publication below TRUNCATEs its staging twin, fills it, then swaps it
// into place. Two processes doing that to the same twin corrupt each other: the
// second TRUNCATE wipes the first one's half-written rows, and the first swap
// then publishes a truncated read model with no error anywhere. The derivations
// container is a singleton, but a manual `DERIVATIONS_ONESHOT=1` run alongside it
// races exactly this way.
//
// ClickHouse has no advisory lock, so detect the overlap: any in-flight
// non-SELECT query naming this twin means another publication is already under
// way. Skipping costs one poll interval, and the next cycle republishes. This
// narrows rather than closes the check-then-truncate window — it turns the likely
// operator mistake into a skipped cycle instead of silently wrong data. The
// query_kind filter is what keeps this probe from matching itself.
export function stagingBusySql(): string {
  return `SELECT count() AS n FROM system.processes
          WHERE query_kind != 'Select' AND position(query, {staging:String}) > 0`
}

async function stagingBusy(client: ClickHouseClient, stagingTable: string): Promise<boolean> {
  const res = await client.query({
    query: stagingBusySql(),
    query_params: { staging: stagingTable },
    format: 'JSONEachRow',
  })
  return Number((await res.json<{ n: string }>())[0]?.n ?? 0) > 0
}

// ───────────────────── atomic full-replace helper ─────────────────────
// The two interval reconstructions below (omnipool owner intervals, xyk farm
// intervals) each recompute their whole read model from scratch, so the
// publication has to REPLACE the model rather than add to it.
// Appending and relying on ReplacingMergeTree + FINAL cannot: a corrected event
// shifts a row's `valid_from_block`/`valid_from_event`, which is part of the
// ORDER BY key, so the recomputed row lands at a DIFFERENT key than the row it
// supersedes — there is no key collision for FINAL to collapse and the stale row
// would linger forever.
//
// So the full recompute is written into a `<table>_staging` twin (declared next
// to its parent in clickhouse/schema, 001_tables.sql) and EXCHANGEd with the live table: a
// single atomic rename swap with no reader-visible gap, after which the live
// table is exactly the latest full run. Truncate staging both before writing
// (clean slate if a prior run crashed mid-way) and after the swap (drop the
// now-superseded old data promptly rather than let it double the table's disk
// footprint until the next run).
// Returns false when the swap was skipped, so a caller never records a rebuild
// that did not happen.
async function atomicFullReplace(
  client: ClickHouseClient,
  liveTable: string,
  write: (stagingTable: string) => Promise<void>,
): Promise<boolean> {
  const stagingTable = `${liveTable}_staging`
  if (await stagingBusy(client, stagingTable)) {
    console.log(`[derivations] ${liveTable} skipped: ${stagingTable} busy in another process`)
    return false
  }
  await client.command({ query: `TRUNCATE TABLE ${stagingTable}` })
  await write(stagingTable)
  await client.command({ query: `EXCHANGE TABLES ${liveTable} AND ${stagingTable}` })
  await client.command({ query: `TRUNCATE TABLE ${stagingTable}` })
  return true
}

// ───────────────────── month-partition publication ─────────────────────
// account_revenue (whose key IS the month) and xcm_arrivals rebuild a whole
// month partition whose source watermark moved, and share this publication.

/**
 * A month whose rebuild legitimately writes zero rows never gets a computed_at,
 * so the staleness LEFT JOIN misses and marks it stale forever. Each job
 * remembers the source watermark each rebuild consumed (in memory, not a
 * completion-marker table) and skips a candidate whose source has not advanced
 * since. A restart costs one extra pass per such month, not one per cycle; a
 * backfilled row raises the watermark and re-marks it, so this stays correct
 * under backward backfill.
 */
export function partitionsNeedingRebuild(
  candidates: { p: string; src_ingest: string }[],
  lastRebuilt: ReadonlyMap<string, string>,
): string[] {
  return candidates.filter(c => lastRebuilt.get(c.p) !== c.src_ingest).map(c => c.p)
}

/** What a staleness query hands the publisher: the partition and the source watermark it carries. */
export interface PartitionCandidate { p: string; src_ingest: string }

/**
 * Publishes a set of stale month-partitions, atomically, one at a time. Each
 * step is load-bearing:
 *   * the staging twin's partition is dropped FIRST, so a run that crashed
 *     mid-fill cannot contribute rows to this one;
 *   * `fill` writes the rebuilt month into the twin (returning false when the
 *     month is not publishable yet, which leaves the candidate unconsumed for a
 *     later cycle);
 *   * REPLACE PARTITION swaps it into the live table in one operation, so a
 *     reader sees the old month until the swap and never an empty one;
 *   * the twin's copy is dropped again rather than left to double the model's
 *     disk footprint until the next run;
 *   * only then is the consumed source watermark remembered, so a rebuild that
 *     threw anywhere above stays a candidate next cycle.
 *
 * Candidates arrive oldest-first (every staleness query orders by partition), so
 * partial coverage is always a contiguous prefix — which is what lets readers
 * split "closed part from the model, tail from raw" at a single boundary.
 *
 * Returns the partitions actually published.
 */
async function publishPartitions(
  client: ClickHouseClient,
  model: string,
  live: string,
  candidates: readonly PartitionCandidate[],
  remembered: Map<string, string>,
  fill: (partition: string, staging: string) => Promise<boolean | void>,
): Promise<string[]> {
  const staging = `${live}_staging`
  const stale = partitionsNeedingRebuild([...candidates], remembered)
  if (!stale.length) return []
  if (await stagingBusy(client, staging)) {
    console.log(`[derivations] ${model} skipped: ${staging} busy in another process`)
    return []
  }
  const ingestByPartition = new Map(candidates.map(c => [c.p, c.src_ingest]))
  const built: string[] = []
  for (const p of stale) {
    // DROP PARTITION on an absent partition is a no-op.
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    if (await fill(p, staging) === false) continue
    await client.command({ query: `ALTER TABLE ${live} REPLACE PARTITION ${p} FROM ${staging}` })
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    const consumed = ingestByPartition.get(p)
    if (consumed != null) remembered.set(p, consumed)
    built.push(p)
  }
  return built
}

/** How many rows a just-published set of partitions holds, for the cycle log. */
async function countPublished(
  client: ClickHouseClient, table: string, partitionExpr: string, built: readonly string[], scope = '1',
): Promise<number> {
  if (!built.length) return 0
  const res = await client.query({
    query: `SELECT count() AS n FROM ${table} WHERE ${scope} AND ${partitionExpr} IN (${built.join(',')})`,
    format: 'JSONEachRow',
  })
  return Number((await res.json<{ n: string }>())[0]?.n ?? 0)
}

// ───────────────────────── progressive bucket folds ─────────────────────────
// The hourly folds of pool_swap_legs, account_trade_volume, revenue_events and
// xyk_lp_total_shares_history are PROGRESSIVE: every cycle recomputes only the
// small BUCKETS whose inputs changed — an hour of chain time for the hourly folds
// and revenue_events, a block range for account_trade_volume, a pool for
// xyk_lp_total_shares_history — and republishes the partition holding them (a
// month; a group of pools for the last). One mechanism, two halves:
//
//  * Which buckets (staleBucketsSql). An MV-fed watermark index holds, per
//    bucket, the newest ingest time of every source row and (for a valued fold)
//    the bucket's asset set. A bucket is recomputed when the fold holds no row
//    for it, when a source row of it was ingested later than
//    INGEST_SETTLE_SECONDS before the bucket was last computed — so a late,
//    replayed or backfilled row re-marks exactly its bucket, wherever it lies,
//    and a bucket computed while its rows were still landing is computed once
//    more after they settle (ingested_at has one-second resolution, and inserts
//    become visible a little after they are stamped) — or, for a valued fold,
//    when its rows' registry fingerprint (valuationRegistryFingerprintSql XOR-ed
//    over the bucket's asset set, plus any input the fold names) no longer
//    matches the registry, so a new decimal unit, price alias or priceable asset
//    re-values exactly the buckets it touches. Never a forward high-water cursor,
//    which a backward backfill would go blind beneath, and never a
//    completion-marker table.
//  * Replace, never add (republishBuckets). A month is republished whole from its
//    `_staging` twin: the twin's partition receives the live month's rows of
//    every bucket NOT being recomputed, then the recomputed buckets, and REPLACE
//    PARTITION swaps it in. A recomputed bucket therefore equals a fresh build of
//    it — a key that vanished from it is gone with it — readers see the previous
//    month or the new one and never a gap, and the table never holds two versions
//    of a row, so readers need no FINAL and no argMax. The copy is the month's
//    finished rows; the source scan, deduplication and valuation run over the
//    stale buckets alone.

/** How long after a source row's ingest its bucket's computation is treated as possibly incomplete. */
export const INGEST_SETTLE_SECONDS = 300

/** One bucket a fold must recompute, as its staleness query returns it. */
export interface StaleBucket {
  /** The bucket's key as text: an hour literal, or a block-bucket number. */
  bucket: string
  /** The newest ingest time among the bucket's inputs. */
  src_ingest: string
  /** The registry fingerprint the recomputed rows carry ('0' for an unvalued fold). */
  fingerprint: string
  /** 1 when the fold holds no row for the bucket. */
  empty: number
  /** 1 once the newest input is older than INGEST_SETTLE_SECONDS. */
  settled: number
}

export interface StaleBucketsSpec {
  /**
   * The WITH list (without `WITH`): scalars the gate reads, then a CTE `src` with
   * one row per bucket — `bucket`, `src_ingest` and, for a valued fold,
   * `bucket_assets` — and any CTE `fingerprintExtra` reads.
   */
  with: string
  /** One row per bucket the fold holds: `bucket`, `n`, `der_computed` and, valued, `fp_min`/`fp_max`. */
  derived: string
  valued: boolean
  /** A UInt64 expression XOR-ed into a bucket's fingerprint: inputs outside its asset set. */
  fingerprintExtra?: string
  /**
   * For an unvalued fold: a UInt64 expression over `src` (no asset set) that is the
   * bucket's whole fingerprint — the rule and inputs it is computed under. `derived`
   * then also returns the stored `fp_min`/`fp_max`, and a bucket whose stored value
   * differs is stale.
   */
  bucketFingerprint?: string
  /**
   * A CTE of `with` holding (a, fp): per-asset inputs outside the registry (chain
   * state an asset's rows read) XOR-ed into that asset's fingerprint, so they
   * re-mark exactly the buckets holding the asset.
   */
  assetInputs?: string
  /** Which source buckets may be computed this cycle at all (a cut, a coverage gate). */
  gate: string
  /** Further output columns, from `src`. */
  columns?: string
}

/** The buckets a fold must recompute this cycle, oldest first (the rules are the section note's). */
export function staleBucketsSql(spec: StaleBucketsSpec): string {
  // The registry fingerprint is hashed once per distinct asset and XOR-ed per
  // bucket, rather than re-hashed for every (bucket, asset) pair.
  const assetFp = spec.assetInputs
    ? `SELECT x.a AS a, bitXor(${valuationRegistryFingerprintSql('x.a')}, ai.fp) AS h
      FROM (SELECT DISTINCT arrayJoin(bucket_assets) AS a FROM src) AS x
      LEFT JOIN ${spec.assetInputs} AS ai ON ai.a = x.a`
    : `SELECT a, ${valuationRegistryFingerprintSql('a')} AS h
      FROM (SELECT DISTINCT arrayJoin(bucket_assets) AS a FROM src)`
  const fingerprint = spec.valued
    ? `,
    asset_fp AS (
      ${assetFp}
    ),
    bucket_fp AS (
      SELECT s.bucket AS bucket, groupBitXor(f.h) AS fp
      FROM (SELECT bucket, arrayJoin(bucket_assets) AS a FROM src) AS s
      INNER JOIN asset_fp AS f ON f.a = s.a
      GROUP BY s.bucket
    )`
    : `,
    bucket_fp AS (SELECT bucket, toUInt64(${spec.bucketFingerprint ?? '0'}) AS fp FROM src)`
  const current = spec.fingerprintExtra ? `bitXor(fp.fp, ${spec.fingerprintExtra})` : 'fp.fp'
  const fingerprintMoved = spec.valued || spec.bucketFingerprint ? `\n         OR der.fp_min != ${current} OR der.fp_max != ${current}` : ''
  return `
    WITH ${spec.with}${fingerprint}
    SELECT toString(src.bucket) AS bucket, toString(src.src_ingest) AS src_ingest, toString(${current}) AS fingerprint,
           der.n = 0 AS empty,
           src.src_ingest <= now() - INTERVAL ${INGEST_SETTLE_SECONDS} SECOND AS settled${spec.columns ? `,\n           ${spec.columns}` : ''}
    FROM src
    LEFT JOIN bucket_fp AS fp ON fp.bucket = src.bucket
    LEFT JOIN (${spec.derived}) AS der ON der.bucket = src.bucket
    -- ClickHouse LEFT JOINs fill a miss with type defaults (this client leaves
    -- join_use_nulls off), so a bucket the fold holds nothing for has n = 0 and an
    -- epoch der_computed, never NULL.
    WHERE ${spec.gate}
      AND (der.n = 0
         OR src.src_ingest > der.der_computed - INTERVAL ${INGEST_SETTLE_SECONDS} SECOND${fingerprintMoved})
    ORDER BY src.bucket`
}

/**
 * A bucket whose inputs fold to no row at all (only aToken wraps, or only
 * unpriced trades, say) leaves nothing to compare, so it would read as never
 * computed on every cycle. Each process remembers the watermark and fingerprint
 * it computed such a bucket at (in memory, not a completion-marker table) and
 * skips it until either moves; a restart costs one extra pass per such bucket.
 */
const foldedEmptyBuckets = new Map<string, Map<string, string>>()

const emptyMark = (b: StaleBucket) => `${b.src_ingest}|${b.fingerprint}`

/** The candidates still to compute once the empty buckets this process already computed at the same watermark and fingerprint are dropped. */
export function bucketsToFold<T extends StaleBucket>(candidates: readonly T[], foldedEmpty: ReadonlyMap<string, string>): T[] {
  return candidates.filter(c => !(Number(c.empty) && Number(c.settled) && foldedEmpty.get(c.bucket) === emptyMark(c)))
}

/** Buckets grouped by month partition, oldest month first. */
export function bucketsByPartition<T>(buckets: readonly T[], keyOf: (b: T) => string, partitionOf: (key: string) => string): Array<[string, T[]]> {
  const months = new Map<string, T[]>()
  for (const b of buckets) {
    const p = partitionOf(keyOf(b))
    const list = months.get(p)
    if (list) list.push(b)
    else months.set(p, [b])
  }
  return [...months.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export interface BucketFoldPublication<T extends StaleBucket> {
  model: string
  /** The live table; its `${table}_staging` twin is declared beside it. */
  table: string
  partitionOf: (bucket: string) => string
  /** Copies the live month's rows of every bucket not in `buckets` into the twin. */
  keptRowsSql: (live: string, staging: string, partition: string, buckets: readonly string[]) => string
  /** The recomputed buckets' INSERT into the twin; null when the month cannot be computed this cycle. */
  insert?: (partition: string, buckets: readonly T[], staging: string) => { query: string; query_params?: Record<string, unknown> } | null
  /** In place of `insert`, for a fold whose month takes several statements: writes the recomputed buckets into the twin, returning the rows written. */
  write?: (partition: string, buckets: readonly T[], staging: string) => Promise<number>
}

/**
 * Republishes every month holding a stale bucket, oldest first (so the computed
 * set below a fold's cut stays a contiguous prefix), and returns the rows the
 * recomputed buckets wrote.
 */
async function republishBuckets<T extends StaleBucket>(
  client: ClickHouseClient, fold: BucketFoldPublication<T>, candidates: readonly T[],
): Promise<number> {
  const { model, table: live } = fold
  const foldedEmpty = foldedEmptyBuckets.get(live) ?? new Map<string, string>()
  foldedEmptyBuckets.set(live, foldedEmpty)
  const stale = bucketsToFold(candidates, foldedEmpty)
  if (!stale.length) return 0
  const staging = `${live}_staging`
  if (await stagingBusy(client, staging)) {
    console.log(`[derivations] ${model} skipped: ${staging} busy in another process`)
    return 0
  }
  let rows = 0
  for (const [p, buckets] of bucketsByPartition(stale, b => b.bucket, fold.partitionOf)) {
    const insert = fold.insert?.(p, buckets, staging)
    if (fold.insert && !insert) continue
    // DROP PARTITION on an absent partition is a no-op; a twin left half-filled by
    // a crashed run never contributes rows.
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    await client.command({ query: fold.keptRowsSql(live, staging, p, buckets.map(b => b.bucket)) })
    const written = insert
      ? Number((await client.command(insert)).summary?.written_rows ?? 0)
      : await fold.write!(p, buckets, staging)
    await client.command({ query: `ALTER TABLE ${live} REPLACE PARTITION ${p} FROM ${staging}` })
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    // Only after the swap, so a month that threw anywhere above stays stale, and
    // only once settled, so a bucket computed while its rows were landing is
    // computed once more.
    for (const b of buckets) if (Number(b.settled)) foldedEmpty.set(b.bucket, emptyMark(b))
    rows += written
  }
  return rows
}

// ─────────────────────── hourly folds of pool_swap_legs ───────────────────────
// pool_swap_hourly and the three USD volume models (pool_volume_hourly,
// asset_volume_hourly, routed_volume_hourly; their SQL is services/volumeHourly.ts)
// are progressive bucket folds of pool_swap_legs whose bucket is a chain-time hour.
//
// Why jobs and not MVs: pool_swap_legs is a ReplacingMergeTree, so the legs must
// be DEDUPLICATED BEFORE they are summed, and an insert-trigger MV cannot do a
// cross-row deduplication (pool_swap_hourly's declaration in
// clickhouse/schema/006_public.sql carries the full argument); the volume folds
// add an ASOF price join and the Omnipool's next-fill window.
//
//  * The watermarks. pool_swap_hour_watermarks (an MV over pool_swap_legs, so
//    every leg source feeds it, the uniswap_v3_legs job's inserts included) holds
//    per hour the newest leg ingest time and the hour's asset set; the uniswap_v3_legs
//    job stamps its legs a cycle after the chain wrote their block, which the
//    settle margin absorbs.
//  * The cut. Every row is a CLOSED hour: the hour the newest leg sits in is still
//    filling and never written. A volume fold also stops at the price pipeline's
//    head hour, the older of its newest block and its newest price row: a leg is
//    valued at the candle closed by its own time, and writing it before that
//    candle exists would bake a 0 USD. Coverage only grows upward, so each newly
//    closed (and priced) hour is folded on the next cycle, and the oldest stale
//    month is published first, so the folded set stays a contiguous prefix below
//    the cut and readers split at max(hour) + 1 hour. For the same reason a
//    volume fold never writes an hour below the price pipeline's FLOOR
//    (PRICED_FLOOR_SQL): on a fresh database, or while price backfill trails
//    the legs, such an hour waits until the priced range descends past it.
//  * What does not re-mark: a repaired or late candle, and a backfilled
//    SetFeeProtocol below swaps already folded. Neither is a leg ingest; the hours
//    they touch need their rows dropped by hand to refold.
// The volume folds bake valuation into every row, so they carry the needsAssets
// registry guard in the runner, like account_trade_volume and revenue_events.

export const POOL_SWAP_HOUR_WATERMARKS_TABLE = 'price_data.pool_swap_hour_watermarks'
const POOL_SWAP_HOURLY_TABLE = 'price_data.pool_swap_hourly'

/** One hourly fold: its table (and `${table}_staging` twin), its source index, its SQL. */
export interface HourlyFold {
  model: string
  table: string
  watermarks: string
  /** Valued at event time: priced cut, candle window, registry fingerprint per row. */
  valued: boolean
  insert: (partition: string, hours: readonly FoldHour[], target: string) => string
  /**
   * The rows the staleness check reads a held hour from, when not every row: a
   * fold that writes a marker row per hour (pair_volume_5min) names it, so the
   * check reads one row per hour off the key prefix instead of the whole table.
   */
  heldRows?: string
}

/** The first hour a fold does not write: the newest leg's (still filling), or for a valued fold the price head's if older. */
export function hourlyFoldCutSql(fold: Pick<HourlyFold, 'watermarks' | 'valued'>): string {
  const openHour = `(SELECT max(hour) FROM ${fold.watermarks})`
  if (!fold.valued) return openHour
  // toStartOfHour(least(a, b)) = least(toStartOfHour(a), toStartOfHour(b)), and
  // ohlc_1h is the MV of price_data.prices keyed on toStartOfHour(block_timestamp),
  // so its newest interval_start IS the newest price row's hour — read from a
  // 1 M-row table instead of a 190 M-row one. blocks is partitioned on
  // block_timestamp, so its max is answered from part metadata.
  return `least(${openHour}, toStartOfHour((SELECT max(block_timestamp) FROM price_data.blocks)),
    (SELECT max(interval_start) FROM price_data.ohlc_1h))`
}

/**
 * The first instant a valued fold may value: the price pipeline's floor, the
 * later of its oldest block's hour and the close of its oldest candle (a fill is
 * valued at a candle closed by its own time). Below it a leg has no price to be
 * valued at, and neither a price row nor a candle carries an ingest time that
 * could re-mark the bucket once prices are backfilled beneath it, so the bucket
 * waits (it holds no row, so it stays a candidate) until the priced range covers
 * it. The epoch rows — the genesis block's 1970 timestamp, a 1970 candle — are no
 * coverage: the 197001 partition holds nothing else, and filtering on the
 * partition rather than the column lets the blocks floor come from part metadata
 * instead of a 15 M-row scan.
 */
export const PRICED_FLOOR_SQL = `greatest(
    toStartOfHour((SELECT min(block_timestamp) FROM price_data.blocks WHERE _partition_id != '197001')),
    (SELECT min(interval_start) FROM price_data.ohlc_1h WHERE _partition_id != '197001') + INTERVAL 1 HOUR)`

/**
 * The hours a fold must recompute this cycle, oldest first: staleBucketsSql over
 * the hourly watermark index and the fold's own hours, gated on the cut (and, for
 * a valued fold, the price floor).
 */
export function hourlyFoldStaleHoursSql(fold: HourlyFold): string {
  return staleBucketsSql({
    with: `${hourlyFoldCutSql(fold)} AS cut,${fold.valued ? `
    ${PRICED_FLOOR_SQL} AS floor,` : ''}
    src AS (
      SELECT hour AS bucket, max(src_ingest) AS src_ingest, groupUniqArrayArray(assets) AS bucket_assets
      FROM ${fold.watermarks}
      GROUP BY hour
    )`,
    derived: `SELECT hour AS bucket, count() AS n, max(computed_at) AS der_computed${fold.valued ? ', min(registry_fp) AS fp_min, max(registry_fp) AS fp_max' : ''}
      FROM ${fold.table}${fold.heldRows ? `
      WHERE ${fold.heldRows}` : ''}
      GROUP BY hour`,
    valued: fold.valued,
    gate: fold.valued ? 'src.bucket < cut AND src.bucket >= floor' : 'src.bucket < cut',
  })
}

/** An hour's month partition. */
export const hourPartition = (hour: string): string => hour.slice(0, 4) + hour.slice(5, 7)

/** The rows of a month that survive its republication: every hour not being recomputed. */
function keptHourRowsSql(live: string, staging: string, partition: string, hours: readonly string[]): string {
  return `INSERT INTO ${staging} SELECT * FROM ${live}
    WHERE toYYYYMM(hour) = ${partition}
      AND hour NOT IN (${hours.map(h => `toDateTime('${h}')`).join(', ')})`
}

export async function runHourlyFold(client: ClickHouseClient, fold: HourlyFold): Promise<DerivationResult> {
  const { model } = fold
  if (fold.valued && !allExplorerAssets().length) {
    console.log(`[derivations] ${model} skipped: asset registry empty`)
    return { model, rows: 0 }
  }
  const res = await client.query({ query: hourlyFoldStaleHoursSql(fold), format: 'JSONEachRow' })
  const stale = await res.json<StaleBucket>()
  if (!stale.length) return { model, rows: 0 }
  // One cut for the whole cycle: every candle window below is anchored on it.
  let cutSeconds = 0
  if (fold.valued) {
    const cutRes = await client.query({ query: `SELECT toString(${hourlyFoldCutSql(fold)}) AS cut`, format: 'JSONEachRow' })
    const cut = (await cutRes.json<{ cut: string }>())[0]?.cut
    if (!cut) return { model, rows: 0 }
    cutSeconds = chTimestampSeconds(cut)
  }
  const rows = await republishBuckets(client, {
    model,
    table: fold.table,
    partitionOf: hourPartition,
    keptRowsSql: keptHourRowsSql,
    insert: (p, hours, staging) => {
      const params = fold.valued ? volumeHourlyPriceParams(p, cutSeconds) : null
      // Every stale hour lies below the cut, so a valued month always has a window.
      if (fold.valued && !params) return null
      const query = fold.insert(p, hours.map(h => ({ hour: h.bucket, fingerprint: h.fingerprint })), staging)
      return params ? { query, query_params: params } : { query }
    },
  }, stale)
  return { model, rows }
}

/**
 * The candle window a month's valuation reads: the public surfaces' anchored
 * window (ANCHORED_PRICE_WINDOW), anchored on the month's end — or the cut, in
 * the live month — and spanning the month, so the staleness lookback is
 * PRICE_LOOKBACK_DAYS before the month's first hour whichever of its hours are
 * folded: a leg's value depends on its month alone.
 */
export function volumeHourlyPriceParams(partition: string, cutSeconds: number): { anchor: string; hours: number } | null {
  const { startSeconds, endSeconds } = monthBounds(partition)
  if (cutSeconds <= startSeconds) return null
  const anchorSeconds = Math.min(cutSeconds, endSeconds)
  return { anchor: chTimestamp(anchorSeconds), hours: Math.ceil((anchorSeconds - startSeconds) / 3_600) }
}

// pool_swap_hourly: pool_swap_legs folded to one row per (venue, pool_key,
// asset_id, leg_kind, fee_dest, fee_recipient, hour) — the pre-aggregate the
// leg-SUM consumers read instead of scanning the 65 M-leg projection. It stores
// RAW integer amounts and no valuation, so it depends on neither the price
// pipeline nor the registry and an hour is foldable the moment it closes.
//
// The inner GROUP BY is pool_swap_legs' own ORDER BY — its ReplacingMergeTree
// replacement key — so a replayed range contributes each leg exactly once, and
// because the aggregation runs in the table's stored order it streams rather than
// building a hash table (optimize_aggregation_in_order). Summing first and
// deduplicating afterwards would double a replayed hour. The outer sum is
// Decimal256 and the stored value a String, matching pool_swap_legs' own
// convention: an hour of 18-decimal legs passes 2^64 routinely and no float may
// touch it. leg_count counts DEDUPLICATED legs, so a row's arithmetic is
// checkable against raw.
export function poolSwapHourlyInsertSql(partition: string, hours: readonly FoldHour[], target: string): string {
  return `INSERT INTO ${target} (venue, pool_key, asset_id, leg_kind, fee_dest, fee_recipient, hour, amount_sum, leg_count, computed_at)
    SELECT venue, pool_key, asset_id, leg_kind, fee_dest, fee_recipient, hour,
           toString(sum(toDecimal256(amount, 0))) AS amount_sum,
           count() AS leg_count,
           now() AS computed_at
    FROM (
      SELECT venue, pool_key, block_height, event_index, leg_kind, leg_index,
             argMax(asset_id, ingested_at) AS asset_id,
             argMax(amount, ingested_at) AS amount,
             argMax(fee_dest, ingested_at) AS fee_dest,
             argMax(fee_recipient, ingested_at) AS fee_recipient,
             toStartOfHour(min(block_timestamp)) AS hour
      FROM price_data.pool_swap_legs
      WHERE ${hourLegsPredicate(partition, hours.map(h => h.hour))}
      GROUP BY venue, pool_key, block_height, event_index, leg_kind, leg_index
    )
    GROUP BY venue, pool_key, asset_id, leg_kind, fee_dest, fee_recipient, hour
    SETTINGS optimize_aggregation_in_order = 1`
}

export const POOL_SWAP_HOURLY_FOLD: HourlyFold = {
  model: 'pool_swap_hourly', table: POOL_SWAP_HOURLY_TABLE, watermarks: POOL_SWAP_HOUR_WATERMARKS_TABLE,
  valued: false, insert: poolSwapHourlyInsertSql,
}

// MEASURED folding a whole month (2026-09, 2.2 M legs): 1.9 s / 6.0 CPU-s for
// pool_volume_hourly and 1.1 s / 4.1 CPU-s for asset_volume_hourly; the routed
// fold is the heaviest — the netting carries every venue's legs through the
// per-trade stage — at 22.8 s / 2.63 GiB peak for the busiest month (2025-05,
// 4.67 M legs). A cycle folds an hour or two.
export const POOL_VOLUME_HOURLY_FOLD: HourlyFold = {
  model: 'pool_volume_hourly', table: POOL_VOLUME_HOURLY_TABLE, watermarks: POOL_SWAP_HOUR_WATERMARKS_TABLE,
  valued: true, insert: poolVolumeHourlyInsertSql,
}
export const ASSET_VOLUME_HOURLY_FOLD: HourlyFold = {
  model: 'asset_volume_hourly', table: ASSET_VOLUME_HOURLY_TABLE, watermarks: POOL_SWAP_HOUR_WATERMARKS_TABLE,
  valued: true, insert: assetVolumeHourlyInsertSql,
}
export const ROUTED_VOLUME_HOURLY_FOLD: HourlyFold = {
  model: 'routed_volume_hourly', table: ROUTED_VOLUME_HOURLY_TABLE, watermarks: POOL_SWAP_HOUR_WATERMARKS_TABLE,
  valued: true, insert: routedVolumeHourlyInsertSql,
}

// pair_volume_5min: the trades between two assets per 5-minute bucket (the pair
// candles' volume; services/pairVolume.ts). The routed fold's netting with the
// endpoint amounts carried, so it costs what that fold costs; one marker row per
// folded hour is what the staleness check reads.
export const PAIR_VOLUME_5MIN_FOLD: HourlyFold = {
  model: 'pair_volume_5min', table: PAIR_VOLUME_5MIN_TABLE, watermarks: POOL_SWAP_HOUR_WATERMARKS_TABLE,
  valued: true, insert: pairVolume5minInsertSql, heldRows: 'asset_lo = 0 AND asset_hi = 0',
}

export const runPoolSwapHourly = (client: ClickHouseClient) => runHourlyFold(client, POOL_SWAP_HOURLY_FOLD)
export const runPairVolume5min = (client: ClickHouseClient) => runHourlyFold(client, PAIR_VOLUME_5MIN_FOLD)
export const runPoolVolumeHourly = (client: ClickHouseClient) => runHourlyFold(client, POOL_VOLUME_HOURLY_FOLD)
export const runAssetVolumeHourly = (client: ClickHouseClient) => runHourlyFold(client, ASSET_VOLUME_HOURLY_FOLD)
export const runRoutedVolumeHourly = (client: ClickHouseClient) => runHourlyFold(client, ROUTED_VOLUME_HOURLY_FOLD)

// ───────────────────────── account_trade_volume ─────────────────────────
// Per-account NET trade volume: routed/DCA trades collapsed to their net
// input/output so intermediate routing hops are not double-counted. The netting
// is a per-trade cross-row aggregation with a block-time ohlc valuation, so it
// cannot be a plain per-row MV. It is a progressive bucket fold whose bucket is
// ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS blocks (the netting/valuation SQL, the bucket
// grain and why it is self-contained live in services/accountTradeVolume.ts):
//
//  * The watermarks. account_trade_volume_watermarks holds per bucket the newest
//    ingest time, newest block, block-time span and asset set of every source row
//    the netting reads: an MV over raw_events (the swaps of both eras, the DCA
//    executions and OTC fill events that key and orient them, the ICE fills and
//    the pot's transfer legs — the intent and transfer tables the netting reads
//    are MV projections of those same raw rows) and one over raw_evm_logs for the
//    v3 pools' Swap logs, which flags the bucket as holding direct v3 swaps.
//  * Dependency lateness. An ICE fill nets only once its intent's order
//    (intent_orders, keyed by intent id, written at the order's own block) is
//    indexed, so an order landing after its fill — a backward backfill reaches the
//    fill first — must re-mark the FILL's bucket. No insert-trigger MV can find
//    that bucket (it is a join), so the staleness query joins the fills' buckets
//    to their orders' ingest times; both tables are small (tens of thousands of
//    rows).
//  * The fingerprint. The bucket's asset set, plus — for a bucket with direct v3
//    swaps — the v3 pools' tokens and fee tiers, their resolved assets and those
//    assets' own valuation fingerprints, so a pool, token mapping or registry
//    change re-values exactly the buckets it touches.
//  * The gate. A bucket is computed once the price pipeline covers it: its
//    earliest source row at or after the priced floor (PRICED_FLOOR_SQL) and its
//    newest source block at or below the priced head (price_data.blocks, which the
//    price pipeline writes per block it prices). Computing earlier would value
//    its trades against candles that do not exist yet, and drop them (HAVING
//    volume_usd > 0). Price coverage descends contiguously (supervisor) and
//    follows the raw head, so the still-filling head bucket is recomputed every
//    cycle while raw lands in it and the model trails the chain by about a cycle.
//  * computed_at is the instant the cycle read the watermarks, not the insert's
//    own clock, so every row ingested after the read — even mid-cycle — compares
//    newer and re-marks its bucket.
// What does not re-mark: a repaired or late candle (not a source ingest). Its
// buckets need their rows dropped by hand to recompute.

const ACCOUNT_TRADE_VOLUME_TABLE = 'price_data.account_trade_volume'
export const ACCOUNT_TRADE_VOLUME_WATERMARKS_TABLE = 'price_data.account_trade_volume_watermarks'

/** A stale account_trade_volume bucket, with the newest source block time its candle window is bounded by. */
interface TradeVolumeStaleBucket extends StaleBucket { src_max_ts: string }

/** The fingerprint of every v3 input outside the Swap logs, valuation of the resolved assets included. */
function tradeVolumeV3InputsCte(): string {
  const a0 = v3TokenAssetSql('t0.asset_id', 'p.token0')
  const a1 = v3TokenAssetSql('t1.asset_id', 'p.token1')
  return `${V3_TOKEN_ASSETS_CTE},
    ${V3_POOLS_CTE},
    v3_inputs AS (
      SELECT groupBitXor(cityHash64(p.pool_address, p.token0, p.token1, p.fee, ${a0}, ${a1},
               ${valuationRegistryFingerprintSql(a0)}, ${valuationRegistryFingerprintSql(a1)})) AS fp
      FROM pools AS p
      LEFT JOIN token_assets AS t0 ON t0.addr = lower(p.token0)
      LEFT JOIN token_assets AS t1 ON t1.addr = lower(p.token1)
    )`
}

/** The account_trade_volume buckets to recompute this cycle (the section note's rules), oldest first. */
export function accountTradeVolumeStaleBucketsSql(table = ACCOUNT_TRADE_VOLUME_TABLE): string {
  const B = ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS
  return staleBucketsSql({
    with: `${PRICED_FLOOR_SQL} AS priced_from,
    (SELECT max(block_height) FROM price_data.blocks) AS priced_to,
    wm AS (
      SELECT bucket, max(src_ingest) AS wm_ingest, max(src_maxb) AS src_maxb,
             min(src_min_ts) AS src_min_ts, max(src_max_ts) AS src_max_ts,
             groupUniqArrayArray(assets) AS bucket_assets, max(v3) AS v3
      FROM ${ACCOUNT_TRADE_VOLUME_WATERMARKS_TABLE}
      GROUP BY bucket
    ),
    late_orders AS (
      -- The newest order ingest behind each bucket's ICE fills.
      SELECT intDiv(f.block_height, ${B}) AS bucket, max(o.order_ingest) AS dep_ingest
      FROM (SELECT DISTINCT intent_id, block_height FROM price_data.intent_events
            WHERE event_name IN (${INTENT_FILL_EVENTS}) AND block_height >= ${ICE_MIN_BLOCK}) AS f
      INNER JOIN (SELECT intent_id, max(ingested_at) AS order_ingest FROM price_data.intent_orders GROUP BY intent_id) AS o
        ON o.intent_id = f.intent_id
      GROUP BY bucket
    ),
    src AS (
      SELECT wm.bucket AS bucket, greatest(wm.wm_ingest, lo.dep_ingest) AS src_ingest, wm.src_maxb AS src_maxb,
             wm.src_min_ts AS src_min_ts, wm.src_max_ts AS src_max_ts, wm.bucket_assets AS bucket_assets, wm.v3 AS v3
      FROM wm
      LEFT JOIN late_orders AS lo ON lo.bucket = wm.bucket
    ),
    ${tradeVolumeV3InputsCte()}`,
    derived: `SELECT intDiv(block_height, ${B}) AS bucket, count() AS n, max(computed_at) AS der_computed,
             min(registry_fp) AS fp_min, max(registry_fp) AS fp_max
      FROM ${table}
      GROUP BY bucket`,
    valued: true,
    fingerprintExtra: `if(src.v3 = 1, (SELECT fp FROM v3_inputs), toUInt64(0))`,
    gate: 'src.src_min_ts >= priced_from AND priced_to >= src.src_maxb',
    columns: 'toString(src.src_max_ts) AS src_max_ts',
  })
}

/** The rows of a month that survive its republication: every bucket not being recomputed. */
export function keptTradeRowsSql(live: string, staging: string, partition: string, buckets: readonly string[]): string {
  return `INSERT INTO ${staging} SELECT * FROM ${live}
    WHERE toYYYYMM(toDateTime(block_height * 12)) = ${partition}
      AND intDiv(block_height, ${ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS}) NOT IN (${buckets.join(', ')})`
}

// The netting SQL bakes in per-asset decimal factors and the price-alias universe,
// so an empty registry (fresh DB before assets are indexed, or a failed
// loadExplorerAssets — the runner also skips this job on load failure) must not
// bake wrongly-valued buckets: bail out instead.
export async function runAccountTradeVolume(client: ClickHouseClient, table = ACCOUNT_TRADE_VOLUME_TABLE): Promise<DerivationResult> {
  const model = 'account_trade_volume'
  if (!allExplorerAssets().length) {
    console.log('[derivations] account_trade_volume skipped: asset registry empty')
    return { model, rows: 0 }
  }
  // Read BEFORE the watermarks, so it is no later than anything they reveal.
  const nowRes = await client.query({ query: 'SELECT toString(now()) AS t', format: 'JSONEachRow' })
  const computedAt = (await nowRes.json<{ t: string }>())[0]?.t
  if (!computedAt) return { model, rows: 0 }
  const res = await client.query({ query: accountTradeVolumeStaleBucketsSql(table), format: 'JSONEachRow' })
  const stale = await res.json<TradeVolumeStaleBucket>()
  const rows = await republishBuckets(client, {
    model,
    table,
    partitionOf: bucketPartition,
    keptRowsSql: keptTradeRowsSql,
    insert: (p, buckets, staging) => ({
      query: accountTradeVolumeInsertSql(p, buckets, staging, {
        computedAt,
        maxBlockTime: buckets.map(b => b.src_max_ts).sort().at(-1),
      }),
    }),
  }, stale)
  return { model, rows }
}

// ───────────────────────── uniswap_v3_legs ─────────────────────────
// Every swap in a concentrated-liquidity pool reaches pool_swap_legs (the public/data
// API's fill source) through this job, from the pool's own Swap log. Not the Broadcast
// MV, for two reasons: the runtime's `UniswapV3` Broadcast names the SwapRouter as
// filler and never the pool (pool_swap_legs_mv excludes the kind), and a direct EVM
// swap emits no Broadcast at all. A job rather than an MV because the leg needs the
// pool's tokens (a JOIN on uniswap_v3_pools, filled by a sibling MV of the same raw
// insert — order between MVs is not defined) and the registry's token → asset map.
// Legs: in, out, and the LP fee (amount_in × fee / 1e6, kept by the pool). The
// swapper is the log's recipient in its ETH-prefixed account form. op_key: a
// Router-routed hop takes the route's Router id from the `UniswapV3` Swapped3 of the
// same extrinsic (matched on the input amount) so the route nets across its hops like
// every other venue's; a direct swap takes `evm:<block>:<event>` — unique per fill,
// so consumers that fold fills into trades by op_key see each as its own trade, and
// the prefix marks the source.
//
// Progressive, and it writes a leg only when it is new or its content changed:
//  * Which hours. The v3 Swap logs' own ingest time per hour (uniswap_v3_events is
//    a 17k-row table, so the per-hour max is read directly), raised by the
//    hour's routed-hop Swapped3 ingest time (uniswap_v3_hop_hour_watermarks),
//    against the watermark each hour was last examined at, remembered in memory:
//    a new, replayed or backfilled Swap or hop re-marks exactly its hour,
//    wherever it lies — never a forward block cursor, which would leave every
//    swap a backward backfill writes below the head unlegged. An hour whose
//    newest input is younger than INGEST_SETTLE_SECONDS is examined again next
//    cycle.
//  * Whole history when an input outside the logs moves: the pools' tokens and
//    fee tiers (uniswap_v3_pools) and the registry's EVM-address → asset map
//    decide every leg's asset, so their fingerprint is compared every cycle, and
//    a change — a pool or a token mapping arriving after its swaps, a remapped
//    token — or a process start (nothing remembered yet) examines every hour.
//  * Content diff. The hour's legs are recomputed and compared, per leg identity,
//    with the newest version already in pool_swap_legs (a hash over every content
//    column); only a missing or different leg is inserted. An unchanged leg is
//    never re-stamped, so a cycle with nothing new writes nothing and re-marks no
//    downstream hour. A written leg carries ingested_at = the insert's now(): it is
//    the version pool_swap_legs replaces on (a corrected leg must outrank the one
//    it supersedes, which a copied source time would tie), and it is what the
//    hourly folds and the other pool_swap_legs consumers compare their own
//    computed_at against — a source time would date the leg before folds that ran
//    without it, and they would never see it.
//  * Publication is a plain INSERT, not a REPLACE PARTITION: pool_swap_legs is
//    shared with the MVs that write every other venue's legs into the same
//    partitions. A leg that stops resolving (its pool or token mapping removed)
//    is not retracted; that would need a tombstone the table does not carry.

/** The hash a v3 leg's content is compared by, over every column but its identity and version. */
const V3_LEG_CONTENT = (alias: string) =>
  `cityHash64(${alias}.asset_id, ${alias}.amount, toString(${alias}.fee_dest), ${alias}.fee_recipient, ${alias}.swapper, ${alias}.op_key,
              ifNull(${alias}.extrinsic_index, 4294967295), ${alias}.block_timestamp)`

/**
 * Every v3 Swap hour with the newest ingest time among its inputs: the Swap logs
 * themselves, and the hour's `UniswapV3` Broadcast.Swapped3 events, whose Router
 * id and swapper a routed hop's op_key and swapper come from
 * (uniswap_v3_hop_hour_watermarks, MV-fed), so a raw_events repair of a hop
 * re-examines its hour however long after its log it lands.
 */
export function uniswapV3SwapHoursSql(): string {
  return `
    SELECT toString(s.log_hour) AS hour, toString(greatest(s.log_ingest, h.hop_ingest)) AS src_ingest,
           greatest(s.log_ingest, h.hop_ingest) <= now() - INTERVAL ${INGEST_SETTLE_SECONDS} SECOND AS settled
    FROM (
      SELECT toStartOfHour(block_timestamp) AS log_hour, max(ingested_at) AS log_ingest
      FROM price_data.uniswap_v3_events
      WHERE kind = 'pool' AND event_name = 'Swap'
      GROUP BY log_hour
    ) AS s
    -- A miss is the DateTime epoch (join_use_nulls off), which greatest() ignores.
    LEFT JOIN (
      SELECT hour, max(src_ingest) AS hop_ingest
      FROM price_data.uniswap_v3_hop_hour_watermarks
      GROUP BY hour
    ) AS h ON h.hour = s.log_hour
    ORDER BY s.log_hour`
}

/** The fingerprint of every leg input outside the Swap logs: each pool's tokens, fee tier and resolved assets. */
export function uniswapV3LegInputsFingerprintSql(): string {
  return `
    WITH ${V3_TOKEN_ASSETS_CTE},
    ${V3_POOLS_CTE}
    SELECT toString(groupBitXor(cityHash64(p.pool_address, p.token0, p.token1, p.fee,
             ${v3TokenAssetSql('t0.asset_id', 'p.token0')}, ${v3TokenAssetSql('t1.asset_id', 'p.token1')}))) AS fingerprint
    FROM pools AS p
    LEFT JOIN token_assets AS t0 ON t0.addr = lower(p.token0)
    LEFT JOIN token_assets AS t1 ON t1.addr = lower(p.token1)`
}

export function uniswapV3LegsInsertSql(partition: string, hours: readonly string[]): string {
  const span = hourLegsPredicate(partition, hours)
  return `INSERT INTO price_data.pool_swap_legs (venue, pool_key, block_height, event_index, leg_index, leg_kind, asset_id, amount, fee_dest, fee_recipient, swapper, op_key, extrinsic_index, block_timestamp, ingested_at)
WITH ${V3_TOKEN_ASSETS_CTE},
${V3_POOLS_CTE},
swap_logs AS (
  SELECT block_height, event_index, extrinsic_index, block_timestamp, contract_address, counterparty, amount0, amount1
  FROM price_data.uniswap_v3_events FINAL
  WHERE kind = 'pool' AND event_name = 'Swap' AND ${span}
),
routed AS (
  -- The Router routes that hopped through a v3 pool, keyed by extrinsic and input amount:
  -- the runtime emits one UniswapV3 Swapped3 per hop with the route's operationStack.
  -- Read only in the swaps' own blocks (primary-key point ranges).
  SELECT block_height, ifNull(extrinsic_index, 4294967295) AS ext,
         JSONExtractString(JSONExtractArrayRaw(args_json, 'inputs')[1], 'amount') AS amount_in,
         toUInt64OrZero(extractGroups(args_json, '"__kind":"Router","value":(\\d+)')[1]) AS router_id,
         JSONExtractString(args_json, 'swapper') AS swapper
  FROM price_data.raw_events
  WHERE event_name = 'Broadcast.Swapped3' AND ${span}
    AND block_height IN (SELECT block_height FROM swap_logs)
    AND JSONExtractString(args_json, 'fillerType', '__kind') = 'UniswapV3'
),
swaps AS (
  SELECT e.block_height AS block_height, e.event_index AS event_index, e.extrinsic_index AS extrinsic_index,
         ifNull(e.extrinsic_index, 4294967295) AS ext, e.block_timestamp AS block_timestamp,
         e.contract_address AS pool, e.counterparty AS recipient, e.amount0 AS amount0, e.amount1 AS amount1,
         p.token0 AS token0, p.token1 AS token1, p.fee AS fee,
         ${v3TokenAssetSql('t0.asset_id', 'p.token0')} AS asset0,
         ${v3TokenAssetSql('t1.asset_id', 'p.token1')} AS asset1
  FROM swap_logs AS e
  INNER JOIN pools AS p ON p.pool_address = e.contract_address
  LEFT JOIN token_assets AS t0 ON t0.addr = lower(p.token0)
  LEFT JOIN token_assets AS t1 ON t1.addr = lower(p.token1)
  WHERE asset0 != 4294967295 AND asset1 != 4294967295
),
hops AS (
  -- One row per (block, extrinsic, input amount): the Router id and swapper of the
  -- route hop that input names, if any.
  SELECT block_height, ext, amount_in, max(router_id) AS hop_router_id, max(swapper) AS hop_swapper
  FROM routed
  GROUP BY block_height, ext, amount_in
),
sided AS (
  SELECT s.*,
         if(s.amount0 > 0, s.asset0, s.asset1) AS asset_in, if(s.amount0 > 0, s.asset1, s.asset0) AS asset_out,
         toUInt256(if(s.amount0 > 0, s.amount0, s.amount1)) AS amount_in,
         toUInt256(abs(if(s.amount0 > 0, s.amount1, s.amount0))) AS amount_out,
         concat('0x45544800', substring(s.pool, 3, 40), '0000000000000000') AS pool_account,
         -- A swap no hop names joins the LEFT JOIN's defaults: id 0, swapper ''.
         h.hop_router_id AS router_id,
         h.hop_swapper AS routed_swapper,
         [tuple(toUInt8(1), asset_in, amount_in, '', ''),
          tuple(toUInt8(2), asset_out, amount_out, '', ''),
          tuple(toUInt8(3), asset_in, intDiv(amount_in * toUInt256(s.fee), toUInt256(1000000)), 'account', pool_account)] AS legs
  FROM swaps AS s
  LEFT JOIN hops AS h
    ON h.block_height = s.block_height AND h.ext = s.ext
   AND h.amount_in = toString(toUInt256(if(s.amount0 > 0, s.amount0, s.amount1)))
),
candidate AS (
  SELECT 'uniswapv3' AS venue, pool AS pool_key, block_height, event_index, toUInt16(leg_i - 1) AS leg_index,
         CAST(legs[leg_i].1 AS Enum8('in' = 1, 'out' = 2, 'fee' = 3)) AS leg_kind,
         legs[leg_i].2 AS asset_id, toString(legs[leg_i].3) AS amount, legs[leg_i].4 AS fee_dest, legs[leg_i].5 AS fee_recipient,
         multiIf(routed_swapper != '', routed_swapper,
                 recipient != '', concat('0x45544800', substring(recipient, 3, 40), '0000000000000000'),
                 '') AS swapper,
         if(router_id > 0, toString(router_id), concat('evm:', toString(block_height), ':', toString(event_index))) AS op_key,
         extrinsic_index, block_timestamp
  FROM sided
  ARRAY JOIN arrayEnumerate(legs) AS leg_i
),
written AS (
  -- The newest version of every v3 leg of these hours, as its content hash.
  SELECT l.pool_key AS pool_key, l.block_height AS block_height, l.event_index AS event_index,
         l.leg_kind AS leg_kind, l.leg_index AS leg_index,
         argMax(${V3_LEG_CONTENT('l')}, l.ingested_at) AS content
  FROM price_data.pool_swap_legs AS l
  WHERE l.venue = 'uniswapv3' AND ${span}
  GROUP BY l.pool_key, l.block_height, l.event_index, l.leg_kind, l.leg_index
)
SELECT c.venue, c.pool_key, c.block_height, c.event_index, c.leg_index, c.leg_kind, c.asset_id, c.amount,
       c.fee_dest, c.fee_recipient, c.swapper, c.op_key, c.extrinsic_index, c.block_timestamp, now() AS ingested_at
FROM candidate AS c
LEFT JOIN written AS w
  ON w.pool_key = c.pool_key AND w.block_height = c.block_height AND w.event_index = c.event_index
 AND w.leg_kind = c.leg_kind AND w.leg_index = c.leg_index
-- A leg never written has content 0 (the LEFT JOIN's type default).
WHERE w.content != ${V3_LEG_CONTENT('c')}
SETTINGS max_memory_usage = 2000000000, max_threads = 4`
}

const v3HoursExamined = new Map<string, string>()
let v3LegInputsExamined: string | null = null

export async function runUniswapV3Legs(client: ClickHouseClient): Promise<DerivationResult> {
  const model = 'uniswap_v3_legs'
  const fpRes = await client.query({ query: uniswapV3LegInputsFingerprintSql(), format: 'JSONEachRow' })
  const fingerprint = (await fpRes.json<{ fingerprint: string }>())[0]?.fingerprint ?? ''
  const res = await client.query({ query: uniswapV3SwapHoursSql(), format: 'JSONEachRow' })
  const all = await res.json<{ hour: string; src_ingest: string; settled: number }>()
  const everything = fingerprint !== v3LegInputsExamined
  const stale = all.filter(h => everything || !Number(h.settled) || v3HoursExamined.get(h.hour) !== h.src_ingest)
  let rows = 0
  for (const [p, hours] of bucketsByPartition(stale, h => h.hour, hourPartition)) {
    const startRes = await client.query({ query: 'SELECT toString(now()) AS t', format: 'JSONEachRow' })
    const start = (await startRes.json<{ t: string }>())[0]?.t ?? ''
    const written = await client.command({ query: uniswapV3LegsInsertSql(p, hours.map(h => h.hour)) })
    // The summary counts the MVs' rows over pool_swap_legs too, so the legs this
    // insert wrote are counted by their stamp (nothing else writes this venue).
    if (Number(written.summary?.written_rows ?? 0) > 0 && start) {
      const countRes = await client.query({
        query: `SELECT count() AS n FROM price_data.pool_swap_legs
                WHERE venue = 'uniswapv3' AND ${hourLegsPredicate(p, hours.map(h => h.hour))}
                  AND ingested_at >= toDateTime({start:String})`,
        query_params: { start },
        format: 'JSONEachRow',
      })
      rows += Number((await countRes.json<{ n: string }>())[0]?.n ?? 0)
    }
    // Only after the insert landed, so a failed month stays a candidate, and only
    // once settled, so the hour is examined once more after its logs stop landing.
    for (const h of hours) if (Number(h.settled)) v3HoursExamined.set(h.hour, h.src_ingest)
  }
  // Only once every hour was examined against it.
  v3LegInputsExamined = fingerprint
  return { model, rows }
}

// ───────────────────────── lp_lifecycle_events ─────────────────────────
// Both reconstructions below need the same thing: a handful of decoded fields
// from the Omnipool/XYK NFT + liquidity-mining lifecycle. That is a pure
// row-wise filter and decode, so it belongs in a materialized view rather than
// in a job — price_data.lp_lifecycle_events (clickhouse/schema) does the eight
// JSONExtract calls once at insert time and holds the ~880k decoded rows. The
// MV's predicate is the disjunction of the two WHERE clauses below; each job
// re-applies its own half against the decoded `collection` column so neither
// observes the other's rows. FINAL deduplicates a replayed range on the
// projection's (block_height, event_index) replacement key.
const LP_LIFECYCLE_SOURCE = 'price_data.lp_lifecycle_events FINAL'

// Every pass over history is bounded BEFORE it runs. Unbounded, a full-history
// read reaches ~84 GiB RSS and the next container to allocate trips the kernel's
// global OOM killer, which takes ClickHouse — and with it every service on the
// box — down; the same work bounded stays near 3 GiB. This is the same clause
// every other full-history read in this module carries.
const FULL_HISTORY_SETTINGS = 'SETTINGS max_memory_usage = 2000000000, max_threads = 4'

/**
 * The two full reconstructions below re-read the whole ~880k-row lifecycle,
 * rebuild every interval in Node and EXCHANGE the table. That is the right shape
 * (a forward cursor is wrong while backfill fills lower blocks, and a shifted key
 * would leave stale rows) but it is pure waste on a cycle where the source has
 * not moved, which is most cycles. So each run first asks the source for its
 * ingest-time watermark and skips the rebuild when it matches the one the last
 * rebuild consumed — one cheap aggregate instead of a full recompute.
 *
 * In memory, not a completion-marker table: a restart costs one extra rebuild,
 * never one per cycle. A backfilled or corrected row carries a newer
 * `ingested_at`, so backward backfill still re-triggers the rebuild.
 */
const rebuiltFromWatermark = new Map<string, string>()

async function sourceWatermark(client: ClickHouseClient, table: string): Promise<string> {
  const res = await client.query({
    query: `SELECT toString(max(ingested_at)) AS w FROM ${table}`,
    format: 'JSONEachRow',
  })
  return String((await res.json<{ w: string | null }>())[0]?.w ?? '')
}

/** The source's watermark when `model` must be rebuilt from it; null when the last published rebuild already consumed exactly this one. */
async function fullRebuildIsCurrent(client: ClickHouseClient, model: string, sourceTable: string): Promise<string | null> {
  const watermark = await sourceWatermark(client, sourceTable)
  return watermark !== '' && rebuiltFromWatermark.get(model) === watermark ? null : watermark
}

// ─────────────────── omnipool_position_owner_intervals ───────────────────
// Bounded full recompute: load the complete Omnipool NFT + liquidity-mining
// lifecycle, reconstruct account-first ownership intervals with the pure
// buildOmnipoolOwnerIntervals domain function, and swap the result into the
// live table atomically (see atomicFullReplace).

export const OMNIPOOL_EVENT_KIND: Record<string, OwnerLifecycleKind> = {
  'Uniques.Issued': 'nft_issue',
  'Uniques.Transferred': 'nft_transfer',
  'Uniques.Burned': 'nft_burn',
  'Omnipool.PositionDestroyed': 'position_destroyed',
  'OmnipoolLiquidityMining.SharesDeposited': 'shares_deposited',
  'OmnipoolLiquidityMining.SharesRedeposited': 'shares_redeposited',
  'OmnipoolLiquidityMining.SharesWithdrawn': 'shares_withdrawn',
  'OmnipoolLiquidityMining.DepositDestroyed': 'deposit_destroyed',
}

interface OmnipoolRawRow {
  block: number
  extrinsic: number | null
  event: number
  ts: number
  event_name: string
  collection: string
  item: string
  positionId: string
  depositId: string
  owner: string
  from: string
  to: string
}

interface OmnipoolIntervalRow {
  account_id: string
  position_id: string
  ownership_kind: 'bare' | 'farmed'
  deposit_id: string
  valid_from_block: number
  valid_from_extrinsic: number
  valid_from_event: number
  valid_from_ts: number
  valid_to_block: number
  valid_to_extrinsic: number
  valid_to_event: number
  source_event_kind: string
  run_id: number
}

// The Omnipool half of lp_lifecycle_events. Exported so the schema/job coupling
// can be asserted without a live ClickHouse (see jobs.test.ts).
export function omnipoolLifecycleSelectSql(): string {
  return `
      SELECT
          block_height AS block,
          extrinsic_index AS extrinsic,
          event_index AS event,
          toUInt32(toUnixTimestamp(block_timestamp)) AS ts,
          event_name,
          collection,
          item,
          position_id AS positionId,
          deposit_id AS depositId,
          owner,
          from_account AS from,
          to_account AS to
      FROM ${LP_LIFECYCLE_SOURCE}
      WHERE event_name IN (
          'Uniques.Issued','Uniques.Transferred','Uniques.Burned',
          'Omnipool.PositionDestroyed',
          'OmnipoolLiquidityMining.SharesDeposited','OmnipoolLiquidityMining.SharesRedeposited',
          'OmnipoolLiquidityMining.SharesWithdrawn','OmnipoolLiquidityMining.DepositDestroyed')
        AND (event_name NOT IN ('Uniques.Issued','Uniques.Transferred','Uniques.Burned')
             OR collection IN ('1337','2584'))
      ORDER BY block_height, event_index
      ${FULL_HISTORY_SETTINGS}
    `
}

export async function runOmnipoolOwnerIntervals(client: ClickHouseClient): Promise<DerivationResult> {
  const model = 'omnipool_owner_intervals'
  const watermark = await fullRebuildIsCurrent(client, model, 'price_data.lp_lifecycle_events')
  if (watermark == null) return { model, rows: 0 }
  const runId = Date.now()
  const res = await client.query({ query: omnipoolLifecycleSelectSql(), format: 'JSONEachRow' })
  const rows = await res.json<OmnipoolRawRow>()

  const events: OwnerLifecycleEvent[] = rows.map(r => ({
    kind: OMNIPOOL_EVENT_KIND[r.event_name],
    collection: r.collection === '1337' ? '1337' : r.collection === '2584' ? '2584' : undefined,
    item: r.item || undefined,
    positionId: r.positionId || undefined,
    depositId: r.depositId || undefined,
    owner: r.owner || undefined,
    from: r.from || undefined,
    to: r.to || undefined,
    block: r.block,
    extrinsic: r.extrinsic ?? null,
    event: r.event,
    ts: r.ts,
  }))

  const intervals = buildOmnipoolOwnerIntervals(events)
  const intervalRows: OmnipoolIntervalRow[] = intervals.map(iv => ({
    account_id: iv.accountId,
    position_id: iv.positionId,
    ownership_kind: iv.ownershipKind,
    deposit_id: iv.depositId,
    valid_from_block: iv.validFrom.block,
    valid_from_extrinsic: iv.validFrom.extrinsic ?? -1,
    valid_from_event: iv.validFrom.event,
    valid_from_ts: iv.validFrom.ts,
    valid_to_block: iv.validTo?.block ?? 0,
    valid_to_extrinsic: iv.validTo ? (iv.validTo.extrinsic ?? -1) : 0,
    valid_to_event: iv.validTo?.event ?? 0,
    source_event_kind: iv.sourceEventKind,
    run_id: runId,
  }))

  const published = await atomicFullReplace(client, 'price_data.omnipool_position_owner_intervals', async stagingTable => {
    const BATCH = 50_000
    for (let i = 0; i < intervalRows.length; i += BATCH) {
      await client.insert({
        table: stagingTable,
        values: intervalRows.slice(i, i + BATCH),
        format: 'JSONEachRow',
      })
    }
  })
  // Only after the swap landed: a skipped or failed run must rebuild next cycle.
  if (published) rebuiltFromWatermark.set(model, watermark)
  return { model, rows: intervalRows.length }
}

// ─────────────────── xyk_farm_principal_intervals ───────────────────
// Bounded full recompute of collection-5389 farm deposits via the pure
// buildXykFarmIntervals domain function; result is swapped into the live
// table atomically (see atomicFullReplace).

export const XYK_FARM_EVENT_KIND: Record<string, XykFarmLifecycleKind> = {
  'Uniques.Issued': 'nft_issue',
  'Uniques.Transferred': 'nft_transfer',
  'Uniques.Burned': 'nft_burn',
  'XYKLiquidityMining.SharesDeposited': 'shares_deposited',
  'XYKLiquidityMining.SharesRedeposited': 'shares_redeposited',
  'XYKLiquidityMining.DepositDestroyed': 'deposit_destroyed',
}

interface XykFarmRawRow {
  block: number
  extrinsic: number | null
  event: number
  ts: number
  event_name: string
  item: string
  depositId: string
  owner: string
  from: string
  to: string
  lpToken: number
  amount: string
}

interface XykFarmIntervalRow {
  account_id: string
  deposit_id: string
  lp_asset_id: number
  principal_shares_raw: string
  valid_from_block: number
  valid_from_extrinsic: number
  valid_from_event: number
  valid_from_ts: number
  valid_to_block: number
  valid_to_extrinsic: number
  valid_to_event: number
  source_event_kind: string
  run_id: number
}

// The XYK-farm half of lp_lifecycle_events (see omnipoolLifecycleSelectSql).
export function xykFarmLifecycleSelectSql(): string {
  return `
      SELECT block_height AS block, extrinsic_index AS extrinsic, event_index AS event,
        toUInt32(toUnixTimestamp(block_timestamp)) AS ts, event_name,
        item, deposit_id AS depositId,
        owner, from_account AS from, to_account AS to,
        lp_token AS lpToken, amount
      FROM ${LP_LIFECYCLE_SOURCE}
      WHERE (event_name IN ('Uniques.Issued','Uniques.Transferred','Uniques.Burned') AND collection='5389')
         OR event_name IN ('XYKLiquidityMining.SharesDeposited','XYKLiquidityMining.SharesRedeposited','XYKLiquidityMining.DepositDestroyed')
      ORDER BY block_height, event_index
      ${FULL_HISTORY_SETTINGS}`
}

export async function runXykFarmIntervals(client: ClickHouseClient): Promise<DerivationResult> {
  const model = 'xyk_farm_intervals'
  const watermark = await fullRebuildIsCurrent(client, model, 'price_data.lp_lifecycle_events')
  if (watermark == null) return { model, rows: 0 }
  const runId = Date.now()
  const res = await client.query({ query: xykFarmLifecycleSelectSql(), format: 'JSONEachRow' })
  const rows = await res.json<XykFarmRawRow>()

  const events: XykFarmLifecycleEvent[] = rows.map(r => ({
    kind: XYK_FARM_EVENT_KIND[r.event_name],
    depositId: (r.event_name.startsWith('Uniques.') ? r.item : r.depositId) || '',
    owner: r.owner || undefined,
    from: r.from || undefined,
    to: r.to || undefined,
    lpAssetId: r.event_name.startsWith('XYKLiquidityMining.Shares') ? r.lpToken : undefined,
    principalShares: r.event_name.startsWith('XYKLiquidityMining.Shares') ? r.amount : undefined,
    block: r.block,
    extrinsic: r.extrinsic ?? null,
    event: r.event,
    ts: r.ts,
  }))

  const intervals = buildXykFarmIntervals(events)
  const intervalRows: XykFarmIntervalRow[] = intervals.map(iv => ({
    account_id: iv.accountId,
    deposit_id: iv.depositId,
    lp_asset_id: iv.lpAssetId,
    principal_shares_raw: iv.principalShares,
    valid_from_block: iv.validFrom.block,
    valid_from_extrinsic: iv.validFrom.extrinsic ?? -1,
    valid_from_event: iv.validFrom.event,
    valid_from_ts: iv.validFrom.ts,
    valid_to_block: iv.validTo?.block ?? 0,
    valid_to_extrinsic: iv.validTo ? (iv.validTo.extrinsic ?? -1) : 0,
    valid_to_event: iv.validTo?.event ?? 0,
    source_event_kind: iv.sourceEventKind,
    run_id: runId,
  }))

  const published = await atomicFullReplace(client, 'price_data.xyk_farm_principal_intervals', async stagingTable => {
    const BATCH = 50_000
    for (let i = 0; i < intervalRows.length; i += BATCH) {
      await client.insert({
        table: stagingTable,
        values: intervalRows.slice(i, i + BATCH),
        format: 'JSONEachRow',
      })
    }
  })
  if (published) rebuiltFromWatermark.set(model, watermark)
  return { model, rows: intervalRows.length }
}

// ─────────────────── xyk_lp_total_shares_history ───────────────────
// The total outstanding supply of each XYK LP (shareToken) as a step function over
// block height, from raw_balance_observations (no RPC): token issuance == sum of all
// holder balances, and substrate Tokens balances are captured from genesis, so
// cumulative net balance deltas reproduce issuance exactly. XYK.LiquidityAdded omits
// the minted-share amount, so events alone cannot do this.
//
// A progressive bucket fold (staleBucketsSql + republishBuckets) whose bucket is a
// POOL: a pool's supply is a function of its own share token's observations alone,
// so recomputing one pool is exactly a fresh build of it.
//  * Which pools. xyk_lp_share_watermarks (an MV over the observation projection)
//    holds each share token's newest observation ingest. A pool is recomputed when
//    the model holds no row for it, or when an observation of it was ingested
//    within INGEST_SETTLE_SECONDS of or after its computation — so a late,
//    replayed or backfilled observation re-marks exactly its pool, wherever its
//    block lies, and the other pools are never read.
//  * Replace, never add. A partition is a group of XYK_POOLS_PER_PARTITION
//    consecutive share-token ids, republished whole from the staging twin: the
//    group's other pools' rows, then the recomputed pools'. A block that vanished
//    from a pool's history is gone with it, and readers see the old group or the
//    new one, never a gap or two versions of a row.
// Why a job rather than request-time reconstruction from the observations: every
// reader wants per-pool totals (one pool, or an account's set), but the
// reconstruction's windowed walk over the projection's wide rows costs a reader
// 19 MiB and ~45 CPU-ms for one or two pools and 318 MiB and 2.7 CPU-s for an
// account holding 82 (measured 2026-10-02), against 0.4 MiB and 13 MiB from this
// table — at ~4k history reads a day, more than the fold costs, for a source whose
// share-token observations change a few hundred times a day.

const XYK_TOTAL_SHARES_TABLE = 'price_data.xyk_lp_total_shares_history'
export const XYK_LP_SHARE_WATERMARKS_TABLE = 'price_data.xyk_lp_share_watermarks'

// First asset id the Hydration asset registry mints sequentially. XYK's
// create_pool registers its share token through that counter, so every share
// token — past and future — sits at or above this floor, while the
// governance-registered assets that dominate the observation table sit below it.
// That makes `asset_id >= floor` a join-free predicate the
// xyk_lp_share_observations MV can apply per inserted row (see
// clickhouse/schema/003_materialized_views.sql) and still be a provable superset
// of the pool set, which the fold below re-filters to exactly.
export const XYK_SHARE_ASSET_ID_FLOOR = 1_000_000

/** How many consecutive share-token ids one partition of the model holds. */
export const XYK_POOLS_PER_PARTITION = 100

// The pool set. price_data.xyk_pool_registry is the MV over XYK.PoolCreated and
// decodes shareToken with the same expression an inline decode here would, so the
// two sets are equal by construction — and the registry is 729 rows against a
// 302M-row raw_events scan the event-name index barely prunes.
const XYK_SHARE_TOKENS_SQL = 'SELECT DISTINCT lp_asset_id AS lp FROM price_data.xyk_pool_registry FINAL'

// Guard on the superset claim. A share token below the floor would simply never
// reach the projection, and its pool would silently vanish from the model, so
// the job checks the real pool set against the floor every run and refuses to
// publish rather than publish a hole.
export function xykShareTokensBelowFloorSql(): string {
  return `SELECT count() AS n FROM (${XYK_SHARE_TOKENS_SQL}) WHERE lp < ${XYK_SHARE_ASSET_ID_FLOOR}`
}

/** A pool's partition: its group of XYK_POOLS_PER_PARTITION share-token ids (the table's `intDiv(lp_asset_id, 100)`). */
export const xykPoolPartition = (pool: string): string => String(Math.floor(Number(pool) / XYK_POOLS_PER_PARTITION))

/** The pools to recompute this cycle (the section note's rules), lowest share-token id first. */
export function xykTotalSharesStalePoolsSql(table = XYK_TOTAL_SHARES_TABLE): string {
  return staleBucketsSql({
    with: `src AS (
      SELECT asset_id AS bucket, max(src_ingest) AS src_ingest
      FROM ${XYK_LP_SHARE_WATERMARKS_TABLE}
      WHERE asset_id IN (${XYK_SHARE_TOKENS_SQL})
      GROUP BY asset_id
    )`,
    derived: `SELECT lp_asset_id AS bucket, count() AS n, max(computed_at) AS der_computed
      FROM ${table}
      GROUP BY lp_asset_id`,
    valued: false,
    gate: '1',
  })
}

/** The rows of a pool group that survive its republication: every pool not being recomputed. */
export function keptXykPoolRowsSql(live: string, staging: string, partition: string, pools: readonly string[]): string {
  return `INSERT INTO ${staging} SELECT * FROM ${live}
    WHERE intDiv(lp_asset_id, ${XYK_POOLS_PER_PARTITION}) = ${partition}
      AND lp_asset_id NOT IN (${pools.join(', ')})`
}

const POOL_ID = /^\d+$/

/**
 * The recomputed pools' step functions, into `target`. Per holder, each
 * observation's balance minus the holder's previous one (the window runs in the
 * projection's own sort order); per block, the sum of those deltas; per pool, their
 * running sum. FINAL: raw_balance_observations is replayable and the projection
 * inherits its replacement key, and the pool predicate keeps FINAL bounded.
 */
export function xykTotalSharesInsertSql(pools: readonly string[], target: string, computedAt: string): string {
  if (!pools.length || !pools.every(p => POOL_ID.test(p))) throw new Error(`xyk_total_shares: bad pool ids ${pools.join(',')}`)
  if (!DATETIME_LITERAL.test(computedAt)) throw new Error(`xyk_total_shares: bad computed_at ${computedAt}`)
  return `INSERT INTO ${target} (lp_asset_id, block_height, total_shares_raw, computed_at)
    SELECT lp, block_height,
      toString(sum(bd) OVER (PARTITION BY lp ORDER BY block_height ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS total_shares_raw,
      toDateTime('${computedAt}') AS computed_at
    FROM (
      SELECT lp, block_height, sum(delta) AS bd
      FROM (
        SELECT asset_id AS lp, block_height,
          toInt256(assumeNotNull(total)) - lagInFrame(toInt256(assumeNotNull(total)), 1, toInt256(0))
            OVER (PARTITION BY asset_id, account_id ORDER BY block_height, observation_id) AS delta
        FROM price_data.xyk_lp_share_observations FINAL
        WHERE asset_id IN (${pools.join(', ')})
      )
      GROUP BY lp, block_height
    )`
}

export async function runXykTotalShares(client: ClickHouseClient, table = XYK_TOTAL_SHARES_TABLE): Promise<DerivationResult> {
  const model = 'xyk_total_shares'
  const guard = await client.query({ query: xykShareTokensBelowFloorSql(), format: 'JSONEachRow' })
  const below = Number((await guard.json<{ n: string }>())[0]?.n ?? 0)
  if (below > 0) {
    throw new Error(
      `${below} XYK share token(s) below asset id ${XYK_SHARE_ASSET_ID_FLOOR}: `
      + 'xyk_lp_share_observations cannot see them, so their pools would be missing from the model',
    )
  }
  // Read BEFORE the watermarks, so it is no later than anything they reveal.
  const nowRes = await client.query({ query: 'SELECT toString(now()) AS t', format: 'JSONEachRow' })
  const computedAt = (await nowRes.json<{ t: string }>())[0]?.t
  if (!computedAt) return { model, rows: 0 }
  const res = await client.query({ query: xykTotalSharesStalePoolsSql(table), format: 'JSONEachRow' })
  const stale = await res.json<StaleBucket>()
  const rows = await republishBuckets(client, {
    model,
    table,
    partitionOf: xykPoolPartition,
    keptRowsSql: keptXykPoolRowsSql,
    insert: (_p, pools, staging) => ({ query: xykTotalSharesInsertSql(pools.map(b => b.bucket), staging, computedAt) }),
  }, stale)
  return { model, rows }
}

// ───────────────────────── revenue_events ─────────────────────────
// One row per protocol-revenue event (clickhouse/schema/008_revenue.sql), from
// the shared per-stream definitions in services/revenueStreams.ts — the same
// definitions the explorer's live tail and the public fees API read, so the
// cold table and the raw tail can never disagree about what a stream means.
// This is a job rather than an MV for the same reasons account_trade_volume
// is: dedup-before-aggregation over ReplacingMergeTree sources, cross-row
// joins (the HSM arb semi-join, the liquidation transfer↔call match), the
// borrow streams' cumulative state, and an event-time price valuation.
//
// A progressive bucket fold (staleBucketsSql + republishBuckets) whose bucket is
// a chain-time HOUR: a block lies in one hour and the table partitions on the
// month of block_timestamp, so a bucket never straddles a partition, and
// hollar_borrow's rows are hourly by construction.
//
//  * The watermarks. revenue_hour_watermarks (MV-fed) holds per hour the newest
//    ingest time, block span and asset set of every source the builders read:
//    every raw_events and raw_extrinsics row (fee events, debits, deposits and
//    dust, EVM markers and logs, XCM barriers and run events, HSM, liquidation and
//    intent events, the ICE sweep — and the projections MV'd from those rows), the
//    raw_evm_logs the builders read (aToken transfers into the collector, ERC-20
//    transfers into the treasury, the v3 pools' Swap logs — the last two flag the
//    hour `v3`), LiquidationCall, the reserve index and mint rows and the
//    debt-token scaled deltas; pool_swap_hour_watermarks adds the legs (every
//    venue's fee and HSM legs, and the v3 legs the uniswap_v3_legs job writes a
//    cycle after their block).
//  * What crosses an hour. Every eventful stream is block-local — its joins (the
//    transfer↔call match, the HSM semi-join, a fee's debits and deposits, an XCM
//    run) never leave the block — so a set of hours folds exactly as it would
//    beside the rest of its month. Four kinds of input reach across hours, each
//    with its own rule:
//      - kind 'debt' (index updates, treasury mints, scaled deltas) feeds
//        cumulative state: hollar_borrow differences each observation against the
//        previous one however far back, and asset_reserve's internal share weighs
//        the interest since the reserve's previous mint. Its staleness cascades
//        FORWARD: an hour is stale when a debt row at or before it was ingested
//        after its computation;
//      - an ICE fill's payer is its intent's owner (intent_orders, written at the
//        order's own block), so an order landing after its fill re-marks the
//        FILL's hour — a join, as in account_trade_volume (both tables are small);
//      - the v3 inputs a row reads unwindowed — the pools' tokens and fee tiers,
//        their SetFeeProtocol history, the vault set, the registry's token map —
//        are fingerprinted on the hours flagged v3;
//      - the money market's chain state (the reserve map, the B0 anchors) is
//        fingerprinted per reserve ASSET, folded into that asset's registry
//        fingerprint, so a newly listed reserve re-values nothing it does not
//        touch; the internal-payer tags are fingerprinted on every hour.
//  * The cut. Only CLOSED, PRICED hours are written — below the newest source
//    hour and the price pipeline's head, at or above its floor (hourlyFoldCutSql,
//    PRICED_FLOOR_SQL) — so the folded set is a contiguous prefix and readers
//    split cold/tail at each stream's own max block_timestamp without double
//    counting (the tail comes from raw via the same builders). computed_at is
//    the instant the cycle read the watermarks.
//  * Settled first. An hour is folded only once its newest source row is
//    INGEST_SETTLE_SECONDS old, so each change is folded once instead of once
//    while its rows land and again after (the other folds' rule): the hollar
//    walk — two passes of money_market_reserve_state_history, ~12 CPU-s at the
//    head — is most of an hour's cost. The cold edge trails by those seconds
//    more; the raw tail covers them.
// What does not re-mark: a repaired or late candle (not a source ingest), as in
// the other valued folds.

import {
  HOLLAR_ASSET_ID,
  REVENUE_EVENT_COLUMNS,
  REVENUE_STREAMS,
  V3_FEE_PROTOCOL_CTE,
  buildRevenueEventRowsSql,
  hollarBorrowHourlyRows,
  internalPayerAccountsSql,
  loadInternalPayerAccounts,
  reserveAssetIdSql,
  resetInternalPayerAccounts,
  type EventfulRevenueStream,
} from '../services/revenueStreams.ts'
import { DECIMAL_STRINGS } from '../services/valuation.ts'
import { hourFingerprintSql } from '../services/volumeHourly.ts'

export const REVENUE_HOUR_WATERMARKS_TABLE = 'price_data.revenue_hour_watermarks'
const REVENUE_EVENTS_TABLE = 'price_data.revenue_events'

/**
 * The streams the job inserts with a plain INSERT … SELECT.
 *
 * The two reserve-level streams are not among them. They name no payer — the
 * market's whole accrual is booked, then split over per-account weights — so the
 * protocol's own part cannot be marked on the row the way a fee's payer is, and
 * has to be carved out in TS against those same weights (see runRevenueEvents).
 */
export const REVENUE_EVENT_STREAMS_INSERTED: readonly EventfulRevenueStream[]
  = REVENUE_STREAMS.filter((s): s is EventfulRevenueStream => s !== 'hollar_borrow' && s !== 'asset_reserve')

/**
 * A stale revenue hour, with the block span of its sources, which bounds every
 * source read, and whether a HOLLAR reserve index moved in it — the only hours
 * hollar_borrow books a row for.
 */
export interface RevenueStaleHour extends StaleBucket { minb: string; maxb: string; hollar: number }

/**
 * Per reserve asset, one fingerprint over the money market's chain state the
 * borrow streams read: the reserve map's rows (hollar_borrow's pools, the debt
 * tokens asset_reserve's weights run over, the aToken a liquidation transfer
 * names) and the B0 anchors of those tokens (every opening balance).
 */
function revenueReserveInputsCte(): string {
  return `reserve_map AS (
      SELECT DISTINCT lower(asset_address) AS reserve, lower(atoken) AS atoken, lower(vdebt) AS vdebt,
             lower(pool_proxy) AS pool, market_key AS market
      FROM price_data.atoken_reserve_map FINAL
    ),
    reserve_inputs AS (
      SELECT a, groupBitXor(h) AS fp
      FROM (
        SELECT ${reserveAssetIdSql('m.reserve')} AS a, cityHash64(m.reserve, m.atoken, m.vdebt, m.pool, m.market) AS h
        FROM reserve_map AS m
        UNION ALL
        SELECT ${reserveAssetIdSql('t.reserve')} AS a,
               cityHash64(lower(x.contract_address), lower(x.holder), x.scaled_balance, x.anchor_block) AS h
        FROM price_data.atoken_scaled_anchor AS x FINAL
        INNER JOIN (SELECT reserve, arrayJoin([atoken, vdebt]) AS contract FROM reserve_map) AS t
          ON t.contract = lower(x.contract_address)
      )
      GROUP BY a
    )`
}

/** The fingerprint of the v3 inputs uniswap_v3_fee reads unwindowed: account_trade_volume's, the fee-protocol history and the vault set. */
function revenueV3InputsCte(): string {
  return `${tradeVolumeV3InputsCte()},
    ${V3_FEE_PROTOCOL_CTE},
    v3_revenue_inputs AS (
      SELECT bitXor(bitXor((SELECT fp FROM v3_inputs),
                           (SELECT groupBitXor(cityHash64(pool, at_key, fp0, fp1)) FROM fee_protocol)),
                    (SELECT groupBitXor(cityHash64(vault_address, token0, token1, fee)) FROM price_data.uniswap_v3_vaults FINAL)) AS fp
    )`
}

/** The revenue hours to recompute this cycle (the section note's rules), oldest first. */
export function revenueEventsStaleHoursSql(table = REVENUE_EVENTS_TABLE): string {
  return staleBucketsSql({
    with: `${hourlyFoldCutSql({ watermarks: REVENUE_HOUR_WATERMARKS_TABLE, valued: true })} AS cut,
    ${PRICED_FLOOR_SQL} AS floor,
    wm AS (
      SELECT hour, ev_ingest, minb, maxb, hour_assets, v3, hollar,
             -- Cumulative-state sources: staleness cascades forward.
             max(debt_own) OVER (ORDER BY hour ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS debt_ingest
      FROM (
        SELECT hour, maxIf(src_ingest, kind = 'events') AS ev_ingest, maxIf(src_ingest, kind = 'debt') AS debt_own,
               min(src_minb) AS minb, max(src_maxb) AS maxb, groupUniqArrayArray(assets) AS hour_assets, max(v3) AS v3,
               maxIf(has(assets, ${HOLLAR_ASSET_ID}), kind = 'debt') AS hollar
        FROM ${REVENUE_HOUR_WATERMARKS_TABLE}
        GROUP BY hour
      )
    ),
    legs AS (
      SELECT hour, max(src_ingest) AS legs_ingest, groupUniqArrayArray(assets) AS leg_assets
      FROM ${POOL_SWAP_HOUR_WATERMARKS_TABLE}
      GROUP BY hour
    ),
    late_orders AS (
      -- The newest order ingest behind each hour's ICE fills.
      SELECT toStartOfHour(f.block_timestamp) AS hour, max(o.order_ingest) AS dep_ingest
      FROM (SELECT DISTINCT intent_id, block_timestamp FROM price_data.intent_events
            WHERE event_name IN (${INTENT_FILL_EVENTS}) AND block_height >= ${ICE_MIN_BLOCK}) AS f
      INNER JOIN (SELECT intent_id, max(ingested_at) AS order_ingest FROM price_data.intent_orders GROUP BY intent_id) AS o
        ON o.intent_id = f.intent_id
      GROUP BY hour
    ),
    src AS (
      SELECT w.hour AS bucket, greatest(w.ev_ingest, w.debt_ingest, l.legs_ingest, lo.dep_ingest) AS src_ingest,
             w.minb AS minb, w.maxb AS maxb, arrayDistinct(arrayConcat(w.hour_assets, l.leg_assets)) AS bucket_assets, w.v3 AS v3,
             w.hollar AS hollar
      FROM wm AS w
      LEFT JOIN legs AS l ON l.hour = w.hour
      LEFT JOIN late_orders AS lo ON lo.hour = w.hour
    ),
    ${revenueReserveInputsCte()},
    internal_payers AS (SELECT groupBitXor(cityHash64(lower(acct))) AS fp FROM (${internalPayerAccountsSql()})),
    ${revenueV3InputsCte()}`,
    derived: `SELECT toStartOfHour(block_timestamp) AS bucket, count() AS n, max(computed_at) AS der_computed,
             min(registry_fp) AS fp_min, max(registry_fp) AS fp_max
      FROM ${table}
      GROUP BY bucket`,
    valued: true,
    assetInputs: 'reserve_inputs',
    fingerprintExtra: 'bitXor((SELECT fp FROM internal_payers), if(src.v3 = 1, (SELECT fp FROM v3_revenue_inputs), toUInt64(0)))',
    // Held until settled, so an hour is folded ONCE per change rather than once
    // while its rows land and again after: the hollar walk dominates an hour's cost.
    gate: `src.bucket < cut AND src.bucket >= floor AND src.src_ingest <= now() - INTERVAL ${INGEST_SETTLE_SECONDS} SECOND`,
    columns: 'toString(src.minb) AS minb, toString(src.maxb) AS maxb, src.hollar AS hollar',
  })
}

const HOUR_LITERAL = /^(\d{4})-(\d{2})-\d{2} \d{2}:00:00$/

/**
 * What every source read of a set of hours of one month is narrowed by: the
 * month (the sources' partition expression), the block span the hours' sources
 * occupy (every raw table's primary key prunes on it), and the hours as runs of
 * consecutive hours — the predicate is repeated in every source read of a
 * builder, so a month of single-hour literals would overflow max_query_size.
 */
export function revenueHoursPredicate(partition: string, hours: readonly RevenueStaleHour[]): string {
  if (!/^\d{6}$/.test(partition)) throw new Error(`invalid partition ${JSON.stringify(partition)}`)
  if (!hours.length) throw new Error('no hours to fold')
  const starts = hours.map(h => {
    const m = HOUR_LITERAL.exec(h.bucket)
    if (!m || `${m[1]}${m[2]}` !== partition) throw new Error(`invalid hour ${JSON.stringify(h.bucket)} for ${partition}`)
    return chTimestampSeconds(h.bucket)
  }).sort((a, b) => a - b)
  const runs: Array<[number, number]> = []
  for (const t of starts) {
    const last = runs.at(-1)
    if (last && t <= last[1]) last[1] = Math.max(last[1], t + 3_600)
    else runs.push([t, t + 3_600])
  }
  const minb = Math.min(...hours.map(h => Number(h.minb)))
  const maxb = Math.max(...hours.map(h => Number(h.maxb)))
  if (!Number.isSafeInteger(minb) || !Number.isSafeInteger(maxb) || minb > maxb) {
    throw new Error(`invalid block span ${minb}..${maxb}`)
  }
  const spans = runs.map(([from, to]) =>
    `(block_timestamp >= toDateTime('${chTimestamp(from)}') AND block_timestamp < toDateTime('${chTimestamp(to)}'))`)
  return `toYYYYMM(block_timestamp) = ${partition}
      AND block_height >= ${minb} AND block_height <= ${maxb}
      AND (${spans.join(' OR ')})`
}

const DATETIME_LITERAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** One stream's rows of a set of hours into the staging twin, stamped with each hour's fingerprint and the read time. */
export function revenueEventsInsertSql(
  stream: EventfulRevenueStream,
  partition: string,
  hours: readonly RevenueStaleHour[],
  computedAt: string,
  target = `${REVENUE_EVENTS_TABLE}_staging`,
): string {
  if (!DATETIME_LITERAL.test(computedAt)) throw new Error(`invalid computed_at ${JSON.stringify(computedAt)}`)
  const fingerprint = hourFingerprintSql('toStartOfHour(block_timestamp)', hours.map(h => ({ hour: h.bucket, fingerprint: h.fingerprint })))
  return `INSERT INTO ${target} (${REVENUE_EVENT_COLUMNS.join(', ')}, registry_fp, computed_at)
SELECT *, ${fingerprint} AS registry_fp, toDateTime('${computedAt}') AS computed_at
FROM (
${buildRevenueEventRowsSql(stream, revenueHoursPredicate(partition, hours))}
)`
}

/** The rows of a month that survive its republication: every hour not being recomputed. */
export function keptRevenueRowsSql(live: string, staging: string, partition: string, hours: readonly string[]): string {
  return `INSERT INTO ${staging} SELECT * FROM ${live}
    WHERE toYYYYMM(block_timestamp) = ${partition}
      AND toStartOfHour(block_timestamp) NOT IN (${hours.map(h => `toDateTime('${h}')`).join(', ')})`
}

function chTimestampSeconds(ts: string): number {
  return Math.floor(Date.parse(`${ts.trim().replace(' ', 'T')}Z`) / 1000)
}

function monthBounds(partition: string): { startSeconds: number; endSeconds: number } {
  const year = Number(partition.slice(0, 4))
  const month = Number(partition.slice(4, 6))
  return {
    startSeconds: Date.UTC(year, month - 1, 1) / 1000,
    endSeconds: Date.UTC(year, month, 1) / 1000,
  }
}

/** A 1e-12-USD integer as the Decimal(38,12) wire string ClickHouse parses. */
function usd1e12String(value: bigint): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  return `${negative ? '-' : ''}${magnitude / 10n ** 12n}.${(magnitude % 10n ** 12n).toString().padStart(12, '0')}`
}

/** What a TS-built row carries beside its content: its hour's fingerprint and the cycle's read time. */
function hourStamp(hours: readonly RevenueStaleHour[], computedAt: string): (hourSeconds: number) => { registry_fp: string; computed_at: string } {
  const byHour = new Map(hours.map(h => [chTimestampSeconds(h.bucket), h.fingerprint]))
  return hourSeconds => ({ registry_fp: byHour.get(hourSeconds) ?? '0', computed_at: computedAt })
}

interface AssetReserveRow {
  block_height: number
  block_timestamp: string
  event_index: number
  asset_id: number
  amount: string
  amount_usd: string
}

/**
 * asset_reserve's rows of a set of hours, split into what external borrowers
 * generated and what the protocol's own accounts did.
 *
 * A MintedToTreasury is a LUMP: it names no payer, and the attribution splits it
 * over the interest each borrower accrued since the reserve's previous mint. So
 * the protocol's own part cannot be marked on the row the way a fee's payer is —
 * it is the same pro-rata share, taken against the same weights, and booked as a
 * second row at the next leg index. The two always re-sum to the gross mint, and
 * `internal_payer` keeps the second out of every protocol-revenue total.
 *
 * Built in TS rather than as an INSERT … SELECT because the weights are a
 * per-window query the SQL cannot carry; at ~18 mints a month that is a handful
 * of rows either way. The weights query is the one the account_revenue job runs
 * again for the per-account split — the same numbers, reached twice, so neither
 * job depends on the other's intermediate state.
 */
async function insertAssetReserveRows(
  client: ClickHouseClient,
  staging: string,
  partition: string,
  hours: readonly RevenueStaleHour[],
  priceParams: { anchor: string; hours: number },
  computedAt: string,
): Promise<number> {
  const rowsRes = await client.query({
    query: buildRevenueEventRowsSql('asset_reserve', revenueHoursPredicate(partition, hours)),
    query_params: priceParams,
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const rows = await rowsRes.json<AssetReserveRow>()
  if (!rows.length) return 0

  const mintsRes = await client.query({
    query: assetReserveMintsSql(),
    query_params: { end: chTimestamp(monthBounds(partition).endSeconds) },
    format: 'JSONEachRow',
  })
  const windows = new Map((await mintsRes.json<MintRow>())
    .map(m => [`${m.block_height}-${m.event_index}`, m]))
  const internalAccounts = await loadInternalPayerAccounts(client)
  const stamp = hourStamp(hours, computedAt)

  const values: Record<string, unknown>[] = []
  for (const row of rows) {
    const grossUsd = scaledUsd(row.amount_usd)
    const grossAmount = BigInt(row.amount || '0')
    const mint = windows.get(`${row.block_height}-${row.event_index}`)
    let internalUsd = 0n
    let internalAmount = 0n
    if (mint && (grossUsd > 0n || grossAmount > 0n)) {
      const weights = await borrowWeights(
        client, mint.reserve, chTimestampSeconds(mint.prev_ts), chTimestampSeconds(mint.mint_ts),
      )
      const total = weights.reduce((sum, w) => sum + w.weight, 0n)
      const internal = weights
        .filter(w => internalAccounts.has(w.account.toLowerCase()))
        .reduce((sum, w) => sum + w.weight, 0n)
      internalUsd = internalShareOf(grossUsd, internal, total)
      internalAmount = internalShareOf(grossAmount, internal, total)
    }
    const base = {
      stream: 'asset_reserve',
      block_height: row.block_height,
      block_timestamp: row.block_timestamp,
      event_index: row.event_index,
      dest: '',
      account: '',
      asset_id: row.asset_id,
      ...stamp(Math.floor(chTimestampSeconds(row.block_timestamp) / 3_600) * 3_600),
    }
    values.push({
      ...base, leg_index: 0, internal_payer: 0,
      amount: (grossAmount - internalAmount).toString(),
      amount_usd: usd1e12String(grossUsd - internalUsd),
    })
    if (internalUsd > 0n || internalAmount > 0n) {
      values.push({
        ...base, leg_index: 1, internal_payer: 1,
        amount: internalAmount.toString(),
        amount_usd: usd1e12String(internalUsd),
      })
    }
  }
  await client.insert({ table: staging, values, format: 'JSONEachRow' })
  return values.length
}

/**
 * hollar_borrow's rows of a set of hours. Interest accrues by index growth, so
 * the hourly rows are computed in TS (exact BigInt identity) over the whole
 * month up to the cut — each hour's row depends only on the observations at or
 * before it, so the month's walk states every hour exactly as a fresh build
 * would — and the recomputed hours' rows are kept. A row is booked only for an
 * hour whose index moved, i.e. one holding a HOLLAR ReserveDataUpdated, so a set
 * of hours without one (every hour before HOLLAR) skips the walk.
 */
async function insertHollarBorrowRows(
  client: ClickHouseClient,
  staging: string,
  partition: string,
  hours: readonly RevenueStaleHour[],
  cutSeconds: number,
  computedAt: string,
): Promise<number> {
  if (!hours.some(h => Number(h.hollar))) return 0
  const { startSeconds, endSeconds } = monthBounds(partition)
  const stamp = hourStamp(hours, computedAt)
  const wanted = new Set(hours.map(h => chTimestampSeconds(h.bucket)))
  // The last bookable hour is the one below the cut: the cut hour is still filling.
  const hollarRows = (await hollarBorrowHourlyRows(client, startSeconds, Math.min(cutSeconds, endSeconds) - 3_600))
    .filter(row => wanted.has(row.hour))
  if (!hollarRows.length) return 0
  const byHour = new Map<number, number>()
  const nextLeg = (hour: number): number => {
    const leg = byHour.get(hour) ?? 0
    byHour.set(hour, leg + 1)
    return leg
  }
  // Interest the protocol's own accounts owed is carved out of the same accrual
  // (see HollarHourlyRow.internalPlanck) and booked beside it, so the pair re-sums
  // to the market's flow while only the external half is revenue. An hour with no
  // internal debt writes one row.
  const values = hollarRows.flatMap(row => {
    const base = {
      stream: 'hollar_borrow',
      block_height: 0,
      block_timestamp: chTimestamp(row.hour),
      event_index: Math.floor(row.hour / 3_600),
      dest: '',
      account: '',
      asset_id: 222,
      ...stamp(row.hour),
    }
    const out = [{
      ...base, leg_index: nextLeg(row.hour), internal_payer: 0,
      amount: (row.amountPlanck - row.internalPlanck).toString(),
      amount_usd: usd1e12String(row.usd1e12 - row.internalUsd1e12),
    }]
    if (row.internalPlanck > 0n) {
      out.push({
        ...base, leg_index: nextLeg(row.hour), internal_payer: 1,
        amount: row.internalPlanck.toString(),
        amount_usd: usd1e12String(row.internalUsd1e12),
      })
    }
    return out
  })
  await client.insert({ table: staging, values, format: 'JSONEachRow' })
  return values.length
}

/**
 * The candle window a month's valuation reads, as the public surfaces anchor it
 * (ANCHORED_PRICE_WINDOW): anchored on the month's end — or the cut, in the live
 * month — and spanning the month, so the staleness lookback starts at the same
 * instant whichever of its hours are folded: a row's value depends on its month
 * alone.
 */
export function revenuePriceParams(partition: string, cutSeconds: number): { anchor: string; hours: number } {
  const { startSeconds, endSeconds } = monthBounds(partition)
  const anchorSeconds = Math.min(cutSeconds, endSeconds)
  return { anchor: chTimestamp(anchorSeconds), hours: Math.ceil((anchorSeconds - startSeconds) / 3_600) + 2 }
}

export async function runRevenueEvents(client: ClickHouseClient, table = REVENUE_EVENTS_TABLE): Promise<DerivationResult> {
  const model = 'revenue_events'
  if (!allExplorerAssets().length) {
    console.log(`[derivations] ${model} skipped: asset registry empty`)
    return { model, rows: 0 }
  }
  // The internal-payer set is fingerprinted into every hour, so the asset_reserve
  // split must read the set the staleness check just saw, not one cached at start.
  resetInternalPayerAccounts()
  // Read BEFORE the watermarks, so it is no later than anything they reveal.
  const nowRes = await client.query({ query: 'SELECT toString(now()) AS t', format: 'JSONEachRow' })
  const computedAt = (await nowRes.json<{ t: string }>())[0]?.t
  if (!computedAt) return { model, rows: 0 }
  const res = await client.query({ query: revenueEventsStaleHoursSql(table), format: 'JSONEachRow' })
  const stale = await res.json<RevenueStaleHour>()
  if (!stale.length) return { model, rows: 0 }
  // One cut for the whole cycle: every candle window and hollar walk below ends on it.
  const cutRes = await client.query({
    query: `SELECT toString(${hourlyFoldCutSql({ watermarks: REVENUE_HOUR_WATERMARKS_TABLE, valued: true })}) AS cut`,
    format: 'JSONEachRow',
  })
  const cut = (await cutRes.json<{ cut: string }>())[0]?.cut
  if (!cut) return { model, rows: 0 }
  const cutSeconds = chTimestampSeconds(cut)

  const rows = await republishBuckets(client, {
    model,
    table,
    partitionOf: hourPartition,
    keptRowsSql: keptRevenueRowsSql,
    write: async (p, hours, staging) => {
      const priceParams = revenuePriceParams(p, cutSeconds)
      let written = 0
      for (const stream of REVENUE_EVENT_STREAMS_INSERTED) {
        const inserted = await client.command({
          query: revenueEventsInsertSql(stream, p, hours, computedAt, staging),
          query_params: priceParams,
        })
        written += Number(inserted.summary?.written_rows ?? 0)
      }
      written += await insertAssetReserveRows(client, staging, p, hours, priceParams, computedAt)
      written += await insertHollarBorrowRows(client, staging, p, hours, cutSeconds, computedAt)
      return written
    },
  }, stale)
  return { model, rows }
}

// ───────────────────────── account_revenue ─────────────────────────
// Per-account, per-stream protocol revenue by calendar month — the account
// grain behind the account/tag Revenue stats and the /accounts sort. Its key is
// the month, so the month is its bucket: a month is rebuilt (publishPartitions)
// whenever its revenue_events hours were republished, strictly AFTER
// revenue_events in the cycle, so the two tables never disagree for long.
//
// Following revenue_events is enough for every input both models share, because
// revenue_events' hour staleness already folds them in: the borrow SPLIT is
// computed here from the debt observations (accountBorrowInterestSql /
// assetReserveMintsSql over the scaled deltas, the anchors and the reserve mints),
// and a debt row backfilled at or before a month re-marks every revenue hour from
// it on (the 'debt' cascade) — so the month's revenue_events publication moves
// and this month follows. The one input that reaches further back is the v3
// split's weights: a vault realization's window opens at the previous
// realization, routinely in an EARLIER month, so the uniswapv3 legs' ingest time
// cascades forward here as well.
//
// The split reads only what revenue_events has published: hollar_borrow's
// weights window ends at the stream's own mark (its last booked hour) inside the
// live month, the rule the dashboard's payer ranking applies, so a rebuild is a
// function of the published hours and a month needs no refresh window to keep
// up with its debt rows.
//
// Eventful streams are a plain GROUP BY of the fresh revenue_events partition
// restricted to protocol revenue. The two borrow streams are attributed here:
// per-account planck interest from the Aave identity in
// services/borrowAttribution.ts weights a pro-rata split of the stream's OWN
// revenue_events USD total (hollar_borrow) or of each MintedToTreasury's
// valued amount over its inter-mint window (asset_reserve) — cumulative-floor
// exact, remainder on account = '', so per stream and month the account sums
// equal the protocol-revenue event sums to the last 1e-12 USD.
//
// ONE ROW PER (account, stream, month) PER BUILD. The table is a
// ReplacingMergeTree over exactly that key, so two rows written for one key in
// the same publication are not two addends: a merge keeps the newer and the
// other's revenue vanishes, silently and only once the merge happens to run —
// a plain sum reads the truth until then, FINAL and argMax read the loss at
// once. Every stream therefore has exactly one writer: the GROUP BY for the
// streams it lists, the accumulator below for ACCOUNT_REVENUE_ATTRIBUTED_STREAMS.
// A stream with two sources (uniswap_v3_fee: per-swap accruals naming their
// payer beside vault realizations spread over a window) folds its eventful
// half into the accumulator, and accountRevenueKeyCollisionsSql refuses to
// publish a partition where a key was written twice anyway.

import {
  accountBorrowInterestSql,
  assetReserveMintsSql,
  distributeUsd1e12,
  internalShareOf,
} from '../services/borrowAttribution.ts'
import { uniswapV3FeePayersSql, uniswapV3RealizationsSql } from '../services/uniswapV3Attribution.ts'
import { HOLLAR_RESERVE_ADDRESS, PROTOCOL_REVENUE_PREDICATE_SQL } from '../services/revenueStreams.ts'
import { scaledUsd } from '../services/valuation.ts'

const ACCOUNT_REVENUE_TABLE = 'price_data.account_revenue'

/** The account_revenue months to rebuild (the section note's rules), oldest first. */
export function accountRevenueStaleMonthsSql(table = ACCOUNT_REVENUE_TABLE, revenueTable = REVENUE_EVENTS_TABLE): string {
  return `
    SELECT toString(src.p) AS p, toString(src.eff_ingest) AS src_ingest
    FROM (
      SELECT p,
             greatest(rev_ingest,
                      max(v3_ingest) OVER (ORDER BY p ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS eff_ingest
      FROM (
        SELECT p, max(rev_ingest) AS rev_ingest, max(v3_ingest) AS v3_ingest
        FROM (
          -- The month's revenue_events publication, read through the per-hour
          -- projection.
          SELECT toYYYYMM(hour) AS p, max(der_computed) AS rev_ingest, toDateTime(0) AS v3_ingest
          FROM (
            SELECT toStartOfHour(block_timestamp) AS hour, max(computed_at) AS der_computed
            FROM ${revenueTable}
            GROUP BY hour
          )
          GROUP BY p
          UNION ALL
          -- The legs the uniswap_v3_fee split is weighted by. Venue-first key
          -- prefix, so this reads only the v3 legs. Only the published ones: a
          -- realization's window ends at the realization, so a leg past the last
          -- published hour weighs nothing yet, and its hour's publication moves
          -- the month's clock above anyway.
          SELECT toYYYYMM(block_timestamp) AS p, toDateTime(0) AS rev_ingest, max(ingested_at) AS v3_ingest
          FROM price_data.pool_swap_legs
          WHERE venue = 'uniswapv3'
            AND block_timestamp < (SELECT toStartOfHour(max(block_timestamp)) + INTERVAL 1 HOUR FROM ${revenueTable})
          GROUP BY p
        )
        GROUP BY p
      )
    ) AS src
    LEFT JOIN (
      SELECT month AS p, max(computed_at) AS der_computed
      FROM ${table}
      GROUP BY p
    ) AS der ON src.p = der.p
    -- Same non-nullable LEFT JOIN rule as staleBucketsSql above.
    WHERE der.der_computed = toDateTime(0) OR src.eff_ingest > der.der_computed
    ORDER BY src.p`
}

/**
 * The streams the accumulator in runAccountRevenue writes, and which the
 * eventful GROUP BY therefore never touches — the two writers must stay
 * disjoint (see the section note). uniswap_v3_fee is here although half of it
 * is eventful: its accrued rows are folded into the accumulator beside the
 * realization shares so an account earns ONE row for the month.
 */
export const ACCOUNT_REVENUE_ATTRIBUTED_STREAMS = ['hollar_borrow', 'asset_reserve', 'uniswap_v3_fee'] as const

/**
 * The attributed eventful streams, straight off the fresh revenue_events
 * partition. No FINAL: a partition is always exactly one publication (REPLACE
 * PARTITION swaps it whole), and identities within one build are unique —
 * accountRevenueKeyCollisionsSql checks that before the swap.
 */
export function accountRevenueEventfulInsertSql(
  partition: string, target = `${ACCOUNT_REVENUE_TABLE}_staging`, revenueTable = REVENUE_EVENTS_TABLE,
): string {
  return `INSERT INTO ${target} (account, stream, month, revenue_usd)
SELECT account, stream, toUInt32(${partition}) AS month, sum(amount_usd) AS revenue_usd
FROM ${revenueTable}
WHERE toYYYYMM(block_timestamp) = ${partition}
  AND stream NOT IN (${ACCOUNT_REVENUE_ATTRIBUTED_STREAMS.map(s => `'${s}'`).join(', ')})
  AND ${PROTOCOL_REVENUE_PREDICATE_SQL}
GROUP BY account, stream`
}

/**
 * The eventful half of uniswap_v3_fee: the pool's protocol share booked per
 * swap under dest = 'accrued', each row naming the swapper who paid it — or ''
 * where the stream blanked a pallet's own swap, which stays booked as
 * unattributed rather than dropped. Read into the accumulator, not inserted:
 * the same account may also hold a share of a vault realization for the month
 * (dest = '', spread by the realization pass), and the two must add up into
 * one row for the key.
 */
export function accountRevenueV3AccruedSql(partition: string, revenueTable = REVENUE_EVENTS_TABLE): string {
  return `-- rev:account-revenue:v3-accrued
SELECT account, toString(sum(amount_usd)) AS usd
FROM ${revenueTable}
WHERE toYYYYMM(block_timestamp) = ${partition}
  AND stream = 'uniswap_v3_fee' AND dest = 'accrued'
  AND ${PROTOCOL_REVENUE_PREDICATE_SQL}
GROUP BY account`
}

/**
 * How many (account, stream) keys the staged month holds more than once. Any
 * is a bug in the build above — a second writer for a stream — and the month
 * must not be published: a ReplacingMergeTree would keep one row per key and
 * lose the other's revenue at its next merge. The staged month is a few
 * thousand rows, so the exact count is cheap.
 */
export function accountRevenueKeyCollisionsSql(partition: string, staging = `${ACCOUNT_REVENUE_TABLE}_staging`): string {
  return `SELECT count() - uniqExact(account, stream) AS n FROM ${staging} WHERE month = ${partition}`
}

/**
 * Where a month's hollar_borrow weights window ends: the month's end, or inside
 * the live month the stream's mark — the start of its last booked hour, the
 * dashboard's rule — so the split covers exactly the interest revenue_events has
 * booked and never reads past the published hours.
 */
export function hollarWeightsEndSeconds(monthEndSeconds: number, markSeconds: number | null): number {
  return markSeconds == null ? monthEndSeconds : Math.min(monthEndSeconds, markSeconds)
}

const accountRevenueRebuilt = new Map<string, string>()

interface WeightRow { account: string; interest: string }
interface MintRow { reserve: string; block_height: number; event_index: number; mint_ts: string; prev_ts: string }
interface V3RealizationRow { pool: string; asset_id: number; usd: string; ts: string; prev_ts: string }

async function borrowWeights(
  client: ClickHouseClient,
  reserve: string,
  startSeconds: number,
  endSeconds: number,
): Promise<{ account: string; weight: bigint }[]> {
  const res = await client.query({
    query: accountBorrowInterestSql(),
    query_params: { reserve, start: chTimestamp(startSeconds), end: chTimestamp(endSeconds) },
    format: 'JSONEachRow',
  })
  return (await res.json<WeightRow>()).map(r => ({ account: r.account, weight: BigInt(r.interest) }))
}

/**
 * The weights an EXTERNAL split runs over. The internal payers' own interest was
 * already carved out of the stream's booked total (revenue_events), so leaving
 * their weight in here would hand their share to everybody else — inflating the
 * very payers the exclusion exists to report honestly. Dropping the weight and
 * the total together is what keeps the two sides equal.
 */
async function externalBorrowWeights(
  client: ClickHouseClient,
  reserve: string,
  startSeconds: number,
  endSeconds: number,
): Promise<{ account: string; weight: bigint }[]> {
  const [weights, internal] = await Promise.all([
    borrowWeights(client, reserve, startSeconds, endSeconds),
    loadInternalPayerAccounts(client),
  ])
  return weights.filter(w => !internal.has(w.account.toLowerCase()))
}

export async function runAccountRevenue(
  client: ClickHouseClient, table = ACCOUNT_REVENUE_TABLE, revenueTable = REVENUE_EVENTS_TABLE,
): Promise<DerivationResult> {
  const model = 'account_revenue'
  const live = table
  const res = await client.query({ query: accountRevenueStaleMonthsSql(table, revenueTable), format: 'JSONEachRow' })
  const candidates = await res.json<PartitionCandidate>()
  if (!partitionsNeedingRebuild(candidates, accountRevenueRebuilt).length) return { model, rows: 0 }
  const markRes = await client.query({
    query: `SELECT toString(max(block_timestamp)) AS mark FROM ${revenueTable} WHERE stream = 'hollar_borrow'`,
    format: 'JSONEachRow',
  })
  const mark = (await markRes.json<{ mark: string }>())[0]?.mark
  const markSeconds = mark && chTimestampSeconds(mark) > 0 ? chTimestampSeconds(mark) : null

  const built = await publishPartitions(client, model, live, candidates, accountRevenueRebuilt, async (p, staging) => {
    const { startSeconds, endSeconds } = monthBounds(p)
    await client.command({ query: accountRevenueEventfulInsertSql(p, staging, revenueTable) })

    // Borrow attribution rows, accumulated per (account, stream) then inserted
    // in one batch. All arithmetic BigInt at the 1e-12 USD scale.
    const attributed = new Map<string, bigint>()
    const key = (account: string, stream: string) => `${stream} ${account}`

    const hollarTotalRes = await client.query({
      query: `SELECT toString(sum(amount_usd)) AS total FROM ${revenueTable}
              WHERE toYYYYMM(block_timestamp) = ${p} AND stream = 'hollar_borrow'
                AND internal_payer = 0`,
      format: 'JSONEachRow',
    })
    const hollarTotal = scaledUsd((await hollarTotalRes.json<{ total: string | null }>())[0]?.total ?? '0')
    if (hollarTotal > 0n) {
      const weights = await externalBorrowWeights(
        client, HOLLAR_RESERVE_ADDRESS, startSeconds, hollarWeightsEndSeconds(endSeconds, markSeconds),
      )
      for (const [account, usd] of distributeUsd1e12(hollarTotal, weights)) {
        const k = key(account, 'hollar_borrow')
        attributed.set(k, (attributed.get(k) ?? 0n) + usd)
      }
    }

    const mintUsdRes = await client.query({
      query: `SELECT block_height, event_index, toString(amount_usd) AS usd FROM ${revenueTable}
              WHERE toYYYYMM(block_timestamp) = ${p} AND stream = 'asset_reserve'
                AND internal_payer = 0`,
      format: 'JSONEachRow',
    })
    const mintUsd = new Map((await mintUsdRes.json<{ block_height: number; event_index: number; usd: string }>())
      .map(r => [`${r.block_height}-${r.event_index}`, scaledUsd(r.usd)]))
    if (mintUsd.size) {
      const mintsRes = await client.query({
        query: assetReserveMintsSql(),
        query_params: { end: chTimestamp(endSeconds) },
        format: 'JSONEachRow',
      })
      const mints = (await mintsRes.json<MintRow>())
        .filter(m => mintUsd.has(`${m.block_height}-${m.event_index}`))
      for (const mint of mints) {
        const usd = mintUsd.get(`${mint.block_height}-${mint.event_index}`) ?? 0n
        if (usd <= 0n) continue
        const weights = await externalBorrowWeights(
          client, mint.reserve, chTimestampSeconds(mint.prev_ts), chTimestampSeconds(mint.mint_ts),
        )
        for (const [account, share] of distributeUsd1e12(usd, weights)) {
          const k = key(account, 'asset_reserve')
          attributed.set(k, (attributed.get(k) ?? 0n) + share)
        }
      }
    }

    // Uniswap v3 protocol fees. The pool-level share is booked per swap and
    // already carries its swapper, so its month is a GROUP BY — folded in HERE
    // rather than inserted by the eventful statement, because the same account
    // may take a share of a realization below and the key admits one row.
    const accruedRes = await client.query({
      query: accountRevenueV3AccruedSql(p, revenueTable),
      format: 'JSONEachRow',
    })
    for (const row of await accruedRes.json<{ account: string; usd: string }>()) {
      const k = key(row.account, 'uniswap_v3_fee')
      attributed.set(k, (attributed.get(k) ?? 0n) + scaledUsd(row.usd))
    }

    // Only the Gamma vault's REALIZATION needs spreading: it pays the Treasury a
    // lump covering many swaps, and the vault is not the payer — see
    // services/uniswapV3Attribution.ts.
    const realizationsRes = await client.query({
      query: uniswapV3RealizationsSql(revenueTable),
      query_params: { partition: Number(p) },
      format: 'JSONEachRow',
    })
    for (const realization of await realizationsRes.json<V3RealizationRow>()) {
      const usd = scaledUsd(realization.usd)
      if (usd <= 0n) continue
      const payersRes = await client.query({
        query: uniswapV3FeePayersSql(),
        query_params: {
          pool: realization.pool,
          asset: Number(realization.asset_id),
          start: realization.prev_ts,
          end: realization.ts,
        },
        format: 'JSONEachRow',
      })
      // A realization names no payer, so an internal swapper among its weights
      // would put protocol money on a protocol account's page. Their share
      // falls to the unattributed bucket instead: the lump itself stays booked
      // (it is a Treasury RECEIPT from an external vault, not a fee the
      // protocol charged itself), so only the attribution moves.
      const internal = await loadInternalPayerAccounts(client)
      const weights = (await payersRes.json<{ account: string; weight: string }>())
        .map(row => ({ account: row.account, weight: BigInt(row.weight) }))
        .filter(w => !internal.has(w.account.toLowerCase()))
      for (const [account, share] of distributeUsd1e12(usd, weights)) {
        const k = key(account, 'uniswap_v3_fee')
        attributed.set(k, (attributed.get(k) ?? 0n) + share)
      }
    }

    if (attributed.size) {
      await client.insert({
        table: staging,
        values: [...attributed].map(([k, usd]) => {
          const [stream, account] = k.split(' ')
          return { account, stream, month: Number(p), revenue_usd: usd1e12String(usd) }
        }),
        format: 'JSONEachRow',
      })
    }

    // Refuse to publish a month that would lose revenue at its next merge; the
    // live table keeps serving the month's previous publication and the error
    // reaches the cycle log (the runner catches per job).
    const collisionsRes = await client.query({ query: accountRevenueKeyCollisionsSql(p, staging), format: 'JSONEachRow' })
    const collisions = Number((await collisionsRes.json<{ n: string }>())[0]?.n ?? 0)
    if (collisions > 0) {
      throw new Error(`account_revenue ${p}: ${collisions} (account, stream) keys written twice — a ReplacingMergeTree keeps one row per key, so the month was not published`)
    }
  })
  return { model, rows: await countPublished(client, live, 'month', built) }
}

// ───────────────────────────── xcm_arrivals ─────────────────────────────
// Store the inbound-XCM arrivals the activity feed already decodes, so they can be
// answered in SQL. `raw_xcm_activity.recipient` is NULL on all 988,879 inbound and
// processed rows — the chain emits no beneficiary for an arrival, it lives in the XCM
// program's un-emitted `DepositAsset` — so nothing in the database could attribute an
// arrival to an account for analysis or the Data API.
//
// This job CALLS the feed's own walk (`xcmInboundCreditsForBlocks`) rather than
// restating it in SQL. A SQL restatement was written first and measured against the
// walk: it drifted four separate ways (a barrier set missing `DmpQueue.ExecutedDownward`,
// a credit set missing `Balances.Issued`/`Minted`, reserved-account prefixes of
// `modl|ETH\0` instead of `modl|sibl|para`, and no handling of the crossable events the
// run must step over — without crossing `EVM.Log`, 149 of the first 151 HOLLAR arrivals
// decode to nothing). One walk, two consumers, parity by construction.
//
// Coverage is an INGEST-TIME watermark per month, like every other job here, never a
// block range between the derived table's own min and max. A block range cannot
// express this model's coverage at all, for two reasons that both lose rows
// silently:
//   * a block that processed a message but decoded to no credit writes nothing,
//     so "there is a derived row at block N" is not "block N has been walked" —
//     a low-end fill interrupted after its first chunk moved the derived minimum
//     down to the source minimum and every block in between was then considered
//     covered forever;
//   * a raw row CORRECTED inside the covered range is invisible to a range, so
//     the arrival it should have produced (or withdrawn) never materialised.
// An ingest-time watermark answers both: a backfilled or corrected row carries a
// newer `ingested_at` than the derived partition's `computed_at`, whatever block
// it sits at.
//
// The same barrier list the walk terminates on, so this selects exactly the blocks the
// walk can decode — a second copy here is how the SQL version started drifting.
const XCM_MESSAGE_EVENTS = XCM_BARRIER_EVENTS.map(n => `'${n}'`).join(',')

// Blocks handed to one walk call. The walk reads per block, so a chunk bounds
// both the ClickHouse reads it issues and the rows held in memory.
const XCM_ARRIVALS_CHUNK_BLOCKS = 5_000

/** Splits a block list into bounded walk chunks, in order, covering it exactly. */
export function xcmArrivalsChunks(blocks: readonly number[], size = XCM_ARRIVALS_CHUNK_BLOCKS): number[][] {
  const chunks: number[][] = []
  for (let start = 0; start < blocks.length; start += size) chunks.push(blocks.slice(start, start + size))
  return chunks
}

/**
 * Ingest-time slack on the per-partition re-walk.
 *
 * A pass stamps `computed_at = now()` on the rows it writes, so a raw row that
 * landed WHILE the pass was running carries an `ingested_at` below that stamp and
 * would never be selected again. Re-walking the blocks whose raw rows were
 * ingested in the hour before the partition's own derivation closes that window;
 * the walk is idempotent (replacement is per (block_height, event_index)), so the
 * overlap costs reads and never correctness.
 */
export const XCM_ARRIVALS_INGEST_OVERLAP_SECONDS = 3_600

export function xcmArrivalsStaleMonthsSql(): string {
  return `
    SELECT toString(src.p) AS p, toString(src.src_ingest) AS src_ingest, toString(der.der_computed) AS der_computed
    FROM (
      SELECT toYYYYMM(block_timestamp) AS p, max(ingested_at) AS src_ingest
      FROM price_data.raw_xcm_activity
      WHERE name IN (${XCM_MESSAGE_EVENTS})
      GROUP BY p
    ) AS src
    LEFT JOIN (
      SELECT toYYYYMM(block_timestamp) AS p, max(computed_at) AS der_computed
      FROM price_data.xcm_arrivals
      GROUP BY p
    ) AS der ON src.p = der.p
    -- Same non-nullable LEFT JOIN rule as staleBucketsSql above: an absent
    -- derived month carries the DateTime epoch, never NULL.
    WHERE der.der_computed = toDateTime(0) OR src.src_ingest > der.der_computed
    ORDER BY src.p`
}

/**
 * The blocks of one month whose XCM rows the derived month has not seen: every
 * message block when the month has never been derived, otherwise the ones whose
 * raw rows were (re-)ingested since it was, plus the overlap above.
 */
export function xcmArrivalsPendingBlocksSql(): string {
  return `SELECT DISTINCT block_height FROM price_data.raw_xcm_activity
          WHERE toYYYYMM(block_timestamp) = {partition:UInt32}
            AND name IN (${XCM_MESSAGE_EVENTS})
            AND ingested_at > {since:DateTime}
          ORDER BY block_height
          ${FULL_HISTORY_SETTINGS}`
}

// A month whose message blocks all decode to nothing writes no arrivals, so the
// LEFT JOIN miss would re-mark it stale on every cycle forever. Same idiom as
// partitionsNeedingRebuild above.
const xcmArrivalsRebuilt = new Map<string, string>()

interface XcmArrivalsPartition { p: string; src_ingest: string; der_computed: string }

export async function runXcmArrivals(client: ClickHouseClient): Promise<DerivationResult> {
  const model = 'xcm_arrivals'
  const res = await client.query({ query: xcmArrivalsStaleMonthsSql(), format: 'JSONEachRow' })
  const candidates = await res.json<XcmArrivalsPartition>()
  const stale = new Set(partitionsNeedingRebuild([...candidates], xcmArrivalsRebuilt))
  if (!stale.size) return { model, rows: 0 }

  let written = 0
  for (const candidate of candidates) {
    if (!stale.has(candidate.p)) continue
    const blocks = await pendingXcmBlocks(client, candidate)
    for (const chunk of xcmArrivalsChunks(blocks)) {
      const credits = await xcmInboundCreditsForBlocks(chunk)
      if (!credits.length) continue
      await insertXcmArrivals(client, credits)
      written += credits.length
    }
    // Only once the whole month walked: a chunk that threw leaves the month a
    // candidate, and the next cycle re-walks it from the same watermark.
    xcmArrivalsRebuilt.set(candidate.p, candidate.src_ingest)
  }
  return { model, rows: written }
}

// Only the blocks that actually processed a message; the walk is given nothing else.
async function pendingXcmBlocks(client: ClickHouseClient, candidate: XcmArrivalsPartition): Promise<number[]> {
  const derived = Math.floor(Date.parse(`${candidate.der_computed.trim().replace(' ', 'T')}Z`) / 1000)
  const since = Number.isFinite(derived) && derived > 0
    ? Math.max(0, derived - XCM_ARRIVALS_INGEST_OVERLAP_SECONDS)
    : 0
  const res = await client.query({
    query: xcmArrivalsPendingBlocksSql(),
    query_params: { partition: Number(candidate.p), since: chTimestamp(since) },
    format: 'JSONEachRow',
  })
  return (await res.json<{ block_height: number }>()).map(x => Number(x.block_height))
}

function sqlQuote(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

async function insertXcmArrivals(client: ClickHouseClient, credits: XcmInboundCredit[]): Promise<void> {
  const values = credits.map(c => `(${c.blockHeight},${c.eventIndex},${sqlQuote(c.ts)},${sqlQuote(c.who)},` +
    `${c.assetId},${sqlQuote(c.amount)},${sqlQuote(c.messageId ?? '')},${c.barrierEventIndex},` +
    `${Math.min(c.barriersInContext, 255)},` +
    `${sqlQuote(c.barriersInContext === 1 ? 'exact' : 'ambiguous')},` +
    `${sqlQuote(c.fromChain ?? '')},${c.fromParachainId ?? 'NULL'},now())`).join(',')
  await client.command({
    query: `INSERT INTO price_data.xcm_arrivals
      (block_height, event_index, block_timestamp, account, asset_id, amount, message_id,
       message_event_index, barriers_in_context, attribution, from_chain, from_parachain_id, computed_at)
      VALUES ${values}`,
  })
}

// ───────────────────────── pair_route_ohlc ─────────────────────────
// Route-priced pair candles (services/pairRouteFold.ts; the tables' declaration in
// clickhouse/schema/014_pair_routes.sql carries the model). A progressive bucket
// fold whose bucket is a chain-time hour of raw_block_snapshots:
//
//  * The watermarks. pair_route_hour_watermarks holds both sides of the staleness
//    test per hour: the source side MV-fed from raw_block_snapshots' three narrow
//    key columns (newest snapshot ingest, block span), the derived side written by
//    this job once it has published the hour (when it computed it, how far into it
//    it got). The v3 pools' logs have a watermark of their own (below); the
//    Omnipool fee legs the fee estimates read (raw_events → pool_swap_legs) land
//    with the same raw ranges as the snapshots.
//  * The cut. The head hour is folded while it fills (recomputed every cycle until
//    its newest snapshot has settled), so the stored model trails the chain by
//    about one cycle — the readers fold the rest on request; an hour is folded only
//    once the price pipeline has reached it (its priced asset set and USD
//    notionals come from ohlc_1h) and never below the price pipeline's floor.
//  * Publication. A recomputed hour is ONE insert per table of its rows plus an
//    is_deleted row for each key the hour held and no longer does, into
//    ReplacingMergeTree(computed_at, is_deleted): a recomputed hour equals a fresh
//    build of it, the insert is atomic (one part), and a cycle writes exactly the
//    hours it recomputed. A day touched is then re-aggregated from its hourly rows
//    the same way. Readers read FINAL on one pair's primary-key prefix.
//  * A cycle folds at most PAIR_ROUTE_HOURS_PER_CYCLE stale hours, newest first:
//    the head stays fresh while a history refold proceeds a slice per cycle.
//  * The v3 pools. A pool's state at an hour replays every log of it before the
//    hour, so a v3 log's ingest (v3_ingest, MV-fed by topic from raw_evm_logs)
//    re-marks its own hour and every later one: the stale test reads the running
//    max of v3_ingest. A new pool, a backfilled or repaired log refolds from its
//    hour on; a live log lands in the head hour.
//  * The rule. Each hour is fingerprinted on the route rule now in force for it
//    (pairRoutes ROUTE_RULE_BASE for every hour, ROUTE_RULE_V3 for an hour at or
//    after the first v3 pool's creation, ROUTE_RULE_OMNI_SLIP at or after the first
//    Omnipool.SlipFeeSet) XOR the inputs of each part the hour can see (the v3 pools
//    created at or below its last block with their tokens' registry mapping, fee
//    and tick spacing; every SlipFeeSet at or below it); the fold stores the
//    fingerprint it computed under (der_rule), and a differing one is stale.
//    Changing the rule — a new slip fee, a pool's token gaining its registry
//    entry — re-marks exactly the hours it can touch, with no marker.
//  * Prices and the registry. An hour's priced set and USD notionals are its own
//    candles: a price row written for the hour (price_ingest, MV-fed from
//    price_data.prices) re-marks it. Each asset's decimals are in the hour's
//    fingerprint from the first hour the asset was priced, so a decimals
//    correction re-marks exactly the hours it can change.
//  * Hour boundaries. An hour starts on the routes the previous hour closed on (its
//    1h rows' `route`); refolding an hour whose closing routes change re-marks the
//    next one, which stops at the first hour whose closing routes come out alike.

export const PAIR_ROUTE_HOURS_PER_CYCLE = 72

/** The route-rule fingerprint of an hour whose last block is `maxb` (UInt64 SQL; reads the WITH scalars of pairRouteStaleHoursSql). */
function pairRouteRuleFingerprintSql(maxb: string, hour: string): string {
  const part = (name: string, version: number) => (version ? `cityHash64('pair-route:${name}', toUInt64(${version}))` : 'toUInt64(0)')
  // Each part: its rule version, XOR the inputs of it the hour can see.
  // Each input list is ONE array of (from, hash) pairs: two separate groupArray
  // scalars over one CTE need not list its rows in the same order (parallel
  // aggregation), which paired hashes with the wrong blocks and made the
  // fingerprint differ between evaluations of the same inputs.
  const scoped = (from: string, name: string, version: number, pairs: string) => `if(${maxb} >= ${from},
         bitXor(${part(name, version)},
                arrayReduce('groupBitXor', arrayMap(p -> if(tupleElement(p, 1) <= ${maxb}, tupleElement(p, 2), toUInt64(0)), ${pairs}))),
         toUInt64(0))`
  return `bitXor(bitXor(bitXor(${part('base', ROUTE_RULE_BASE)},
      ${scoped('v3_from', 'v3', ROUTE_RULE_V3, 'v3_pairs')}),
      ${scoped('slip_from', 'omni-slip', ROUTE_RULE_OMNI_SLIP, 'slip_pairs')}),
      arrayReduce('groupBitXor', arrayMap(p -> if(tupleElement(p, 1) <= toUnixTimestamp(${hour}), tupleElement(p, 2), toUInt64(0)), dec_pairs)))`
}

export function pairRouteStaleHoursSql(): string {
  return staleBucketsSql({
    with: `least((SELECT max(hour) FROM ${PAIR_ROUTE_WATERMARKS_TABLE}),
      toStartOfHour((SELECT max(block_timestamp) FROM price_data.blocks)),
      (SELECT max(interval_start) FROM price_data.ohlc_1h)) AS cut,
    ${PRICED_FLOOR_SQL} AS floor,
    ${V3_TOKEN_ASSETS_CTE},
    v3_pools AS (
      SELECT min(p.block_height) AS created,
             cityHash64(lower(p.pool_address), any(p.fee), any(p.tick_spacing),
                        any(${v3TokenAssetSql('t0.asset_id', 'p.token0')}), any(${v3TokenAssetSql('t1.asset_id', 'p.token1')})) AS h
      FROM price_data.uniswap_v3_pools AS p
      LEFT JOIN token_assets AS t0 ON t0.addr = lower(p.token0)
      LEFT JOIN token_assets AS t1 ON t1.addr = lower(p.token1)
      GROUP BY lower(p.pool_address)
    ),
    (SELECT if(count() = 0, toUInt32(4294967295), toUInt32(min(created))) FROM v3_pools) AS v3_from,
    (SELECT groupArray((created, h)) FROM v3_pools) AS v3_pairs,
    slip_sets AS (
      SELECT block_height AS b, cityHash64(block_height, event_index, JSONExtractUInt(argMax(args_json, ingested_at), 'slipFee', 'maxSlipFee')) AS h
      FROM price_data.raw_events
      WHERE event_name = 'Omnipool.SlipFeeSet'
      GROUP BY block_height, event_index
    ),
    (SELECT if(count() = 0, toUInt32(4294967295), toUInt32(min(b))) FROM slip_sets) AS slip_from,
    (SELECT groupArray((b, h)) FROM slip_sets) AS slip_pairs,
    -- Each asset's decimals from the first hour it was priced (an unpriced asset is
    -- in no pair yet, so a registration re-marks nothing, a decimals correction
    -- every hour the asset was priced in).
    dec_assets AS (
      SELECT o.asset_id AS a, toUnixTimestamp(min(o.interval_start)) AS first_t, cityHash64(o.asset_id, any(r.decimals)) AS h
      FROM (SELECT DISTINCT asset_id, interval_start FROM price_data.ohlc_1h) AS o
      INNER JOIN (SELECT asset_id, argMax(decimals, observed_block) AS decimals FROM price_data.assets GROUP BY asset_id) AS r ON r.asset_id = o.asset_id
      GROUP BY o.asset_id
    ),
    (SELECT groupArray((first_t, h)) FROM dec_assets) AS dec_pairs,
    src AS (
      SELECT bucket, greatest(snap_ingest, v3_cum, price_ing) AS src_ingest, minb, maxb
      FROM (
        SELECT hour AS bucket, max(src_ingest) AS snap_ingest, min(minb) AS minb, max(maxb) AS maxb, max(price_ingest) AS price_ing,
               max(max(v3_ingest)) OVER (ORDER BY hour ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS v3_cum
        FROM ${PAIR_ROUTE_WATERMARKS_TABLE}
        GROUP BY hour
      )
      WHERE maxb > 0
    )`,
    // The alias reuses the column's name, so n reads the alias (the aggregate)
    // rather than nesting max() in max().
    derived: `SELECT hour AS bucket, max(der_computed) AS der_computed, toUInt64(der_computed > toDateTime(0)) AS n,
        tupleElement(max(der_rule), 2) AS fp_min, fp_min AS fp_max
      FROM ${PAIR_ROUTE_WATERMARKS_TABLE}
      GROUP BY hour`,
    valued: false,
    bucketFingerprint: pairRouteRuleFingerprintSql('maxb', 'bucket'),
    gate: 'src.bucket <= cut AND src.bucket >= floor',
    columns: 'toString(src.minb) AS minb, toString(src.maxb) AS maxb',
  })
}

export interface PairRouteStaleHour extends StaleBucket { minb: string; maxb: string }

/** What every hour of one fold run shares: the reserve map, decimals, the priced sets and notionals. */
async function pairRouteShared(client: ClickHouseClient, hours: readonly string[]): Promise<{
  reservePairs: Set<string>
  priced: Map<string, { ids: number[]; usd: Map<number, number> }>
  v3From: number
}> {
  const [rp, pr, v3] = await Promise.all([
    client.query({ query: PAIR_ROUTE_RESERVE_PAIRS_SQL, format: 'JSONEachRow' }),
    client.query({ query: pairRoutePricedSql(), query_params: { hours: [...hours] }, format: 'JSONEachRow' }),
    client.query({ query: `SELECT min(block_height) AS b FROM price_data.uniswap_v3_events WHERE kind = 'pool'`, format: 'JSONEachRow' }),
  ])
  const reservePairs = new Set((await rp.json<{ u: number; a: number }>()).map(r => `${r.u}:${r.a}`))
  const priced = new Map<string, { ids: number[]; usd: Map<number, number> }>()
  for (const r of await pr.json<{ hour: string; ids: number[]; opens: number[] }>()) {
    const ids = r.ids.map(Number)
    priced.set(r.hour, { ids, usd: new Map(ids.map((id, i) => [id, Number(r.opens[i])])) })
  }
  const v3From = Number((await v3.json<{ b: number | string }>())[0]?.b ?? 0) || Number.MAX_SAFE_INTEGER
  return { reservePairs, priced, v3From }
}

/**
 * Folds one day partition's stale hours into the staging twin: each hour's rows
 * from pairRouteFold.foldHour, then the day's rows from the twin's hourly rows.
 * Exported for the history refold, which runs day partitions in parallel through
 * this same function.
 */
type StoredInterval = keyof typeof PAIR_ROUTE_TABLES

/** The keys a table holds in [from, to) (their newest versions), as `lo:hi:unix` → the key's stored route. */
/**
 * The keys a window of one table holds (newest version, not deleted), with the
 * hourly and daily rows' `route` — the 1h route is the next hour's seed. The
 * 5-minute table's projection carries the keys only, so its route reads ''.
 */
export function pairRouteHeldSql(iv: StoredInterval): string {
  return `-- pair-route:held
      SELECT asset_lo, asset_hi, toUnixTimestamp(t_start) AS t, ${iv === '5min' ? "'' AS v_route" : 'v_route'}
      FROM (${pairRouteLatestSql(PAIR_ROUTE_TABLES[iv], iv === '5min' ? [] : ['route'])})`
}

async function heldKeys(client: ClickHouseClient, iv: StoredInterval, from: number, to: number): Promise<Map<string, string>> {
  const res = await client.query({
    query: pairRouteHeldSql(iv),
    query_params: { from: chTimestamp(from), to: chTimestamp(to) },
    format: 'JSONEachRow',
  })
  return new Map((await res.json<{ asset_lo: number; asset_hi: number; t: number; v_route: string }>()).map(r => [`${r.asset_lo}:${r.asset_hi}:${r.t}`, r.v_route]))
}

/** Per `lo:hi`, the route in force at the close of the hour starting at `hour` (its stored 1h rows). */
async function closingRoutes(client: ClickHouseClient, hour: number): Promise<Map<string, string>> {
  const held = await heldKeys(client, '1h', hour, hour + 3_600)
  return new Map([...held].map(([k, route]) => [k.split(':').slice(0, 2).join(':'), route]))
}

const rowKey = (r: { asset_lo: number; asset_hi: number; interval_start: string }) =>
  `${r.asset_lo}:${r.asset_hi}:${chTimestampSeconds(r.interval_start)}`

/**
 * Publishes one window of one table: its recomputed rows and an is_deleted row for
 * every key the window held that the recomputation no longer has — one insert.
 */
async function publishWindow(
  client: ClickHouseClient, iv: StoredInterval, from: number, to: number, rows: readonly PairRouteRow[], computedAt: string,
): Promise<number> {
  const held = await heldKeys(client, iv, from, to)
  const now = new Set(rows.map(rowKey))
  const values: Array<Record<string, unknown>> = rows.map(({ iv: _iv, ...r }) => ({ ...r, is_deleted: 0 }))
  for (const k of held.keys()) {
    if (now.has(k)) continue
    const [lo, hi, t] = k.split(':').map(Number) as [number, number, number]
    values.push({
      asset_lo: lo, asset_hi: hi, interval_start: chTimestamp(t), open: '0', high: '0', low: '0', close: '0', route: '', routes: 0,
      fee_ppm: 0, buckets: 0, complete: 0, first_block: 0, last_block: 0, computed_at: computedAt, is_deleted: 1,
    })
  }
  if (!values.length) return 0
  await client.insert({ table: PAIR_ROUTE_TABLES[iv], values, format: 'JSONEachRow' })
  return values.length
}

/**
 * Folds stale hours and publishes them (each hour, then each day it touched, then
 * the hour's derived watermark). Exported for the history refold, which runs hours
 * in parallel through this same function.
 */
export async function foldPairRouteHours(client: ClickHouseClient, hours: readonly PairRouteStaleHour[], computedAtSec = Math.floor(Date.now() / 1000)): Promise<number> {
  if (!hours.length) return 0
  const computedAt = chTimestamp(computedAtSec)
  const shared = await pairRouteShared(client, hours.map(h => h.bucket))
  const decimals = (id: number) => assetDescriptor(id).decimals
  const days = new Set<number>()
  const inRun = new Set(hours.map(h => chTimestampSeconds(h.bucket)))
  let written = 0
  for (const h of hours) {
    const hour = chTimestampSeconds(h.bucket)
    const pricedHour = shared.priced.get(h.bucket)
    let rows: PairRouteRow[] = []
    let lastBlock = 0, lastTs = 0
    if (pricedHour?.ids.length) {
      const inputs = await loadFoldHourInputs(client, { hour, minb: Number(h.minb), maxb: Number(h.maxb) }, {
        priced: pricedHour.ids, usd: pricedHour.usd, decimals, reservePairs: shared.reservePairs, computedAt,
        v3: Number(h.maxb) >= shared.v3From,
      })
      // The hour starts on the routes the previous hour closed on, so a route held
      // by the switch margin carries across the hour boundary as it does across buckets.
      const out = foldHour({ ...inputs, seed: await closingRoutes(client, hour - 3_600) })
      rows = out.rows
      lastBlock = out.lastBlock
      lastTs = out.lastTs
    } else {
      // No candle that hour: nothing to route, but the hour is still folded.
      const res = await client.query({ query: pairRouteBlocksSql(), query_params: { b0: Number(h.minb), b1: Number(h.maxb) }, format: 'JSONEachRow' })
      const blocks = await res.json<{ b: number; t: number }>()
      const last = blocks[blocks.length - 1]
      lastBlock = Number(last?.b ?? 0)
      lastTs = Number(last?.t ?? 0)
    }
    written += await publishWindow(client, '5min', hour, hour + 3_600, rows.filter(r => r.iv === '5min'), computedAt)
    const before = await closingRoutes(client, hour)
    written += await publishWindow(client, '1h', hour, hour + 3_600, rows.filter(r => r.iv === '1h'), computedAt)
    // The next hour started on this hour's closing routes: when they changed, it is
    // stale (unless this run folds it next). The cascade stops at the first hour
    // whose closing routes come out the same.
    const after = new Map(rows.filter(r => r.iv === '1h').map(r => [`${r.asset_lo}:${r.asset_hi}`, r.route]))
    if (!inRun.has(hour + 3_600) && !sameRoutes(before, after)) await markPairRouteHourStale(client, hour + 3_600)
    await client.insert({
      table: PAIR_ROUTE_WATERMARKS_TABLE,
      values: [{
        hour: h.bucket, src_ingest: chTimestamp(0), minb: 4_294_967_295, maxb: 0, v3_ingest: chTimestamp(0),
        der_computed: computedAt, der_last_block: lastBlock, der_last_ts: chTimestamp(lastTs), der_rule: [computedAt, h.fingerprint],
      }],
      format: 'JSONEachRow',
    })
    days.add(Math.floor(hour / 86_400) * 86_400)
  }
  for (const day of days) {
    const hoursRes = await client.query({
      query: `SELECT uniqExact(hour) AS n FROM ${PAIR_ROUTE_WATERMARKS_TABLE} WHERE hour >= {day:DateTime} AND hour < {day:DateTime} + INTERVAL 1 DAY AND maxb > 0`,
      query_params: { day: chTimestamp(day) },
      format: 'JSONEachRow',
    })
    const dayHours = Number((await hoursRes.json<{ n: string }>())[0]?.n ?? 0)
    const res = await client.query({ query: pairRouteDailyRowsSql(), query_params: { from: chTimestamp(day), to: chTimestamp(day + 86_400), hours: dayHours }, format: 'JSONEachRow' })
    const daily = (await res.json<Record<string, string | number>>()).map(r => ({
      iv: '1d' as const, asset_lo: Number(r.asset_lo), asset_hi: Number(r.asset_hi), interval_start: String(r.d_start),
      open: String(r.d_open), high: String(r.d_high), low: String(r.d_low), close: String(r.d_close),
      route: String(r.d_route), routes: Number(r.d_routes), fee_ppm: Number(r.d_fee), buckets: Number(r.d_buckets),
      complete: Number(r.d_complete), first_block: Number(r.d_first), last_block: Number(r.d_last), computed_at: computedAt,
    }))
    written += await publishWindow(client, '1d', day, day + 86_400, daily, computedAt)
  }
  return written
}

const sameRoutes = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

/** Re-marks an already folded hour (its seed changed): a newer derived rule stamp with fingerprint 0. */
async function markPairRouteHourStale(client: ClickHouseClient, hour: number): Promise<void> {
  const res = await client.query({
    query: `SELECT max(der_computed) > toDateTime(0) AS folded FROM ${PAIR_ROUTE_WATERMARKS_TABLE} WHERE hour = {hour:DateTime}`,
    query_params: { hour: chTimestamp(hour) },
    format: 'JSONEachRow',
  })
  if (!Number((await res.json<{ folded: number }>())[0]?.folded ?? 0)) return
  pairRouteCascadeMarks++
  await client.insert({
    table: PAIR_ROUTE_WATERMARKS_TABLE,
    values: [{ hour: chTimestamp(hour), src_ingest: chTimestamp(0), minb: 4_294_967_295, maxb: 0, v3_ingest: chTimestamp(0), der_rule: [chTimestamp(Math.floor(Date.now() / 1000)), '0'] }],
    format: 'JSONEachRow',
  })
}

/** Hours re-marked by a changed seed since the process started (a diagnostic the cycle logs). */
export let pairRouteCascadeMarks = 0

export async function runPairRouteOhlc(client: ClickHouseClient, hoursPerCycle = PAIR_ROUTE_HOURS_PER_CYCLE): Promise<DerivationResult> {
  const model = 'pair_route_ohlc'
  if (!allExplorerAssets().length) {
    console.log(`[derivations] ${model} skipped: asset registry empty`)
    return { model, rows: 0 }
  }
  // computed_at is the instant the cycle read the watermarks, so a snapshot
  // ingested while the cycle runs re-marks its hour.
  const computedAtSec = Math.floor(Date.now() / 1000)
  const res = await client.query({ query: pairRouteStaleHoursSql(), format: 'JSONEachRow' })
  const stale = await res.json<PairRouteStaleHour>()
  if (!stale.length) return { model, rows: 0 }
  const slice = [...stale].sort((a, b) => b.bucket.localeCompare(a.bucket)).slice(0, hoursPerCycle)
  // Oldest first within the slice, so a day's hours are folded before it is re-aggregated.
  slice.sort((a, b) => a.bucket.localeCompare(b.bucket))
  const marksBefore = pairRouteCascadeMarks
  const rows = await foldPairRouteHours(client, slice, computedAtSec)
  if (pairRouteCascadeMarks > marksBefore) console.log(`[derivations] ${model}: ${pairRouteCascadeMarks - marksBefore} next hour(s) re-marked by a changed closing route`)
  return { model, rows }
}
