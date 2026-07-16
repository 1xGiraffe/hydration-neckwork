-- Replay-safe reserve-index projection for aToken balance reconstruction.
-- ReserveDataUpdated is replayable in raw_money_market_reserves, so the stable
-- pool/reserve/event key replaces retried rows instead of adding them.

CREATE TABLE IF NOT EXISTS price_data.money_market_reserve_indices
(
    pool_address String,
    reserve_address String,
    block_height UInt32,
    event_index UInt32,
    block_timestamp DateTime,
    liquidity_index UInt256,
    variable_borrow_index UInt256,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (pool_address, reserve_address, block_height, event_index)
SETTINGS index_granularity = 4096;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.money_market_reserve_indices_mv
TO price_data.money_market_reserve_indices AS
SELECT
    lower(if(pool_address = '', contract_address, pool_address)) AS pool_address,
    lower(ifNull(reserve_address, '')) AS reserve_address,
    block_height,
    event_index,
    block_timestamp,
    toUInt256OrZero(JSONExtractString(decoded_args_json, 'liquidityIndex')) AS liquidity_index,
    toUInt256OrZero(JSONExtractString(decoded_args_json, 'variableBorrowIndex')) AS variable_borrow_index,
    ingested_at
FROM price_data.raw_money_market_reserves
WHERE event_name = 'ReserveDataUpdated' AND ifNull(reserve_address, '') != '';

CREATE TABLE IF NOT EXISTS price_data.money_market_reserve_indices_backfill
(
    partition String,
    completed_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
