-- Exact account-first balance history. Unlike the weekly directory aggregate,
-- this preserves every observation timestamp so historical chart buckets and
-- their period-price valuation retain the raw source semantics.

CREATE TABLE IF NOT EXISTS price_data.account_balance_history
(
    account_id String,
    asset_id String,
    asset_kind LowCardinality(String),
    block_height UInt32,
    block_timestamp DateTime,
    observation_id String,
    total String,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (account_id, asset_id, block_height, asset_kind, observation_id)
SETTINGS index_granularity = 4096;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.account_balance_history_mv
TO price_data.account_balance_history AS
SELECT
    account_id,
    asset_id,
    asset_kind,
    block_height,
    block_timestamp,
    observation_id,
    ifNull(total, '') AS total,
    ingested_at
FROM price_data.raw_balance_observations
WHERE account_id != '' AND asset_id != '';

CREATE TABLE IF NOT EXISTS price_data.account_balance_history_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
