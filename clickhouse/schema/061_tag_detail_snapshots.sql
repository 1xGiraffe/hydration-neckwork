-- Durable snapshots for complete tag portfolio/detail responses. Membership is
-- part of the validity key; background refresh replaces each tag atomically.

CREATE TABLE IF NOT EXISTS price_data.tag_detail_snapshots
(
    tag_id String,
    membership_key String,
    payload_json String,
    computed_at DateTime
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY tag_id
SETTINGS index_granularity = 64;
