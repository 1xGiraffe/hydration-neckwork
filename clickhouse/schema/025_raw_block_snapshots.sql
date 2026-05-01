CREATE TABLE IF NOT EXISTS price_data.raw_block_snapshots
(
    block_height UInt32,
    block_hash String,
    block_timestamp DateTime,
    spec_version UInt32,
    snapshot_version UInt16 DEFAULT 1,
    families Array(String),
    payload_format LowCardinality(String) DEFAULT 'json',
    payload_json String CODEC(ZSTD(9)),
    payload_sha256 String,
    payload_size_bytes UInt32 MATERIALIZED toUInt32(length(payload_json)),
    ingest_source LowCardinality(String) DEFAULT 'rpc',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY block_height
SETTINGS index_granularity = 8192;
