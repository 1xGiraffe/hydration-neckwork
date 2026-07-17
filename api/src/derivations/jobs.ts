// Idempotent, range-aware recompute jobs for the four read models that a plain
// materialized view cannot express (they need cross-row netting or a stateful
// lifecycle walk). The runner (Task 5) calls each every cycle; every function
// here is safe to call repeatedly.
//
//   - account_trade_volume            partition-diff incremental (no tracking table)
//   - omnipool_position_owner_intervals  bounded full recompute, fresh run_id
//   - xyk_farm_principal_intervals       bounded full recompute, fresh run_id
//   - xyk_lp_total_shares_history         bounded full recompute, fresh run_id
//
// The three reconstructions write with a fresh run_id and their target tables are
// ReplacingMergeTree(run_id) keyed on stable business keys, so a later run simply
// supersedes prior rows. account_trade_volume drops+rebuilds whole CH partitions.
// Target tables already exist in clickhouse/schema/001_tables.sql — nothing here
// creates tables or writes the (retired) lp_history_model_coverage gate rows.

import type { ClickHouseClient } from '../db/client.ts'
import {
  allExplorerAssets,
  PRICE_ALIAS_ID,
  SHARE_TOKEN_UNDERLYING_ID,
  priceAssetId,
} from '../services/explorerAssets.ts'
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

// ───────────────────────── account_trade_volume ─────────────────────────
// Per-account NET trade volume: routed/DCA trades collapsed to their net
// input/output so intermediate routing hops are not double-counted. The netting
// is a per-trade cross-row aggregation with a block-time ohlc valuation, so it
// cannot be a plain per-row MV. Whole CH month-partitions are dropped and rebuilt
// from source, so re-runs are idempotent. The netting/valuation SQL below mirrors
// services/accountTradeVolume.ts.

// First block emitting Broadcast.Swapped (the unified swap-event era). At/above
// this height a swap's hops are Broadcast.Swapped* events (grouped by their
// operationStack Router id); below it, legacy pallet *Executed events (grouped by
// extrinsic index).
const BROADCAST_MIN_BLOCK = 6_837_788
const EVENT_ANCHOR_OFFSET = 1_099_511_627_776n // 2^40 — event-index anchors clear of real router ids
const LEGACY_EVENTS = "'Omnipool.SellExecuted','Omnipool.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted'"
const BROADCAST_EVENTS = "'Broadcast.Swapped','Broadcast.Swapped2','Broadcast.Swapped3'"

function maxDecimals(): number {
  const m = Math.max(12, ...allExplorerAssets().map(a => a.decimals))
  if (m > 65) throw new Error(`asset decimals above 65 unsupported (found ${m})`)
  return m
}

function normFactorSql(expr: string, target: number): string {
  const assets = allExplorerAssets().filter(a => a.decimals <= target)
  const ids = assets.map(a => a.assetId)
  const factors = assets.map(a => `'${10n ** BigInt(target - a.decimals)}'`)
  const fallback = 10n ** BigInt(target - 12)
  return `toDecimal256(transform(toUInt32(${expr}), [${ids.join(',') || '0'}], [${factors.join(',') || "'1'"}], '${fallback}'), 0)`
}

// asset id → the id whose ohlc feed prices it (aTokens/bonds → underlying; share
// tokens stay themselves — they are priced directly by their own feed).
function priceAliasSql(expr: string): string {
  const from = Object.keys(PRICE_ALIAS_ID).map(Number).filter(k => SHARE_TOKEN_UNDERLYING_ID[k] == null)
  const to = from.map(k => priceAssetId(k))
  if (!from.length) return `toUInt32(${expr})`
  return `transform(toUInt32(${expr}), [${from.join(',')}], [${to.join(',')}], toUInt32(${expr}))`
}

function priceIdUniverse(): string {
  const ids = new Set<number>()
  for (const a of allExplorerAssets()) { ids.add(a.assetId); ids.add(priceAssetId(a.assetId)) }
  return [...ids].join(',') || '0'
}

// The per-partition netting + valuation INSERT. Groups a partition's swap legs
// into net trades, values each surviving asset at its block-time ohlc close, and
// stores volume_usd = max(net_in_usd, net_out_usd).
function buildPartitionInsertSql(partition: string): string {
  const md = maxDecimals()
  const anchor = EVENT_ANCHOR_OFFSET.toString()
  const pf = `toYYYYMM(toDateTime(block_height * 12)) = ${partition}`
  const rid = `toUInt64OrZero(extractGroups(args_json, '"__kind":"Router","value":(\\\\d+)')[1])`
  const bcastKey = `if(rid > 0, rid, ${anchor} + event_index)`
  const legacyKey = `if(extrinsic_index IS NULL, ${anchor} + event_index, toUInt64(extrinsic_index))`
  // Broadcast.Swapped (v1) reported inverted amounts for single-leg ExactOut
  // XYK/LBP fills; Swapped2+ fixed it. Mirror decodeRawTrade: swap the input and
  // output amounts for exactly that case (Swapped2/3 never match).
  const inv = `(event_name = 'Broadcast.Swapped' AND JSONExtractString(args_json,'operation','__kind') = 'ExactOut' AND JSONExtractString(args_json,'fillerType','__kind') IN ('XYK','LBP') AND length(JSONExtractArrayRaw(args_json,'inputs')) = 1 AND length(JSONExtractArrayRaw(args_json,'outputs')) = 1)`
  const outAmount = `if(${inv}, JSONExtractString(JSONExtractArrayRaw(args_json,'inputs')[1],'amount'), JSONExtractString(leg,'amount'))`
  const inAmount = `if(${inv}, JSONExtractString(JSONExtractArrayRaw(args_json,'outputs')[1],'amount'), JSONExtractString(leg,'amount'))`
  return `
INSERT INTO price_data.account_trade_volume
  (account, block_height, trade_key, volume_usd, net_in_usd, net_out_usd, trade_count, computed_at)
WITH
legs AS (
  SELECT JSONExtractString(args_json,'swapper') AS account, block_height, ${bcastKey} AS trade_key,
         block_timestamp AS block_time, JSONExtractInt(leg,'asset') AS asset_id,
         toDecimal256(${outAmount}, 0) AS samt
  FROM (SELECT block_height, event_index, block_timestamp, event_name, args_json, ${rid} AS rid
        FROM price_data.raw_events WHERE event_name IN (${BROADCAST_EVENTS}) AND block_height >= ${BROADCAST_MIN_BLOCK} AND ${pf})
  ARRAY JOIN JSONExtractArrayRaw(args_json,'outputs') AS leg
  UNION ALL
  SELECT JSONExtractString(args_json,'swapper'), block_height, ${bcastKey},
         block_timestamp, JSONExtractInt(leg,'asset'), -toDecimal256(${inAmount}, 0)
  FROM (SELECT block_height, event_index, block_timestamp, event_name, args_json, ${rid} AS rid
        FROM price_data.raw_events WHERE event_name IN (${BROADCAST_EVENTS}) AND block_height >= ${BROADCAST_MIN_BLOCK} AND ${pf})
  ARRAY JOIN JSONExtractArrayRaw(args_json,'inputs') AS leg
  UNION ALL
  SELECT JSONExtractString(args_json,'who') AS account, block_height, ${legacyKey} AS trade_key,
         block_timestamp, toUInt32(greatest(0, JSONExtractInt(args_json,'assetIn'))),
         -toDecimal256(multiIf(event_name='XYK.SellExecuted', JSONExtractString(args_json,'amount'),
                               event_name='XYK.BuyExecuted', JSONExtractString(args_json,'buyPrice'),
                               JSONExtractString(args_json,'amountIn')), 0)
  FROM price_data.raw_events WHERE event_name IN (${LEGACY_EVENTS}) AND block_height < ${BROADCAST_MIN_BLOCK} AND ${pf}
  UNION ALL
  SELECT JSONExtractString(args_json,'who'), block_height, ${legacyKey},
         block_timestamp, toUInt32(greatest(0, JSONExtractInt(args_json,'assetOut'))),
         toDecimal256(multiIf(event_name='XYK.SellExecuted', JSONExtractString(args_json,'salePrice'),
                              event_name='XYK.BuyExecuted', JSONExtractString(args_json,'amount'),
                              JSONExtractString(args_json,'amountOut')), 0)
  FROM price_data.raw_events WHERE event_name IN (${LEGACY_EVENTS}) AND block_height < ${BROADCAST_MIN_BLOCK} AND ${pf}
),
net AS (
  SELECT account, block_height, trade_key, any(block_time) AS block_time, asset_id, sum(samt) AS net_amt
  FROM legs WHERE match(account, '^0x[0-9a-f]{64}$')
  GROUP BY account, block_height, trade_key, asset_id
),
valued AS (
  SELECT n.account AS account, n.block_height AS block_height, n.trade_key AS trade_key,
         toFloat64(multiplyDecimal(multiplyDecimal(n.net_amt, ${normFactorSql('n.asset_id', md)}, 0), toDecimal256(p.close, 12), 12)) / 1e${md} AS net_usd
  FROM net n
  ASOF LEFT JOIN (
    SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close
    FROM price_data.ohlc_1h WHERE asset_id IN (${priceIdUniverse()}) GROUP BY asset_id, interval_start
  ) p ON p.asset_id = ${priceAliasSql('n.asset_id')} AND p.price_time <= n.block_time
)
SELECT account, block_height, trade_key,
       toDecimal128(greatest(sum(greatest(net_usd, 0)), sum(greatest(-net_usd, 0))), 12) AS volume_usd,
       toDecimal128(sum(greatest(-net_usd, 0)), 12) AS net_in_usd,
       toDecimal128(sum(greatest(net_usd, 0)), 12) AS net_out_usd,
       toUInt32(1) AS trade_count, now() AS computed_at
FROM valued
GROUP BY account, block_height, trade_key
HAVING volume_usd > 0`
}

// Partition-diff: a partition needs rebuild when its source swap coverage differs
// from the derived coverage. We compare, per month-partition, the count of
// distinct source swap blocks against the count of distinct blocks already
// present in account_trade_volume. This single comparison covers both cases:
//   - live growth: new blocks land in the newest partition → source > derived → rebuild
//   - out-of-order backward backfill: a low partition gets filled (source > 0) while
//     derived is still 0 → mismatch → rebuild
// No tracking table is needed — both counts are read from live tables each cycle.
// Steady-state partitions match and are skipped, so the pass is incremental.
async function stalePartitions(client: ClickHouseClient): Promise<string[]> {
  // Mirror exactly which source rows buildPartitionInsertSql consumes (the era
  // split), so a block that will never produce a derived row is not counted.
  const srcRes = await client.query({
    query: `SELECT toString(toYYYYMM(toDateTime(block_height * 12))) AS p, uniqExact(block_height) AS c
            FROM price_data.raw_events
            WHERE (event_name IN (${BROADCAST_EVENTS}) AND block_height >= ${BROADCAST_MIN_BLOCK})
               OR (event_name IN (${LEGACY_EVENTS}) AND block_height < ${BROADCAST_MIN_BLOCK})
            GROUP BY p ORDER BY p`,
    format: 'JSONEachRow',
  })
  const src = new Map<string, number>()
  for (const r of await srcRes.json<{ p: string; c: string }>()) src.set(r.p, Number(r.c))

  const derRes = await client.query({
    query: `SELECT toString(toYYYYMM(toDateTime(block_height * 12))) AS p, uniqExact(block_height) AS c
            FROM price_data.account_trade_volume GROUP BY p`,
    format: 'JSONEachRow',
  })
  const der = new Map<string, number>()
  for (const r of await derRes.json<{ p: string; c: string }>()) der.set(r.p, Number(r.c))

  // src is ORDER BY p ascending; Map keeps insertion order → rebuild oldest first.
  const stale: string[] = []
  for (const [p, c] of src) if (c !== (der.get(p) ?? 0)) stale.push(p)
  return stale
}

// Recompute only the partitions whose source/derived coverage diverges. Assumes
// the explorer asset registry is loaded (loadExplorerAssets) — the netting SQL
// bakes in per-asset decimal factors and the price-alias universe.
export async function runAccountTradeVolume(client: ClickHouseClient): Promise<DerivationResult> {
  const model = 'account_trade_volume'
  const stale = await stalePartitions(client)
  for (const p of stale) {
    await client.command({
      query: `ALTER TABLE price_data.account_trade_volume DROP PARTITION ${p}`,
      clickhouse_settings: { mutations_sync: '1' },
    })
    await client.command({ query: buildPartitionInsertSql(p) })
  }
  if (!stale.length) return { model, rows: 0 }
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
// pure buildOmnipoolOwnerIntervals domain function, and write with a fresh
// run_id (ReplacingMergeTree(run_id) supersedes prior rows on their stable keys).

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

  const BATCH = 50_000
  for (let i = 0; i < intervalRows.length; i += BATCH) {
    await client.insert({
      table: 'price_data.omnipool_position_owner_intervals',
      values: intervalRows.slice(i, i + BATCH),
      format: 'JSONEachRow',
    })
  }
  return { model: 'omnipool_owner_intervals', rows: intervalRows.length }
}

// ─────────────────── xyk_farm_principal_intervals ───────────────────
// Bounded full recompute of collection-5389 farm deposits via the pure
// buildXykFarmIntervals domain function; fresh run_id supersedes prior rows.

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

  const BATCH = 50_000
  for (let i = 0; i < intervalRows.length; i += BATCH) {
    await client.insert({
      table: 'price_data.xyk_farm_principal_intervals',
      values: intervalRows.slice(i, i + BATCH),
      format: 'JSONEachRow',
    })
  }
  return { model: 'xyk_farm_intervals', rows: intervalRows.length }
}

// ─────────────────── xyk_lp_total_shares_history ───────────────────
// Reconstructs the total outstanding supply of each XYK LP (shareToken) as a step
// function over block height, from raw_balance_observations (approach A, no RPC):
// token issuance == sum of all holder balances, and substrate Tokens balances are
// captured from genesis, so cumulative net balance deltas reproduce issuance
// exactly. XYK.LiquidityAdded omits the minted-share amount, so events alone
// cannot do this. A fresh run_id replaces prior rows per (lp_asset_id, block).

// The single INSERT…SELECT for the total-shares reconstruction, keyed by run id.
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
  return `INSERT INTO price_data.xyk_lp_total_shares_history
        SELECT lp_asset_id, block_height, total_shares_raw, ${runId} AS run_id, now() AS ingested_at
        FROM (${stepSelect})`
}

export async function runXykTotalShares(client: ClickHouseClient): Promise<DerivationResult> {
  const runId = Date.now()
  await client.command({
    query: xykTotalSharesInsertSql(runId),
    clickhouse_settings: { max_threads: 4, max_insert_threads: '2', max_execution_time: 3600, max_memory_usage: '8000000000' },
  })
  const res = await client.query({
    query: `SELECT count() AS n FROM price_data.xyk_lp_total_shares_history WHERE run_id = ${runId}`,
    format: 'JSONEachRow',
  })
  return { model: 'xyk_total_shares', rows: Number((await res.json<{ n: string }>())[0]?.n ?? 0) }
}
