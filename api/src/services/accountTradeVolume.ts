// Per-account NET trade volume read model (price_data.account_trade_volume):
// routed/DCA trades collapsed to their net input/output so intermediate routing
// hops are not double-counted.
//
// The netting is a per-trade cross-row aggregation with a block-time ohlc
// valuation, so it cannot be a plain per-row MV. Every leg of a trade lies in one
// block (one extrinsic, or one block hook), so the model is computed per BUCKET of
// ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS blocks, each self-contained: the derivations
// job (runAccountTradeVolume) recomputes only the buckets whose raw, registry
// inputs or late intent orders moved, and republishes their month partition from
// its staging twin, so readers never see a gap and need no FINAL.

import { allExplorerAssets, PRICE_ALIAS_ID, priceAssetId } from './explorerAssets.ts'
import { ICE_POT_ACCOUNT, V3_POOLS_CTE, V3_TOKEN_ASSETS_CTE, v3TokenAssetSql } from './revenueStreams.ts'

// First block emitting Broadcast.Swapped (the unified swap-event era). At/above
// this height a swap's hops are Broadcast.Swapped* events (grouped by their
// operationStack Router id); below it, legacy pallet *Executed events (grouped by
// extrinsic index).
const BROADCAST_MIN_BLOCK = 6_837_788
const EVENT_ANCHOR_OFFSET = 1_099_511_627_776n // 2^40 — event-index anchors clear of real router ids
const LEGACY_EVENTS = "'Omnipool.SellExecuted','Omnipool.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted','LBP.SellExecuted','LBP.BuyExecuted'"
const BROADCAST_EVENTS = "'Broadcast.Swapped','Broadcast.Swapped2','Broadcast.Swapped3'"
// ICE intents (runtime 443, block 14362830): a fill is the owner's trade. The four
// events that settle an intent — the last of a DCA is DcaCompleted alone, with no
// amounts of its own — and the solver's holding pot (`modlice_ice#`), through which
// every fill moves as one Currencies.Transferred in and one out.
export const ICE_MIN_BLOCK = 14_362_830
export const INTENT_FILL_EVENTS = "'Intent.IntentResolved','Intent.IntentResovedPartially','Intent.DcaTradeExecuted','Intent.DcaCompleted'"
// The OTC pallet's fill events, which name a fill's TAKER as `who` — the only
// thing that resolves an OTC Broadcast fill's two sides (see the `bcast` CTE).
const OTC_FILL_EVENTS = "'OTC.Filled','OTC.PartiallyFilled'"

// Source for per-account trading volume: the de-duped net-trade model. One
// summable USD column per trade row.
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

// asset id → the id whose ohlc feed prices it: the one historical price rule
// (priceAssetId) — aTokens and bonds through their underlying, a Hydrated pool
// share through its wrapper, every other share its own NAV series.
function priceAliasSql(expr: string): string {
  const from = Object.keys(PRICE_ALIAS_ID).map(Number).filter(k => priceAssetId(k) !== k)
  const to = from.map(k => priceAssetId(k))
  if (!from.length) return `toUInt32(${expr})`
  return `transform(toUInt32(${expr}), [${from.join(',')}], [${to.join(',')}], toUInt32(${expr}))`
}

function priceIdUniverse(): string {
  const ids = new Set<number>()
  for (const a of allExplorerAssets()) { ids.add(a.assetId); ids.add(priceAssetId(a.assetId)) }
  return [...ids].join(',') || '0'
}

// ── Buckets ──
// A bucket is ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS consecutive blocks,
// intDiv(block_height, 1800). Block-aligned rather than hour-aligned because every
// source the netting reads is ordered by block_height, so a bucket is a plain
// primary-key range on each of them, and because a trade never leaves its block,
// so any block-aligned bucket nets exactly as a full build would. 1800 blocks is an
// hour at today's 2 s blocks (6 h at the early 12 s), which bounds what the
// still-filling head bucket costs to recompute each cycle. The table's partitions
// are the synthetic block-space months of `block_height * 12` (see the note above
// account_trade_volume in clickhouse/schema/001_tables.sql); each begins at a UTC
// day, 86,400 synthetic seconds = 7,200 blocks, a multiple of 1800, so a bucket
// never straddles two partitions.
export const ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS = 1800
const BUCKET_BLOCKS = ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS

/** The month partition (`YYYYMM` of the synthetic block clock) a bucket lies in. */
export function bucketPartition(bucket: string | number): string {
  const b = Number(bucket)
  if (!Number.isInteger(b) || b < 0) throw new Error(`invalid bucket ${JSON.stringify(bucket)}`)
  const d = new Date(b * BUCKET_BLOCKS * 12 * 1000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * The blocks of a set of buckets of one partition, as a primary-key range on
 * block_height (the span of the set) narrowed to exactly the set.
 */
export function bucketBlocksPredicate(partition: string, buckets: readonly string[], column = 'block_height'): string {
  if (!/^\d{6}$/.test(partition)) throw new Error(`invalid partition ${JSON.stringify(partition)}`)
  if (!buckets.length) throw new Error('no buckets to compute')
  for (const b of buckets) {
    if (!/^\d+$/.test(b) || bucketPartition(b) !== partition) throw new Error(`invalid bucket ${JSON.stringify(b)} for ${partition}`)
  }
  const ids = [...new Set(buckets.map(Number))].sort((a, b) => a - b)
  return `${column} >= ${ids[0] * BUCKET_BLOCKS} AND ${column} < ${(ids[ids.length - 1] + 1) * BUCKET_BLOCKS}
      AND intDiv(${column}, ${BUCKET_BLOCKS}) IN (${ids.join(', ')})`
}

// Every raw_events row the netting reads, directly or through an MV-fed
// projection of raw_events (intent_events, transfer_activity_by_time): the
// unified-era Broadcast.Swapped* at/above the cutover, the legacy pallet
// *Executed below it with the DCA executions that key them, the OTC fill events
// that resolve a fill's taker, the ICE fills from runtime 443 and the
// Currencies.Transferred legs through the solver's pot (by the pot account
// anywhere in the event, a superset of the from/to match the netting applies —
// a watermark over a superset only re-marks more). The bucket watermark MV
// (account_trade_volume_watermarks_mv) carries this predicate verbatim, which
// api/src/derivations/jobs.test.ts asserts.
export function accountTradeVolumeSourceFilterSql(): string {
  return `((event_name IN (${BROADCAST_EVENTS}) AND block_height >= ${BROADCAST_MIN_BLOCK})`
    + ` OR (event_name IN (${LEGACY_EVENTS}, 'DCA.TradeExecuted') AND block_height < ${BROADCAST_MIN_BLOCK})`
    + ` OR (event_name IN (${OTC_FILL_EVENTS}))`
    + ` OR (event_name IN (${INTENT_FILL_EVENTS}) AND block_height >= ${ICE_MIN_BLOCK})`
    + ` OR (event_name = 'Currencies.Transferred' AND block_height >= ${ICE_MIN_BLOCK} AND position(args_json, '${ICE_POT_ACCOUNT}') > 0))`
}

// The registry assets a source row values, for the bucket's registry fingerprint:
// a Broadcast fill's input and output assets, a legacy fill's assetIn/assetOut
// (exactly as the netting reads them) and a pot leg's currency, which also covers
// every ICE fill's two assets (each fill moves through the pot as one transfer of
// each). The direct v3 swaps' assets depend on the pool and token maps and are
// fingerprinted with them (the watermarks' `v3` flag).
export function accountTradeVolumeSourceAssetsSql(): string {
  return `multiIf(event_name IN (${BROADCAST_EVENTS}), arrayMap(x -> toUInt32(JSONExtractInt(x, 'asset')), arrayConcat(JSONExtractArrayRaw(args_json, 'inputs'), JSONExtractArrayRaw(args_json, 'outputs'))),`
    + ` event_name IN (${LEGACY_EVENTS}), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn'))), toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut')))],`
    + ` event_name = 'Currencies.Transferred', [toUInt32(JSONExtractInt(args_json, 'currencyId'))], [])`
}

// The bucket netting + valuation INSERT. Groups the buckets' swap legs into net
// trades, values each surviving asset at its block-time ohlc close, and stores
// volume_usd = max(net_in_usd, net_out_usd), one row per (account, block_height,
// trade_key), each carrying its bucket's registry fingerprint. Exported as the
// single source of truth for the netting SQL; the derivations job writes it into
// the staging twin and publishes via REPLACE PARTITION.
//
// Replay safety: raw_events is ReplacingMergeTree(ingested_at) keyed on
// (block_height, event_index), so a replayed range holds duplicate row versions
// until background merges collapse them. Every raw_events read below uses FINAL
// so a recompute between replay and merge nets each leg exactly once; the reads
// stay bounded by the bucket range + event-name set.
//
// Valuation stays in Decimal end-to-end: prices are Decimal(38,12) at the source
// (ohlc close states), so converting through Float64 would be the only lossy
// stage — amounts × norm-factor × close and the /10^md rescale run on the plain
// decimal OPERATORS, and per-trade sums aggregate Decimal256(12). The operators,
// not multiplyDecimal/divideDecimal: every operand scale here lines up so the two
// forms are the same integer arithmetic (Decimal256(0) × Decimal256(0) is scale 0,
// × Decimal256(12) is scale 12 by scale addition, and ÷ Decimal256(0) keeps
// scale 12 and truncates toward zero), but the adaptive-scale functions are a
// per-row path where the operators are vectorised — measured 4.70 → 2.65 CPU-s
// per month INSERT. `net_amt` is SIGNED, so the truncation direction matters
// and was proved rather than assumed: 2.77 M rows across seven months from
// 2023-01 to the live head (1.10 M of them negative, four below the Broadcast
// cutover) produced 0 mismatches, identical sums, identical per-row hash and the
// same Decimal(76,12) type, and the published volume_usd/net_in_usd/net_out_usd
// folds came out bit-identical.

// The ASOF right side is the whole ohlc_1h feed for every priced asset. A candle
// matches only where `price_time <= block_time`, so every candle whose hour closes
// after the buckets' last trade is dead weight and can be cut. There is no safe
// lower bound: an asset with no candle inside the buckets is valued at the last
// candle before it, however far back that lies. `maxBlockTime` is the buckets' own
// newest source block timestamp, carried by the bucket watermarks; omitting it
// values against the whole feed.
function priceWindowSql(maxBlockTime: string | undefined): string {
  if (maxBlockTime == null) return ''
  if (!DATETIME_RE.test(maxBlockTime)) {
    throw new Error(`invalid bucket price watermark ${JSON.stringify(maxBlockTime)}`)
  }
  return ` AND interval_start <= (toDateTime('${maxBlockTime}') - toIntervalHour(1))`
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** One bucket to compute, with the registry fingerprint its rows carry. */
export interface TradeVolumeBucket {
  bucket: string
  /** The bucket's registry fingerprint, a decimal UInt64. */
  fingerprint: string
}

export function accountTradeVolumeInsertSql(
  partition: string,
  buckets: readonly TradeVolumeBucket[],
  targetTable: string,
  opts: { computedAt: string; maxBlockTime?: string },
): string {
  const md = maxDecimals()
  const usdDivisor = (10n ** BigInt(md)).toString()
  const anchor = EVENT_ANCHOR_OFFSET.toString()
  if (!DATETIME_RE.test(opts.computedAt)) throw new Error(`invalid computed_at ${JSON.stringify(opts.computedAt)}`)
  for (const b of buckets) if (!/^\d+$/.test(b.fingerprint)) throw new Error(`invalid fingerprint ${JSON.stringify(b.fingerprint)}`)
  const pf = bucketBlocksPredicate(partition, buckets.map(b => b.bucket))
  const registryFp = `transform(intDiv(block_height, ${BUCKET_BLOCKS}), [${buckets.map(b => `toUInt32(${b.bucket})`).join(', ')}],
                   [${buckets.map(b => `toUInt64(${b.fingerprint})`).join(', ')}], toUInt64(0))`
  const rid = `toUInt64OrZero(extractGroups(args_json, '"__kind":"Router","value":(\\\\d+)')[1])`
  const bcastKey = `if(rid > 0, rid, ${anchor} + event_index)`
  // A signed legacy swap is identified by its extrinsic. An unsigned one has none, and
  // its identity is whatever block hook produced it: a ROUTED DCA execution emits one
  // pallet *Executed event per hop before its DCA.TradeExecuted, so keying each hop on
  // its own event splits one trade into per-hop trades — the intermediate asset appears
  // as an output of one key and an input of the next instead of netting to zero, and
  // volume_usd counts the gross hops. Key every unsigned leg on the nearest FOLLOWING
  // DCA.TradeExecuted for the same (block, who) — the execution event a DCA execution
  // is already addressed by — and fall back to the leg's own event index for the
  // pallet/block-hook swaps (treasury/referral distribution and the like) that no
  // execution encloses, where the event is the only identity there is.
  //
  // The fallback and the "one owner, several independent single-hop executions in one
  // block" case are unaffected by construction: the former matches nothing, the latter
  // maps each leg to its own execution, so only the key's label moves. Over the whole
  // legacy era all 957,314 of the 1,800,654 unsigned legs that match an execution lie
  // strictly inside that execution's DCA.ExecutionStarted…DCA.TradeExecuted window, so
  // the nearest-following rule never glues an unrelated leg onto a trade.
  const legacyKey = `if(s.extrinsic_index IS NULL, ${anchor} + if(x.exec_marker > 0, x.exec_index, s.event_index), toUInt64(s.extrinsic_index))`
  // exec_marker is event_index + 1, so the ASOF LEFT JOIN's zero-filled miss is
  // distinguishable from a genuine execution at event index 0.
  const legacyLegs = `
legacy AS (
  SELECT s.block_height AS block_height, s.block_timestamp AS block_timestamp, s.who AS who,
         s.event_name AS event_name, s.args_json AS args_json, ${legacyKey} AS trade_key
  FROM (SELECT block_height, event_index, extrinsic_index, block_timestamp, event_name, args_json,
               JSONExtractString(args_json,'who') AS who
        FROM price_data.raw_events FINAL
        WHERE event_name IN (${LEGACY_EVENTS}) AND block_height < ${BROADCAST_MIN_BLOCK} AND ${pf}) s
  ASOF LEFT JOIN (
    SELECT block_height, JSONExtractString(args_json,'who') AS who,
           event_index AS exec_index, event_index + 1 AS exec_marker
    FROM price_data.raw_events FINAL
    WHERE event_name = 'DCA.TradeExecuted' AND block_height < ${BROADCAST_MIN_BLOCK} AND ${pf}
  ) x ON s.block_height = x.block_height AND s.who = x.who AND s.event_index <= x.exec_index
)`
  // Broadcast.Swapped (v1) reported inverted amounts for single-leg ExactOut
  // XYK/LBP fills; Swapped2+ fixed it. Mirror decodeRawTrade: swap the input and
  // output amounts for exactly that case (Swapped2/3 never match).
  const inv = `(event_name = 'Broadcast.Swapped' AND JSONExtractString(args_json,'operation','__kind') = 'ExactOut' AND JSONExtractString(args_json,'fillerType','__kind') IN ('XYK','LBP') AND length(JSONExtractArrayRaw(args_json,'inputs')) = 1 AND length(JSONExtractArrayRaw(args_json,'outputs')) = 1)`
  const outAmount = `if(${inv}, JSONExtractString(JSONExtractArrayRaw(args_json,'inputs')[1],'amount'), JSONExtractString(leg,'amount'))`
  const inAmount = `if(${inv}, JSONExtractString(JSONExtractArrayRaw(args_json,'outputs')[1],'amount'), JSONExtractString(leg,'amount'))`
  // The legacy era carries the same hazard in the pallet events themselves: XYK
  // and LBP name their buy fields identically and mean the opposite by them.
  // XYK.BuyExecuted is (amount = received, buyPrice = paid); LBP.BuyExecuted is
  // (amount = paid, buyPrice = received). Checked against the Router.RouteExecuted
  // in the same extrinsic over the whole legacy era: LBP buyPrice = amountOut in
  // 26/26 routed buys, XYK amount = amountOut in 396/446 (the rest multi-hop, where
  // a single leg is not the route total). Sells agree — amount paid, salePrice
  // received — so only the buy branch splits.
  //
  // Reading an LBP buy with XYK's order swaps the trade's two sides, and because
  // the two assets rarely share decimals the error is unbounded, not a rounding
  // slip: block 4192220 paid 202.025 DOT (10 dec) for 1e17 raw of a Treasury bond
  // (18 dec), and valuing the bond's integer as DOT booked 10,000,000 DOT —
  // $77.3M of volume for a $1,562 trade. 26 such buys inflated the whole
  // account_trade_volume leaderboard by $815.2M.
  // A trade whose every fill is an AAVE-filler swap is an aToken mint or redeem — a
  // 1:1 money-market wrap (DOT→aDOT, a pool share into its money-market wrapper),
  // not a swap: the public volume surfaces drop it by the same rule
  // (poolVolumes.ts `all_aave`) and the indexer's per-account volume by asset
  // identity. Untreated, the Treasury's four share→aToken wraps in block 14,672,012
  // read as $3.27M of trading. An aave hop INSIDE a routed trade stays: it is a real
  // hop and already cancels in the per-asset net, so only whole-trade wraps go
  // (`all_aave`, carried through `legs`/`net` as the minimum over the trade).
  // ICE intents settle through the solver's pot: the pot runs the AMM routes and the
  // owner only pays into and receives out of it. The owner's trade is the FILL, and
  // it is the only booking — the pot's own Broadcast legs (swapper = pot) are left
  // out wherever a fill in the same extrinsic names its owner (`bcast`), since
  // they are the same trade a second time: a pot that kept
  // them read $813k of "trading" by October 2026 on top of the owners' fills, and
  // any sum across accounts counted intent volume twice. The fill states exact
  // per-owner amounts, so even a multi-owner solution needs no split of the routes
  // (the indexer, which has only the routes, re-attributes them instead — see
  // src/blocks/icePotSettlement.ts). The owner's trade is the FILL: the Intent event's amounts for a resolve,
  // a partial or a DCA trade; for the budget-exhausting DcaCompleted, which states
  // none, the pot's settlement legs for that (solution, owner, asset) less the
  // sibling fills that state theirs — exact for one completion per (owner, asset)
  // in a solution, and nothing rather than a split guess for two — with the input
  // side falling back to what the final trade spends where no owner->pot transfer
  // measures it (completion_fallback; services/iceSettlement.ts is the one rule).
  // Keyed on the Intent event, in the event-anchored space clear of router ids.
  const intentFills = `
intent_fills AS (
  SELECT e.block_height AS block_height, e.extrinsic_index AS extrinsic_index, e.event_index AS event_index,
         e.block_timestamp AS block_time, e.event_name AS event_name,
         lower(o.owner) AS account, o.asset_in AS asset_in, o.asset_out AS asset_out,
         toDecimal256(if(e.amount_in = '', '0', e.amount_in), 0) AS stated_in,
         toDecimal256(if(e.amount_out = '', '0', e.amount_out), 0) AS stated_out,
         e.intent_id AS intent_id, o.amount_in AS order_in, o.budget AS order_budget
  FROM (SELECT intent_id, block_height, assumeNotNull(ie.extrinsic_index) AS extrinsic_index, event_index, block_timestamp, event_name, amount_in, amount_out
        FROM price_data.intent_events AS ie FINAL
        WHERE event_name IN (${INTENT_FILL_EVENTS}) AND ie.extrinsic_index IS NOT NULL AND block_height >= ${ICE_MIN_BLOCK} AND ${pf}) e
  INNER JOIN (SELECT intent_id, owner, asset_in, asset_out, amount_in, budget FROM price_data.intent_orders FINAL) o ON o.intent_id = e.intent_id
),
-- The completion's input when no owner->pot transfer measures it (since ~block
-- 15,140,000 the pallet repatriates the reserved budget instead, and an Erc20
-- asset_in leaves no leg at all): what the final trade spends, min(the order's
-- per-trade amount, the budget left before it) — the newest DcaTradeExecuted's
-- remaining budget, else the order's budget (services/iceSettlement.ts, which
-- matches the measured leg on every completion that has one). intent_events is
-- small and the completing intents' earlier trades lie outside the bucket.
completion_prior AS (
  SELECT intent_id, argMax(remaining_budget, toUInt64(block_height) * 4294967296 + event_index) AS rb
  FROM price_data.intent_events FINAL
  WHERE event_name = 'Intent.DcaTradeExecuted' AND block_height >= ${ICE_MIN_BLOCK}
    AND intent_id IN (SELECT intent_id FROM intent_fills WHERE event_name = 'Intent.DcaCompleted')
  GROUP BY intent_id
),
completion_fallback AS (
  SELECT f.block_height AS block_height, f.event_index AS event_index,
         least(toDecimal256(if(f.order_in = '', '0', f.order_in), 0),
               toDecimal256(if(p.rb != '', p.rb, if(f.order_budget = '', f.order_in, f.order_budget)), 0)) AS amount
  FROM intent_fills f
  LEFT JOIN completion_prior p ON p.intent_id = f.intent_id
  WHERE f.event_name = 'Intent.DcaCompleted'
),
pot_legs AS (
  SELECT block_height, assumeNotNull(t.extrinsic_index) AS extrinsic_index,
         lower(from_account) AS src, lower(to_account) AS dst, asset_id, toDecimal256(if(amount = '', '0', amount), 0) AS amount
  FROM price_data.transfer_activity_by_time AS t FINAL
  WHERE event_name = 'Currencies.Transferred' AND t.extrinsic_index IS NOT NULL AND block_height >= ${ICE_MIN_BLOCK} AND ${pf}
    AND (from_account = '${ICE_POT_ACCOUNT}' OR to_account = '${ICE_POT_ACCOUNT}')
),
moved AS (
  SELECT block_height, extrinsic_index, if(dst = '${ICE_POT_ACCOUNT}', src, dst) AS account, asset_id,
         if(dst = '${ICE_POT_ACCOUNT}', 'in', 'out') AS dir, sum(amount) AS amount
  FROM pot_legs GROUP BY block_height, extrinsic_index, account, asset_id, dir
),
stated AS (
  SELECT block_height, extrinsic_index, account, asset_in AS asset_id, 'in' AS dir, sum(stated_in) AS amount
  FROM intent_fills WHERE event_name != 'Intent.DcaCompleted' GROUP BY block_height, extrinsic_index, account, asset_id
  UNION ALL
  SELECT block_height, extrinsic_index, account, asset_out, 'out', sum(stated_out)
  FROM intent_fills WHERE event_name != 'Intent.DcaCompleted' GROUP BY block_height, extrinsic_index, account, asset_out
),
claims AS (
  SELECT block_height, extrinsic_index, account, asset_in AS asset_id, 'in' AS dir, count() AS n
  FROM intent_fills WHERE event_name = 'Intent.DcaCompleted' GROUP BY block_height, extrinsic_index, account, asset_id
  UNION ALL
  SELECT block_height, extrinsic_index, account, asset_out, 'out', count()
  FROM intent_fills WHERE event_name = 'Intent.DcaCompleted' GROUP BY block_height, extrinsic_index, account, asset_out
),
completion AS (
  SELECT c.block_height AS block_height, c.extrinsic_index AS extrinsic_index, c.account AS account, c.asset_id AS asset_id, c.dir AS dir,
         if(c.n = 1, greatest(m.amount - s.amount, toDecimal256(0, 0)), toDecimal256(0, 0)) AS amount
  FROM claims c
  LEFT JOIN moved m ON m.block_height = c.block_height AND m.extrinsic_index = c.extrinsic_index AND m.account = c.account AND m.asset_id = c.asset_id AND m.dir = c.dir
  LEFT JOIN stated s ON s.block_height = c.block_height AND s.extrinsic_index = c.extrinsic_index AND s.account = c.account AND s.asset_id = c.asset_id AND s.dir = c.dir
),
intent_trades AS (
  SELECT f.block_height AS block_height, f.event_index AS event_index, f.block_time AS block_time, f.account AS account,
         f.asset_in AS asset_in, f.asset_out AS asset_out,
         if(f.event_name = 'Intent.DcaCompleted', if(ci.amount > 0, ci.amount, cf.amount), f.stated_in) AS amount_in,
         if(f.event_name = 'Intent.DcaCompleted', co.amount, f.stated_out) AS amount_out
  FROM intent_fills f
  LEFT JOIN completion ci ON ci.block_height = f.block_height AND ci.extrinsic_index = f.extrinsic_index AND ci.account = f.account AND ci.asset_id = f.asset_in AND ci.dir = 'in'
  LEFT JOIN completion co ON co.block_height = f.block_height AND co.extrinsic_index = f.extrinsic_index AND co.account = f.account AND co.asset_id = f.asset_out AND co.dir = 'out'
  LEFT JOIN completion_fallback cf ON cf.block_height = f.block_height AND cf.event_index = f.event_index
)`
  // Direct EVM swaps in the concentrated-liquidity (Uniswap v3) pools emit no Broadcast,
  // so the pool's own Swap log is the trade; the trader is the log's recipient in its
  // ETH-prefixed account form. A Router-routed hop through the pool has a `UniswapV3`
  // Swapped3 in its extrinsic and is already in `legs` through it, so those extrinsics
  // are left out here. Tokens resolve through the registry's contract addresses or the
  // `0x…01 + id` asset precompile (the pools and token map are the uniswap_v3_legs
  // job's own CTEs, and the bucket fingerprint covers both); a swap whose token
  // neither names is dropped rather than booked as asset 0.
  const v3Direct = `
v3_direct AS (
  SELECT concat('0x45544800', substring(e.counterparty, 3, 40), '0000000000000000') AS account,
         e.block_height AS block_height, e.event_index AS event_index, e.block_timestamp AS block_time,
         ${v3TokenAssetSql('t0.asset_id', 'p.token0')} AS asset0, ${v3TokenAssetSql('t1.asset_id', 'p.token1')} AS asset1,
         if(e.amount0 > 0, asset0, asset1) AS asset_in, if(e.amount0 > 0, asset1, asset0) AS asset_out,
         toDecimal256(toString(toUInt256(if(e.amount0 > 0, e.amount0, e.amount1))), 0) AS amount_in,
         toDecimal256(toString(toUInt256(abs(if(e.amount0 > 0, e.amount1, e.amount0)))), 0) AS amount_out
  FROM (SELECT block_height, event_index, extrinsic_index, block_timestamp, contract_address, counterparty, amount0, amount1
        FROM price_data.uniswap_v3_events FINAL WHERE kind = 'pool' AND event_name = 'Swap' AND ${pf}) e
  INNER JOIN pools p ON p.pool_address = e.contract_address
  LEFT JOIN token_assets t0 ON t0.addr = lower(p.token0)
  LEFT JOIN token_assets t1 ON t1.addr = lower(p.token1)
  WHERE e.counterparty != '' AND asset0 != 4294967295 AND asset1 != 4294967295
    AND (e.block_height, ifNull(e.extrinsic_index, 4294967295)) NOT IN (
      SELECT block_height, ifNull(extrinsic_index, 4294967295) FROM price_data.raw_events FINAL
      WHERE event_name = 'Broadcast.Swapped3' AND JSONExtractString(args_json, 'fillerType', '__kind') = 'UniswapV3' AND ${pf})
)`
  return `
INSERT INTO ${targetTable}
  (account, block_height, trade_key, volume_usd, net_in_usd, net_out_usd, trade_count, registry_fp, computed_at)
WITH ${V3_TOKEN_ASSETS_CTE},
${V3_POOLS_CTE},${legacyLegs},${intentFills},${v3Direct},
bcast AS (
  SELECT e.block_height AS block_height, e.event_index AS event_index, e.block_timestamp AS block_time,
         e.event_name AS event_name, e.args_json AS args_json, e.rid AS rid,
         -- An OTC fill cannot be booked against its swapper: the legs are always
         -- the TAKER's direction, while swapper names the order's MAKER in 620 of
         -- the 796 fills on chain and the taker in the other 176. The pallet's own
         -- fill event sits at event_index - 1 and names the taker as who; the taker
         -- is always one of {swapper, filler}, so the maker is the other one. Same
         -- rule as the live indexer and the repair script, which share it in
         -- src/blocks/otcCounterparty.ts. An unresolvable fill (no sibling event in
         -- its block, or a taker that is neither account) keeps swapper.
         -- The ICE pot's route legs are its fills a second time — but only where a
         -- fill in the same extrinsic books them to an owner. A solution whose fills
         -- name no owner yet (its IntentSubmitted not indexed, as in a backward
         -- backfill) keeps them on the pot rather than losing the trade, until the
         -- order lands and re-marks the fill's bucket. '' fails the account shape
         -- \`net\` keeps.
         if(e.swapper = '${ICE_POT_ACCOUNT}' AND (e.block_height, e.extrinsic_index) IN (SELECT block_height, extrinsic_index FROM intent_fills), '',
         multiIf(NOT e.is_otc, e.swapper,
                 t.taker = e.swapper, e.swapper,
                 t.taker = e.filler_acct, e.filler_acct,
                 e.swapper)) AS principal,
         multiIf(NOT e.is_otc, '',
                 t.taker = e.swapper, e.filler_acct,
                 t.taker = e.filler_acct, e.swapper,
                 '') AS passive,
         e.is_aave AS is_aave
  FROM (
    SELECT block_height, extrinsic_index, event_index, block_timestamp, event_name, args_json, ${rid} AS rid,
           JSONExtractString(args_json,'swapper') AS swapper,
           JSONExtractString(args_json,'filler') AS filler_acct,
           JSONExtractString(args_json,'fillerType','__kind') = 'OTC' AS is_otc,
           toUInt8(JSONExtractString(args_json,'fillerType','__kind') = 'AAVE') AS is_aave
    FROM price_data.raw_events FINAL
    WHERE event_name IN (${BROADCAST_EVENTS}) AND block_height >= ${BROADCAST_MIN_BLOCK} AND ${pf}
  ) e
  LEFT JOIN (
    SELECT block_height, event_index + 1 AS bc_index, JSONExtractString(args_json,'who') AS taker
    FROM price_data.raw_events FINAL
    WHERE event_name IN (${OTC_FILL_EVENTS}) AND ${pf}
  ) t ON t.block_height = e.block_height AND t.bc_index = e.event_index
),
legs AS (
  SELECT principal AS account, block_height, ${bcastKey} AS trade_key,
         block_time, JSONExtractInt(leg,'asset') AS asset_id,
         toDecimal256(${outAmount}, 0) AS samt, is_aave AS aave
  FROM bcast
  ARRAY JOIN JSONExtractArrayRaw(args_json,'outputs') AS leg
  UNION ALL
  SELECT principal, block_height, ${bcastKey},
         block_time, JSONExtractInt(leg,'asset'), -toDecimal256(${inAmount}, 0), is_aave
  FROM bcast
  ARRAY JOIN JSONExtractArrayRaw(args_json,'inputs') AS leg
  UNION ALL
  -- The maker's mirror image of the same fill: it gave up what the order put OUT
  -- and received what came IN. Only OTC resolves a passive side, so these two arms
  -- are empty for every pool venue.
  SELECT passive, block_height, ${bcastKey},
         block_time, JSONExtractInt(leg,'asset'), -toDecimal256(${outAmount}, 0), is_aave
  FROM bcast
  ARRAY JOIN JSONExtractArrayRaw(args_json,'outputs') AS leg
  WHERE passive != ''
  UNION ALL
  SELECT passive, block_height, ${bcastKey},
         block_time, JSONExtractInt(leg,'asset'), toDecimal256(${inAmount}, 0), is_aave
  FROM bcast
  ARRAY JOIN JSONExtractArrayRaw(args_json,'inputs') AS leg
  WHERE passive != ''
  UNION ALL
  SELECT who AS account, block_height, trade_key,
         block_timestamp, toUInt32(greatest(0, JSONExtractInt(args_json,'assetIn'))),
         -toDecimal256(multiIf(event_name IN ('XYK.SellExecuted','LBP.SellExecuted'), JSONExtractString(args_json,'amount'),
                               event_name = 'XYK.BuyExecuted', JSONExtractString(args_json,'buyPrice'),
                               event_name = 'LBP.BuyExecuted', JSONExtractString(args_json,'amount'),
                               JSONExtractString(args_json,'amountIn')), 0), toUInt8(0)
  FROM legacy
  UNION ALL
  SELECT who, block_height, trade_key,
         block_timestamp, toUInt32(greatest(0, JSONExtractInt(args_json,'assetOut'))),
         toDecimal256(multiIf(event_name IN ('XYK.SellExecuted','LBP.SellExecuted'), JSONExtractString(args_json,'salePrice'),
                              event_name = 'XYK.BuyExecuted', JSONExtractString(args_json,'amount'),
                              event_name = 'LBP.BuyExecuted', JSONExtractString(args_json,'buyPrice'),
                              JSONExtractString(args_json,'amountOut')), 0), toUInt8(0)
  FROM legacy
  UNION ALL
  SELECT account, block_height, ${anchor} + event_index AS trade_key, block_time, asset_in, -amount_in, toUInt8(0)
  FROM intent_trades
  UNION ALL
  SELECT account, block_height, ${anchor} + event_index, block_time, asset_out, amount_out, toUInt8(0)
  FROM intent_trades
  UNION ALL
  SELECT account, block_height, ${anchor} + event_index AS trade_key, block_time, asset_in, -amount_in, toUInt8(0)
  FROM v3_direct
  UNION ALL
  SELECT account, block_height, ${anchor} + event_index, block_time, asset_out, amount_out, toUInt8(0)
  FROM v3_direct
),
net AS (
  SELECT account, block_height, trade_key, any(block_time) AS block_time, asset_id, sum(samt) AS net_amt, min(aave) AS all_aave
  FROM legs WHERE match(account, '^0x[0-9a-f]{64}$')
  GROUP BY account, block_height, trade_key, asset_id
),
valued AS (
  SELECT n.account AS account, n.block_height AS block_height, n.trade_key AS trade_key, n.all_aave AS all_aave,
         n.net_amt * ${normFactorSql('n.asset_id', md)} * toDecimal256(p.close, 12) / toDecimal256('${usdDivisor}', 0) AS net_usd
  FROM net n
  ASOF LEFT JOIN (
    SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close
    FROM price_data.ohlc_1h WHERE asset_id IN (${priceIdUniverse()})${priceWindowSql(opts.maxBlockTime)} GROUP BY asset_id, interval_start
  ) p ON p.asset_id = ${priceAliasSql('n.asset_id')} AND p.price_time <= n.block_time
)
SELECT account, block_height, trade_key,
       toDecimal128(greatest(sum(greatest(net_usd, toDecimal256(0, 12))), sum(greatest(-net_usd, toDecimal256(0, 12)))), 12) AS volume_usd,
       toDecimal128(sum(greatest(-net_usd, toDecimal256(0, 12))), 12) AS net_in_usd,
       toDecimal128(sum(greatest(net_usd, toDecimal256(0, 12))), 12) AS net_out_usd,
       toUInt32(1) AS trade_count, ${registryFp} AS registry_fp, toDateTime('${opts.computedAt}') AS computed_at
FROM valued
GROUP BY account, block_height, trade_key
HAVING volume_usd > 0 AND min(all_aave) = 0`
}
