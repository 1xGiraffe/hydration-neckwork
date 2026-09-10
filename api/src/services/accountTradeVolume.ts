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
const LEGACY_EVENTS = "'Omnipool.SellExecuted','Omnipool.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted','LBP.SellExecuted','LBP.BuyExecuted'"
const BROADCAST_EVENTS = "'Broadcast.Swapped','Broadcast.Swapped2','Broadcast.Swapped3'"
// ICE intents (runtime 443, block 14362830): a fill is the owner's trade. The four
// events that settle an intent — the last of a DCA is DcaCompleted alone, with no
// amounts of its own — and the solver's holding pot (`modlice_ice#`), through which
// every fill moves as one Currencies.Transferred in and one out.
const ICE_MIN_BLOCK = 14_362_830
const INTENT_FILL_EVENTS = "'Intent.IntentResolved','Intent.IntentResovedPartially','Intent.DcaTradeExecuted','Intent.DcaCompleted'"
// The OTC pallet's fill events, which name a fill's TAKER as `who` — the only
// thing that resolves an OTC Broadcast fill's two sides (see the `bcast` CTE).
const OTC_FILL_EVENTS = "'OTC.Filled','OTC.PartiallyFilled'"
const ICE_POT_ACCOUNT = '0x6d6f646c6963655f696365230000000000000000000000000000000000000000'

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
// (its two era legs). Single source of truth for the era split: the
// swap_source_partition_watermarks MV that feeds the incremental staleness check
// carries this predicate verbatim, and api/src/derivations/jobs.test.ts asserts
// the declared MV still matches it.
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
// Block bounds of a derived-table partition, i.e. the inverse of the
// `toYYYYMM(toDateTime(block_height * 12))` expression the partition key uses.
// A block is 12 synthetic seconds, so the month's first block is its UTC epoch
// second divided by 12, and the bound is exclusive at the next month's first block.
// "Synthetic" is load-bearing: 12 is a partitioning constant, decoupled from the
// chain's real block time (~12-15s until Q3 2025, ~6s since, 2s next), and it must stay identical across all
// six sites — see the note above account_trade_volume in
// clickhouse/schema/001_tables.sql. Do not re-pin it at a block-time change; a
// faster chain just makes each partition span fewer real days (~15 at 6s, ~5 at 2s,
// so proportionally more partitions go stale per real day and this job rebuilds
// more often), which is a cost question, never a correctness one.
export function partitionBlockRange(partition: string): { fromBlock: number; toBlock: number } {
  const year = Number(partition.slice(0, 4))
  const month = Number(partition.slice(4, 6))
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`invalid derived partition ${JSON.stringify(partition)}`)
  }
  const MS_PER_BLOCK = 12_000
  return {
    fromBlock: Math.floor(Date.UTC(year, month - 1, 1) / MS_PER_BLOCK),
    toBlock: Math.floor(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1) / MS_PER_BLOCK),
  }
}

// The ASOF right side is the whole ohlc_1h feed for every priced asset. A candle
// matches only where `price_time <= block_time`, so every candle whose hour closes
// after the partition's last trade is dead weight and can be cut. There is no safe
// lower bound: an asset with no candle inside the partition is valued at the last
// candle before it, however far back that lies. `maxBlockTime` is the partition's
// own last swap block timestamp, carried by the staleness watermark projection;
// omitting it values against the whole feed.
function priceWindowSql(maxBlockTime: string | undefined): string {
  if (maxBlockTime == null) return ''
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(maxBlockTime)) {
    throw new Error(`invalid partition price watermark ${JSON.stringify(maxBlockTime)}`)
  }
  return ` AND interval_start <= (toDateTime('${maxBlockTime}') - toIntervalHour(1))`
}

export function buildPartitionInsertSql(
  partition: string,
  targetTable = 'price_data.account_trade_volume',
  maxBlockTime?: string,
): string {
  const md = maxDecimals()
  const usdDivisor = (10n ** BigInt(md)).toString()
  const anchor = EVENT_ANCHOR_OFFSET.toString()
  // The derived table's partition is a synthetic month over `block_height * 12`
  // seconds. ClickHouse cannot invert that function chain into a primary-key range,
  // so filtering raw_events (ORDER BY block_height, event_index) on the expression
  // alone read every granule of the table for each rebuild. Hand the sort key the
  // equivalent explicit range and keep the expression for exactness.
  const { fromBlock, toBlock } = partitionBlockRange(partition)
  const pf = `block_height >= ${fromBlock} AND block_height < ${toBlock} AND toYYYYMM(toDateTime(block_height * 12)) = ${partition}`
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
  // ICE intents settle through the solver's pot: the pot runs the AMM routes (its
  // Broadcast legs, swapper = pot, stay the pot's — the routes it ran, as the fee
  // processor keeps its conversions) and the owner only pays into and receives out
  // of it. The owner's trade is the FILL: the Intent event's amounts for a resolve,
  // a partial or a DCA trade; for the budget-exhausting DcaCompleted, which states
  // none, the pot's settlement legs for that (solution, owner, asset) less the
  // sibling fills that state theirs — exact for one completion per (owner, asset)
  // in a solution, and nothing rather than a split guess for two. Keyed on the
  // Intent event, in the event-anchored space clear of router ids.
  const intentFills = `
intent_fills AS (
  SELECT e.block_height AS block_height, e.extrinsic_index AS extrinsic_index, e.event_index AS event_index,
         e.block_timestamp AS block_time, e.event_name AS event_name,
         lower(o.owner) AS account, o.asset_in AS asset_in, o.asset_out AS asset_out,
         toDecimal256(if(e.amount_in = '', '0', e.amount_in), 0) AS stated_in,
         toDecimal256(if(e.amount_out = '', '0', e.amount_out), 0) AS stated_out
  FROM (SELECT intent_id, block_height, assumeNotNull(extrinsic_index) AS extrinsic_index, event_index, block_timestamp, event_name, amount_in, amount_out
        FROM price_data.intent_events FINAL
        WHERE event_name IN (${INTENT_FILL_EVENTS}) AND extrinsic_index IS NOT NULL AND block_height >= ${ICE_MIN_BLOCK} AND ${pf}) e
  INNER JOIN (SELECT intent_id, owner, asset_in, asset_out FROM price_data.intent_orders FINAL) o ON o.intent_id = e.intent_id
),
pot_legs AS (
  SELECT block_height, assumeNotNull(extrinsic_index) AS extrinsic_index,
         lower(from_account) AS src, lower(to_account) AS dst, asset_id, toDecimal256(if(amount = '', '0', amount), 0) AS amount
  FROM price_data.transfer_activity_by_time FINAL
  WHERE event_name = 'Currencies.Transferred' AND extrinsic_index IS NOT NULL AND block_height >= ${ICE_MIN_BLOCK} AND ${pf}
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
         if(f.event_name = 'Intent.DcaCompleted', ci.amount, f.stated_in) AS amount_in,
         if(f.event_name = 'Intent.DcaCompleted', co.amount, f.stated_out) AS amount_out
  FROM intent_fills f
  LEFT JOIN completion ci ON ci.block_height = f.block_height AND ci.extrinsic_index = f.extrinsic_index AND ci.account = f.account AND ci.asset_id = f.asset_in AND ci.dir = 'in'
  LEFT JOIN completion co ON co.block_height = f.block_height AND co.extrinsic_index = f.extrinsic_index AND co.account = f.account AND co.asset_id = f.asset_out AND co.dir = 'out'
)`
  // Direct EVM swaps in the concentrated-liquidity (Uniswap v3) pools emit no Broadcast,
  // so the pool's own Swap log is the trade; the trader is the log's recipient in its
  // ETH-prefixed account form. A Router-routed hop through the pool has a `UniswapV3`
  // Swapped3 in its extrinsic and is already in `legs` through it, so those extrinsics
  // are left out here. Tokens resolve through the registry's contract addresses or the
  // `0x…01 + id` asset precompile; a swap whose token neither names is dropped rather
  // than booked as asset 0.
  const v3Asset = (tokenExpr: string, joined: string) => {
    const hex = `replaceRegexpOne(lower(${tokenExpr}), '^0x', '')`
    return `if(${joined} > 0, toUInt32(${joined}), if(length(${hex}) = 40 AND substring(${hex}, 1, 32) = '00000000000000000000000000000001', toUInt32(reinterpretAsUInt32(reverse(unhex(substring(${hex}, 33, 8))))), toUInt32(4294967295)))`
  }
  const v3Direct = `
v3_direct AS (
  SELECT concat('0x45544800', substring(e.counterparty, 3, 40), '0000000000000000') AS account,
         e.block_height AS block_height, e.event_index AS event_index, e.block_timestamp AS block_time,
         ${v3Asset('p.token0', 't0.asset_id')} AS asset0, ${v3Asset('p.token1', 't1.asset_id')} AS asset1,
         if(e.amount0 > 0, asset0, asset1) AS asset_in, if(e.amount0 > 0, asset1, asset0) AS asset_out,
         toDecimal256(toString(toUInt256(if(e.amount0 > 0, e.amount0, e.amount1))), 0) AS amount_in,
         toDecimal256(toString(toUInt256(abs(if(e.amount0 > 0, e.amount1, e.amount0)))), 0) AS amount_out
  FROM (SELECT block_height, event_index, extrinsic_index, block_timestamp, contract_address, counterparty, amount0, amount1
        FROM price_data.uniswap_v3_events FINAL WHERE kind = 'pool' AND event_name = 'Swap' AND ${pf}) e
  INNER JOIN price_data.uniswap_v3_pools p ON p.pool_address = e.contract_address
  LEFT JOIN (SELECT lower(evm_address) AS addr, any(asset_id) AS asset_id FROM price_data.assets WHERE evm_address != '' GROUP BY addr) t0 ON t0.addr = lower(p.token0)
  LEFT JOIN (SELECT lower(evm_address) AS addr, any(asset_id) AS asset_id FROM price_data.assets WHERE evm_address != '' GROUP BY addr) t1 ON t1.addr = lower(p.token1)
  WHERE e.counterparty != '' AND asset0 != 4294967295 AND asset1 != 4294967295
    AND (e.block_height, ifNull(e.extrinsic_index, 4294967295)) NOT IN (
      SELECT block_height, ifNull(extrinsic_index, 4294967295) FROM price_data.raw_events FINAL
      WHERE event_name = 'Broadcast.Swapped3' AND JSONExtractString(args_json, 'fillerType', '__kind') = 'UniswapV3' AND ${pf})
)`
  return `
INSERT INTO ${targetTable}
  (account, block_height, trade_key, volume_usd, net_in_usd, net_out_usd, trade_count, computed_at)
WITH${legacyLegs},${intentFills},${v3Direct},
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
         -- this partition, or a taker that is neither account) keeps swapper, which
         -- is how it was booked before.
         multiIf(NOT e.is_otc, e.swapper,
                 t.taker = e.swapper, e.swapper,
                 t.taker = e.filler_acct, e.filler_acct,
                 e.swapper) AS principal,
         multiIf(NOT e.is_otc, '',
                 t.taker = e.swapper, e.filler_acct,
                 t.taker = e.filler_acct, e.swapper,
                 '') AS passive
  FROM (
    SELECT block_height, event_index, block_timestamp, event_name, args_json, ${rid} AS rid,
           JSONExtractString(args_json,'swapper') AS swapper,
           JSONExtractString(args_json,'filler') AS filler_acct,
           JSONExtractString(args_json,'fillerType','__kind') = 'OTC' AS is_otc
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
         toDecimal256(${outAmount}, 0) AS samt
  FROM bcast
  ARRAY JOIN JSONExtractArrayRaw(args_json,'outputs') AS leg
  UNION ALL
  SELECT principal, block_height, ${bcastKey},
         block_time, JSONExtractInt(leg,'asset'), -toDecimal256(${inAmount}, 0)
  FROM bcast
  ARRAY JOIN JSONExtractArrayRaw(args_json,'inputs') AS leg
  UNION ALL
  -- The maker's mirror image of the same fill: it gave up what the order put OUT
  -- and received what came IN. Only OTC resolves a passive side, so these two arms
  -- are empty for every pool venue.
  SELECT passive, block_height, ${bcastKey},
         block_time, JSONExtractInt(leg,'asset'), -toDecimal256(${outAmount}, 0)
  FROM bcast
  ARRAY JOIN JSONExtractArrayRaw(args_json,'outputs') AS leg
  WHERE passive != ''
  UNION ALL
  SELECT passive, block_height, ${bcastKey},
         block_time, JSONExtractInt(leg,'asset'), toDecimal256(${inAmount}, 0)
  FROM bcast
  ARRAY JOIN JSONExtractArrayRaw(args_json,'inputs') AS leg
  WHERE passive != ''
  UNION ALL
  SELECT who AS account, block_height, trade_key,
         block_timestamp, toUInt32(greatest(0, JSONExtractInt(args_json,'assetIn'))),
         -toDecimal256(multiIf(event_name IN ('XYK.SellExecuted','LBP.SellExecuted'), JSONExtractString(args_json,'amount'),
                               event_name = 'XYK.BuyExecuted', JSONExtractString(args_json,'buyPrice'),
                               event_name = 'LBP.BuyExecuted', JSONExtractString(args_json,'amount'),
                               JSONExtractString(args_json,'amountIn')), 0)
  FROM legacy
  UNION ALL
  SELECT who, block_height, trade_key,
         block_timestamp, toUInt32(greatest(0, JSONExtractInt(args_json,'assetOut'))),
         toDecimal256(multiIf(event_name IN ('XYK.SellExecuted','LBP.SellExecuted'), JSONExtractString(args_json,'salePrice'),
                              event_name = 'XYK.BuyExecuted', JSONExtractString(args_json,'amount'),
                              event_name = 'LBP.BuyExecuted', JSONExtractString(args_json,'buyPrice'),
                              JSONExtractString(args_json,'amountOut')), 0)
  FROM legacy
  UNION ALL
  SELECT account, block_height, ${anchor} + event_index AS trade_key, block_time, asset_in, -amount_in
  FROM intent_trades
  UNION ALL
  SELECT account, block_height, ${anchor} + event_index, block_time, asset_out, amount_out
  FROM intent_trades
  UNION ALL
  SELECT account, block_height, ${anchor} + event_index AS trade_key, block_time, asset_in, -amount_in
  FROM v3_direct
  UNION ALL
  SELECT account, block_height, ${anchor} + event_index, block_time, asset_out, amount_out
  FROM v3_direct
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
    FROM price_data.ohlc_1h WHERE asset_id IN (${priceIdUniverse()})${priceWindowSql(maxBlockTime)} GROUP BY asset_id, interval_start
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
