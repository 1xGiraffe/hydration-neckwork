-- Replay-safe HDX holder first/last-nonzero timestamps for the dashboard churn
-- chart. Historical rows are populated by the API's resumable monthly backfill.

CREATE TABLE IF NOT EXISTS price_data.hdx_holder_lifetime
(
    account_id String,
    first_nonzero_state AggregateFunction(min, DateTime),
    last_nonzero_state AggregateFunction(max, DateTime)
)
ENGINE = AggregatingMergeTree()
ORDER BY account_id
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.hdx_holder_lifetime_mv
TO price_data.hdx_holder_lifetime AS
SELECT
    account_id,
    minState(block_timestamp) AS first_nonzero_state,
    maxState(block_timestamp) AS last_nonzero_state
FROM price_data.raw_balance_observations
WHERE asset_id = '0' AND account_id != '' AND toUInt256OrZero(total) > 0
GROUP BY account_id;

CREATE TABLE IF NOT EXISTS price_data.hdx_holder_lifetime_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
