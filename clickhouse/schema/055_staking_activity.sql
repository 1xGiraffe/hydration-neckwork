-- Sparse, replay-safe source for global/account/asset staking activity.
-- Historical rows are copied by the API's resumable monthly backfill.

CREATE TABLE IF NOT EXISTS price_data.staking_activity
(
    block_height UInt32,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    block_timestamp DateTime,
    event_name LowCardinality(String),
    who String,
    args_json String,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.staking_activity_mv
TO price_data.staking_activity AS
SELECT
    block_height,
    event_index,
    extrinsic_index,
    block_timestamp,
    event_name,
    JSONExtractString(args_json, 'who') AS who,
    args_json,
    ingested_at
FROM price_data.raw_events
WHERE event_name IN (
    'CollatorRewards.CollatorRewarded',
    'GigaHdx.Staked',
    'GigaHdx.Unstaked',
    'GigaHdx.UnstakeCancelled',
    'GigaHdx.MigratedFromLegacy',
    'GigaHdxRewards.RewardsClaimed',
    'Staking.PositionCreated',
    'Staking.StakeAdded',
    'Staking.Unstaked',
    'Staking.ForceUnstaked',
    'Staking.RewardsClaimed'
);

CREATE TABLE IF NOT EXISTS price_data.staking_activity_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
