-- Exact replay-safe daily counts for the high-volume Events and signed
-- Extrinsics charts. Bitmap union makes reinserted raw ranges idempotent.

CREATE TABLE IF NOT EXISTS price_data.daily_chain_identity_counts_v2
(
    kind LowCardinality(String),
    day Date,
    identity_state AggregateFunction(groupBitmap, UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYear(day)
ORDER BY (kind, day)
SETTINGS index_granularity = 64;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.daily_event_identity_counts_v2_mv
TO price_data.daily_chain_identity_counts_v2 AS
SELECT 'events' AS kind, toDate(block_timestamp) AS day,
    groupBitmapState(bitOr(bitShiftLeft(toUInt64(event_index), 32), toUInt64(block_height))) AS identity_state
FROM price_data.raw_events
GROUP BY day;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.daily_extrinsic_identity_counts_v2_mv
TO price_data.daily_chain_identity_counts_v2 AS
SELECT 'extrinsics' AS kind, toDate(block_timestamp) AS day,
    groupBitmapState(bitOr(bitShiftLeft(toUInt64(extrinsic_index), 32), toUInt64(block_height))) AS identity_state
FROM price_data.raw_extrinsics
WHERE coalesce(signer, effective_signer) IS NOT NULL
GROUP BY day;

CREATE TABLE IF NOT EXISTS price_data.daily_chain_identity_counts_v2_backfill
(
    kind String,
    partition String,
    completed_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY (kind, partition);
