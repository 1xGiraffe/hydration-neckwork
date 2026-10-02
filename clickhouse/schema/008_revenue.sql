-- Protocol revenue read models, filled by the `revenue` derivations jobs
-- (api/src/derivations/jobs.ts) from the shared per-stream definitions in
-- api/src/services/revenueStreams.ts. Nothing here is written by an MV except
-- the small watermark index at the bottom. revenue_events is a progressive
-- hourly fold: each cycle recomputes only the hours whose sources changed and
-- republishes their month from its staging twin (the month's other hours plus
-- the recomputed ones, then REPLACE PARTITION); account_revenue rebuilds a month
-- whenever that month's revenue_events hours were republished. Re-runs are
-- idempotent, a recomputed hour equals a fresh build of it (rows that vanished
-- from it included), and readers never observe a half-built month or two
-- versions of a row.
--
-- revenue_events: one row per revenue event, event-time valued.
--   stream ∈ omnipool_asset_fee | omnipool_protocol_fee | liquidation_penalty |
--            pepl_liquidation_profit | asset_reserve | hollar_borrow |
--            hsm_revenue | ice_matched_fee | uniswap_v3_fee | network_fee |
--            xcm_execution_fee (REVENUE_STREAMS in revenueStreams.ts is the list).
--   Eventful streams carry their chain identity (block_height, event_index,
--   leg_index — leg_index disambiguates multi-row splits such as the
--   liquidation-penalty pro-rata attribution). The two borrow-interest streams
--   are reserve-level: hollar_borrow materializes HOURLY accrual rows
--   (block_height = 0, event_index = hour epoch / 3600, leg_index = reserve
--   ordinal, block_timestamp = the hour) and asset_reserve rows are the
--   MintedToTreasury realizations; both carry account = '' — their per-account
--   truth lives in account_revenue only. Identity needs to be unique within an
--   hour's build, not stable across runs, because publication replaces the
--   whole hour.
--   `dest` classifies the omnipool fee legs' destination ('protocol' | 'lp' |
--   'burned'; '' for every other stream). The lp/burned legs exist ONLY for
--   the public fees API's feeDestination matrix: every explorer revenue
--   surface and account_revenue filter to dest IN ('', 'protocol').
--   `internal_payer` marks what the protocol paid ITSELF (INTERNAL_PAYER_TAGS
--   in api/src/services/revenueStreams.ts — the treasury, the protocol
--   multisig, the pallet pots). Such a row is NOT revenue and leaves every
--   total and every ranking through PROTOCOL_REVENUE_PREDICATE_SQL, but it is
--   kept and marked rather than dropped, so the gross flow stays auditable and
--   the public fees API's destination matrix reads exactly what it always did.
--   The two reserve-level streams carry no payer, so their internal part is
--   carved out as a SECOND row (same identity, next leg_index): hollar_borrow
--   by the internal holders' own scaled debt against the same index move, and
--   asset_reserve by the internal share of the interest its mint window
--   accrued. External + internal always re-sums to the gross market flow.
--   `account` is the PAYER as it appears at source (substrate pubkey hex or
--   ETH-mapped account form); '' where genuinely unattributable (HSM arb
--   profit, reserve-level borrow rows, placeholder swapper).
--   `amount` is the raw integer amount of asset_id; `amount_usd` the
--   event-time valuation (hourly ASOF close, 1e-12 USD integer semantics).
--   `registry_fp` is the row's hour's fingerprint at computation (the registry
--   valuation of the hour's assets, the money market's chain state per reserve
--   asset, the internal-payer tags and, on hours with v3 sources, the v3
--   inputs), compared every cycle to re-value exactly the hours a change touches.
--   Only CLOSED, PRICED, SETTLED hours are written (below the newest source hour
--   and the price pipeline's head, its sources landed), so readers split cold/tail at each stream's max
--   block_timestamp without double counting; the tail comes from raw via the
--   same builders.
-- The staleness check needs only per-hour row count, max(computed_at) and
-- fingerprint range; computed_by_hour keeps that read key-sized instead of
-- grouping every row each cycle (as account_trade_volume's does in
-- 001_tables.sql), and `rebuild` is required so a replacing merge cannot leave
-- an aggregate projection out of sync.
CREATE TABLE IF NOT EXISTS price_data.revenue_events (`stream` LowCardinality(String), `block_height` UInt32, `block_timestamp` DateTime, `event_index` UInt32, `leg_index` UInt16, `dest` LowCardinality(String), `account` String, `asset_id` UInt32, `amount` String, `internal_payer` UInt8 DEFAULT 0, `amount_usd` Decimal(38, 12), `registry_fp` UInt64 DEFAULT 0, `computed_at` DateTime DEFAULT now(), PROJECTION computed_by_hour (SELECT toStartOfHour(block_timestamp) AS hour, count() AS n, max(computed_at) AS der_computed, min(registry_fp) AS fp_min, max(registry_fp) AS fp_max GROUP BY hour)) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (block_height, event_index, leg_index, stream) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';

-- Per-account, per-stream protocol revenue by calendar month (`month` =
-- toYYYYMM of the event time), rebuilt whole per month — the month is its key —
-- whenever the month's revenue_events hours were republished. Eventful streams are a GROUP BY of
-- revenue_events restricted to PROTOCOL_REVENUE_PREDICATE_SQL (dest
-- IN ('', 'protocol') and internal_payer = 0); the borrow streams
-- are attributed here from per-account scaled debt × Δ variable_borrow_index
-- (hollar_borrow directly — the sum over accounts equals the reserve series by
-- algebraic identity — and asset_reserve by splitting each MintedToTreasury
-- amount pro-rata over per-account interest accrued since the reserve's
-- previous mint). Every rounding or pre-history remainder lands on
-- account = '', so per stream and month
--   sum(account_revenue.revenue_usd) == sum(protocol-dest revenue_events.amount_usd)
-- holds exactly; readers must treat account = '' as "unattributed", never a
-- real payer. A publication writes each (account, stream, month) key ONCE
-- (a stream with two sources, uniswap_v3_fee, is folded before the insert;
-- the job refuses to publish a month with a doubled key): the replacing
-- engine would keep one row per key at its next merge, so readers sum the
-- rows as written and never rely on FINAL to add them. Account-first ORDER
-- BY serves the directory join and the account/tag lookups.
CREATE TABLE IF NOT EXISTS price_data.account_revenue (`account` String, `stream` LowCardinality(String), `month` UInt32, `revenue_usd` Decimal(38, 12), `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY month ORDER BY (account, stream, month) SETTINGS index_granularity = 8192;

-- Staging twins for the atomic REPLACE PARTITION publications — byte-identical
-- to their live tables (see the note above account_trade_volume_staging in
-- 001_tables.sql: engine, ORDER BY and PARTITION BY must match or the swap
-- publishes the wrong shape).
CREATE TABLE IF NOT EXISTS price_data.revenue_events_staging (`stream` LowCardinality(String), `block_height` UInt32, `block_timestamp` DateTime, `event_index` UInt32, `leg_index` UInt16, `dest` LowCardinality(String), `account` String, `asset_id` UInt32, `amount` String, `internal_payer` UInt8 DEFAULT 0, `amount_usd` Decimal(38, 12), `registry_fp` UInt64 DEFAULT 0, `computed_at` DateTime DEFAULT now(), PROJECTION computed_by_hour (SELECT toStartOfHour(block_timestamp) AS hour, count() AS n, max(computed_at) AS der_computed, min(registry_fp) AS fp_min, max(registry_fp) AS fp_max GROUP BY hour)) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (block_height, event_index, leg_index, stream) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';
CREATE TABLE IF NOT EXISTS price_data.account_revenue_staging (`account` String, `stream` LowCardinality(String), `month` UInt32, `revenue_usd` Decimal(38, 12), `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY month ORDER BY (account, stream, month) SETTINGS index_granularity = 8192;


-- Per-hour source watermarks for revenue_events' progressive fold, keyed by
-- the chain-time hour (toStartOfHour(block_timestamp)) — the fold's bucket. Per
-- hour and kind: the newest ingest time, the block span (every source read of a
-- recomputed hour is bounded to it), the assets the hour's rows are valued in
-- (the registry fingerprint's input) and whether it holds v3 sources. Asking the
-- sources directly would re-aggregate raw_events/raw_evm_logs every cycle;
-- max(), min() and groupUniqArray are idempotent under replay, so a re-inserted
-- range leaves every watermark unchanged, and a dropped raw row leaves one high
-- — re-marking an hour rather than hiding staleness. The legs (every venue's
-- fee and HSM legs, the v3 legs) come from pool_swap_hour_watermarks
-- (006_public.sql), which the hourly folds share.
--
-- `kind` splits the staleness semantics:
--   'events' — sources that only affect their own hour, because every eventful
--              stream is block-local: hour h is stale when wm(h) is newer than
--              h's computation;
--   'debt'   — sources whose rows change the OPENING state of every later hour
--              (debt-token scaled deltas feed cumulative balances; reserve
--              index and mint rows feed the accrual and the inter-mint
--              windows): hour h is stale when max over h' <= h of wm(h') is,
--              i.e. a backfilled row cascades staleness forward.
-- On an existing deployment the MVs only see inserts from creation on; the
-- rollout seeds history with a one-time ad-hoc INSERT…SELECT mirroring each
-- MV's SELECT (replay-safe: min/max aggregation), per the schema-and-derivations
-- rules — a fresh database populates from genesis automatically.
CREATE TABLE IF NOT EXISTS price_data.revenue_hour_watermarks (`hour` DateTime, `kind` LowCardinality(String), `src_ingest` SimpleAggregateFunction(max, DateTime), `src_minb` SimpleAggregateFunction(min, UInt32), `src_maxb` SimpleAggregateFunction(max, UInt32), `assets` SimpleAggregateFunction(groupUniqArrayArray, Array(UInt32)), `v3` SimpleAggregateFunction(max, UInt8)) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(hour) ORDER BY (hour, kind) SETTINGS index_granularity = 64;

-- Every raw_events row: the builders read a long list of event shapes (the
-- fee-paid events, the payer's debits, the treasury's deposits and the dust
-- before them, the EVM execution markers and logs, the XCM barriers and run
-- events, HSM and liquidation events, the ICE sweep, and the intent and
-- liquidation projections MV'd from these rows), so the watermark is not a
-- second list that a builder change could outgrow. The assets are those the
-- rows are valued in: HDX for the fee-paid events, the treasury deposit's
-- currency, the ICE sweep's, the liquidated debt asset.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_hour_watermarks_events_mv TO price_data.revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32), `v3` UInt8) AS SELECT toStartOfHour(block_timestamp) AS hour, 'events' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, groupUniqArrayArray(multiIf(event_name = 'TransactionPayment.TransactionFeePaid', [toUInt32(0)], (event_name IN ('Tokens.Deposited', 'Balances.Deposit', 'Currencies.Deposited')) AND (JSONExtractString(args_json, 'who') = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'), [if(event_name = 'Balances.Deposit', toUInt32(0), toUInt32(JSONExtractUInt(args_json, 'currencyId')))], (event_name = 'Currencies.Transferred') AND (JSONExtractString(args_json, 'from') = '0x6d6f646c6963655f696365230000000000000000000000000000000000000000'), [toUInt32(JSONExtractUInt(args_json, 'currencyId'))], event_name = 'Liquidation.Liquidated', [toUInt32(JSONExtractUInt(args_json, 'debtAsset'))], CAST([], 'Array(UInt32)'))) AS assets, toUInt8(0) AS v3 FROM price_data.raw_events GROUP BY hour;

-- Every raw_extrinsics row: the network-fee and XCM-execution payers, the
-- extrinsic's own fee and tip, the dispatch_permit scope.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_hour_watermarks_extrinsics_mv TO price_data.revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32), `v3` UInt8) AS SELECT toStartOfHour(block_timestamp) AS hour, 'events' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets, toUInt8(0) AS v3 FROM price_data.raw_extrinsics GROUP BY hour;

-- The raw_evm_logs the builders read: the liquidation penalty's aToken
-- transfer into the money-market collector, a Gamma vault's fee share as an
-- ERC-20 Transfer to the Treasury's EVM address (the builder narrows to known
-- vaults), and the v3 pools' Swap logs, whose legs the uniswap_v3_legs job
-- writes. The last two flag the hour `v3`: uniswap_v3_fee also reads the pools,
-- their SetFeeProtocol history and the vault set, which those hours'
-- fingerprints carry.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_hour_watermarks_evm_logs_mv TO price_data.revenue_hour_watermarks (`hour` DateTime, `kind` LowCardinality(String), `src_ingest` SimpleAggregateFunction(max, DateTime), `src_minb` SimpleAggregateFunction(min, UInt32), `src_maxb` SimpleAggregateFunction(max, UInt32), `assets` SimpleAggregateFunction(groupUniqArrayArray, Array(UInt32)), `v3` SimpleAggregateFunction(max, UInt8)) AS SELECT toStartOfHour(block_timestamp) AS hour, 'events' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets, max(toUInt8(ifNull(event_name, '') != 'BalanceTransfer')) AS v3 FROM price_data.raw_evm_logs WHERE ((event_name = 'BalanceTransfer') AND (lower(JSONExtractString(decoded_args_json, 'to')) = '0xe52567ff06acd6cbe7ba94dc777a3126e180b6d9')) OR ((event_name = 'Transfer') AND (lower(JSONExtractString(decoded_args_json, 'to')) = '0x6d6f646c70792f74727372790000000000000000')) OR (topic0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67') GROUP BY hour;

-- Liquidation calls (the penalty stream's payer attribution), valued in the
-- collateral reserve's asset.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_hour_watermarks_mm_events_mv TO price_data.revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32), `v3` UInt8) AS SELECT toStartOfHour(block_timestamp) AS hour, 'events' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, groupUniqArray(if(startsWith(lower(JSONExtractString(decoded_args_json, 'collateralAsset')), '0x0000000000000000000000000000000100'), reinterpretAsUInt32(reverse(unhex(right(lower(JSONExtractString(decoded_args_json, 'collateralAsset')), 8)))), transform(lower(JSONExtractString(decoded_args_json, 'collateralAsset')), ['0x531a654d1696ed52e7275a8cede955e82620f99a'], [toUInt32(222)], toUInt32(0)))) AS assets, toUInt8(0) AS v3 FROM price_data.raw_money_market_events WHERE event_name = 'LiquidationCall' GROUP BY hour;

-- Reserve index updates and treasury mints: cumulative-state inputs, so kind
-- 'debt' (forward-cascading staleness), valued in the reserve's asset.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_hour_watermarks_mm_reserves_mv TO price_data.revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32), `v3` UInt8) AS SELECT toStartOfHour(block_timestamp) AS hour, 'debt' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, groupUniqArray(if(startsWith(ifNull(reserve_address, ''), '0x0000000000000000000000000000000100'), reinterpretAsUInt32(reverse(unhex(right(ifNull(reserve_address, ''), 8)))), transform(ifNull(reserve_address, ''), ['0x531a654d1696ed52e7275a8cede955e82620f99a'], [toUInt32(222)], toUInt32(0)))) AS assets, toUInt8(0) AS v3 FROM price_data.raw_money_market_reserves WHERE event_name IN ('MintedToTreasury', 'ReserveDataUpdated') GROUP BY hour;

-- Debt-token scaled deltas: cumulative opening balances of every later hour,
-- so kind 'debt'.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_hour_watermarks_debt_deltas_mv TO price_data.revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32), `v3` UInt8) AS SELECT toStartOfHour(block_timestamp) AS hour, 'debt' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets, toUInt8(0) AS v3 FROM price_data.atoken_scaled_deltas GROUP BY hour;
