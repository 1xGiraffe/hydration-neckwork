-- Sparse replay-safe HSM dashboard source. Broadcast.Swapped3 is retained only
-- when the decoded filler is HSM, avoiding a scan of the high-volume swap feed.

CREATE TABLE IF NOT EXISTS price_data.hsm_activity
(
    block_height UInt32,
    event_index UInt32,
    block_timestamp DateTime,
    event_name LowCardinality(String),
    args_json String,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.hsm_activity_mv
TO price_data.hsm_activity AS
SELECT block_height, event_index, block_timestamp, event_name, args_json, ingested_at
FROM price_data.raw_events
WHERE event_name IN ('HSM.CollateralAdded','HSM.CollateralUpdated','HSM.ArbitrageExecuted')
   OR (event_name = 'Broadcast.Swapped3'
       AND JSONExtractString(args_json, 'fillerType', '__kind') = 'HSM');

CREATE TABLE IF NOT EXISTS price_data.hsm_activity_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
