-- Read models for the public /v1 REST API. Three MV-fed projections over
-- raw_events, all replay-safe ReplacingMergeTree keyed on a natural on-chain
-- identity so a re-inserted raw range replaces its rows instead of adding to
-- them. pool_swap_legs is fed by five MVs — one per swap-event shape the chain
-- has emitted — that all write the same leg identity. Normative definitions:
-- api/src/public/ is the only reader; each service states its own semantics.
--
-- Extraction paths below are pinned against the shapes raw_events actually holds:
--
--   Broadcast.Swapped{,2,3} — {"swapper":"0x…","filler":"0x…",
--     "fillerType":{"__kind":"Omnipool"},"operation":{"__kind":"ExactIn"},
--     "inputs":[{"asset":1,"amount":"1040000000000"}],"outputs":[…],
--     "fees":[{"asset":0,"amount":"…","destination":{"__kind":"Account","value":"0x…"}}],
--     "operationStack":[{"__kind":"Router","value":10556971}]}
--   * Leg amounts are u128 on chain and JSON *strings* in args_json. They are
--     extracted and stored as String and only widened to UInt256 by the reader
--     that does arithmetic: an 18-decimal leg passes 2^64 routinely, so UInt64
--     would truncate and a float would lose precision.
--   * `operation` and `destination` are Substrate enums: `{"__kind":…}` plus a
--     `value` on the variants that carry one. destination is Account(AccountId32)
--     | Burned and has no third variant, so a fee leg always has a fee_dest and
--     only the Account variant carries a recipient.
--   * fillerType.value: absent for Omnipool/AAVE/HSM, the pool id for Stableswap,
--     the order id for OTC, the share-token id for XYK. Venues seen in the modern
--     era as of 2026-08-12: omnipool, stableswap, aave, xyk, hsm, otc. `lbp` is a
--     declared value that has never filled a Broadcast event; confirm the live set
--     with SELECT DISTINCT venue rather than trusting this line.
--   * `UniswapV3` (runtime 443) is EXCLUDED here: its Broadcast names the SwapRouter
--     as filler, never the pool, so a leg keyed on it would collapse every
--     concentrated-liquidity pool onto one key. The uniswap_v3_legs derivation
--     (api/src/derivations/jobs.ts) books the venue instead, from the pool's own Swap
--     log (which names the pool) — routed hops with their Router op_key, direct EVM
--     swaps with `evm:<block>:<event>` — as venue 'uniswapv3', pool_key = pool contract.
--
--   OmnipoolLiquidityMining/XYKLiquidityMining farm lifecycle — GlobalFarmCreated
--     and GlobalFarmUpdated name the farm `id`; every other lifecycle event names
--     it `globalFarmId` and adds `yieldFarmId`. Both spellings are read, so a farm
--     id is never silently 0. The WarehouseLM pallets' per-block
--     GlobalFarmAccRPZUpdated / YieldFarmAccRPVSUpdated accumulators and the
--     per-deposit Shares*/RewardClaimed events are not lifecycle and are excluded.
--
--   OTC — Placed carries assetIn/assetOut/amountIn/amountOut/partiallyFillable,
--     Filled/PartiallyFilled carry who/amountIn/amountOut/fee, Cancelled carries
--     orderId alone. Absent fields default to 0/'' rather than dropping the row.
--
--   Pre-Broadcast per-pallet *Executed events — the legacy era's only trade
--     record. Verified against src/types/{omnipool,stableswap,xyk}/events.ts and
--     against the shapes raw_events holds:
--   * Omnipool.SellExecuted/BuyExecuted — v115 {who, assetIn, assetOut, amountIn,
--     amountOut}; v170 adds {assetFeeAmount, protocolFeeAmount}; v201 adds
--     {hubAmountIn, hubAmountOut}. The fee fields are absent over blocks
--     1,708,104–3,112,599 and present from 3,112,604 on, so the fee legs are
--     emitted only when the event carries them — defaulting an absent field to 0
--     would invent 267,638 zero-fee legs in the pre-v170 range. The v201 hub
--     amounts are Omnipool's internal LRNA hop, not a user leg, and are not
--     projected.
--   * Stableswap.SellExecuted/BuyExecuted — v183 {who, poolId, assetIn, assetOut,
--     amountIn, amountOut, fee}, one shape for the whole era.
--   * XYK.SellExecuted {who, assetIn, assetOut, amount, salePrice, feeAsset,
--     feeAmount, pool} / XYK.BuyExecuted {who, assetOut, assetIn, amount,
--     buyPrice, feeAsset, feeAmount, pool} — v183, one shape for the whole era.
--   * LBP.SellExecuted/BuyExecuted — same field names as XYK minus `pool`. The
--     pallet is dead (640 events, blocks 3,681,850–4,198,163) and has no generated
--     type module, so the shape is read from raw.
--
-- Era boundary: block 6,837,788 is the first block emitting Broadcast.Swapped,
-- the unified swap event (verified: min(block_height) over the three Broadcast
-- names is exactly 6,837,788 and none fire below it). It is also the ONLY thing
-- separating the two eras in this table, because the legacy per-pallet events did
-- not stop — Omnipool.SellExecuted alone fires 4.7M more times at or above the
-- boundary, alongside the Broadcast event for the same fill. So each legacy MV
-- carries `block_height < 6837788` and the modern one `>= 6837788`; dropping
-- either clause double-projects every modern fill. Both sides match
-- api/src/services/accountTradeVolume.ts BROADCAST_MIN_BLOCK.

-- One row per swap-fill leg, dimensioned by venue. Feeds pool volumes, fee
-- revenue and platform totals; USD valuation is read-time (event-time ohlc
-- close), never stored, so a late price correction cannot leave this table wrong.
-- leg_index is the leg's position in the fill's concatenated in→out→fee legs, so
-- (block_height, event_index, leg_kind, leg_index) is a stable leg identity and
-- replaying the block replaces each leg exactly once.
--
-- op_key groups the legs of one ROUTED trade across its per-venue fills, which is
-- what platform-total netting has to sum over: a multi-hop route emits one fill
-- per hop, and grouping by extrinsic instead under-nets a batch that carries
-- several independent trades. It is the Router operation id, '' when the fill
-- carries no Router entry (a direct pallet swap or a block hook) — a consumer
-- netting those falls back to the leg's own (block_height, event_index), the same
-- way accountTradeVolume.ts anchors its unrouted keys.
CREATE TABLE IF NOT EXISTS price_data.pool_swap_legs (`venue` LowCardinality(String), `pool_key` String, `block_height` UInt32, `event_index` UInt32, `leg_index` UInt16, `leg_kind` Enum8('in' = 1, 'out' = 2, 'fee' = 3), `asset_id` UInt32, `amount` String, `fee_dest` LowCardinality(String), `fee_recipient` String, `swapper` String, `op_key` String, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (venue, pool_key, block_height, event_index, leg_kind, leg_index) SETTINGS index_granularity = 8192;

-- Liquidity-mining farm lifecycle, one row per event. args_json is kept raw and
-- folded in TS (the stableswap_pool_params idiom): the reward-curve and
-- yield-per-period fields differ per event and per pallet, and decoding them in
-- SQL would freeze today's shape into the schema. No /v1 endpoint consumes this
-- yet — it exists so farm APR can be added without a backfill later.
CREATE TABLE IF NOT EXISTS price_data.farm_config_events (`pallet` LowCardinality(String), `event_name` LowCardinality(String), `global_farm_id` UInt32, `yield_farm_id` Nullable(UInt32), `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `args_json` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (global_farm_id, block_height, event_index) SETTINGS index_granularity = 8192;

-- Typed OTC order events. Order state folds at read time (open = Placed with no
-- terminal event), so no stateful projection is needed. No /v1 endpoint consumes
-- this yet; it exists for the later feeds work. It does NOT supersede
-- otc_activity, which keeps args_json and extrinsic_index (and so the per-fill
-- `fee`) that this typed shape drops.
--
-- Consumer warning: asset_in/asset_out/amount_in/amount_out/partially_fillable are
-- only populated on Placed rows, and their absent-field default is 0 — which is
-- also HDX's real asset id. Read the pair from the order's Placed row, never from
-- a Filled/PartiallyFilled/Cancelled row, where 0 means "not carried by this
-- event" rather than "HDX".
CREATE TABLE IF NOT EXISTS price_data.otc_order_events (`order_id` UInt32, `event_name` LowCardinality(String), `asset_in` UInt32, `asset_out` UInt32, `amount_in` String, `amount_out` String, `partially_fillable` UInt8, `filler` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (order_id, block_height, event_index) SETTINGS index_granularity = 8192;

-- Explodes each Broadcast.Swapped* fill into its in/out/fee legs. The three leg
-- arrays are mapped to one tuple shape, concatenated, and ARRAY JOINed so a
-- single MV emits all three leg kinds and leg_index stays consistent across them.
--
-- The `legacy_exact_out` guard is Broadcast.Swapped v1's inverted-amount bug for
-- single-leg ExactOut XYK/LBP fills. It swaps the two AMOUNTS and leaves each
-- side's ASSET in place — exactly what decorateLegacyBroadcastTrade in
-- src/blocks/extractVolume.ts and the `inv` expression in
-- api/src/services/accountTradeVolume.ts do. Swapping the arrays wholesale
-- instead would move the assets too, exchanging the trade's two sides; because
-- the pair rarely shares decimals that error is unbounded rather than a rounding
-- slip. Swapped2 fixed the bug and later events carry the same fill shape
-- legitimately, so the event-name clause is what keeps the correction from
-- firing on them — it is load-bearing, not defensive.
--
-- op_key mirrors accountTradeVolume.ts's `rid`: the Router operation id read out
-- of operationStack by regex rather than by decoding the array, because the entry
-- is positional and its neighbours (DCA, Omnipool, …) vary per trade.
--
-- No FINAL: an MV is an insert trigger over the inserted block, and
-- deduplication is the destination table's replacement key's job.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.pool_swap_legs_mv TO price_data.pool_swap_legs (`venue` LowCardinality(String), `pool_key` String, `block_height` UInt32, `event_index` UInt32, `leg_index` UInt16, `leg_kind` Enum8('in' = 1, 'out' = 2, 'fee' = 3), `asset_id` UInt32, `amount` String, `fee_dest` LowCardinality(String), `fee_recipient` String, `swapper` String, `op_key` String, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `ingested_at` DateTime) AS WITH JSONExtractString(args_json, 'fillerType', '__kind') AS filler_kind, (event_name = 'Broadcast.Swapped' AND JSONExtractString(args_json, 'operation', '__kind') = 'ExactOut' AND JSONExtractString(args_json, 'fillerType', '__kind') IN ('XYK', 'LBP') AND length(JSONExtractArrayRaw(args_json, 'inputs')) = 1 AND length(JSONExtractArrayRaw(args_json, 'outputs')) = 1) AS legacy_exact_out, JSONExtractArrayRaw(args_json, 'inputs') AS in_raw, JSONExtractArrayRaw(args_json, 'outputs') AS out_raw, toUInt64OrZero(extractGroups(args_json, '"__kind":"Router","value":(\\d+)')[1]) AS router_id, arrayMap(x -> tuple(toUInt8(1), toUInt32(JSONExtractUInt(x, 'asset')), if(legacy_exact_out, JSONExtractString(out_raw[1], 'amount'), JSONExtractString(x, 'amount')), '', ''), in_raw) AS in_legs, arrayMap(x -> tuple(toUInt8(2), toUInt32(JSONExtractUInt(x, 'asset')), if(legacy_exact_out, JSONExtractString(in_raw[1], 'amount'), JSONExtractString(x, 'amount')), '', ''), out_raw) AS out_legs, arrayMap(x -> tuple(toUInt8(3), toUInt32(JSONExtractUInt(x, 'asset')), JSONExtractString(x, 'amount'), lower(JSONExtractString(x, 'destination', '__kind')), if(JSONExtractString(x, 'destination', '__kind') = 'Account', JSONExtractString(x, 'destination', 'value'), '')), JSONExtractArrayRaw(args_json, 'fees')) AS fee_legs, arrayConcat(in_legs, out_legs, fee_legs) AS legs SELECT lower(filler_kind) AS venue, multiIf(filler_kind = 'Omnipool', 'omnipool', filler_kind IN ('Stableswap', 'OTC'), toString(JSONExtractUInt(args_json, 'fillerType', 'value')), JSONExtractString(args_json, 'filler')) AS pool_key, block_height, event_index, toUInt16(leg_i - 1) AS leg_index, CAST(legs[leg_i].1 AS Enum8('in' = 1, 'out' = 2, 'fee' = 3)) AS leg_kind, legs[leg_i].2 AS asset_id, legs[leg_i].3 AS amount, legs[leg_i].4 AS fee_dest, legs[leg_i].5 AS fee_recipient, JSONExtractString(args_json, 'swapper') AS swapper, if(router_id > 0, toString(router_id), '') AS op_key, extrinsic_index, block_timestamp, ingested_at FROM price_data.raw_events ARRAY JOIN arrayEnumerate(legs) AS leg_i WHERE event_name IN ('Broadcast.Swapped', 'Broadcast.Swapped2', 'Broadcast.Swapped3') AND block_height >= 6837788 AND filler_kind != 'UniswapV3';

-- Legacy-era (pre-Broadcast) fills, one MV per pallet, into the same table and
-- the same leg identity. Four notes hold for all four:
--
--   * op_key is '' — Router.Executed exists in that era but carries no operation
--     id, so there is nothing to group a multi-hop route by. Consumers fall back
--     to the leg's own (block_height, event_index), exactly as they already do
--     for an unrouted modern fill.
--   * leg_index is the leg's position in the same in→out→fee concatenation the
--     modern MV builds, so a legacy row's identity means what a modern row's
--     means. A pallet that emits no fee field emits no fee leg rather than a
--     zero one, which is why the concatenation is built with arrayConcat over
--     conditional pieces instead of a fixed-length list.
--   * Amounts stay JSON strings for the same 2^64 reason as the modern MV. The
--     asset ids are JSON numbers here (not strings), so they go through
--     JSONExtractInt with the greatest(0, …) clamp the 003 swap views use.
--   * fee_dest/fee_recipient record only what the event actually carries, with one
--     exception the chain settles for us. The legacy events name no destination
--     enum. Measured over the 112k blocks straight above the boundary
--     (6,837,788–6,950,000), the Omnipool ASSET fee reaches three recipients —
--     the pool 117,713 times, referrals 59,609 and staking 58,090 — so which of
--     the three a legacy asset fee went to is genuinely unknowable and that leg
--     keeps fee_dest ''. The PROTOCOL fee is not ambiguous: all 115,913 LRNA
--     protocol-fee legs in that same window are Burned, so the legacy protocol
--     leg is recorded as 'burned' (see the Omnipool MV below). '' there would let
--     burned LRNA through every `fee_dest != 'burned'` filter and book it as
--     accrued revenue for the whole legacy era.

-- Omnipool legacy fills. protocolFeeAmount is charged in LRNA (asset 1), and
-- assetFeeAmount in the asset LEAVING the pool — except on a BUY before the
-- runtime upgrade at block 4,221,778, where it is charged in the asset ENTERING
-- it. Both halves are measured over the whole legacy era, on the fills whose two
-- assets have DIFFERENT decimals (the only ones where the two readings are
-- distinguishable rather than a coincidence of scale):
--
--   * Sells: 1,655,268 of 1,655,488 put the fee at 0.05–5% of amountOut and only
--     5 at that fraction of amountIn. One side, the whole era.
--   * Buys: the split is by block and it is total. Below 4,221,778, 25,913 of
--     25,913 read as a fraction of amountIn and none as a fraction of amountOut;
--     at or above it, 265,339 of 265,421 read the other way round. The last
--     in-asset buy is block 4,221,745, the first out-asset buy 4,221,815, and the
--     only runtime upgrade between them (ParachainSystem.ValidationFunctionApplied)
--     is block 4,221,778, with no buy in the gap — so the boundary is that
--     upgrade, not a fitted constant.
--
-- Reading the wrong side is not a rounding error: block 3,739,855 buys 0.1 WBTC
-- (8 decimals) for 3,526 DAI and pays 10.65 DAI of fee. Booked against WBTC that
-- same integer is 106 billion WBTC, and one such fill values a day's fees at
-- 1e16 USD. The median-only check that missed this is why the measurement above
-- is stated per direction and per era, not as one median.
--
-- The two fee fields always appear together (v170+) or not at all (v115), so one
-- JSONHas gates both legs.
--
-- The protocol leg carries fee_dest 'burned' rather than the asset leg's '':
-- 115,913 of 115,913 LRNA protocol-fee legs over blocks 6,837,788–6,950,000 are
-- Burned. (The current era credits LRNA protocol fees to an Account instead —
-- that change is later than the boundary and says nothing about the legacy era,
-- so the boundary measurement is the one that transfers backwards.)
--
-- Consumer warning — the two eras report a DIFFERENT FILL SHAPE for this venue.
-- Every one of 44,165 sampled modern Omnipool fills touches the hub: the router
-- reports A→LRNA and LRNA→B as two fills. A legacy fill is the whole A→B swap
-- with no hub leg — only 11,628 of 2,528,860 legacy fills (0.46%) name asset 1 at
-- all, and those are users genuinely trading LRNA. Netted volume and fee totals
-- are era-consistent, but a consumer that SELECTS hub legs (asset_id = 1 on the
-- in or out side) as its unit of Omnipool activity finds zero legacy events.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.pool_swap_legs_omnipool_legacy_mv TO price_data.pool_swap_legs (`venue` LowCardinality(String), `pool_key` String, `block_height` UInt32, `event_index` UInt32, `leg_index` UInt16, `leg_kind` Enum8('in' = 1, 'out' = 2, 'fee' = 3), `asset_id` UInt32, `amount` String, `fee_dest` LowCardinality(String), `fee_recipient` String, `swapper` String, `op_key` String, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `ingested_at` DateTime) AS WITH toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn'))) AS asset_in, toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut'))) AS asset_out, arrayConcat([tuple(toUInt8(1), asset_in, JSONExtractString(args_json, 'amountIn'), '', '')], [tuple(toUInt8(2), asset_out, JSONExtractString(args_json, 'amountOut'), '', '')], if(JSONHas(args_json, 'assetFeeAmount'), [tuple(toUInt8(3), if(event_name = 'Omnipool.BuyExecuted' AND block_height < 4221778, asset_in, asset_out), JSONExtractString(args_json, 'assetFeeAmount'), '', ''), tuple(toUInt8(3), toUInt32(1), JSONExtractString(args_json, 'protocolFeeAmount'), 'burned', '')], CAST([], 'Array(Tuple(UInt8, UInt32, String, String, String))'))) AS legs SELECT 'omnipool' AS venue, 'omnipool' AS pool_key, block_height, event_index, toUInt16(leg_i - 1) AS leg_index, CAST(legs[leg_i].1 AS Enum8('in' = 1, 'out' = 2, 'fee' = 3)) AS leg_kind, legs[leg_i].2 AS asset_id, legs[leg_i].3 AS amount, legs[leg_i].4 AS fee_dest, legs[leg_i].5 AS fee_recipient, JSONExtractString(args_json, 'who') AS swapper, '' AS op_key, extrinsic_index, block_timestamp, ingested_at FROM price_data.raw_events ARRAY JOIN arrayEnumerate(legs) AS leg_i WHERE event_name IN ('Omnipool.SellExecuted', 'Omnipool.BuyExecuted') AND block_height < 6837788;

-- Stableswap legacy fills. pool_key is the poolId as a string, matching what the
-- modern MV reads out of fillerType.value for this venue. The single `fee` is
-- charged on OPPOSITE sides of the trade per event — the pallet documents Sell as
-- "fee paid in asset leaving the pool" and Buy as "fee paid in asset entering the
-- pool", and the modern era agrees (of 28,686 sampled Stableswap fills, 10,315
-- carry the fee on the out asset against 10,286 SellExecuted events in the same
-- range, 18,371 on the in asset against 14,805 BuyExecuted plus the pallet's
-- liquidity operations, which also fill through Broadcast). Reading one side for
-- both would misattribute every buy's fee to the wrong asset. The fee stays in
-- the pool, whose account is a poolId sub-account SQL cannot derive, so the
-- destination is recorded as an account credit with the recipient left empty.
--
-- The fee's relationship to the trade legs also differs by direction, per the
-- pallet's event docs: a sell's fee is ALREADY SUBTRACTED from amountOut, a buy's
-- is ALREADY INCLUDED in amountIn. Either way the fee leg restates value the
-- in/out legs already account for, so a consumer that adds fee legs to trade legs
-- double-counts it — fee legs are a revenue breakdown, not extra flow.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.pool_swap_legs_stableswap_legacy_mv TO price_data.pool_swap_legs (`venue` LowCardinality(String), `pool_key` String, `block_height` UInt32, `event_index` UInt32, `leg_index` UInt16, `leg_kind` Enum8('in' = 1, 'out' = 2, 'fee' = 3), `asset_id` UInt32, `amount` String, `fee_dest` LowCardinality(String), `fee_recipient` String, `swapper` String, `op_key` String, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `ingested_at` DateTime) AS WITH toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn'))) AS asset_in, toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut'))) AS asset_out, arrayConcat([tuple(toUInt8(1), asset_in, JSONExtractString(args_json, 'amountIn'), '', '')], [tuple(toUInt8(2), asset_out, JSONExtractString(args_json, 'amountOut'), '', '')], [tuple(toUInt8(3), if(event_name = 'Stableswap.SellExecuted', asset_out, asset_in), JSONExtractString(args_json, 'fee'), 'account', '')]) AS legs SELECT 'stableswap' AS venue, toString(toUInt32(greatest(0, JSONExtractInt(args_json, 'poolId')))) AS pool_key, block_height, event_index, toUInt16(leg_i - 1) AS leg_index, CAST(legs[leg_i].1 AS Enum8('in' = 1, 'out' = 2, 'fee' = 3)) AS leg_kind, legs[leg_i].2 AS asset_id, legs[leg_i].3 AS amount, legs[leg_i].4 AS fee_dest, legs[leg_i].5 AS fee_recipient, JSONExtractString(args_json, 'who') AS swapper, '' AS op_key, extrinsic_index, block_timestamp, ingested_at FROM price_data.raw_events ARRAY JOIN arrayEnumerate(legs) AS leg_i WHERE event_name IN ('Stableswap.SellExecuted', 'Stableswap.BuyExecuted') AND block_height < 6837788;

-- XYK legacy fills. The pallet names the amounts by role, not by side: a sell is
-- (amount paid, salePrice received) and a buy is (buyPrice paid, amount received)
-- — the mapping swap_activity_mv and accountTradeVolume.ts already use. The event
-- names its own feeAsset, so no side has to be inferred: over the whole legacy era
-- feeAsset is assetOut on all 256,365 sells and assetIn on all 35,157 buys.
-- pool_key and fee_recipient are both the `pool` account the event carries, which
-- is the same account the modern era reports as the XYK fee recipient (for example
-- 0xb941ce…95ce appears as both), so the credit is asserted from evidence.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.pool_swap_legs_xyk_legacy_mv TO price_data.pool_swap_legs (`venue` LowCardinality(String), `pool_key` String, `block_height` UInt32, `event_index` UInt32, `leg_index` UInt16, `leg_kind` Enum8('in' = 1, 'out' = 2, 'fee' = 3), `asset_id` UInt32, `amount` String, `fee_dest` LowCardinality(String), `fee_recipient` String, `swapper` String, `op_key` String, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `ingested_at` DateTime) AS WITH toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn'))) AS asset_in, toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut'))) AS asset_out, JSONExtractString(args_json, 'pool') AS pool_account, arrayConcat([tuple(toUInt8(1), asset_in, if(event_name = 'XYK.SellExecuted', JSONExtractString(args_json, 'amount'), JSONExtractString(args_json, 'buyPrice')), '', '')], [tuple(toUInt8(2), asset_out, if(event_name = 'XYK.SellExecuted', JSONExtractString(args_json, 'salePrice'), JSONExtractString(args_json, 'amount')), '', '')], [tuple(toUInt8(3), toUInt32(greatest(0, JSONExtractInt(args_json, 'feeAsset'))), JSONExtractString(args_json, 'feeAmount'), 'account', pool_account)]) AS legs SELECT 'xyk' AS venue, pool_account AS pool_key, block_height, event_index, toUInt16(leg_i - 1) AS leg_index, CAST(legs[leg_i].1 AS Enum8('in' = 1, 'out' = 2, 'fee' = 3)) AS leg_kind, legs[leg_i].2 AS asset_id, legs[leg_i].3 AS amount, legs[leg_i].4 AS fee_dest, legs[leg_i].5 AS fee_recipient, JSONExtractString(args_json, 'who') AS swapper, '' AS op_key, extrinsic_index, block_timestamp, ingested_at FROM price_data.raw_events ARRAY JOIN arrayEnumerate(legs) AS leg_i WHERE event_name IN ('XYK.SellExecuted', 'XYK.BuyExecuted') AND block_height < 6837788;

-- LBP legacy fills. LBP names its buy fields exactly as XYK does and means the
-- OPPOSITE by them: an LBP buy is (amount paid, buyPrice received), so LBP pays
-- `amount` on both sides of the pallet while XYK pays `amount` on a sell and
-- `buyPrice` on a buy. That is the divergence accountTradeVolume.ts documents and
-- the reason LBP gets its own MV instead of sharing XYK's; reading an LBP buy in
-- XYK's order exchanges the trade's two sides, and since the pair rarely shares
-- decimals the error is unbounded (one such misread booked $77.3M of volume for a
-- $1,562 trade). The event's own feeAmount cross-checks it: at block 4,196,692
-- feeAmount is 2.04% of `amount` in feeAsset = assetIn, which only holds if
-- `amount` is the paid side.
--
-- LBP.SellExecuted/BuyExecuted carry no `pool` (unlike XYK) and an MV cannot join
-- LBP.PoolCreated, so pool_key is '' — LBP legs are venue-scoped only. The pallet
-- emitted 640 fills in total and is dead, so no consumer needs a per-pool LBP
-- breakdown. The fee goes to the pool's configured collector, which the event does
-- not name, so the recipient stays empty.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.pool_swap_legs_lbp_legacy_mv TO price_data.pool_swap_legs (`venue` LowCardinality(String), `pool_key` String, `block_height` UInt32, `event_index` UInt32, `leg_index` UInt16, `leg_kind` Enum8('in' = 1, 'out' = 2, 'fee' = 3), `asset_id` UInt32, `amount` String, `fee_dest` LowCardinality(String), `fee_recipient` String, `swapper` String, `op_key` String, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `ingested_at` DateTime) AS WITH toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn'))) AS asset_in, toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut'))) AS asset_out, arrayConcat([tuple(toUInt8(1), asset_in, JSONExtractString(args_json, 'amount'), '', '')], [tuple(toUInt8(2), asset_out, if(event_name = 'LBP.SellExecuted', JSONExtractString(args_json, 'salePrice'), JSONExtractString(args_json, 'buyPrice')), '', '')], [tuple(toUInt8(3), toUInt32(greatest(0, JSONExtractInt(args_json, 'feeAsset'))), JSONExtractString(args_json, 'feeAmount'), 'account', '')]) AS legs SELECT 'lbp' AS venue, '' AS pool_key, block_height, event_index, toUInt16(leg_i - 1) AS leg_index, CAST(legs[leg_i].1 AS Enum8('in' = 1, 'out' = 2, 'fee' = 3)) AS leg_kind, legs[leg_i].2 AS asset_id, legs[leg_i].3 AS amount, legs[leg_i].4 AS fee_dest, legs[leg_i].5 AS fee_recipient, JSONExtractString(args_json, 'who') AS swapper, '' AS op_key, extrinsic_index, block_timestamp, ingested_at FROM price_data.raw_events ARRAY JOIN arrayEnumerate(legs) AS leg_i WHERE event_name IN ('LBP.SellExecuted', 'LBP.BuyExecuted') AND block_height < 6837788;

-- Farm lifecycle events of both liquidity-mining pallets. The event-name set is
-- the pallets' full lifecycle vocabulary, not only the names seen so far: several
-- have never fired, and naming them here means a first termination or resume
-- lands in the projection instead of being silently dropped.
--
-- raw_events.event_name is referenced table-qualified in both the projection and
-- the filter because this SELECT also aliases a column to `event_name`:
-- ClickHouse resolves a bare column in WHERE against the SELECT's aliases first,
-- so an unqualified `event_name IN (…)` here matches nothing and the projection
-- stays silently empty.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.farm_config_events_mv TO price_data.farm_config_events (`pallet` LowCardinality(String), `event_name` LowCardinality(String), `global_farm_id` UInt32, `yield_farm_id` Nullable(UInt32), `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `args_json` String, `ingested_at` DateTime) AS SELECT if(startsWith(raw_events.event_name, 'OmnipoolLiquidityMining.'), 'omnipool_lm', 'xyk_lm') AS pallet, splitByChar('.', raw_events.event_name)[2] AS event_name, toUInt32(if(JSONHas(args_json, 'globalFarmId'), JSONExtractUInt(args_json, 'globalFarmId'), JSONExtractUInt(args_json, 'id'))) AS global_farm_id, if(JSONHas(args_json, 'yieldFarmId'), toNullable(toUInt32(JSONExtractUInt(args_json, 'yieldFarmId'))), NULL) AS yield_farm_id, block_height, event_index, block_timestamp, args_json, ingested_at FROM price_data.raw_events WHERE raw_events.event_name IN ('OmnipoolLiquidityMining.GlobalFarmCreated', 'OmnipoolLiquidityMining.GlobalFarmUpdated', 'OmnipoolLiquidityMining.GlobalFarmTerminated', 'OmnipoolLiquidityMining.YieldFarmCreated', 'OmnipoolLiquidityMining.YieldFarmUpdated', 'OmnipoolLiquidityMining.YieldFarmStopped', 'OmnipoolLiquidityMining.YieldFarmResumed', 'OmnipoolLiquidityMining.YieldFarmTerminated', 'XYKLiquidityMining.GlobalFarmCreated', 'XYKLiquidityMining.GlobalFarmUpdated', 'XYKLiquidityMining.GlobalFarmTerminated', 'XYKLiquidityMining.YieldFarmCreated', 'XYKLiquidityMining.YieldFarmUpdated', 'XYKLiquidityMining.YieldFarmStopped', 'XYKLiquidityMining.YieldFarmResumed', 'XYKLiquidityMining.YieldFarmTerminated');

-- OTC order events, one row per event. Only Placed carries the asset pair and
-- partiallyFillable, and only Filled/PartiallyFilled carry the filling account,
-- so the missing fields default rather than suppressing the event.
--
-- raw_events.event_name is table-qualified for the same alias-shadowing reason as
-- farm_config_events_mv above.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.otc_order_events_mv TO price_data.otc_order_events (`order_id` UInt32, `event_name` LowCardinality(String), `asset_in` UInt32, `asset_out` UInt32, `amount_in` String, `amount_out` String, `partially_fillable` UInt8, `filler` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `ingested_at` DateTime) AS SELECT toUInt32(JSONExtractUInt(args_json, 'orderId')) AS order_id, splitByChar('.', raw_events.event_name)[2] AS event_name, toUInt32(JSONExtractUInt(args_json, 'assetIn')) AS asset_in, toUInt32(JSONExtractUInt(args_json, 'assetOut')) AS asset_out, JSONExtractString(args_json, 'amountIn') AS amount_in, JSONExtractString(args_json, 'amountOut') AS amount_out, toUInt8(JSONExtractBool(args_json, 'partiallyFillable')) AS partially_fillable, JSONExtractString(args_json, 'who') AS filler, block_height, event_index, block_timestamp, ingested_at FROM price_data.raw_events WHERE raw_events.event_name IN ('OTC.Placed', 'OTC.Filled', 'OTC.PartiallyFilled', 'OTC.Cancelled');

-- Hourly leg sums: pool_swap_legs folded to one row per
-- (venue, pool_key, asset_id, leg_kind, fee_dest, fee_recipient, hour).
-- MEASURED over the whole era: 65,450,926 legs collapse to 3,009,629 rows (22x),
-- and the omnipool fee slice those readers take collapses 22,897,119 legs to
-- 539,833 rows (42x).
--
-- WHY THIS IS NOT A MATERIALIZED VIEW, against the derivation hierarchy in
-- AGENTS.md § Schema and derivations:
--
--  1. An MV cannot express it. pool_swap_legs is ReplacingMergeTree(ingested_at),
--     so re-indexing a raw range inserts a SECOND copy of every leg. An
--     AggregatingMergeTree/SummingMergeTree MV fed by it — or fed by raw_events
--     with the same extraction — adds both copies into the hour's sum: exactly the
--     "additive materialized view that double-counts replays" AGENTS.md forbids.
--     A sum has no replay-idempotent mergeable state (uniqState is idempotent but
--     answers a different question; a maxMap keyed on the leg identity is
--     idempotent but stores one entry per leg, i.e. no aggregation at all).
--     Deduplication has to happen BEFORE the sum, which is a cross-row operation
--     an insert-trigger MV cannot do.
--  2. It is not per-entity, so request-time reconstruction and the coordinated
--     refresher's in-memory snapshots do not apply.
--  3. It is not a swept per-entity model: there is no entity, and its definition
--     is SQL rather than an application-code classification.
--  4. So it is the remaining case — a global, heavy model none of the above can
--     express — which is what the derivations service exists for. The job is an
--     hourly fold (api/src/derivations/jobs.ts, runHourlyFold): each cycle it
--     recomputes only the hours whose legs were ingested since they were last
--     folded, found through pool_swap_hour_watermarks below.
--
-- Partitioning matches the source exactly: hour is derived from block_timestamp,
-- so toYYYYMM(hour) = toYYYYMM(block_timestamp) and one derived partition is one
-- source partition. A month holding recomputed hours is republished whole with
-- REPLACE PARTITION from the staging twin (its untouched hours copied, its stale
-- hours recomputed), so a partition is always exactly one publication and the
-- ReplacingMergeTree key can never hold two versions of a row — readers need no
-- FINAL and no argMax.
--
-- amount_sum is a String for the same reason pool_swap_legs.amount is: an hour of
-- 18-decimal legs passes 2^64 by a wide margin, and it is only ever widened to
-- Decimal256 by the reader that does arithmetic. leg_count is the number of
-- DEDUPLICATED legs behind the sum, which is what makes a row's arithmetic
-- checkable against raw.
--
-- The job never writes the hour in progress, so every row present is a CLOSED
-- hour, and each hour is folded on the first cycle after it closes. The per-pool
-- volume reader (api/src/data/services/poolsData.ts) takes closed hours from here
-- and the tail from pool_swap_legs, split at max(hour) + 1 hour; an empty or
-- lagging table pushes the cut DOWN, so the raw arm answers more of the range and
-- the split costs time rather than rows — it is not a coverage gate. The
-- platform readers (data/services/statsData.ts, public/services/defillama.ts) read
-- the closed hours alone.
--
-- The one bounded staleness this does NOT cover is raw arriving BELOW the cut: a
-- late or backfilled leg is missing from its hour until the watermark re-marks it
-- and the job refolds it, so a window over it under-reports for at most one
-- derivations poll cycle (DERIVATIONS_POLL_SECONDS, 600 s by default). Replays are
-- never affected — both arms collapse the leg identity before summing, so a
-- re-inserted range cannot double-count on either side of the cut.
--
-- pool_swap_hour_watermarks is the small MV-fed source index the hourly folds
-- decide their stale hours from: per chain-time hour, the newest leg ingest time
-- and the set of assets the hour's legs carry (what the valued folds fingerprint
-- the registry over). One row per hour (~32k for the whole chain) keeps the check
-- proportional to hours, not legs: max(ingested_at) over pool_swap_legs itself
-- measured a 68 M-row / 522 MiB scan. It is replay-safe — max and a set union are
-- idempotent, and a replay's newer ingested_at re-marks exactly its hour.
CREATE TABLE IF NOT EXISTS price_data.pool_swap_hour_watermarks (`hour` DateTime, `src_ingest` SimpleAggregateFunction(max, DateTime), `assets` SimpleAggregateFunction(groupUniqArrayArray, Array(UInt32))) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(hour) ORDER BY hour SETTINGS index_granularity = 64;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.pool_swap_hour_watermarks_mv TO price_data.pool_swap_hour_watermarks (`hour` DateTime, `src_ingest` SimpleAggregateFunction(max, DateTime), `assets` SimpleAggregateFunction(groupUniqArrayArray, Array(UInt32))) AS SELECT toStartOfHour(block_timestamp) AS hour, max(ingested_at) AS src_ingest, groupUniqArray(asset_id) AS assets FROM price_data.pool_swap_legs GROUP BY hour;

CREATE TABLE IF NOT EXISTS price_data.pool_swap_hourly (`venue` LowCardinality(String), `pool_key` String, `asset_id` UInt32, `leg_kind` Enum8('in' = 1, 'out' = 2, 'fee' = 3), `fee_dest` LowCardinality(String), `fee_recipient` String, `hour` DateTime, `amount_sum` String, `leg_count` UInt64, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY (venue, leg_kind, hour, asset_id, pool_key, fee_dest, fee_recipient) SETTINGS index_granularity = 8192;

-- Staging twin for pool_swap_hourly, identical in every respect. A republished
-- month is assembled here first and swapped in with ALTER TABLE … REPLACE
-- PARTITION, so readers see the previous month or the new one, never a partial one.
CREATE TABLE IF NOT EXISTS price_data.pool_swap_hourly_staging (`venue` LowCardinality(String), `pool_key` String, `asset_id` UInt32, `leg_kind` Enum8('in' = 1, 'out' = 2, 'fee' = 3), `fee_dest` LowCardinality(String), `fee_recipient` String, `hour` DateTime, `amount_sum` String, `leg_count` UInt64, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY (venue, leg_kind, hour, asset_id, pool_key, fee_dest, fee_recipient) SETTINGS index_granularity = 8192;

-- Hourly USD volume read models: pool_swap_legs folded per (venue, pool, hour)
-- and per (asset, venue, pool, hour), valued at event time. The definitions are
-- the public volume surfaces' own, composed from the same SQL fragments
-- (api/src/services/volumeHourly.ts states them; services/poolVolumes.ts owns
-- them), so a sum of these rows over a window is what /v1/pools/*/volumes
-- answers for it:
--
--   pool_volume_hourly — every FILL counted once in the pool it executed in,
--     valued by its out side (its in side when the out side is unpriced). The
--     Omnipool counts a user swap once: the A -> H2O first hop of a hub swap adds
--     nothing and the H2O -> B fill that completes it carries the swap. A trade
--     routed through two pools counts in both, so venue volumes sum to more than
--     routed volume. `fills` counts the fills that carry volume (Omnipool first
--     hops excluded); `unpriced_fills` those with no priced side, kept at 0 USD.
--     lp_fee_usd is the fee legs that accrue to the pool's liquidity providers
--     (the yield endpoints' rule), protocol_fee_usd every other fee leg (the
--     Omnipool's H2O fee and the asset-fee share routed away from the pool, burned
--     legs, OTC and LBP fees); together they are every fee leg. A Uniswap v3 fee
--     leg is the whole swap fee, so its protocol share — 1/n where the pool's
--     SetFeeProtocol denominator n for the fee's token was on at the swap, the
--     uniswap_v3_fee revenue stream's accrual rule — moves from lp_fee_usd to
--     protocol_fee_usd. Fees are never volume.
--   asset_volume_hourly — the value of an asset's own in/out legs (sold plus
--     bought) per fill, inheriting the fill's value when those legs are unpriced;
--     one fill A -> B adds to A and to B. The Omnipool hub asset H2O (id 1) has no
--     rows: its legs are the venue's plumbing, not asset trades. `legs` counts the
--     asset's in/out legs, `unpriced_legs` those of a side that ended at 0 USD.
--
-- Both exclude venue `aave` (an aToken mint/redeem is a 1:1 wrap, not a swap).
-- Valuation is the house rule: the 1h candle that had closed by the fill
-- (interval_start + 1 HOUR <= block_timestamp), the asset aliased through the
-- one historical price rule, exact Decimal at the 1e-12 USD scale.
--
-- Derivations jobs, not materialized views, for pool_swap_hourly's reason above
-- (the legs must be deduplicated before they are summed) plus a cross-row ASOF
-- price join and the Omnipool's next-fill window. The same hourly fold as
-- pool_swap_hourly, on the same watermarks and the same month republication, so
-- readers need no FINAL. Only hours below the cut are written — the newest leg's
-- hour is still filling, and an hour past the price pipeline's head (the older of
-- its newest block and its newest price row) has no whole candle yet — so every
-- row is a closed, priced hour, each folded on the first cycle after it closes
-- and is priced, and readers end at the cut (max(hour) + 1 hour); no raw tail. A
-- late or backfilled leg below the cut is missing until the watermark re-marks its
-- hour, at most one derivations cycle later. `registry_fp` is the registry's
-- valuation inputs (decimal unit, price alias, priceability) fingerprinted over
-- the hour's asset set when the hour was folded; a registry change that moves it
-- re-folds the hour on the next cycle. A repaired or late candle re-marks nothing,
-- so a price repair below the cut needs the affected hours' rows dropped by hand.
--
-- ORDER BY follows the readers: a pool's or a venue's hours; an asset's hours
-- across its venues. A platform-wide hour range prunes by month partition.
-- MEASURED over the whole era (2023-01 to 2026-10): 369,675 pool rows (6.6 MiB)
-- and 1,142,439 asset rows (15.3 MiB) in 46 months, ~9k and ~27k rows in a recent
-- month, so every reader shape (one pool, one venue, one asset, everything) reads
-- at most a few hundred thousand rows in single-digit milliseconds and needs no
-- projection.
CREATE TABLE IF NOT EXISTS price_data.pool_volume_hourly (`venue` LowCardinality(String), `pool_key` String, `hour` DateTime, `volume_usd` Decimal(38, 12), `fills` UInt32, `lp_fee_usd` Decimal(38, 12), `protocol_fee_usd` Decimal(38, 12), `unpriced_fills` UInt32, `registry_fp` UInt64, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY (venue, pool_key, hour) SETTINGS index_granularity = 8192;

-- Staging twin for pool_volume_hourly, identical in every respect (REPLACE PARTITION source).
CREATE TABLE IF NOT EXISTS price_data.pool_volume_hourly_staging (`venue` LowCardinality(String), `pool_key` String, `hour` DateTime, `volume_usd` Decimal(38, 12), `fills` UInt32, `lp_fee_usd` Decimal(38, 12), `protocol_fee_usd` Decimal(38, 12), `unpriced_fills` UInt32, `registry_fp` UInt64, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY (venue, pool_key, hour) SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS price_data.asset_volume_hourly (`asset_id` UInt32, `venue` LowCardinality(String), `pool_key` String, `hour` DateTime, `volume_usd` Decimal(38, 12), `legs` UInt32, `unpriced_legs` UInt32, `registry_fp` UInt64, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY (asset_id, hour, venue, pool_key) SETTINGS index_granularity = 8192;

-- Staging twin for asset_volume_hourly, identical in every respect (REPLACE PARTITION source).
CREATE TABLE IF NOT EXISTS price_data.asset_volume_hourly_staging (`asset_id` UInt32, `venue` LowCardinality(String), `pool_key` String, `hour` DateTime, `volume_usd` Decimal(38, 12), `legs` UInt32, `unpriced_legs` UInt32, `registry_fp` UInt64, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY (asset_id, hour, venue, pool_key) SETTINGS index_granularity = 8192;

-- Routed (netted) platform volume per hour: every trade counted ONCE, at the
-- larger of its two boundary sides after the per-asset netting across its route,
-- whole-trade aToken wraps excluded — the definition of public
-- /v1/stats/platform totalRoutedUsd and the DefiLlama day series, composed from
-- the same SQL (api/src/services/poolVolumes.ts routedNettedCteSql +
-- nettedTradeSidesSql; volumeHourly.ts states the fold), so an hourly sum over a
-- window is the routed figure for it and a UTC day's sum is DefiLlama's day.
-- `trades` counts the routed trades with a fill in the hour; `unpriced_trades`
-- those whose two sides both valued to 0. The pool and asset folds' job shape,
-- watermarks, cut and registry fingerprint; a request-time fold could not serve it
-- (one busy month MEASURED 22.8 s / 2.63 GiB against the explorer api's 20 s cap).
CREATE TABLE IF NOT EXISTS price_data.routed_volume_hourly (`hour` DateTime, `volume_usd` Decimal(38, 12), `trades` UInt32, `unpriced_trades` UInt32, `registry_fp` UInt64, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY hour SETTINGS index_granularity = 8192;

-- Staging twin for routed_volume_hourly, identical in every respect (REPLACE PARTITION source).
CREATE TABLE IF NOT EXISTS price_data.routed_volume_hourly_staging (`hour` DateTime, `volume_usd` Decimal(38, 12), `trades` UInt32, `unpriced_trades` UInt32, `registry_fp` UInt64, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY hour SETTINGS index_granularity = 8192;

-- GIGAHDX voting-reward read models, for GET /v1/staking/gigahdx/voting-apr
-- (spec § Semantics 10). Two tiny MV-fed projections over raw_events:
--
--   gigahdx_reward_allocations — one row per GigaHdxRewards.RewardPoolAllocated.
--     The pallet DELETES its per-referendum storage once the last voter's reward
--     is recorded, so these events are the only durable record of what was paid
--     and against which weighted-vote denominator. args shape (pinned against
--     raw): {"refIndex":381,"trackId":5,"totalReward":"…",
--     "totalWeightedVotes":"…","votersRemaining":188}. Both amounts are u128
--     JSON strings and stay String here; the reader widens to bigint.
--
--   gigahdx_stake_events — GigaHdx.Staked/Unstaked/YieldRealized flows, from
--     which the pallet's TotalLocked is an exact integer sum:
--     Σ Staked.amount + Σ YieldRealized.amount − Σ Unstaked.payout.
--     GigaHdx.MigratedFromLegacy is deliberately EXCLUDED: every migration also
--     emits a GigaHdx.Staked for the same amount (verified on the full history,
--     512 co-occurrences), so projecting both would double-count ~40% of the
--     stake. hdx_amount is the event's HDX-side value (amount / payout / amount
--     per event type); gigahdx_amount is the share-side value where the event
--     carries one ('' on YieldRealized).
--
-- On an existing deployment, create both tables + MVs and seed their history
-- once with each MV's exact SELECT (the normal uncommitted rollout backfill);
-- a fresh database fills them automatically while raw_events is ingested.
CREATE TABLE IF NOT EXISTS price_data.gigahdx_reward_allocations (`ref_index` UInt32, `track_id` UInt16, `total_reward` String, `total_weighted_votes` String, `voters_remaining` UInt32, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (ref_index, block_height, event_index) SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.gigahdx_reward_allocations_mv TO price_data.gigahdx_reward_allocations (`ref_index` UInt32, `track_id` UInt16, `total_reward` String, `total_weighted_votes` String, `voters_remaining` UInt32, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `ingested_at` DateTime) AS SELECT toUInt32(JSONExtractUInt(args_json, 'refIndex')) AS ref_index, toUInt16(JSONExtractUInt(args_json, 'trackId')) AS track_id, JSONExtractString(args_json, 'totalReward') AS total_reward, JSONExtractString(args_json, 'totalWeightedVotes') AS total_weighted_votes, toUInt32(JSONExtractUInt(args_json, 'votersRemaining')) AS voters_remaining, block_height, event_index, block_timestamp, ingested_at FROM price_data.raw_events WHERE raw_events.event_name = 'GigaHdxRewards.RewardPoolAllocated';

CREATE TABLE IF NOT EXISTS price_data.gigahdx_stake_events (`event_name` LowCardinality(String), `who` String, `hdx_amount` String, `gigahdx_amount` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (block_height, event_index) SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.gigahdx_stake_events_mv TO price_data.gigahdx_stake_events (`event_name` LowCardinality(String), `who` String, `hdx_amount` String, `gigahdx_amount` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `ingested_at` DateTime) AS SELECT splitByChar('.', raw_events.event_name)[2] AS event_name, JSONExtractString(args_json, 'who') AS who, if(raw_events.event_name = 'GigaHdx.Unstaked', JSONExtractString(args_json, 'payout'), JSONExtractString(args_json, 'amount')) AS hdx_amount, multiIf(raw_events.event_name = 'GigaHdx.Staked', JSONExtractString(args_json, 'gigahdx'), raw_events.event_name = 'GigaHdx.Unstaked', JSONExtractString(args_json, 'gigahdxAmount'), '') AS gigahdx_amount, block_height, event_index, block_timestamp, ingested_at FROM price_data.raw_events WHERE raw_events.event_name IN ('GigaHdx.Staked', 'GigaHdx.Unstaked', 'GigaHdx.YieldRealized');
