-- Exact hourly closes for account/tag portfolio history. argMax states preserve
-- the same final observation chosen from raw data and merge idempotently across
-- raw replays and overlapping bounded backfills.

CREATE TABLE IF NOT EXISTS price_data.account_balance_hourly
(
    account_id String,
    asset_id String,
    interval_start DateTime,
    balance_state AggregateFunction(argMax, String, Tuple(UInt32, String, DateTime)),
    block_state AggregateFunction(argMax, UInt32, Tuple(UInt32, String, DateTime)),
    first_block_state AggregateFunction(min, UInt32),
    last_block_state AggregateFunction(max, UInt32),
    first_timestamp_state AggregateFunction(min, DateTime),
    last_timestamp_state AggregateFunction(max, DateTime)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYear(interval_start)
ORDER BY (account_id, asset_id, interval_start)
SETTINGS index_granularity = 4096;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.account_balance_hourly_mv
TO price_data.account_balance_hourly AS
WITH tuple(block_height, observation_id, ingested_at) AS version
SELECT account_id, asset_id, toStartOfHour(block_timestamp) AS interval_start,
    argMaxState(ifNull(toString(toUInt256OrZero(total)), '0'), version) AS balance_state,
    argMaxState(block_height, version) AS block_state,
    minState(block_height) AS first_block_state,
    maxState(block_height) AS last_block_state,
    minState(block_timestamp) AS first_timestamp_state,
    maxState(block_timestamp) AS last_timestamp_state
FROM price_data.raw_balance_observations
WHERE account_id != '' AND asset_id != ''
GROUP BY account_id, asset_id, interval_start;

CREATE TABLE IF NOT EXISTS price_data.account_balance_hourly_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
