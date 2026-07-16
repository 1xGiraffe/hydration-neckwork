-- Durable background snapshots for expensive whole-directory sort/page shapes.
-- Requests read these after process restarts; the API refreshes hot shapes on a
-- bounded cadence and replaces each key atomically.

CREATE TABLE IF NOT EXISTS price_data.account_directory_snapshots
(
    snapshot_key String,
    payload_json String,
    computed_at DateTime
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY snapshot_key
SETTINGS index_granularity = 64;
