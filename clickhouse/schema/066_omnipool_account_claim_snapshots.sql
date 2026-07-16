-- Atomic current Omnipool NFT-position claims for whole-account-directory
-- ranking. The API builds one bounded generation from the replay-safe current
-- position/ownership aggregates, values every position with exact integer
-- withdrawal math, and publishes it only after the complete generation exists.

CREATE TABLE IF NOT EXISTS price_data.omnipool_account_claim_snapshots
(
    snapshot_id String,
    position_id String,
    account_id String,
    asset_id UInt32,
    amount UInt256,
    hub_amount UInt256,
    venue LowCardinality(String),
    computed_at DateTime
)
ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY snapshot_id
ORDER BY (snapshot_id, position_id)
SETTINGS index_granularity = 1024;

CREATE TABLE IF NOT EXISTS price_data.omnipool_account_claim_snapshot_state
(
    snapshot_key LowCardinality(String),
    snapshot_id String,
    source_position_count UInt32,
    claim_count UInt32,
    source_checksum String,
    computed_at DateTime
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY snapshot_key
SETTINGS index_granularity = 64;
