CREATE TABLE IF NOT EXISTS price_data.raw_extrinsics
(
    block_height UInt32,
    block_timestamp DateTime,
    extrinsic_index UInt32,
    extrinsic_hash String,
    version UInt8,
    signer Nullable(String),
    fee Nullable(String),
    tip Nullable(String),
    success UInt8,
    signature_json Nullable(String) CODEC(ZSTD(6)),
    call_name LowCardinality(String),
    call_args_json String CODEC(ZSTD(6)),
    error_json Nullable(String) CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, extrinsic_index)
SETTINGS index_granularity = 8192;
