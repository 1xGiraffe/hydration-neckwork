// Idempotent, range-aware recompute jobs for the read models that a plain
// materialized view cannot express (they need cross-row netting, joins,
// valuation or a stateful lifecycle walk). The runner (derivations/runner.ts)
// calls each every cycle; every function here is safe to call repeatedly.
//
//   - account_trade_volume               partition-diff incremental (no tracking table)
//   - pool_swap_hourly                   partition-diff incremental (no tracking table)
//   - omnipool_position_owner_intervals  bounded full recompute, atomic staging swap
//   - xyk_farm_principal_intervals       bounded full recompute, atomic staging swap
//   - xyk_lp_total_shares_history        bounded full recompute, atomic staging swap
//   - revenue_events                     partition-diff incremental (MV-fed watermark index)
//   - account_revenue                    partition-diff incremental, keyed on revenue_events
//
// The three reconstructions write their full result into a `<table>_staging` twin
// and EXCHANGE it with the live table (see atomicFullReplace below) — the live
// table is always exactly the latest full run, with no stale rows left behind by
// a shifted ReplacingMergeTree key and no unbounded run_id growth. account_trade_volume
// rebuilds stale month-partitions in its own `_staging` twin and publishes each via
// atomic REPLACE PARTITION, and pool_swap_hourly does the same per month. Both
// the live tables and their staging twins are declared in clickhouse/schema
// (001_tables.sql, plus 006_public.sql for pool_swap_hourly) — nothing here
// creates a table or writes the (retired) lp_history_model_coverage gate rows.

import type { ClickHouseClient } from '../db/client.ts'
import { buildPartitionInsertSql } from '../services/accountTradeVolume.ts'
import { allExplorerAssets } from '../services/explorerAssets.ts'
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
// The three reconstruction jobs below (omnipool owner intervals, xyk farm
// intervals, xyk total shares) each recompute their whole read model from
// scratch every run. They used to append rows with a fresh run_id, relying on
// ReplacingMergeTree(run_id) + FINAL to collapse old rows on their stable
// business key. That breaks under out-of-order backward backfill: a corrected
// event can shift a row's `valid_from_block`/`valid_from_event`, which is part
// of the ORDER BY key, so the new row lands at a *different* key than the old
// one — FINAL has no key collision to collapse, and the stale row lingers
// forever (plus run_id rows accumulate without bound).
//
// Instead, write the full recompute into a `<table>_staging` twin (declared next
// to its parent in clickhouse/schema — 001_tables.sql for these three,
// 006_public.sql for pool_swap_hourly) and EXCHANGE it with the
// live table — a single atomic rename swap with no reader-visible gap. The live
// table is then always exactly the latest full run: no stale keys, no unbounded
// run_id growth. Truncate staging both before writing (clean slate if a prior
// run crashed mid-way) and after the swap (drop the now-superseded old data
// promptly rather than let it double the table's disk footprint until the next
// run).
async function atomicFullReplace(
  client: ClickHouseClient,
  liveTable: string,
  write: (stagingTable: string) => Promise<void>,
): Promise<void> {
  const stagingTable = `${liveTable}_staging`
  if (await stagingBusy(client, stagingTable)) {
    console.log(`[derivations] ${liveTable} skipped: ${stagingTable} busy in another process`)
    return
  }
  await client.command({ query: `TRUNCATE TABLE ${stagingTable}` })
  await write(stagingTable)
  await client.command({ query: `EXCHANGE TABLES ${liveTable} AND ${stagingTable}` })
  await client.command({ query: `TRUNCATE TABLE ${stagingTable}` })
}

// ───────────────────────── account_trade_volume ─────────────────────────
// Per-account NET trade volume: routed/DCA trades collapsed to their net
// input/output so intermediate routing hops are not double-counted. The netting
// is a per-trade cross-row aggregation with a block-time ohlc valuation, so it
// cannot be a plain per-row MV. Whole CH month-partitions are rebuilt in a
// staging twin and published atomically (REPLACE PARTITION), so re-runs are
// idempotent and readers never observe a missing month. The netting/valuation
// SQL and the swap-row filter live in services/accountTradeVolume.ts (single
// source of truth, imported above) — this module only decides which partitions
// to rebuild and how they are published.

// Ingest-time incremental partition selection, gated on price coverage.
//
// A DISTINCT-block / row COUNT comparison is wrong here: derived rows are a
// filtered SUBSET of source blocks — the netting SELECT drops unpriced, net-zero
// (HAVING volume_usd > 0) and non-64hex-account swaps — so a partition's source
// block count is (almost) always > its derived block count. Counts therefore
// never match and every partition would rebuild every cycle.
//
// Instead we compare ingest-time watermarks. A month-partition is a rebuild
// candidate when:
//   - it has NO derived rows yet (LEFT JOIN miss), OR
//   - the newest raw swap row (max ingested_at) is newer than the newest derived
//     row (max computed_at) in that partition.
// This is subset-safe (watermarks don't depend on which rows survive the filter)
// and correct under out-of-order backward backfill: freshly backfilled raw rows
// carry a newer ingested_at than the partition's derived computed_at, re-triggering
// it; steady-state partitions (no new/rewritten raw) have max ingested_at <=
// max computed_at and are skipped.
//
// Price-coverage gate: the valuation depends on ohlc prices, which the main
// (price) pipeline writes on its own schedule — behind raw on a fresh database
// and during backward backfill. Computing a partition before its prices exist
// would bake in dropped (unpriced → HAVING) trades, and no later signal would
// re-mark it stale. So a candidate is only returned once the priced range
// covers it: min(blocks) at-or-below the partition's first block AND max(blocks)
// at-or-past the partition's last source swap block. Price backfill descends
// contiguously (supervisor), so coverage is monotone and each partition
// computes exactly once it is priceable — and an empty blocks table (brand-new
// DB) yields no candidates at all.
//
// The source watermarks come from price_data.swap_source_partition_watermarks
// (clickhouse/schema), an MV over the same swap-row filter. Asking raw_events
// directly meant a full-table aggregate every cycle: the derived partition key
// is toYYYYMM(toDateTime(block_height * 12)) — a synthetic block-space clock, not
// the chain's block time, identical at all five sites and not to be re-pinned at a
// block-time change (see clickhouse/schema/001_tables.sql above
// account_trade_volume) — which ClickHouse cannot invert into a primary-key range, and raw_events is partitioned on real
// block_timestamp, so neither form of pruning applied. max() is idempotent under
// replay, so the MV holds the same watermarks in ~50 rows. Dropping raw rows
// would leave a watermark high rather than low, which re-marks a partition stale
// rather than hiding staleness.
export function stalePartitionsSql(): string {
  return `
    SELECT toString(src.p) AS p, toString(src.src_ingest) AS src_ingest, toString(src.src_max_ts) AS src_max_ts
    FROM (
      SELECT p,
             max(src_ingest) AS src_ingest,
             max(src_maxb) AS src_maxb,
             max(src_max_ts) AS src_max_ts
      FROM price_data.swap_source_partition_watermarks
      GROUP BY p
    ) AS src
    LEFT JOIN (
      -- Synthetic block-space partition clock (the 12 is not the chain's block
      -- time); this expression and the intDiv(..., 12) inverse below must stay in
      -- step with account_trade_volume's PARTITION BY.
      SELECT toYYYYMM(toDateTime(block_height * 12)) AS p, max(computed_at) AS der_computed
      FROM price_data.account_trade_volume
      GROUP BY p
    ) AS der ON src.p = der.p
    CROSS JOIN (
      SELECT min(block_height) AS priced_from, max(block_height) AS priced_to
      FROM price_data.blocks
    ) AS pc
    -- ClickHouse LEFT JOINs use type defaults unless join_use_nulls=1; this
    -- client deliberately leaves the default in place. A missing DateTime is
    -- therefore epoch, not NULL. Testing IS NULL here silently skipped every
    -- source partition that had never produced a derived row.
    WHERE (der.der_computed = toDateTime(0) OR src.src_ingest > der.der_computed)
      AND pc.priced_from <= intDiv(toUnixTimestamp(parseDateTimeBestEffort(concat(toString(src.p), '01'))), 12)
      AND pc.priced_to >= src.src_maxb
    ORDER BY src.p`
}

// A partition whose valuation legitimately nets to nothing writes zero rows, so
// the derived side never gets a computed_at and the LEFT JOIN miss marks it stale
// forever — three early synthetic partitions were rebuilt on every cycle despite
// writing nothing. Remember the source watermark each rebuild consumed
// (in memory, not a completion-marker table) and skip a candidate whose source has
// not advanced since. A restart costs one extra pass per such partition, not one
// per cycle; a backfilled row raises src_ingest and re-marks it stale, so this
// stays correct under backward backfill.
const rebuiltSourceWatermark = new Map<string, string>()

export function resetRebuiltSourceWatermarkForTest(): void {
  rebuiltSourceWatermark.clear()
}

// Candidates whose source actually moved since the last rebuild this process did.
export function partitionsNeedingRebuild(
  candidates: { p: string; src_ingest: string }[],
  lastRebuilt: ReadonlyMap<string, string>,
): string[] {
  return candidates.filter(c => lastRebuilt.get(c.p) !== c.src_ingest).map(c => c.p)
}

interface StalePartition { p: string; src_ingest: string; src_max_ts: string }

// src is ORDER BY p ascending → rebuild oldest partition first.
async function stalePartitions(client: ClickHouseClient): Promise<StalePartition[]> {
  const res = await client.query({ query: stalePartitionsSql(), format: 'JSONEachRow' })
  return res.json<StalePartition>()
}

// Recompute only the partitions whose source/derived coverage diverges. The
// netting SQL bakes in per-asset decimal factors and the price-alias universe,
// so an empty registry (fresh DB before assets are indexed, or a failed
// loadExplorerAssets — the runner also skips this job on load failure) must
// not bake wrongly-valued partitions: bail out instead.
//
// Publication is atomic per partition: the rebuild lands in the `_staging`
// twin first, then REPLACE PARTITION swaps it into the live table in one
// operation — readers see the old partition until the swap, never a gap
// (the old DROP PARTITION + INSERT exposed an empty month mid-rebuild).
export async function runAccountTradeVolume(client: ClickHouseClient): Promise<DerivationResult> {
  const model = 'account_trade_volume'
  if (!allExplorerAssets().length) {
    console.log('[derivations] account_trade_volume skipped: asset registry empty')
    return { model, rows: 0 }
  }
  const live = 'price_data.account_trade_volume'
  const staging = `${live}_staging`
  const candidates = await stalePartitions(client)
  const stale = partitionsNeedingRebuild(candidates, rebuiltSourceWatermark)
  if (!stale.length) return { model, rows: 0 }
  if (await stagingBusy(client, staging)) {
    console.log(`[derivations] ${model} skipped: ${staging} busy in another process`)
    return { model, rows: 0 }
  }
  const ingestByPartition = new Map(candidates.map(c => [c.p, c.src_ingest]))
  // The partition's last swap block time, straight off the watermark projection.
  // It bounds the valuation's ohlc right side from above — see
  // buildPartitionInsertSql.
  const maxBlockTimeByPartition = new Map(candidates.map(c => [c.p, c.src_max_ts]))
  for (const p of stale) {
    // Clean slate in staging for this partition (a prior crashed run may have
    // left rows); DROP PARTITION on an absent partition is a no-op.
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    await client.command({ query: buildPartitionInsertSql(p, staging, maxBlockTimeByPartition.get(p)) })
    await client.command({ query: `ALTER TABLE ${live} REPLACE PARTITION ${p} FROM ${staging}` })
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    // Only after the swap succeeded: a failed rebuild must stay a candidate.
    const consumed = ingestByPartition.get(p)
    if (consumed != null) rebuiltSourceWatermark.set(p, consumed)
  }
  const res = await client.query({
    // Synthetic block-space partition clock, same constant as the PARTITION BY.
    query: `SELECT count() AS n FROM price_data.account_trade_volume
            WHERE toYYYYMM(toDateTime(block_height * 12)) IN (${stale.join(',')})`,
    format: 'JSONEachRow',
  })
  return { model, rows: Number((await res.json<{ n: string }>())[0]?.n ?? 0) }
}

// ───────────────────────── pool_swap_hourly ─────────────────────────
// pool_swap_legs folded to one row per (venue, pool_key, asset_id, leg_kind,
// fee_dest, fee_recipient, hour) — the pre-aggregate the leg-SUM consumers read
// instead of scanning the 65 M-leg projection. Its declaration
// (clickhouse/schema/006_public.sql) carries the full argument for why this is a
// derivations job and not a materialized view; the short form is that the source
// is a ReplacingMergeTree, so the legs must be DEDUPLICATED BEFORE they are
// summed, and an insert-trigger MV cannot do a cross-row deduplication.
//
// Same partition-diff shape as account_trade_volume above, minus its
// price-coverage gate: this model stores RAW integer amounts and no valuation, so
// it does not depend on the price pipeline and a partition is computable the
// moment its legs are indexed.

const POOL_SWAP_HOURLY_TABLE = 'price_data.pool_swap_hourly'

// The hour the newest indexed leg sits in. Everything at or above it is still
// filling, so the job never writes it: every row in the model is a CLOSED hour,
// which is what lets a reader split "aggregate below, raw legs above" at
// max(hour) + 1 hour without ever double-counting or dropping an hour.
//
// This comes from the MV-fed hourly watermark index rather than re-reading the
// 65 M-leg source. The watermark table is populated by the same pool_swap_legs
// insert and max() is replay-idempotent.
const POOL_SWAP_OPEN_HOUR = `(SELECT max(hour) FROM price_data.pool_swap_hour_watermarks)`

// Keep at most one day of closed legs on the raw tail. Rebuilding the live
// calendar month for every newly closed hour would scan the same month 24 times
// a day; waiting 24 hours bounds reader cost while reducing rebuild work 24x.
// A replay/backfill into an hour already below the published cut still marks the
// partition stale immediately through the covered-hour watermark below.
export const POOL_SWAP_HOURLY_REFRESH_HOURS = 24

// Ingest-time partition diff over the small hourly watermark index. Three things
// can make a month stale:
//   1. it has never been folded;
//   2. a replay/backfill changed an hour already at or below its published cut;
//   3. its raw tail reached 24 hours, or the calendar month closed.
//
// Appending an ordinary live swap above the cut does NOT rebuild the month: the
// reader already takes that tail from raw legs. This avoids both the old 68 M-row
// staleness scan every ten minutes and a same-month rebuild on every live insert.
export function poolSwapHourlyStalePartitionsSql(): string {
  return `
    WITH ${POOL_SWAP_OPEN_HOUR} AS open_hour
    SELECT toString(toYYYYMM(src.hour)) AS p, toString(max(src.src_ingest)) AS src_ingest
    FROM price_data.pool_swap_hour_watermarks AS src
    LEFT JOIN (
      SELECT toYYYYMM(hour) AS p, max(hour) AS der_max_hour, max(computed_at) AS der_computed
      FROM ${POOL_SWAP_HOURLY_TABLE}
      GROUP BY p
    ) AS der ON toYYYYMM(src.hour) = der.p
    WHERE src.hour < open_hour
    GROUP BY toYYYYMM(src.hour), der.der_max_hour, der.der_computed, open_hour
    -- Same non-nullable LEFT JOIN rule as stalePartitionsSql above: an absent
    -- derived month carries the DateTime epoch, never NULL.
    HAVING der.der_computed = toDateTime(0)
      OR maxIf(src.src_ingest, src.hour <= der.der_max_hour) > der.der_computed
      OR (
        max(src.hour) > der.der_max_hour
        AND (
          toYYYYMM(src.hour) < toYYYYMM(open_hour)
          OR dateDiff('hour', der.der_max_hour, max(src.hour)) >= ${POOL_SWAP_HOURLY_REFRESH_HOURS}
        )
      )
    ORDER BY toYYYYMM(src.hour)`
}

// One month-partition's fold, into the staging twin.
//
// The inner GROUP BY is pool_swap_legs' own ORDER BY — its ReplacingMergeTree
// replacement key — so a replayed range contributes each leg exactly once, and
// because the aggregation runs in the table's stored order it streams rather than
// building a hash table over the month (the same optimize_aggregation_in_order
// property the DefiLlama daily fold relies on). Summing first and deduplicating
// afterwards would double a replayed hour.
//
// The outer sum is Decimal256 and the stored value a String, matching
// pool_swap_legs' own convention: an hour of 18-decimal legs passes 2^64 routinely
// and no float may touch it. leg_count counts DEDUPLICATED legs, so a row's
// arithmetic is checkable against raw.
export function poolSwapHourlyInsertSql(partition: string, target: string): string {
  return `INSERT INTO ${target}
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
      WHERE toYYYYMM(block_timestamp) = ${partition}
        AND block_timestamp < ${POOL_SWAP_OPEN_HOUR}
      GROUP BY venue, pool_key, block_height, event_index, leg_kind, leg_index
    )
    GROUP BY venue, pool_key, asset_id, leg_kind, fee_dest, fee_recipient, hour
    SETTINGS optimize_aggregation_in_order = 1`
}

// Same purpose as rebuiltSourceWatermark above: a partition whose every leg is
// still inside the open hour writes no rows, so the LEFT JOIN miss would re-mark
// it stale on every cycle forever. Remembering the source watermark each rebuild
// consumed costs one extra pass after a restart instead of one per cycle.
const poolSwapHourlyRebuilt = new Map<string, string>()

export function resetPoolSwapHourlyWatermarkForTest(): void {
  poolSwapHourlyRebuilt.clear()
}

export async function runPoolSwapHourly(client: ClickHouseClient): Promise<DerivationResult> {
  const model = 'pool_swap_hourly'
  const live = POOL_SWAP_HOURLY_TABLE
  const staging = `${live}_staging`
  const res = await client.query({ query: poolSwapHourlyStalePartitionsSql(), format: 'JSONEachRow' })
  const candidates = await res.json<{ p: string; src_ingest: string }>()
  const stale = partitionsNeedingRebuild(candidates, poolSwapHourlyRebuilt)
  if (!stale.length) return { model, rows: 0 }
  if (await stagingBusy(client, staging)) {
    console.log(`[derivations] ${model} skipped: ${staging} busy in another process`)
    return { model, rows: 0 }
  }
  const ingestByPartition = new Map(candidates.map(c => [c.p, c.src_ingest]))
  // Oldest partition first (the staleness query orders by p), so partial coverage
  // is always a contiguous PREFIX of the era. That is what makes the readers' cut
  // at max(hour) + 1 hour safe: everything above the cut comes from raw legs, and
  // there is never a hole below it.
  for (const p of stale) {
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    await client.command({ query: poolSwapHourlyInsertSql(p, staging) })
    await client.command({ query: `ALTER TABLE ${live} REPLACE PARTITION ${p} FROM ${staging}` })
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    const consumed = ingestByPartition.get(p)
    if (consumed != null) poolSwapHourlyRebuilt.set(p, consumed)
  }
  const counted = await client.query({
    query: `SELECT count() AS n FROM ${live} WHERE toYYYYMM(hour) IN (${stale.join(',')})`,
    format: 'JSONEachRow',
  })
  return { model, rows: Number((await counted.json<{ n: string }>())[0]?.n ?? 0) }
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
    `
}

export async function runOmnipoolOwnerIntervals(client: ClickHouseClient): Promise<DerivationResult> {
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

  await atomicFullReplace(client, 'price_data.omnipool_position_owner_intervals', async stagingTable => {
    const BATCH = 50_000
    for (let i = 0; i < intervalRows.length; i += BATCH) {
      await client.insert({
        table: stagingTable,
        values: intervalRows.slice(i, i + BATCH),
        format: 'JSONEachRow',
      })
    }
  })
  return { model: 'omnipool_owner_intervals', rows: intervalRows.length }
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
      ORDER BY block_height, event_index`
}

export async function runXykFarmIntervals(client: ClickHouseClient): Promise<DerivationResult> {
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

  await atomicFullReplace(client, 'price_data.xyk_farm_principal_intervals', async stagingTable => {
    const BATCH = 50_000
    for (let i = 0; i < intervalRows.length; i += BATCH) {
      await client.insert({
        table: stagingTable,
        values: intervalRows.slice(i, i + BATCH),
        format: 'JSONEachRow',
      })
    }
  })
  return { model: 'xyk_farm_intervals', rows: intervalRows.length }
}

// ─────────────────── xyk_lp_total_shares_history ───────────────────
// Reconstructs the total outstanding supply of each XYK LP (shareToken) as a step
// function over block height, from raw_balance_observations (approach A, no RPC):
// token issuance == sum of all holder balances, and substrate Tokens balances are
// captured from genesis, so cumulative net balance deltas reproduce issuance
// exactly. XYK.LiquidityAdded omits the minted-share amount, so events alone
// cannot do this. The result is swapped into the live table atomically (see
// atomicFullReplace) rather than appended per (lp_asset_id, block).

// Single source of truth for the live table name: runXykTotalShares passes
// this to atomicFullReplace as `liveTable`, and xykTotalSharesInsertSql derives
// its staging INSERT target from the same constant. Keeping these structurally
// tied (rather than two hand-matched literals) means a future rename can't
// silently orphan the INSERT from the table atomicFullReplace actually swaps.
const XYK_TOTAL_SHARES_TABLE = 'price_data.xyk_lp_total_shares_history'

// First asset id the Hydration asset registry mints sequentially. XYK's
// create_pool registers its share token through that counter, so every share
// token — past and future — sits at or above this floor, while the
// governance-registered assets that dominate the observation table sit below it.
// That makes `asset_id >= floor` a join-free predicate the
// xyk_lp_share_observations MV can apply per inserted row (see
// clickhouse/schema/003_materialized_views.sql) and still be a provable superset
// of the pool set, which the reconstruction below re-filters to exactly.
export const XYK_SHARE_ASSET_ID_FLOOR = 1_000_000

// The pool set. price_data.xyk_pool_registry is the MV over XYK.PoolCreated and
// decodes shareToken with the same expression this used to run inline, so the two
// sets are equal by construction — but the registry is 729 rows against a 302M-row
// raw_events scan the event-name index barely prunes.
const XYK_SHARE_TOKENS_SQL = 'SELECT DISTINCT lp_asset_id AS lp FROM price_data.xyk_pool_registry FINAL'

// Guard on the superset claim. A share token below the floor would simply never
// reach the projection, and its pool would silently vanish from the model, so
// the job checks the real pool set against the floor every run and refuses to
// publish rather than publish a hole.
export function xykShareTokensBelowFloorSql(): string {
  return `SELECT count() AS n FROM (${XYK_SHARE_TOKENS_SQL}) WHERE lp < ${XYK_SHARE_ASSET_ID_FLOOR}`
}

// The single INSERT…SELECT for the total-shares reconstruction, keyed by run id.
// Targets the staging twin (never the live table directly) so the run's
// result becomes visible only via the atomic EXCHANGE in runXykTotalShares.
// Exported so its shape can be unit-tested without a live ClickHouse.
export function xykTotalSharesInsertSql(runId: number): string {
  const stepSelect = `
      WITH lps AS (
        ${XYK_SHARE_TOKENS_SQL}
      ),
      row_deltas AS (
        SELECT asset_id AS lp, block_height,
          toInt256(assumeNotNull(total)) - lagInFrame(toInt256(assumeNotNull(total)), 1, toInt256(0))
            OVER (PARTITION BY asset_id, account_id ORDER BY block_height, observation_id) AS delta
        FROM price_data.xyk_lp_share_observations FINAL
        WHERE asset_id IN (SELECT lp FROM lps)
      ),
      per_block AS (SELECT lp, block_height, sum(delta) AS bd FROM row_deltas GROUP BY lp, block_height)
      SELECT lp AS lp_asset_id, block_height,
        toString(sum(bd) OVER (PARTITION BY lp ORDER BY block_height ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS total_shares_raw
      FROM per_block`
  return `INSERT INTO ${XYK_TOTAL_SHARES_TABLE}_staging
        SELECT lp_asset_id, block_height, total_shares_raw, ${runId} AS run_id, now() AS ingested_at
        FROM (${stepSelect})`
}

export async function runXykTotalShares(client: ClickHouseClient): Promise<DerivationResult> {
  const runId = Date.now()
  const liveTable = XYK_TOTAL_SHARES_TABLE
  const guard = await client.query({ query: xykShareTokensBelowFloorSql(), format: 'JSONEachRow' })
  const below = Number((await guard.json<{ n: string }>())[0]?.n ?? 0)
  if (below > 0) {
    throw new Error(
      `${below} XYK share token(s) below asset id ${XYK_SHARE_ASSET_ID_FLOOR}: `
      + 'xyk_lp_share_observations cannot see them, so their pools would be missing from the model',
    )
  }
  // No memory carve-out: windowing 1.2M projected rows in their stored order
  // fits the long-op client's default cap, where the 244M-row scan and sort this
  // replaced needed 8 GB.
  await atomicFullReplace(client, liveTable, async () => {
    await client.command({ query: xykTotalSharesInsertSql(runId) })
  })
  const res = await client.query({
    query: `SELECT count() AS n FROM ${liveTable} WHERE run_id = ${runId}`,
    format: 'JSONEachRow',
  })
  return { model: 'xyk_total_shares', rows: Number((await res.json<{ n: string }>())[0]?.n ?? 0) }
}

// ───────────────────────── revenue_events ─────────────────────────
// One row per protocol-revenue event (clickhouse/schema/008_revenue.sql), from
// the shared per-stream definitions in services/revenueStreams.ts — the same
// definitions the explorer's live tail and the public fees API read, so the
// cold table and the raw tail can never disagree about what a stream means.
// This is a job rather than an MV for the same reasons account_trade_volume
// is: dedup-before-aggregation over ReplacingMergeTree sources, cross-row
// joins (the HSM arb semi-join, the liquidation transfer↔call match), and an
// event-time price valuation.
//
// Same partition-diff shape as account_trade_volume, with two twists:
//  * The 'debt' watermark kind cascades staleness FORWARD (a running max over
//    p' <= p): a backfilled debt-token delta or reserve-index row changes the
//    opening state of every later month, not just its own.
//  * Only CLOSED hours are written (block_timestamp below the newest source
//    hour), so readers split cold/tail at the table's own max hour + 1 h; the
//    live month is additionally rebuilt at most once per
//    REVENUE_REFRESH_SECONDS because the tail already serves its fresh edge.

import {
  REVENUE_STREAMS,
  buildRevenueEventRowsSql,
  hollarBorrowHourlyRows,
  type EventfulRevenueStream,
} from '../services/revenueStreams.ts'

const REVENUE_EVENTS_TABLE = 'price_data.revenue_events'

/** How long a live-month publication stays before the tail hands back to a rebuild. */
export const REVENUE_REFRESH_SECONDS = 3_600

/** Every eventful stream, in the order each partition inserts them. */
export const REVENUE_EVENT_STREAMS_INSERTED: readonly EventfulRevenueStream[]
  = REVENUE_STREAMS.filter((s): s is EventfulRevenueStream => s !== 'hollar_borrow')

export function revenueStalePartitionsSql(): string {
  return `
    SELECT toString(src.p) AS p, toString(src.eff_ingest) AS src_ingest, toString(src.src_max_ts) AS src_max_ts
    FROM (
      SELECT p,
             -- 'events' staleness is per-month; 'debt' staleness cascades
             -- forward, because those sources feed cumulative opening state.
             greatest(ev_ingest,
                      max(debt_ingest) OVER (ORDER BY p ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS eff_ingest,
             src_maxb, src_max_ts, src_min_ts
      FROM (
        SELECT p,
               maxIf(src_ingest, kind = 'events') AS ev_ingest,
               maxIf(src_ingest, kind = 'debt') AS debt_ingest,
               max(src_maxb) AS src_maxb,
               max(src_max_ts) AS src_max_ts,
               min(src_min_ts) AS src_min_ts
        FROM price_data.revenue_source_partition_watermarks
        GROUP BY p
      )
    ) AS src
    LEFT JOIN (
      SELECT toYYYYMM(block_timestamp) AS p, max(computed_at) AS der_computed
      FROM ${REVENUE_EVENTS_TABLE}
      GROUP BY p
    ) AS der ON src.p = der.p
    CROSS JOIN (
      SELECT min(block_timestamp) AS priced_from, max(block_timestamp) AS priced_to
      FROM price_data.blocks
    ) AS pc
    -- Same non-nullable LEFT JOIN rule as stalePartitionsSql above: an absent
    -- derived month carries the DateTime epoch, never NULL.
    WHERE (der.der_computed = toDateTime(0) OR src.eff_ingest > der.der_computed)
      -- The live month's fresh edge is already served from raw by every
      -- reader, so rebuilding it on each new event would only churn; history
      -- and first builds are never delayed.
      AND (der.der_computed = toDateTime(0)
           OR src.p != toYYYYMM(now())
           OR der.der_computed < now() - INTERVAL ${REVENUE_REFRESH_SECONDS} SECOND)
      -- Price-coverage gate, same argument as account_trade_volume: computing
      -- a partition before its candles exist would bake unpriced (0-USD) rows
      -- with no later signal to re-mark it.
      AND pc.priced_from <= src.src_min_ts
      AND pc.priced_to >= src.src_max_ts
    ORDER BY src.p`
}

/** One stream's month insert into the staging twin, bounded to closed hours. */
export function revenueEventsInsertSql(
  stream: EventfulRevenueStream,
  partition: string,
  cutLiteral: string,
  target = `${REVENUE_EVENTS_TABLE}_staging`,
): string {
  const extra = `toYYYYMM(block_timestamp) = ${partition} AND block_timestamp < toDateTime('${cutLiteral}')`
  return `INSERT INTO ${target} (stream, block_height, block_timestamp, event_index, leg_index, dest, account, asset_id, amount, amount_usd)
${buildRevenueEventRowsSql(stream, extra)}`
}

const revenueEventsRebuilt = new Map<string, string>()

export function resetRevenueEventsWatermarkForTest(): void {
  revenueEventsRebuilt.clear()
}

interface RevenueStalePartition { p: string; src_ingest: string; src_max_ts: string }

function chTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
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

export async function runRevenueEvents(client: ClickHouseClient): Promise<DerivationResult> {
  const model = 'revenue_events'
  if (!allExplorerAssets().length) {
    console.log(`[derivations] ${model} skipped: asset registry empty`)
    return { model, rows: 0 }
  }
  const live = REVENUE_EVENTS_TABLE
  const staging = `${live}_staging`
  const res = await client.query({ query: revenueStalePartitionsSql(), format: 'JSONEachRow' })
  const candidates = await res.json<RevenueStalePartition>()
  const stale = partitionsNeedingRebuild(candidates, revenueEventsRebuilt)
  if (!stale.length) return { model, rows: 0 }
  if (await stagingBusy(client, staging)) {
    console.log(`[derivations] ${model} skipped: ${staging} busy in another process`)
    return { model, rows: 0 }
  }

  // The closed-hour cut comes from the GLOBAL newest source row, not from the
  // candidate's own watermark: an old backfilled month must republish its whole
  // range, and only the live edge has an open hour to exclude.
  const cutRes = await client.query({
    query: 'SELECT toString(toStartOfHour(max(src_max_ts))) AS cut FROM price_data.revenue_source_partition_watermarks',
    format: 'JSONEachRow',
  })
  const cutLiteral = (await cutRes.json<{ cut: string }>())[0]?.cut
  if (!cutLiteral) return { model, rows: 0 }
  const cutSeconds = chTimestampSeconds(cutLiteral)

  const ingestByPartition = new Map(candidates.map(c => [c.p, c.src_ingest]))
  const built: string[] = []
  for (const p of stale) {
    const { startSeconds, endSeconds } = monthBounds(p)
    // Nothing in this month is a closed hour yet (a brand-new month); leave the
    // candidate unconsumed so the next cycle retries once hours close.
    if (cutSeconds <= startSeconds) continue
    const anchorSeconds = Math.min(cutSeconds, endSeconds)
    const anchor = chTimestamp(anchorSeconds)
    const hours = Math.ceil((anchorSeconds - startSeconds) / 3_600) + 2

    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    for (const stream of REVENUE_EVENT_STREAMS_INSERTED) {
      await client.command({
        query: revenueEventsInsertSql(stream, p, cutLiteral),
        query_params: { anchor, hours },
      })
    }
    // hollar_borrow accrues by index growth, so its hourly rows are computed in
    // TS (exact BigInt identity) and inserted like any other stream's rows. The
    // last bookable hour is one below the cut: the cut hour is still filling.
    const hollarRows = await hollarBorrowHourlyRows(client, startSeconds, Math.min(anchorSeconds, cutSeconds) - 3_600)
    if (hollarRows.length) {
      const byHour = new Map<number, number>()
      await client.insert({
        table: staging,
        values: hollarRows.map(row => {
          const legIndex = byHour.get(row.hour) ?? 0
          byHour.set(row.hour, legIndex + 1)
          return {
            stream: 'hollar_borrow',
            block_height: 0,
            block_timestamp: chTimestamp(row.hour),
            event_index: Math.floor(row.hour / 3_600),
            leg_index: legIndex,
            dest: '',
            account: '',
            asset_id: 222,
            amount: row.amountPlanck.toString(),
            amount_usd: usd1e12String(row.usd1e12),
          }
        }),
        format: 'JSONEachRow',
      })
    }
    await client.command({ query: `ALTER TABLE ${live} REPLACE PARTITION ${p} FROM ${staging}` })
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    const consumed = ingestByPartition.get(p)
    if (consumed != null) revenueEventsRebuilt.set(p, consumed)
    built.push(p)
  }
  if (!built.length) return { model, rows: 0 }
  const counted = await client.query({
    query: `SELECT count() AS n FROM ${live} WHERE toYYYYMM(block_timestamp) IN (${built.join(',')})`,
    format: 'JSONEachRow',
  })
  return { model, rows: Number((await counted.json<{ n: string }>())[0]?.n ?? 0) }
}

// ───────────────────────── account_revenue ─────────────────────────
// Per-account, per-stream protocol revenue by calendar month — the account
// grain behind the account/tag Revenue stats and the /accounts sort. Rebuilt
// per partition strictly AFTER revenue_events (its only upstream: staleness
// keys on revenue_events.computed_at, which already folds in the forward-
// cascading debt watermarks), so the two tables can never disagree for long.
//
// Eventful streams are a plain GROUP BY of the fresh revenue_events partition
// restricted to protocol revenue. The two borrow streams are attributed here:
// per-account planck interest from the Aave identity in
// services/borrowAttribution.ts weights a pro-rata split of the stream's OWN
// revenue_events USD total (hollar_borrow) or of each MintedToTreasury's
// valued amount over its inter-mint window (asset_reserve) — cumulative-floor
// exact, remainder on account = '', so per stream and month the account sums
// equal the protocol-revenue event sums to the last 1e-12 USD.

import {
  accountBorrowInterestSql,
  assetReserveMintsSql,
  distributeUsd1e12,
} from '../services/borrowAttribution.ts'
import { HOLLAR_RESERVE_ADDRESS, PROTOCOL_REVENUE_PREDICATE_SQL } from '../services/revenueStreams.ts'
import { scaledUsd } from '../services/valuation.ts'

const ACCOUNT_REVENUE_TABLE = 'price_data.account_revenue'

export function accountRevenueStalePartitionsSql(): string {
  return `
    SELECT toString(src.p) AS p, toString(src.src_ingest) AS src_ingest
    FROM (
      SELECT toYYYYMM(block_timestamp) AS p, max(computed_at) AS src_ingest
      FROM ${REVENUE_EVENTS_TABLE}
      GROUP BY p
    ) AS src
    LEFT JOIN (
      SELECT month AS p, max(computed_at) AS der_computed
      FROM ${ACCOUNT_REVENUE_TABLE}
      GROUP BY p
    ) AS der ON src.p = der.p
    -- Same non-nullable LEFT JOIN rule as stalePartitionsSql above.
    WHERE der.der_computed = toDateTime(0) OR src.src_ingest > der.der_computed
    ORDER BY src.p`
}

/**
 * The attributed eventful streams, straight off the fresh revenue_events
 * partition. No FINAL: a partition is always exactly one publication (REPLACE
 * PARTITION swaps it whole), and identities within one build are unique.
 */
export function accountRevenueEventfulInsertSql(partition: string, target = `${ACCOUNT_REVENUE_TABLE}_staging`): string {
  return `INSERT INTO ${target} (account, stream, month, revenue_usd)
SELECT account, stream, toUInt32(${partition}) AS month, sum(amount_usd) AS revenue_usd
FROM ${REVENUE_EVENTS_TABLE}
WHERE toYYYYMM(block_timestamp) = ${partition}
  AND stream NOT IN ('hollar_borrow', 'asset_reserve')
  AND ${PROTOCOL_REVENUE_PREDICATE_SQL}
GROUP BY account, stream`
}

const accountRevenueRebuilt = new Map<string, string>()

export function resetAccountRevenueWatermarkForTest(): void {
  accountRevenueRebuilt.clear()
}

interface WeightRow { account: string; interest: string }
interface MintRow { reserve: string; block_height: number; event_index: number; mint_ts: string; prev_ts: string }

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

export async function runAccountRevenue(client: ClickHouseClient): Promise<DerivationResult> {
  const model = 'account_revenue'
  const live = ACCOUNT_REVENUE_TABLE
  const staging = `${live}_staging`
  const res = await client.query({ query: accountRevenueStalePartitionsSql(), format: 'JSONEachRow' })
  const candidates = await res.json<{ p: string; src_ingest: string }>()
  const stale = partitionsNeedingRebuild(candidates, accountRevenueRebuilt)
  if (!stale.length) return { model, rows: 0 }
  if (await stagingBusy(client, staging)) {
    console.log(`[derivations] ${model} skipped: ${staging} busy in another process`)
    return { model, rows: 0 }
  }
  const ingestByPartition = new Map(candidates.map(c => [c.p, c.src_ingest]))

  for (const p of stale) {
    const { startSeconds, endSeconds } = monthBounds(p)
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    await client.command({ query: accountRevenueEventfulInsertSql(p) })

    // Borrow attribution rows, accumulated per (account, stream) then inserted
    // in one batch. All arithmetic BigInt at the 1e-12 USD scale.
    const attributed = new Map<string, bigint>()
    const key = (account: string, stream: string) => `${stream} ${account}`

    const hollarTotalRes = await client.query({
      query: `SELECT toString(sum(amount_usd)) AS total FROM ${REVENUE_EVENTS_TABLE}
              WHERE toYYYYMM(block_timestamp) = ${p} AND stream = 'hollar_borrow'`,
      format: 'JSONEachRow',
    })
    const hollarTotal = scaledUsd((await hollarTotalRes.json<{ total: string | null }>())[0]?.total ?? '0')
    if (hollarTotal > 0n) {
      const weights = await borrowWeights(client, HOLLAR_RESERVE_ADDRESS, startSeconds, endSeconds)
      for (const [account, usd] of distributeUsd1e12(hollarTotal, weights)) {
        const k = key(account, 'hollar_borrow')
        attributed.set(k, (attributed.get(k) ?? 0n) + usd)
      }
    }

    const mintUsdRes = await client.query({
      query: `SELECT block_height, event_index, toString(amount_usd) AS usd FROM ${REVENUE_EVENTS_TABLE}
              WHERE toYYYYMM(block_timestamp) = ${p} AND stream = 'asset_reserve'`,
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
        const weights = await borrowWeights(
          client, mint.reserve, chTimestampSeconds(mint.prev_ts), chTimestampSeconds(mint.mint_ts),
        )
        for (const [account, share] of distributeUsd1e12(usd, weights)) {
          const k = key(account, 'asset_reserve')
          attributed.set(k, (attributed.get(k) ?? 0n) + share)
        }
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

    await client.command({ query: `ALTER TABLE ${live} REPLACE PARTITION ${p} FROM ${staging}` })
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    const consumed = ingestByPartition.get(p)
    if (consumed != null) accountRevenueRebuilt.set(p, consumed)
  }
  const counted = await client.query({
    query: `SELECT count() AS n FROM ${live} WHERE month IN (${stale.join(',')})`,
    format: 'JSONEachRow',
  })
  return { model, rows: Number((await counted.json<{ n: string }>())[0]?.n ?? 0) }
}
