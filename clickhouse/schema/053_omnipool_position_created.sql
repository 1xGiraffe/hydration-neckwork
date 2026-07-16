-- Sparse creation-height lookup for current Omnipool position history. The
-- stable position id makes live inserts and resumable monthly backfills
-- replay-safe, while account requests avoid reopening raw_events.

CREATE TABLE IF NOT EXISTS price_data.omnipool_position_created
(
    position_id String,
    block_height UInt32,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY position_id
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.omnipool_position_created_mv
TO price_data.omnipool_position_created AS
SELECT
    toString(JSONExtractInt(args_json, 'positionId')) AS position_id,
    block_height,
    ingested_at
FROM price_data.raw_events
WHERE event_name = 'Omnipool.PositionCreated'
  AND JSONExtractInt(args_json, 'positionId') > 0;

CREATE TABLE IF NOT EXISTS price_data.omnipool_position_created_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
