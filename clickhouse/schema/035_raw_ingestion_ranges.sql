CREATE TABLE IF NOT EXISTS price_data.raw_ingestion_ranges
(
    range_id String,
    pipeline_id String,
    from_block UInt32,
    to_block UInt32,
    status LowCardinality(String),
    first_hash String DEFAULT '',
    first_parent_hash String DEFAULT '',
    last_hash String DEFAULT '',
    block_count UInt32 DEFAULT 0,
    expected_block_count UInt32 DEFAULT 0,
    broken_parent_links UInt32 DEFAULT 0,
    error Nullable(String) CODEC(ZSTD(6)),
    started_at DateTime DEFAULT now(),
    completed_at Nullable(DateTime),
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY range_id
SETTINGS index_granularity = 8192;
