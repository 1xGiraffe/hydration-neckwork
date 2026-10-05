-- User Revenue: what users EARN on Hydration, net, booked when it accrues (the
-- chain's own arithmetic says it is owed), never when it is claimed. Written only
-- by the `user_revenue_hourly` and `account_user_revenue` derivations jobs
-- (api/src/derivations/jobs.ts) from the shared definitions in
-- api/src/services/userRevenueStreams.ts and the fold in
-- api/src/services/userRevenueFold.ts. Protocol Revenue (008_revenue.sql) keeps
-- its meaning; the two are NOT additive (a fee retained by the Omnipool for its
-- LPs is user revenue, the protocol's cut of the same swap is protocol revenue,
-- and the HDX sub-pool's POL is both a protocol-revenue stream and the pool
-- the hub fee lands in).
--
-- Every fact carries `holder_class` ∈ user | protocol | unattributed (user
-- surfaces filter 'user'; reconciliation is per (stream, month, class)), the
-- `pot` the income came from, and `via` — the custody path it reached the holder
-- through ('' for a direct holding) or, for an unattributed amount, its named
-- cause ('omnipool-hub-channel', 'custody:<kind>', 'voting-unrecorded',
-- 'opening-stock', 'rounding', …). Amounts are raw Int256 units of `asset_id`
-- (signed: paid items — borrow interest, exit fees, forfeits, farm write-downs —
-- are negative), `amount_usd` their valuation at the hour's closed candle
-- (1e-12 USD integer semantics, truncated per account-hour cell), `unpriced`
-- the cells the hour could not value (never valued as 0).
--
-- One MARKER row per computed bucket (stream = '', every other key column
-- empty/0, amounts 0) records that the bucket was folded even when it holds no
-- fact, so an empty hour or month is not "never computed"; readers filter
-- stream != ''.

-- Global hourly facts: the rivers, the windows and the breakdowns. A progressive
-- hourly fold (republished per month partition from the staging twin by REPLACE
-- PARTITION, the shared bucket-fold mechanism); computed_by_hour keeps the
-- staleness read key-sized.
CREATE TABLE IF NOT EXISTS price_data.user_revenue_hourly (`hour` DateTime, `stream` LowCardinality(String), `pot` String, `via` LowCardinality(String), `asset_id` UInt32, `holder_class` LowCardinality(String), `amount` Int256, `amount_usd` Decimal(38, 12), `unpriced` UInt32, `registry_fp` UInt64 DEFAULT 0, `computed_at` DateTime DEFAULT now(), PROJECTION computed_by_hour (SELECT hour, count() AS n, max(computed_at) AS der_computed, min(registry_fp) AS fp_min, max(registry_fp) AS fp_max GROUP BY hour), PROJECTION assets_by_month (SELECT toYYYYMM(hour), stream, asset_id, count() GROUP BY toYYYYMM(hour), stream, asset_id)) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY (hour, stream, pot, via, asset_id, holder_class) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';

-- Per-account facts at DAY grain (the account/tag tabs, the directory column,
-- the Data API's earnings route); monthly sums by the aggregate projection. A
-- month is rebuilt WHOLE and published by REPLACE PARTITION, so every
-- (account, day, stream, pot, via, asset_id, holder_class) key is written once
-- per build and a plain sum reads it. account = '' carries what no account
-- holds (rounding remainders, the hub-channel remainder, unrecorded voting
-- rewards); every non-user amount keeps its class and via. `opening_fp` is the
-- content fingerprint of the month's opening exposure anchor the facts were
-- computed from, `closing_fp` that of the next month's anchor the same build
-- wrote (0 for the month still filling) — see user_revenue_exposure_anchor.
CREATE TABLE IF NOT EXISTS price_data.account_user_revenue_daily (`account` String, `day` Date, `stream` LowCardinality(String), `pot` String, `via` LowCardinality(String), `asset_id` UInt32, `holder_class` LowCardinality(String), `amount` Int256, `amount_usd` Decimal(38, 12), `unpriced` UInt32 DEFAULT 0, `opening_fp` UInt64, `closing_fp` UInt64 DEFAULT 0, `registry_fp` UInt64, `computed_at` DateTime DEFAULT now(), PROJECTION by_account_month (SELECT account, toYYYYMM(day), stream, holder_class, sum(amount_usd), sum(unpriced) GROUP BY account, toYYYYMM(day), stream, holder_class)) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(day) ORDER BY (account, day, stream, pot, via, asset_id, holder_class) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';

-- Month-start exposure anchors, keyed by a STABLE exposure id: what every pot's
-- holders held at the start of `month` (an Omnipool position's shares and entry
-- price, a staking position's stake and reward checkpoint, a scaled aToken /
-- debt balance, a share balance …). anchor(m+1) is written by the account fold
-- AFTER month m's facts are published, from the same inputs, so it is a pure
-- function of raw: rebuilt twice it is identical. Month m's facts store the
-- content fingerprint of anchor(m) they read (opening_fp) and of the anchor(m+1)
-- they produced (closing_fp). A later anchor(m) whose content differs re-queues
-- m, and the cascade stops at the first month whose anchor content is unchanged;
-- a build that crashed after publishing month m's facts but before its anchor(m+1)
-- (written to the staging twin first, swapped in LAST) leaves the live anchor's
-- fingerprint different from m's closing_fp, which re-queues m.
ALTER TABLE price_data.account_user_revenue_daily ADD COLUMN IF NOT EXISTS `closing_fp` UInt64 DEFAULT 0 AFTER `opening_fp`;
-- The account fold's CUT: on a month's marker row, the end of the last hour the build folded (the month's end
-- once complete; the live month's foldable head while it fills). Readers state the account facts "through" it.
ALTER TABLE price_data.account_user_revenue_daily ADD COLUMN IF NOT EXISTS `folded_through` DateTime DEFAULT toDateTime(0) AFTER `closing_fp`;

CREATE TABLE IF NOT EXISTS price_data.user_revenue_exposure_anchor (`month` UInt32, `pot` String, `holder` String, `exposure_id` String, `units` Int256, `aux` String, `computed_at` DateTime DEFAULT now(), PROJECTION fp_by_month (SELECT month, groupBitXor(cityHash64(pot, holder, exposure_id, toString(units), aux)) GROUP BY month)) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY month ORDER BY (pot, holder, exposure_id) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';

-- Staging twins for the atomic REPLACE PARTITION publications — byte-identical
-- to their live tables (engine, ORDER BY, PARTITION BY, projections), or the
-- swap is refused or publishes the wrong shape.
CREATE TABLE IF NOT EXISTS price_data.user_revenue_hourly_staging (`hour` DateTime, `stream` LowCardinality(String), `pot` String, `via` LowCardinality(String), `asset_id` UInt32, `holder_class` LowCardinality(String), `amount` Int256, `amount_usd` Decimal(38, 12), `unpriced` UInt32, `registry_fp` UInt64 DEFAULT 0, `computed_at` DateTime DEFAULT now(), PROJECTION computed_by_hour (SELECT hour, count() AS n, max(computed_at) AS der_computed, min(registry_fp) AS fp_min, max(registry_fp) AS fp_max GROUP BY hour), PROJECTION assets_by_month (SELECT toYYYYMM(hour), stream, asset_id, count() GROUP BY toYYYYMM(hour), stream, asset_id)) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY (hour, stream, pot, via, asset_id, holder_class) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';
CREATE TABLE IF NOT EXISTS price_data.account_user_revenue_daily_staging (`account` String, `day` Date, `stream` LowCardinality(String), `pot` String, `via` LowCardinality(String), `asset_id` UInt32, `holder_class` LowCardinality(String), `amount` Int256, `amount_usd` Decimal(38, 12), `unpriced` UInt32 DEFAULT 0, `opening_fp` UInt64, `closing_fp` UInt64 DEFAULT 0, `registry_fp` UInt64, `computed_at` DateTime DEFAULT now(), PROJECTION by_account_month (SELECT account, toYYYYMM(day), stream, holder_class, sum(amount_usd), sum(unpriced) GROUP BY account, toYYYYMM(day), stream, holder_class)) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(day) ORDER BY (account, day, stream, pot, via, asset_id, holder_class) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';
ALTER TABLE price_data.account_user_revenue_daily_staging ADD COLUMN IF NOT EXISTS `closing_fp` UInt64 DEFAULT 0 AFTER `opening_fp`;
ALTER TABLE price_data.account_user_revenue_daily_staging ADD COLUMN IF NOT EXISTS `folded_through` DateTime DEFAULT toDateTime(0) AFTER `closing_fp`;
CREATE TABLE IF NOT EXISTS price_data.user_revenue_exposure_anchor_staging (`month` UInt32, `pot` String, `holder` String, `exposure_id` String, `units` Int256, `aux` String, `computed_at` DateTime DEFAULT now(), PROJECTION fp_by_month (SELECT month, groupBitXor(cityHash64(pot, holder, exposure_id, toString(units), aux)) GROUP BY month)) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY month ORDER BY (pot, holder, exposure_id) SETTINGS index_granularity = 8192, deduplicate_merge_projection_mode = 'rebuild';

-- The staleness reads' projections (a quiet cycle reads the watermarks, the marker rows and these): the hourly
-- facts' asset set per month (the registry fingerprint's input) and each anchor's content fingerprint. On an
-- existing deployment they apply to new parts; a table republished whole (a re-fold) carries them everywhere,
-- or MATERIALIZE PROJECTION backfills the old parts. Live and staging twins alike, or REPLACE PARTITION refuses.
ALTER TABLE price_data.user_revenue_hourly ADD PROJECTION IF NOT EXISTS assets_by_month (SELECT toYYYYMM(hour), stream, asset_id, count() GROUP BY toYYYYMM(hour), stream, asset_id);
ALTER TABLE price_data.user_revenue_hourly_staging ADD PROJECTION IF NOT EXISTS assets_by_month (SELECT toYYYYMM(hour), stream, asset_id, count() GROUP BY toYYYYMM(hour), stream, asset_id);
ALTER TABLE price_data.user_revenue_exposure_anchor MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild';
ALTER TABLE price_data.user_revenue_exposure_anchor ADD PROJECTION IF NOT EXISTS fp_by_month (SELECT month, groupBitXor(cityHash64(pot, holder, exposure_id, toString(units), aux)) GROUP BY month);
ALTER TABLE price_data.user_revenue_exposure_anchor_staging MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild';
ALTER TABLE price_data.user_revenue_exposure_anchor_staging ADD PROJECTION IF NOT EXISTS fp_by_month (SELECT month, groupBitXor(cityHash64(pot, holder, exposure_id, toString(units), aux)) GROUP BY month);

-- Source watermarks the user-revenue folds read beside the ones they share
-- (revenue_hour_watermarks 'events'/'debt' — every raw_events/raw_extrinsics row,
-- the money market's scaled deltas and reserve indices; pool_swap_hour_watermarks
-- — every venue's legs; pair_route_hour_watermarks — the block snapshots and, as
-- price_ingest, every price row). Per chain-time hour and kind: the newest
-- ingest, the block span. max()/min() are idempotent under replay, so a
-- re-inserted range leaves every watermark unchanged.
--   'state'      — balance observations and ERC-20 transfer deltas (share and
--                  accruing-token holdings): cumulative exposure, staleness
--                  cascades FORWARD;
--   'pool_state' — the 600-block Omnipool / stableswap state grids: the hour and
--                  the next (a grid interval spans the boundary);
--   'mm_inc'     — money-market incentive index updates and programme
--                  configuration: cascades forward to the next emitted point;
--   'v3'         — Uniswap v3 Mint/Burn/Collect/Swap rows: the range book is
--                  cumulative, cascades forward;
--   'lm_config'  — farm configuration events: cascades forward.
-- On an existing deployment the MVs only see inserts from their creation on; the
-- rollout seeds history once ad hoc with an INSERT…SELECT mirroring each MV's
-- SELECT (replay-safe through min/max aggregation), per the schema rules.
CREATE TABLE IF NOT EXISTS price_data.user_revenue_hour_watermarks (`hour` DateTime, `kind` LowCardinality(String), `src_ingest` SimpleAggregateFunction(max, DateTime), `src_minb` SimpleAggregateFunction(min, UInt32), `src_maxb` SimpleAggregateFunction(max, UInt32), `assets` SimpleAggregateFunction(groupUniqArrayArray, Array(UInt32))) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(hour) ORDER BY (hour, kind) SETTINGS index_granularity = 64;

-- The same for sources WITHOUT a block timestamp, by 600-block bucket
-- (intDiv(block_height, 600)); the folds map a bucket to hours through a bounded
-- read of price_data.blocks over the bucket span.
--   'lm'         — liquidity-mining entry captures, deposit and yield-farm
--                  events: an entry's stake cascades forward; a yield-farm sync
--                  re-marks back to the farm's previous sync (interpolation);
--   'xyk_shares' — XYK LP share observations: cumulative, cascades forward.
CREATE TABLE IF NOT EXISTS price_data.user_revenue_block_watermarks (`bucket` UInt32, `kind` LowCardinality(String), `src_ingest` SimpleAggregateFunction(max, DateTime)) ENGINE = AggregatingMergeTree ORDER BY (bucket, kind) SETTINGS index_granularity = 64;

-- Every MV below sits on an ingestion path (raw-live's balance observations, the
-- snapshot MVs' pool-state grids, the money-market log MVs): a throw or a NULL
-- into an ordinary column fails the SOURCE insert and stalls ingestion. So every
-- SELECT reads only non-Nullable columns, converts nothing that can throw, and is
-- pinned by api/tests/userRevenueSchema.test.ts.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_hour_watermarks_balances_mv TO price_data.user_revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32)) AS SELECT toStartOfHour(block_timestamp) AS hour, 'state' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets FROM price_data.raw_balance_observations GROUP BY hour;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_hour_watermarks_erc20_mv TO price_data.user_revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32)) AS SELECT toStartOfHour(block_timestamp) AS hour, 'state' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets FROM price_data.erc20_transfer_deltas GROUP BY hour;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_hour_watermarks_omnipool_state_mv TO price_data.user_revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32)) AS SELECT toStartOfHour(block_timestamp) AS hour, 'pool_state' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets FROM price_data.omnipool_pool_state_history GROUP BY hour;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_hour_watermarks_stableswap_state_mv TO price_data.user_revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32)) AS SELECT toStartOfHour(block_timestamp) AS hour, 'pool_state' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets FROM price_data.stableswap_pool_state_history GROUP BY hour;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_hour_watermarks_mm_inc_mv TO price_data.user_revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32)) AS SELECT toStartOfHour(block_timestamp) AS hour, 'mm_inc' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets FROM price_data.mm_incentive_index_updates GROUP BY hour;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_hour_watermarks_mm_prog_mv TO price_data.user_revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32)) AS SELECT toStartOfHour(block_timestamp) AS hour, 'mm_inc' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets FROM price_data.mm_incentive_programmes GROUP BY hour;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_hour_watermarks_v3_mv TO price_data.user_revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32)) AS SELECT toStartOfHour(block_timestamp) AS hour, 'v3' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets FROM price_data.uniswap_v3_events GROUP BY hour;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_hour_watermarks_farm_config_mv TO price_data.user_revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32)) AS SELECT toStartOfHour(block_timestamp) AS hour, 'lm_config' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, CAST([], 'Array(UInt32)') AS assets FROM price_data.farm_config_events GROUP BY hour;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_block_watermarks_lm_entries_mv TO price_data.user_revenue_block_watermarks (`bucket` UInt32, `kind` String, `src_ingest` DateTime) AS SELECT intDiv(block_height, 600) AS bucket, 'lm' AS kind, max(ingested_at) AS src_ingest FROM price_data.raw_lm_farm_entries GROUP BY bucket;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_block_watermarks_lm_deposit_mv TO price_data.user_revenue_block_watermarks (`bucket` UInt32, `kind` String, `src_ingest` DateTime) AS SELECT intDiv(block_height, 600) AS bucket, 'lm' AS kind, max(ingested_at) AS src_ingest FROM price_data.lm_deposit_farm_events GROUP BY bucket;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_block_watermarks_lm_yield_mv TO price_data.user_revenue_block_watermarks (`bucket` UInt32, `kind` String, `src_ingest` DateTime) AS SELECT intDiv(block_height, 600) AS bucket, 'lm' AS kind, max(ingested_at) AS src_ingest FROM price_data.lm_yield_farm_events GROUP BY bucket;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.user_revenue_block_watermarks_xyk_shares_mv TO price_data.user_revenue_block_watermarks (`bucket` UInt32, `kind` String, `src_ingest` DateTime) AS SELECT intDiv(block_height, 600) AS bucket, 'xyk_shares' AS kind, max(ingested_at) AS src_ingest FROM price_data.xyk_lp_share_observations GROUP BY bucket;

-- GIGAHDX per-voter reward records (GigaHdxRewards.UserRewardRecorded), keyed by
-- referendum: E3 books each record at its referendum's allocation, and the
-- staleness read re-marks exactly that allocation hour when a record's ingest is
-- newer than it — a read of this small table instead of a raw_events scan. The
-- extractors return their default ('' / 0) on a malformed payload and never
-- throw; every source column is non-Nullable.
CREATE TABLE IF NOT EXISTS price_data.gigahdx_reward_records (`ref_index` UInt64, `who` String, `reward` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (ref_index, block_height, event_index) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.gigahdx_reward_records_mv TO price_data.gigahdx_reward_records (`ref_index` UInt64, `who` String, `reward` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `ingested_at` DateTime) AS SELECT JSONExtractUInt(args_json, 'refIndex') AS ref_index, lower(JSONExtractString(args_json, 'who')) AS who, JSONExtractString(args_json, 'rewardAmount') AS reward, block_height, event_index, block_timestamp, ingested_at FROM price_data.raw_events WHERE raw_events.event_name = 'GigaHdxRewards.UserRewardRecorded';
