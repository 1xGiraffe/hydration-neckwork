-- Route-priced pair candles: each pair's price along its best on-chain trade route,
-- for the pairs whose route leaves the Omnipool. A pair whose best route is one
-- Omnipool crossing is priced exactly by the ratio of the two assets' USD prices
-- (both are hub price × the same H2O price), so it is never stored here and its
-- readers keep the per-block USD ratio (services/crossPair.ts).
--
-- Written only by the `pair_route_ohlc` derivations job (api/src/derivations/jobs.ts;
-- the fold in api/src/services/pairRouteFold.ts, route search and spot in
-- services/pairRoutes.ts), a progressive bucket fold over the per-block pool
-- snapshots (raw_block_snapshots: the omnipool, stableswap and xyk sections and the
-- money-market wraps) plus the Uniswap v3 pools' logs (uniswap_v3_events). The
-- bucket is a chain-time hour. A recomputed hour is published as ONE insert of its
-- rows — every key it now holds, plus an is_deleted row for every key it held
-- before and no longer does — into ReplacingMergeTree(computed_at, is_deleted)
-- tables, so a recomputed hour equals a fresh build of it, the insert is atomic, a
-- cycle writes only the hours it recomputed, and readers read FINAL on the pair's
-- primary-key prefix (one pair, one window: bounded).
--
-- One table per stored interval, each row the price of asset_lo in asset_hi (how
-- many hi one lo buys; the inverse is 1/x with high and low swapped), the marginal
-- spot BEFORE fees at 30 digits:
--   _5min — the fold's own grain: open/close at the bucket's first/last block,
--           high/low over every block whose route pools changed. The route is
--           the one in force at each block: the pair's best few candidates are
--           taken at the bucket's first block and re-rated at every block their
--           pools change, the price moving to a candidate only when it beats the
--           route in force by a margin; a switch is priced on both routes at its
--           block, so it is an intra-candle move. `route` is the route in force
--           at the close, `routes` how many were in force within the bucket.
--   _1h   — the hour's 5-minute rows; complete = every 5-minute bucket of the
--           hour that has blocks is route-priced.
--   _1d   — the day's hourly rows; complete = every hour of the day is a
--           complete hourly row.
-- Readers derive 15min/30min from 5min, 4h from 1h, and 1w/1M from 1d, and use a
-- candle only where the fold covered every sub-bucket it spans (the coverage below)
-- and the pair has a complete row for each (services/pairPriceSource.ts); any
-- other bucket falls back to the USD ratio. `route` names the bucket's closing
-- route hop by hop (kind:pool:from>to), `routes` counts the routes in force within it,
-- `fee_ppm` is the closing route's fee complement Π(1 − fee) in ppm (route
-- selection only — never applied to a price). Coarse intervals sit in coarse
-- partitions so a long window touches a handful of parts.
CREATE TABLE IF NOT EXISTS price_data.pair_route_ohlc_5min (`asset_lo` UInt32, `asset_hi` UInt32, `interval_start` DateTime, `open` Decimal(76, 30), `high` Decimal(76, 30), `low` Decimal(76, 30), `close` Decimal(76, 30), `route` String, `routes` UInt16, `fee_ppm` UInt32, `buckets` UInt16, `complete` UInt8, `first_block` UInt32, `last_block` UInt32, `computed_at` DateTime, `is_deleted` UInt8 DEFAULT 0, PROJECTION p_time (SELECT asset_lo, asset_hi, interval_start, computed_at, is_deleted ORDER BY interval_start)) ENGINE = ReplacingMergeTree(computed_at, is_deleted) PARTITION BY toYYYYMM(interval_start) ORDER BY (asset_lo, asset_hi, interval_start) SETTINGS index_granularity = 1024, deduplicate_merge_projection_mode = 'rebuild';
CREATE TABLE IF NOT EXISTS price_data.pair_route_ohlc_1h (`asset_lo` UInt32, `asset_hi` UInt32, `interval_start` DateTime, `open` Decimal(76, 30), `high` Decimal(76, 30), `low` Decimal(76, 30), `close` Decimal(76, 30), `route` String, `routes` UInt16, `fee_ppm` UInt32, `buckets` UInt16, `complete` UInt8, `first_block` UInt32, `last_block` UInt32, `computed_at` DateTime, `is_deleted` UInt8 DEFAULT 0, PROJECTION p_time (SELECT * ORDER BY interval_start)) ENGINE = ReplacingMergeTree(computed_at, is_deleted) PARTITION BY toYear(interval_start) ORDER BY (asset_lo, asset_hi, interval_start) SETTINGS index_granularity = 1024, deduplicate_merge_projection_mode = 'rebuild';
CREATE TABLE IF NOT EXISTS price_data.pair_route_ohlc_1d (`asset_lo` UInt32, `asset_hi` UInt32, `interval_start` DateTime, `open` Decimal(76, 30), `high` Decimal(76, 30), `low` Decimal(76, 30), `close` Decimal(76, 30), `route` String, `routes` UInt16, `fee_ppm` UInt32, `buckets` UInt16, `complete` UInt8, `first_block` UInt32, `last_block` UInt32, `computed_at` DateTime, `is_deleted` UInt8 DEFAULT 0, PROJECTION p_time (SELECT * ORDER BY interval_start)) ENGINE = ReplacingMergeTree(computed_at, is_deleted) PARTITION BY tuple() ORDER BY (asset_lo, asset_hi, interval_start) SETTINGS index_granularity = 1024, deduplicate_merge_projection_mode = 'rebuild';
-- The publication's time-first reads (an hour's or a day's keys across every pair,
-- pairRouteFold.pairRouteLatestSql) go through p_time: the tables' pair-first sort
-- key cannot serve a time-only predicate. On an existing deployment the
-- projections are added here and materialized once at rollout
-- (ALTER TABLE … MATERIALIZE PROJECTION p_time), a fresh database builds them with
-- every part.
ALTER TABLE price_data.pair_route_ohlc_5min MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild';
ALTER TABLE price_data.pair_route_ohlc_5min ADD PROJECTION IF NOT EXISTS p_time (SELECT asset_lo, asset_hi, interval_start, computed_at, is_deleted ORDER BY interval_start);
ALTER TABLE price_data.pair_route_ohlc_1h MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild';
ALTER TABLE price_data.pair_route_ohlc_1h ADD PROJECTION IF NOT EXISTS p_time (SELECT * ORDER BY interval_start);
ALTER TABLE price_data.pair_route_ohlc_1d MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild';
ALTER TABLE price_data.pair_route_ohlc_1d ADD PROJECTION IF NOT EXISTS p_time (SELECT * ORDER BY interval_start);
-- The fold's ingest-time watermark index, per chain-time hour of raw_block_snapshots.
-- The source side is MV-fed: the newest snapshot ingest and the hour's block span
-- (the MV reads only the three narrow, non-Nullable key columns of the insert —
-- never payload_json — so it adds no JSON work to raw ingestion and cannot put a
-- NULL into an ordinary column; a replayed range only re-stamps src_ingest), and
-- the newest ingest of a Uniswap v3 log the fold's pool state reads (v3_ingest:
-- PoolCreated, Initialize, Swap, Mint, Burn, by topic0 alone, from any contract —
-- the same discovery-by-topic as 010, so a new factory, pool or fee tier needs no
-- change here). A v3 pool's state at an hour is the replay of all its logs before
-- it, so a v3 log re-marks its own hour AND every later one (the stale test takes
-- the running max of v3_ingest), which is what a new pool, a backfilled or a
-- repaired log needs; a live log lands in the head hour, which nothing follows yet.
-- The derived side is written by the fold after it published the hour: when it
-- computed the hour (der_computed), how far into it it got (der_last_block,
-- der_last_ts — the whole hour once closed, the head while it fills) and the route
-- rule it was folded under (der_rule: (der_computed, fingerprint), so max() keeps
-- the newest computation's fingerprint). The hour is stale while der_computed is
-- unset, a source was ingested within the settle margin of or after it, or the
-- rule now in force for the hour (pairRoutes ROUTE_RULE_*, plus the v3 pools the
-- hour can see and their token mapping) differs from der_rule's; der_last_ts is the
-- fold's coverage, which readers use to tell a bucket with no route-priced row (a
-- pure-Omnipool route) from one not folded yet. The MVs leave the der_* columns at
-- their defaults and every writer leaves the columns it does not own at
-- aggregate-neutral values (src_ingest/v3_ingest epoch, minb UInt32 max, maxb 0).
CREATE TABLE IF NOT EXISTS price_data.pair_route_hour_watermarks (`hour` DateTime, `src_ingest` SimpleAggregateFunction(max, DateTime), `minb` SimpleAggregateFunction(min, UInt32), `maxb` SimpleAggregateFunction(max, UInt32), `der_computed` SimpleAggregateFunction(max, DateTime) DEFAULT toDateTime(0), `der_last_block` SimpleAggregateFunction(max, UInt32) DEFAULT 0, `der_last_ts` SimpleAggregateFunction(max, DateTime) DEFAULT toDateTime(0), `v3_ingest` SimpleAggregateFunction(max, DateTime) DEFAULT toDateTime(0), `der_rule` SimpleAggregateFunction(max, Tuple(DateTime, UInt64)) DEFAULT (toDateTime(0), toUInt64(0)), `price_ingest` SimpleAggregateFunction(max, DateTime) DEFAULT toDateTime(0)) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(hour) ORDER BY hour SETTINGS index_granularity = 64;
ALTER TABLE price_data.pair_route_hour_watermarks ADD COLUMN IF NOT EXISTS `der_computed` SimpleAggregateFunction(max, DateTime) DEFAULT toDateTime(0);
ALTER TABLE price_data.pair_route_hour_watermarks ADD COLUMN IF NOT EXISTS `der_last_block` SimpleAggregateFunction(max, UInt32) DEFAULT 0;
ALTER TABLE price_data.pair_route_hour_watermarks ADD COLUMN IF NOT EXISTS `der_last_ts` SimpleAggregateFunction(max, DateTime) DEFAULT toDateTime(0);
ALTER TABLE price_data.pair_route_hour_watermarks ADD COLUMN IF NOT EXISTS `v3_ingest` SimpleAggregateFunction(max, DateTime) DEFAULT toDateTime(0);
ALTER TABLE price_data.pair_route_hour_watermarks ADD COLUMN IF NOT EXISTS `der_rule` SimpleAggregateFunction(max, Tuple(DateTime, UInt64)) DEFAULT (toDateTime(0), toUInt64(0));
ALTER TABLE price_data.pair_route_hour_watermarks ADD COLUMN IF NOT EXISTS `price_ingest` SimpleAggregateFunction(max, DateTime) DEFAULT toDateTime(0);
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.pair_route_hour_watermarks_mv TO price_data.pair_route_hour_watermarks (`hour` DateTime, `src_ingest` SimpleAggregateFunction(max, DateTime), `minb` SimpleAggregateFunction(min, UInt32), `maxb` SimpleAggregateFunction(max, UInt32)) AS SELECT toStartOfHour(block_timestamp) AS hour, max(ingested_at) AS src_ingest, min(block_height) AS minb, max(block_height) AS maxb FROM price_data.raw_block_snapshots GROUP BY hour;
-- The v3 side: topic0 is Nullable on raw_evm_logs and a NULL fails the IN (the row
-- is skipped); every output column is non-Nullable by construction.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.pair_route_hour_watermarks_v3_mv TO price_data.pair_route_hour_watermarks (`hour` DateTime, `src_ingest` SimpleAggregateFunction(max, DateTime), `minb` SimpleAggregateFunction(min, UInt32), `maxb` SimpleAggregateFunction(max, UInt32), `v3_ingest` SimpleAggregateFunction(max, DateTime)) AS SELECT toStartOfHour(block_timestamp) AS hour, toDateTime(0) AS src_ingest, toUInt32(4294967295) AS minb, toUInt32(0) AS maxb, max(ingested_at) AS v3_ingest FROM price_data.raw_evm_logs WHERE topic0 IN ('0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118', '0x98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95', '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde', '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c') GROUP BY hour;
-- The price side: an hour's priced asset set and the USD notionals route selection
-- sizes its reference trade with are that hour's candles (ohlc_1h, fed from
-- price_data.prices), so a price row written for an hour — live, backfilled or
-- repaired — re-marks it. price_data.prices carries no ingest time, so the stamp is
-- the insert's own (now() in an MV is the moment the insert ran); every output
-- column is non-Nullable.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.pair_route_hour_watermarks_prices_mv TO price_data.pair_route_hour_watermarks (`hour` DateTime, `src_ingest` SimpleAggregateFunction(max, DateTime), `minb` SimpleAggregateFunction(min, UInt32), `maxb` SimpleAggregateFunction(max, UInt32), `price_ingest` SimpleAggregateFunction(max, DateTime)) AS SELECT toStartOfHour(block_timestamp) AS hour, toDateTime(0) AS src_ingest, toUInt32(4294967295) AS minb, toUInt32(0) AS maxb, now() AS price_ingest FROM price_data.prices GROUP BY hour;
