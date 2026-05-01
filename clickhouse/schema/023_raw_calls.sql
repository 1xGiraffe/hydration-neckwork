CREATE TABLE IF NOT EXISTS price_data.raw_calls
(
    block_height UInt32,
    block_timestamp DateTime,
    extrinsic_index Nullable(UInt32),
    call_address String,
    parent_call_address Nullable(String),
    call_name LowCardinality(String),
    origin_json Nullable(String) CODEC(ZSTD(6)),
    args_json String CODEC(ZSTD(6)),
    success Nullable(UInt8),
    error_json Nullable(String) CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, call_address)
SETTINGS index_granularity = 8192;
