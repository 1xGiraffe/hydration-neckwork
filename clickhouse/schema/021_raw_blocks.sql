CREATE TABLE IF NOT EXISTS price_data.raw_blocks
(
    block_height UInt32,
    block_hash String,
    parent_hash String,
    state_root Nullable(String),
    extrinsics_root Nullable(String),
    block_timestamp DateTime,
    spec_version UInt32,
    author Nullable(String),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY block_height
SETTINGS index_granularity = 8192;
