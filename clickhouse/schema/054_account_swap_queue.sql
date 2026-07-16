-- Account-keyed signed swaps. The historical model is filled in bounded block
-- ranges by the API. Live swap events enter a compact queue; the API resolves
-- only their exact extrinsic tuples before inserting account rows. A direct
-- raw_events -> raw_extrinsics materialized-view join is intentionally avoided
-- because ClickHouse would scan/build the entire extrinsics side per insert.

CREATE TABLE IF NOT EXISTS price_data.account_swap_activity
(
    account String,
    block_height UInt32,
    event_index UInt32,
    extrinsic_index UInt32,
    block_timestamp DateTime,
    event_name LowCardinality(String),
    signer String,
    asset_in UInt32,
    asset_out UInt32,
    amount_in String,
    amount_out String,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (account, block_height, event_index);

CREATE TABLE IF NOT EXISTS price_data.account_swap_activity_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

CREATE TABLE IF NOT EXISTS price_data.account_swap_activity_queue
(
    queued_at DateTime64(3),
    block_height UInt32,
    event_index UInt32,
    extrinsic_index UInt32,
    block_timestamp DateTime,
    event_name LowCardinality(String),
    asset_in UInt32,
    asset_out UInt32,
    amount_in String,
    amount_out String,
    ingested_at DateTime
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(queued_at)
ORDER BY (queued_at, block_height, event_index, ingested_at)
TTL toDateTime(queued_at) + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.account_swap_activity_queue_mv
TO price_data.account_swap_activity_queue AS
SELECT
    now64(3) AS queued_at,
    block_height,
    event_index,
    toUInt32(extrinsic_index) AS extrinsic_index,
    block_timestamp,
    event_name,
    toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn'))) AS asset_in,
    toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut'))) AS asset_out,
    JSONExtractString(args_json, 'amountIn') AS amount_in,
    JSONExtractString(args_json, 'amountOut') AS amount_out,
    ingested_at
FROM price_data.raw_events
WHERE event_name IN ('Router.Executed','Omnipool.SellExecuted','Omnipool.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted')
  AND extrinsic_index IS NOT NULL;

CREATE TABLE IF NOT EXISTS price_data.account_swap_activity_queue_state
(
    id UInt8,
    queued_at DateTime64(3),
    block_height UInt32,
    event_index UInt32,
    ingested_at DateTime,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;

CREATE TABLE IF NOT EXISTS price_data.account_swap_activity_queue_seed
(id UInt8, seeded_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(seeded_at)
ORDER BY id;

DROP TABLE IF EXISTS price_data.account_swap_activity_mv;
