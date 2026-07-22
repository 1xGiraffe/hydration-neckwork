// Idempotent, range-aware recompute jobs for the six read models that a plain
// materialized view cannot express (they need cross-row netting or a stateful
// lifecycle walk). The runner (derivations/runner.ts) calls each every cycle;
// every function here is safe to call repeatedly.
//
//   - account_trade_volume               partition-diff incremental (no tracking table)
//   - omnipool_position_owner_intervals  bounded full recompute, atomic staging swap
//   - xyk_farm_principal_intervals       bounded full recompute, atomic staging swap
//   - xyk_lp_total_shares_history        bounded full recompute, atomic staging swap
//   - proxy_call_activity                bounded full recompute, atomic staging swap
//   - multisig_operation_activity        bounded full recompute, atomic staging swap
//
// The five reconstructions write their full result into a `<table>_staging` twin
// and EXCHANGE it with the live table (see atomicFullReplace below) — the live
// table is always exactly the latest full run, with no stale rows left behind by
// a shifted ReplacingMergeTree key and no unbounded run_id growth. account_trade_volume
// rebuilds stale month-partitions in its own `_staging` twin and publishes each via
// atomic REPLACE PARTITION. Target tables already exist in
// clickhouse/schema/001_tables.sql — nothing here creates tables (beyond the
// on-demand staging twins) or writes the (retired) lp_history_model_coverage gate rows.

import type { ClickHouseClient } from '../db/client.ts'
import {
  buildPartitionInsertSql,
  swapEventFilterSql,
} from '../services/accountTradeVolume.ts'
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
import {
  buildProxyCallRows,
  buildMultisigOperations,
  proxyChildAddress,
  type ProxyCallSource,
  type ExtrinsicCallRow,
  type MultisigLifecycleEvent,
  type MultisigCallInfo,
} from '../services/onBehalfActivity.ts'

export interface DerivationResult {
  model: string
  rows: number
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
// Instead, write the full recompute into a `<table>_staging` twin (same DDL,
// created on demand) and EXCHANGE it with the live table — a single atomic
// rename swap with no reader-visible gap. The live table is then always
// exactly the latest full run: no stale keys, no unbounded run_id growth.
// Truncate staging both before writing (clean slate if a prior run crashed
// mid-way) and after the swap (drop the now-superseded old data promptly
// rather than let it double the table's disk footprint until the next run).
async function atomicFullReplace(
  client: ClickHouseClient,
  liveTable: string,
  write: (stagingTable: string) => Promise<void>,
): Promise<void> {
  const stagingTable = `${liveTable}_staging`
  await client.command({ query: `CREATE TABLE IF NOT EXISTS ${stagingTable} AS ${liveTable}` })
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
// DB) yields no candidates at all. The swap-row filter comes from the service
// so it matches the exact source rows the netting consumes.
export function stalePartitionsSql(): string {
  return `
    SELECT toString(src.p) AS p
    FROM (
      SELECT toYYYYMM(toDateTime(block_height * 12)) AS p,
             max(ingested_at) AS src_ingest,
             max(block_height) AS src_maxb
      FROM price_data.raw_events
      WHERE ${swapEventFilterSql()}
      GROUP BY p
    ) AS src
    LEFT JOIN (
      SELECT toYYYYMM(toDateTime(block_height * 12)) AS p, max(computed_at) AS der_computed
      FROM price_data.account_trade_volume
      GROUP BY p
    ) AS der ON src.p = der.p
    CROSS JOIN (
      SELECT min(block_height) AS priced_from, max(block_height) AS priced_to
      FROM price_data.blocks
    ) AS pc
    WHERE (der.der_computed IS NULL OR src.src_ingest > der.der_computed)
      AND pc.priced_from <= intDiv(toUnixTimestamp(parseDateTimeBestEffort(concat(toString(src.p), '01'))), 12)
      AND pc.priced_to >= src.src_maxb
    ORDER BY src.p`
}

// src is ORDER BY p ascending → rebuild oldest partition first.
async function stalePartitions(client: ClickHouseClient): Promise<string[]> {
  const res = await client.query({ query: stalePartitionsSql(), format: 'JSONEachRow' })
  return (await res.json<{ p: string }>()).map(r => r.p)
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
  const stale = await stalePartitions(client)
  if (!stale.length) return { model, rows: 0 }
  await client.command({ query: `CREATE TABLE IF NOT EXISTS ${staging} AS ${live}` })
  for (const p of stale) {
    // Clean slate in staging for this partition (a prior crashed run may have
    // left rows); DROP PARTITION on an absent partition is a no-op.
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    await client.command({ query: buildPartitionInsertSql(p, staging) })
    await client.command({ query: `ALTER TABLE ${live} REPLACE PARTITION ${p} FROM ${staging}` })
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
  }
  const res = await client.query({
    query: `SELECT count() AS n FROM price_data.account_trade_volume
            WHERE toYYYYMM(toDateTime(block_height * 12)) IN (${stale.join(',')})`,
    format: 'JSONEachRow',
  })
  return { model, rows: Number((await res.json<{ n: string }>())[0]?.n ?? 0) }
}

// ─────────────────── omnipool_position_owner_intervals ───────────────────
// Bounded full recompute: load the complete Omnipool NFT + liquidity-mining
// lifecycle (~1M rows), reconstruct account-first ownership intervals with the
// pure buildOmnipoolOwnerIntervals domain function, and swap the result into
// the live table atomically (see atomicFullReplace).

const OMNIPOOL_EVENT_KIND: Record<string, OwnerLifecycleKind> = {
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

export async function runOmnipoolOwnerIntervals(client: ClickHouseClient): Promise<DerivationResult> {
  const runId = Date.now()
  const res = await client.query({
    query: `
      SELECT
          block_height AS block,
          extrinsic_index AS extrinsic,
          event_index AS event,
          toUInt32(toUnixTimestamp(block_timestamp)) AS ts,
          event_name,
          JSONExtractString(args_json, 'collection') AS collection,
          JSONExtractString(args_json, 'item') AS item,
          JSONExtractString(args_json, 'positionId') AS positionId,
          JSONExtractString(args_json, 'depositId') AS depositId,
          lower(JSONExtractString(args_json, 'owner')) AS owner,
          lower(JSONExtractString(args_json, 'from')) AS from,
          lower(JSONExtractString(args_json, 'to')) AS to
      FROM price_data.raw_events
      WHERE event_name IN (
          'Uniques.Issued','Uniques.Transferred','Uniques.Burned',
          'Omnipool.PositionDestroyed',
          'OmnipoolLiquidityMining.SharesDeposited','OmnipoolLiquidityMining.SharesRedeposited',
          'OmnipoolLiquidityMining.SharesWithdrawn','OmnipoolLiquidityMining.DepositDestroyed')
        AND (event_name NOT IN ('Uniques.Issued','Uniques.Transferred','Uniques.Burned')
             OR JSONExtractString(args_json, 'collection') IN ('1337','2584'))
      ORDER BY block_height, event_index
    `,
    format: 'JSONEachRow',
  })
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

const XYK_FARM_EVENT_KIND: Record<string, XykFarmLifecycleKind> = {
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

export async function runXykFarmIntervals(client: ClickHouseClient): Promise<DerivationResult> {
  const runId = Date.now()
  const res = await client.query({
    query: `
      SELECT block_height AS block, extrinsic_index AS extrinsic, event_index AS event,
        toUInt32(toUnixTimestamp(block_timestamp)) AS ts, event_name,
        JSONExtractString(args_json,'item') AS item, JSONExtractString(args_json,'depositId') AS depositId,
        lower(JSONExtractString(args_json,'owner')) AS owner, lower(JSONExtractString(args_json,'from')) AS from,
        lower(JSONExtractString(args_json,'to')) AS to,
        toInt32(JSONExtractInt(args_json,'lpToken')) AS lpToken, JSONExtractString(args_json,'amount') AS amount
      FROM price_data.raw_events
      WHERE (event_name IN ('Uniques.Issued','Uniques.Transferred','Uniques.Burned') AND JSONExtractString(args_json,'collection')='5389')
         OR event_name IN ('XYKLiquidityMining.SharesDeposited','XYKLiquidityMining.SharesRedeposited','XYKLiquidityMining.DepositDestroyed')
      ORDER BY block_height, event_index`,
    format: 'JSONEachRow',
  })
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

// The single INSERT…SELECT for the total-shares reconstruction, keyed by run id.
// Targets the staging twin (never the live table directly) so the run's
// result becomes visible only via the atomic EXCHANGE in runXykTotalShares.
// Exported so its shape can be unit-tested without a live ClickHouse.
export function xykTotalSharesInsertSql(runId: number): string {
  const stepSelect = `
      WITH lps AS (
        SELECT DISTINCT toInt32(JSONExtractInt(args_json,'shareToken')) AS lp
        FROM price_data.raw_events WHERE event_name='XYK.PoolCreated'
      ),
      row_deltas AS (
        SELECT toInt32(asset_id) AS lp, block_height,
          toInt256(assumeNotNull(total)) - lagInFrame(toInt256(assumeNotNull(total)), 1, toInt256(0))
            OVER (PARTITION BY asset_id, account_id ORDER BY block_height, observation_id) AS delta
        FROM price_data.raw_balance_observations
        WHERE asset_kind='substrate' AND toInt32OrZero(asset_id) IN (SELECT lp FROM lps)
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
  await atomicFullReplace(client, liveTable, async () => {
    await client.command({
      query: xykTotalSharesInsertSql(runId),
      clickhouse_settings: { max_threads: 4, max_insert_threads: '2', max_execution_time: 3600, max_memory_usage: '8000000000' },
    })
  })
  const res = await client.query({
    query: `SELECT count() AS n FROM ${liveTable} WHERE run_id = ${runId}`,
    format: 'JSONEachRow',
  })
  return { model: 'xyk_total_shares', rows: Number((await res.json<{ n: string }>())[0]?.n ?? 0) }
}

// ───────────────────── proxy_call_activity ─────────────────────
// One row per Proxy.proxy / Proxy.proxy_announced call at any nesting depth,
// keyed by the proxied ("real") account. Global source is ~4.6k calls, so a
// bounded full recompute + atomic swap (same mechanism as the interval jobs)
// is cheaper and more robust than incremental bookkeeping. Raw inputs are
// replayable ReplacingMergeTree rows — dedupe by stable identity first.

const CALL_DEDUPE = 'ORDER BY ingested_at DESC LIMIT 1 BY block_height, assumeNotNull(extrinsic_index), call_address'

interface RawCallRow {
  block: number
  extrinsic: number
  callAddress: string
  ts: number
  callName: string
  argsJson: string
  originJson: string | null
  success: number | null
}

const RAW_CALL_SELECT = `
  SELECT block_height AS block, assumeNotNull(extrinsic_index) AS extrinsic, call_address AS callAddress,
         toUInt32(toUnixTimestamp(block_timestamp)) AS ts, call_name AS callName,
         args_json AS argsJson, origin_json AS originJson, success
  FROM price_data.raw_calls`

// Extract real account from Proxy.proxy args JSON, with graceful fallback on parse error.
function proxyRealAccount(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as { real?: string }
    return args.real?.toLowerCase() ?? ''
  } catch { return '' }
}

// Member calls of a set of extrinsics, loaded tuple-chunked so the IN list
// stays bounded; used to find the dispatched child of each wrapper call.
async function loadExtrinsicCalls(client: ClickHouseClient, tuples: Set<string>): Promise<RawCallRow[]> {
  const list = [...tuples]
  const out: RawCallRow[] = []
  const CHUNK = 10_000
  for (let i = 0; i < list.length; i += CHUNK) {
    const inList = list.slice(i, i + CHUNK).map(t => `(${t})`).join(',')
    const res = await client.query({
      query: `${RAW_CALL_SELECT} WHERE (block_height, assumeNotNull(extrinsic_index)) IN (${inList}) AND extrinsic_index IS NOT NULL ${CALL_DEDUPE}`,
      format: 'JSONEachRow',
    })
    out.push(...await res.json<RawCallRow>())
  }
  return out
}

export async function runProxyCallActivity(client: ClickHouseClient): Promise<DerivationResult> {
  const runId = Date.now()
  const res = await client.query({
    query: `${RAW_CALL_SELECT}
      WHERE call_name IN ('Proxy.proxy', 'Proxy.proxy_announced') AND extrinsic_index IS NOT NULL
      ${CALL_DEDUPE}`,
    format: 'JSONEachRow',
  })
  const proxyRows = await res.json<RawCallRow>()
  const proxies: ProxyCallSource[] = proxyRows.map(r => ({
    block: r.block, extrinsic: r.extrinsic, callAddress: r.callAddress, ts: r.ts,
    proxyCallName: r.callName,
    realAccount: proxyRealAccount(r.argsJson),
  }))
  const memberCalls = await loadExtrinsicCalls(client, new Set(proxies.map(p => `${p.block},${p.extrinsic}`)))
  const children: ExtrinsicCallRow[] = memberCalls.map(c => ({
    block: c.block, extrinsic: c.extrinsic, callAddress: c.callAddress, callName: c.callName, success: c.success,
  }))
  const rows = buildProxyCallRows(proxies, children, runId)
  await atomicFullReplace(client, 'price_data.proxy_call_activity', async stagingTable => {
    const BATCH = 50_000
    for (let i = 0; i < rows.length; i += BATCH) {
      await client.insert({ table: stagingTable, values: rows.slice(i, i + BATCH), format: 'JSONEachRow' })
    }
  })
  return { model: 'proxy_call_activity', rows: rows.length }
}

// ─────────────────── multisig_operation_activity ───────────────────
// One row per multisig OPERATION at its latest state, reconstructed from the
// four Multisig.* lifecycle events (timepoint identity) joined with the
// Multisig.* calls (threshold / signatories / inner call) via the same
// createKeyMulti derive-check refreshMultisigs uses. as_multi_threshold_1
// emits no events and becomes an executed op directly from its call.

function signedOrigin(originJson: string | null): string | null {
  if (!originJson) return null
  try {
    const o = JSON.parse(originJson) as { value?: { __kind?: string; value?: string } }
    return o.value?.__kind === 'Signed' && typeof o.value.value === 'string' ? o.value.value.toLowerCase() : null
  } catch { return null }
}

interface MultisigEventRow {
  block: number
  eventIndex: number
  extrinsic: number
  ts: number
  event_name: string
  multisig: string
  callHash: string
  actor: string
  tpHeight: number
  tpIndex: number
  hasTp: number
  resultKind: string
}

const MS_EVENT_KIND: Record<string, MultisigLifecycleEvent['kind']> = {
  'Multisig.NewMultisig': 'new',
  'Multisig.MultisigApproval': 'approval',
  'Multisig.MultisigExecuted': 'executed',
  'Multisig.MultisigCancelled': 'cancelled',
}

export async function runMultisigOperations(client: ClickHouseClient): Promise<DerivationResult> {
  const runId = Date.now()
  const evRes = await client.query({
    query: `
      SELECT block_height AS block, event_index AS eventIndex, assumeNotNull(extrinsic_index) AS extrinsic,
             toUInt32(toUnixTimestamp(block_timestamp)) AS ts, event_name,
             lower(JSONExtractString(args_json, 'multisig')) AS multisig,
             lower(JSONExtractString(args_json, 'callHash')) AS callHash,
             lower(multiIf(JSONHas(args_json, 'approving'), JSONExtractString(args_json, 'approving'),
                           JSONExtractString(args_json, 'cancelling'))) AS actor,
             toUInt32(JSONExtractInt(args_json, 'timepoint', 'height')) AS tpHeight,
             toUInt32(JSONExtractInt(args_json, 'timepoint', 'index')) AS tpIndex,
             JSONHas(args_json, 'timepoint') AS hasTp,
             JSONExtractString(args_json, 'result', '__kind') AS resultKind
      FROM price_data.raw_events
      WHERE event_name IN ('Multisig.NewMultisig', 'Multisig.MultisigApproval', 'Multisig.MultisigExecuted', 'Multisig.MultisigCancelled')
        AND extrinsic_index IS NOT NULL
      ORDER BY ingested_at DESC
      LIMIT 1 BY block_height, event_index`,
    format: 'JSONEachRow',
  })
  const eventRows = await evRes.json<MultisigEventRow>()
  const events: MultisigLifecycleEvent[] = eventRows.map(r => ({
    kind: MS_EVENT_KIND[r.event_name],
    multisig: r.multisig, callHash: r.callHash,
    timepointHeight: r.hasTp ? r.tpHeight : null,
    timepointIndex: r.hasTp ? r.tpIndex : null,
    actor: r.actor, block: r.block, extrinsic: r.extrinsic, eventIndex: r.eventIndex, ts: r.ts,
    ok: r.event_name === 'Multisig.MultisigExecuted' ? r.resultKind === 'Ok' : null,
  }))

  const callRes = await client.query({
    query: `${RAW_CALL_SELECT}
      WHERE call_name IN ('Multisig.as_multi', 'Multisig.approve_as_multi', 'Multisig.as_multi_threshold_1', 'Multisig.cancel_as_multi')
        AND extrinsic_index IS NOT NULL
      ${CALL_DEDUPE}`,
    format: 'JSONEachRow',
  })
  const callRows = await callRes.json<RawCallRow>()
  const tuples = new Set(callRows.map(c => `${c.block},${c.extrinsic}`))
  const memberCalls = await loadExtrinsicCalls(client, tuples)
  const byAddress = new Map<string, RawCallRow>()
  for (const c of memberCalls) byAddress.set(`${c.block}:${c.extrinsic}:${c.callAddress}`, c)
  // origin_json is unset on some historical rows — fall back to the extrinsic
  // signer (correct for root-level calls, which is all real traffic so far).
  const signerRes = tuples.size ? await client.query({
    query: `
      SELECT block_height AS block, extrinsic_index AS extrinsic, lower(coalesce(signer, effective_signer)) AS signer
      FROM price_data.raw_extrinsics
      WHERE (block_height, extrinsic_index) IN (${[...tuples].map(t => `(${t})`).join(',')})
      ORDER BY ingested_at DESC
      LIMIT 1 BY block_height, extrinsic_index`,
    format: 'JSONEachRow',
  }) : null
  const signers = new Map<string, string>()
  if (signerRes) for (const s of await signerRes.json<{ block: number; extrinsic: number; signer: string | null }>()) {
    if (s.signer) signers.set(`${s.block}:${s.extrinsic}`, s.signer)
  }

  const calls: MultisigCallInfo[] = callRows.map(c => {
    let threshold: number | null = null
    let otherSignatories: string[] = []
    try {
      const args = JSON.parse(c.argsJson) as { threshold?: number; otherSignatories?: string[] }
      threshold = typeof args.threshold === 'number' ? args.threshold : null
      otherSignatories = Array.isArray(args.otherSignatories) ? args.otherSignatories.map(s => s.toLowerCase()) : []
    } catch { /* keep defaults — the derive-check will simply not match */ }
    const child = byAddress.get(`${c.block}:${c.extrinsic}:${proxyChildAddress(c.callAddress)}`)
    return {
      block: c.block, extrinsic: c.extrinsic, callAddress: c.callAddress, callName: c.callName,
      threshold, otherSignatories,
      originAccount: signedOrigin(c.originJson) ?? signers.get(`${c.block}:${c.extrinsic}`) ?? null,
      callSuccess: c.success,
      innerCallName: child?.callName ?? null,
      innerSuccess: child?.success ?? null,
      ts: c.ts,
    }
  })

  const rows = buildMultisigOperations(events, calls, runId)
  await atomicFullReplace(client, 'price_data.multisig_operation_activity', async stagingTable => {
    const BATCH = 50_000
    for (let i = 0; i < rows.length; i += BATCH) {
      await client.insert({ table: stagingTable, values: rows.slice(i, i + BATCH), format: 'JSONEachRow' })
    }
  })
  return { model: 'multisig_operations', rows: rows.length }
}
