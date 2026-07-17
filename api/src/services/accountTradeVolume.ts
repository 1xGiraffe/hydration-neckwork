// Per-account NET trade volume read model (price_data.account_trade_volume):
// routed/DCA trades collapsed to their net input/output so intermediate routing
// hops are not double-counted. See docs/superpowers/specs/2026-07-17-account-
// trade-volume-dedup-design.md.
//
// The netting is a per-trade cross-row aggregation with a block-time ohlc
// valuation, so it cannot be a plain per-row MV. The derivations runner rebuilds
// whole CH month-partitions in a staging twin and publishes them atomically
// (REPLACE PARTITION), so re-runs are idempotent and readers never see a gap.

import { allExplorerAssets, PRICE_ALIAS_ID, SHARE_TOKEN_UNDERLYING_ID, priceAssetId } from './explorerAssets.ts'

// First block emitting Broadcast.Swapped (the unified swap-event era). At/above
// this height a swap's hops are Broadcast.Swapped* events (grouped by their
// operationStack Router id); below it, legacy pallet *Executed events (grouped by
// extrinsic index).
const BROADCAST_MIN_BLOCK = 6_837_788
const EVENT_ANCHOR_OFFSET = 1_099_511_627_776n // 2^40 — event-index anchors clear of real router ids
const LEGACY_EVENTS = "'Omnipool.SellExecuted','Omnipool.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted'"
const BROADCAST_EVENTS = "'Broadcast.Swapped','Broadcast.Swapped2','Broadcast.Swapped3'"

// Source for per-account trading volume: the de-duped net-trade model, whose
// derivations job keeps every partition covered. One summable USD column per
// account.
export function accountVolumeSource(): { table: string; col: string } {
  return { table: 'price_data.account_trade_volume', col: 'volume_usd' }
}

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

// The combined swap-row filter: every raw event that could contribute to a netted
// trade — unified-era Broadcast.Swapped* at/above the cutover, legacy pallet
// *Executed below it. This is the same row set buildPartitionInsertSql consumes
// (its two era legs), factored out so the incremental staleness check can select
// exactly the source rows the netting SELECT does. Single source of truth for the
// era split.
export function swapEventFilterSql(): string {
  return `((event_name IN (${BROADCAST_EVENTS}) AND block_height >= ${BROADCAST_MIN_BLOCK})`
    + ` OR (event_name IN (${LEGACY_EVENTS}) AND block_height < ${BROADCAST_MIN_BLOCK}))`
}

// The per-partition netting + valuation INSERT. Groups a partition's swap legs
// into net trades, values each surviving asset at its block-time ohlc close, and
// stores volume_usd = max(net_in_usd, net_out_usd). Exported as the single source
// of truth for the netting SQL (reused by the derivations recompute job, which
// writes into the staging twin and publishes via REPLACE PARTITION).
//
// Replay safety: raw_events is ReplacingMergeTree(ingested_at) keyed on
// (block_height, event_index), so a replayed range holds duplicate row versions
// until background merges collapse them. Every raw_events read below uses FINAL
// so a recompute between replay and merge nets each leg exactly once; the reads
// stay bounded by the partition filter + event-name set.
//
// Valuation stays in Decimal end-to-end: prices are Decimal(38,12) at the source
// (ohlc close states), so converting through Float64 would be the only lossy
// stage — amounts × norm-factor × close and the /10^md rescale all use
// multiplyDecimal/divideDecimal, and per-trade sums aggregate Decimal256(12).
export function buildPartitionInsertSql(
  partition: string,
  targetTable = 'price_data.account_trade_volume',
): string {
  const md = maxDecimals()
  const usdDivisor = (10n ** BigInt(md)).toString()
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
INSERT INTO ${targetTable}
  (account, block_height, trade_key, volume_usd, net_in_usd, net_out_usd, trade_count, computed_at)
WITH
legs AS (
  SELECT JSONExtractString(args_json,'swapper') AS account, block_height, ${bcastKey} AS trade_key,
         block_timestamp AS block_time, JSONExtractInt(leg,'asset') AS asset_id,
         toDecimal256(${outAmount}, 0) AS samt
  FROM (SELECT block_height, event_index, block_timestamp, event_name, args_json, ${rid} AS rid
        FROM price_data.raw_events FINAL WHERE event_name IN (${BROADCAST_EVENTS}) AND block_height >= ${BROADCAST_MIN_BLOCK} AND ${pf})
  ARRAY JOIN JSONExtractArrayRaw(args_json,'outputs') AS leg
  UNION ALL
  SELECT JSONExtractString(args_json,'swapper'), block_height, ${bcastKey},
         block_timestamp, JSONExtractInt(leg,'asset'), -toDecimal256(${inAmount}, 0)
  FROM (SELECT block_height, event_index, block_timestamp, event_name, args_json, ${rid} AS rid
        FROM price_data.raw_events FINAL WHERE event_name IN (${BROADCAST_EVENTS}) AND block_height >= ${BROADCAST_MIN_BLOCK} AND ${pf})
  ARRAY JOIN JSONExtractArrayRaw(args_json,'inputs') AS leg
  UNION ALL
  SELECT JSONExtractString(args_json,'who') AS account, block_height, ${legacyKey} AS trade_key,
         block_timestamp, toUInt32(greatest(0, JSONExtractInt(args_json,'assetIn'))),
         -toDecimal256(multiIf(event_name='XYK.SellExecuted', JSONExtractString(args_json,'amount'),
                               event_name='XYK.BuyExecuted', JSONExtractString(args_json,'buyPrice'),
                               JSONExtractString(args_json,'amountIn')), 0)
  FROM price_data.raw_events FINAL WHERE event_name IN (${LEGACY_EVENTS}) AND block_height < ${BROADCAST_MIN_BLOCK} AND ${pf}
  UNION ALL
  SELECT JSONExtractString(args_json,'who'), block_height, ${legacyKey},
         block_timestamp, toUInt32(greatest(0, JSONExtractInt(args_json,'assetOut'))),
         toDecimal256(multiIf(event_name='XYK.SellExecuted', JSONExtractString(args_json,'salePrice'),
                              event_name='XYK.BuyExecuted', JSONExtractString(args_json,'amount'),
                              JSONExtractString(args_json,'amountOut')), 0)
  FROM price_data.raw_events FINAL WHERE event_name IN (${LEGACY_EVENTS}) AND block_height < ${BROADCAST_MIN_BLOCK} AND ${pf}
),
net AS (
  SELECT account, block_height, trade_key, any(block_time) AS block_time, asset_id, sum(samt) AS net_amt
  FROM legs WHERE match(account, '^0x[0-9a-f]{64}$')
  GROUP BY account, block_height, trade_key, asset_id
),
valued AS (
  SELECT n.account AS account, n.block_height AS block_height, n.trade_key AS trade_key,
         divideDecimal(multiplyDecimal(multiplyDecimal(n.net_amt, ${normFactorSql('n.asset_id', md)}, 0), toDecimal256(p.close, 12), 12), toDecimal256('${usdDivisor}', 0), 12) AS net_usd
  FROM net n
  ASOF LEFT JOIN (
    SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close
    FROM price_data.ohlc_1h WHERE asset_id IN (${priceIdUniverse()}) GROUP BY asset_id, interval_start
  ) p ON p.asset_id = ${priceAliasSql('n.asset_id')} AND p.price_time <= n.block_time
)
SELECT account, block_height, trade_key,
       toDecimal128(greatest(sum(greatest(net_usd, toDecimal256(0, 12))), sum(greatest(-net_usd, toDecimal256(0, 12)))), 12) AS volume_usd,
       toDecimal128(sum(greatest(-net_usd, toDecimal256(0, 12))), 12) AS net_in_usd,
       toDecimal128(sum(greatest(net_usd, toDecimal256(0, 12))), 12) AS net_out_usd,
       toUInt32(1) AS trade_count, now() AS computed_at
FROM valued
GROUP BY account, block_height, trade_key
HAVING volume_usd > 0`
}
