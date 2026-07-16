-- Completed exact tab-count snapshots for the fixed/reproducible tag scopes.
-- A row is usable only when membership_key matches the current normalized tag
-- membership. The API refreshes snapshots sequentially in the background, so
-- Explorer requests never aggregate millions of account-event references.

CREATE TABLE IF NOT EXISTS price_data.tag_activity_counts
(
    tag_id String,
    membership_key String,
    extrinsics UInt64,
    events UInt64,
    activity UInt64,
    computed_at DateTime
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY tag_id
SETTINGS index_granularity = 64;
