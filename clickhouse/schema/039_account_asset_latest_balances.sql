CREATE TABLE IF NOT EXISTS price_data.account_asset_latest_balances
(
    account_id String,
    asset_id String,
    total_state AggregateFunction(argMax, Nullable(String), UInt32),
    free_state AggregateFunction(argMax, Nullable(String), UInt32),
    reserved_state AggregateFunction(argMax, Nullable(String), UInt32),
    last_block_state AggregateFunction(max, UInt32)
)
ENGINE = AggregatingMergeTree()
ORDER BY (account_id, asset_id)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.account_asset_latest_balances_mv
TO price_data.account_asset_latest_balances
AS
SELECT
    account_id,
    asset_id,
    argMaxState(total, block_height) AS total_state,
    argMaxState(free, block_height) AS free_state,
    argMaxState(reserved, block_height) AS reserved_state,
    maxState(block_height) AS last_block_state
FROM price_data.raw_balance_observations
WHERE account_id != '' AND asset_id != ''
GROUP BY account_id, asset_id;
