-- Sparse replay-safe vote source for the global and scoped activity feeds.
-- Vote filters otherwise scan the complete raw event table because event_name
-- is not part of its primary key. Historical rows are backfilled one source
-- month at a time and the API enables this path only after every marker exists.

CREATE TABLE IF NOT EXISTS price_data.vote_activity
(
    block_height UInt32,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    call_address String,
    block_timestamp DateTime,
    event_name LowCardinality(String),
    args_json String,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 512;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.vote_activity_mv
TO price_data.vote_activity AS
SELECT block_height, event_index, extrinsic_index, call_address,
    block_timestamp, event_name, args_json, ingested_at
FROM price_data.raw_events
WHERE event_name IN ('ConvictionVoting.Voted', 'Democracy.Voted');

CREATE TABLE IF NOT EXISTS price_data.vote_activity_backfill
(
    partition String,
    completed_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
