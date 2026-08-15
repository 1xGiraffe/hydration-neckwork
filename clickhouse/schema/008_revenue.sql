-- Protocol revenue read models, filled by the `revenue` derivations jobs
-- (api/src/derivations/jobs.ts) from the shared per-stream definitions in
-- api/src/services/revenueStreams.ts. Nothing here is written by an MV except
-- the small watermark index at the bottom; both fact tables publish whole
-- month-partitions atomically (staging twin + REPLACE PARTITION), so re-runs
-- are idempotent and readers never observe a half-built month.
--
-- revenue_events: one row per revenue event, event-time valued.
--   stream ∈ omnipool_asset_fee | omnipool_protocol_fee | liquidation_penalty |
--            pepl_liquidation_profit | asset_reserve | hollar_borrow |
--            hsm_revenue | network_fee.
--   Eventful streams carry their chain identity (block_height, event_index,
--   leg_index — leg_index disambiguates multi-row splits such as the
--   liquidation-penalty pro-rata attribution). The two borrow-interest streams
--   are reserve-level: hollar_borrow materializes HOURLY accrual rows
--   (block_height = 0, event_index = hour epoch / 3600, leg_index = reserve
--   ordinal, block_timestamp = the hour) and asset_reserve rows are the
--   MintedToTreasury realizations; both carry account = '' — their per-account
--   truth lives in account_revenue only. Identity needs to be unique within a
--   partition build, not stable across runs, because publication replaces the
--   whole partition.
--   `dest` classifies the omnipool fee legs' destination ('protocol' | 'lp' |
--   'burned'; '' for every other stream). The lp/burned legs exist ONLY for
--   the public fees API's feeDestination matrix: every explorer revenue
--   surface and account_revenue filter to dest IN ('', 'protocol').
--   `account` is the PAYER as it appears at source (substrate pubkey hex or
--   ETH-mapped account form); '' where genuinely unattributable (HSM arb
--   profit, reserve-level borrow rows, placeholder swapper).
--   `amount` is the raw integer amount of asset_id; `amount_usd` the
--   event-time valuation (hourly ASOF close, 1e-12 USD integer semantics).
--   Only CLOSED hours are written (block_timestamp below the newest source
--   watermark's hour), so readers split cold/tail at max published hour + 1h
--   without double counting; the tail comes from raw via the same builders.
-- The projection keeps the derivations staleness check key-sized (see the
-- account_trade_volume note in 001_tables.sql); `rebuild` so a replacing merge
-- cannot leave it out of sync. Existing deployments materialize it once at
-- rollout.
CREATE TABLE IF NOT EXISTS price_data.revenue_events (`stream` LowCardinality(String), `block_height` UInt32, `block_timestamp` DateTime, `event_index` UInt32, `leg_index` UInt16, `dest` LowCardinality(String), `account` String, `asset_id` UInt32, `amount` String, `amount_usd` Decimal(38, 12), `computed_at` DateTime DEFAULT now(), PROJECTION computed_by_partition (SELECT toYYYYMM(block_timestamp) AS p, max(computed_at) AS der_computed GROUP BY p)) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (block_height, event_index, leg_index, stream) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';

-- Per-account, per-stream protocol revenue by calendar month (`month` =
-- toYYYYMM of the event time). Eventful streams are a GROUP BY of
-- revenue_events restricted to dest IN ('', 'protocol'); the borrow streams
-- are attributed here from per-account scaled debt × Δ variable_borrow_index
-- (hollar_borrow directly — the sum over accounts equals the reserve series by
-- algebraic identity — and asset_reserve by splitting each MintedToTreasury
-- amount pro-rata over per-account interest accrued since the reserve's
-- previous mint). Every rounding or pre-history remainder lands on
-- account = '', so per stream and month
--   sum(account_revenue.revenue_usd) == sum(protocol-dest revenue_events.amount_usd)
-- holds exactly; readers must treat account = '' as "unattributed", never a
-- real payer. Account-first ORDER BY serves the directory join and the
-- account/tag lookups.
CREATE TABLE IF NOT EXISTS price_data.account_revenue (`account` String, `stream` LowCardinality(String), `month` UInt32, `revenue_usd` Decimal(38, 12), `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY month ORDER BY (account, stream, month) SETTINGS index_granularity = 8192;

-- Staging twins for the atomic REPLACE PARTITION publications — byte-identical
-- to their live tables (see the note above account_trade_volume_staging in
-- 001_tables.sql: engine, ORDER BY and PARTITION BY must match or the swap
-- publishes the wrong shape).
CREATE TABLE IF NOT EXISTS price_data.revenue_events_staging (`stream` LowCardinality(String), `block_height` UInt32, `block_timestamp` DateTime, `event_index` UInt32, `leg_index` UInt16, `dest` LowCardinality(String), `account` String, `asset_id` UInt32, `amount` String, `amount_usd` Decimal(38, 12), `computed_at` DateTime DEFAULT now(), PROJECTION computed_by_partition (SELECT toYYYYMM(block_timestamp) AS p, max(computed_at) AS der_computed GROUP BY p)) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (block_height, event_index, leg_index, stream) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';
CREATE TABLE IF NOT EXISTS price_data.account_revenue_staging (`account` String, `stream` LowCardinality(String), `month` UInt32, `revenue_usd` Decimal(38, 12), `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY month ORDER BY (account, stream, month) SETTINGS index_granularity = 8192;

-- MV-fed source watermarks for the revenue jobs' staleness diff, keyed by the
-- derived tables' calendar-month partition. Asking the sources directly would
-- re-aggregate raw_events/raw_evm_logs every poll cycle (the same argument as
-- swap_source_partition_watermarks in 001_tables.sql); max() is idempotent
-- under replay, so a re-inserted range leaves every watermark unchanged, and a
-- dropped raw row leaves it high — re-marking a partition stale rather than
-- hiding staleness.
--
-- `kind` splits the staleness semantics:
--   'events' — sources that only affect their own month (fee legs, fee-paid
--              events, liquidation transfers/calls, HSM fills, treasury gas
--              deposits): partition p is stale when wm(p) > computed_at(p).
--   'debt'   — sources whose rows change OPENING state of every later month
--              (debt-token scaled deltas feed a cumulative balance; reserve
--              index/mint rows feed cross-boundary accrual): partition p is
--              stale when max over p' <= p of wm(p') > computed_at(p), i.e. a
--              backfilled row cascades staleness forward.
-- On an existing deployment the MVs only see inserts from creation on; the
-- rollout seeds history with a one-time ad-hoc INSERT…SELECT mirroring each
-- MV's SELECT (replay-safe: max() aggregation), per the schema-and-derivations
-- rules — a fresh database populates from genesis automatically.
CREATE TABLE IF NOT EXISTS price_data.revenue_source_partition_watermarks (`kind` LowCardinality(String), `p` UInt32, `src_ingest` SimpleAggregateFunction(max, DateTime), `src_maxb` SimpleAggregateFunction(max, UInt32), `src_max_ts` SimpleAggregateFunction(max, DateTime), `src_min_ts` SimpleAggregateFunction(min, DateTime)) ENGINE = AggregatingMergeTree PARTITION BY tuple() ORDER BY (kind, p) SETTINGS index_granularity = 64;

-- Trade-fee + HSM leg source (any leg insert can carry a fee or fill row).
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_source_wm_legs_mv TO price_data.revenue_source_partition_watermarks (`kind` LowCardinality(String), `p` UInt32, `src_ingest` SimpleAggregateFunction(max, DateTime), `src_maxb` SimpleAggregateFunction(max, UInt32), `src_max_ts` SimpleAggregateFunction(max, DateTime), `src_min_ts` SimpleAggregateFunction(min, DateTime)) AS SELECT 'events' AS kind, toYYYYMM(block_timestamp) AS p, max(ingested_at) AS src_ingest, max(block_height) AS src_maxb, max(block_timestamp) AS src_max_ts, min(block_timestamp) AS src_min_ts FROM price_data.pool_swap_legs GROUP BY p;

-- Substrate events the revenue builders read: fee-paid (network fees), HSM arb
-- markers, PEPL profits, and the treasury gas deposits (who-filtered so the
-- torrent of unrelated Balances.Deposit rows stays out of the watermark).
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_source_wm_events_mv TO price_data.revenue_source_partition_watermarks (`kind` LowCardinality(String), `p` UInt32, `src_ingest` SimpleAggregateFunction(max, DateTime), `src_maxb` SimpleAggregateFunction(max, UInt32), `src_max_ts` SimpleAggregateFunction(max, DateTime), `src_min_ts` SimpleAggregateFunction(min, DateTime)) AS SELECT 'events' AS kind, toYYYYMM(block_timestamp) AS p, max(ingested_at) AS src_ingest, max(block_height) AS src_maxb, max(block_timestamp) AS src_max_ts, min(block_timestamp) AS src_min_ts FROM price_data.raw_events WHERE (event_name IN ('TransactionPayment.TransactionFeePaid', 'HSM.ArbitrageExecuted', 'Liquidation.Liquidated')) OR ((event_name IN ('Tokens.Deposited', 'Balances.Deposit')) AND (JSONExtractString(args_json, 'who') = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000')) GROUP BY p;

-- Liquidation-penalty transfer source (aToken BalanceTransfer into the
-- money-market collector).
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_source_wm_evm_logs_mv TO price_data.revenue_source_partition_watermarks (`kind` LowCardinality(String), `p` UInt32, `src_ingest` SimpleAggregateFunction(max, DateTime), `src_maxb` SimpleAggregateFunction(max, UInt32), `src_max_ts` SimpleAggregateFunction(max, DateTime), `src_min_ts` SimpleAggregateFunction(min, DateTime)) AS SELECT 'events' AS kind, toYYYYMM(block_timestamp) AS p, max(ingested_at) AS src_ingest, max(block_height) AS src_maxb, max(block_timestamp) AS src_max_ts, min(block_timestamp) AS src_min_ts FROM price_data.raw_evm_logs WHERE (event_name = 'BalanceTransfer') AND (lower(JSONExtractString(decoded_args_json, 'to')) = '0xe52567ff06acd6cbe7ba94dc777a3126e180b6d9') GROUP BY p;

-- Liquidation-call source (payer attribution for the penalty stream).
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_source_wm_mm_events_mv TO price_data.revenue_source_partition_watermarks (`kind` LowCardinality(String), `p` UInt32, `src_ingest` SimpleAggregateFunction(max, DateTime), `src_maxb` SimpleAggregateFunction(max, UInt32), `src_max_ts` SimpleAggregateFunction(max, DateTime), `src_min_ts` SimpleAggregateFunction(min, DateTime)) AS SELECT 'events' AS kind, toYYYYMM(block_timestamp) AS p, max(ingested_at) AS src_ingest, max(block_height) AS src_maxb, max(block_timestamp) AS src_max_ts, min(block_timestamp) AS src_min_ts FROM price_data.raw_money_market_events WHERE event_name = 'LiquidationCall' GROUP BY p;

-- Reserve index updates + treasury mints: cross-boundary accrual inputs, so
-- kind 'debt' (forward-cascading staleness).
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_source_wm_mm_reserves_mv TO price_data.revenue_source_partition_watermarks (`kind` LowCardinality(String), `p` UInt32, `src_ingest` SimpleAggregateFunction(max, DateTime), `src_maxb` SimpleAggregateFunction(max, UInt32), `src_max_ts` SimpleAggregateFunction(max, DateTime), `src_min_ts` SimpleAggregateFunction(min, DateTime)) AS SELECT 'debt' AS kind, toYYYYMM(block_timestamp) AS p, max(ingested_at) AS src_ingest, max(block_height) AS src_maxb, max(block_timestamp) AS src_max_ts, min(block_timestamp) AS src_min_ts FROM price_data.raw_money_market_reserves WHERE event_name IN ('MintedToTreasury', 'ReserveDataUpdated') GROUP BY p;

-- Debt-token scaled-delta source: feeds cumulative opening balances of every
-- later month, so kind 'debt'.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_source_wm_debt_deltas_mv TO price_data.revenue_source_partition_watermarks (`kind` LowCardinality(String), `p` UInt32, `src_ingest` SimpleAggregateFunction(max, DateTime), `src_maxb` SimpleAggregateFunction(max, UInt32), `src_max_ts` SimpleAggregateFunction(max, DateTime), `src_min_ts` SimpleAggregateFunction(min, DateTime)) AS SELECT 'debt' AS kind, toYYYYMM(block_timestamp) AS p, max(ingested_at) AS src_ingest, max(block_height) AS src_maxb, max(block_timestamp) AS src_max_ts, min(block_timestamp) AS src_min_ts FROM price_data.atoken_scaled_deltas GROUP BY p;
