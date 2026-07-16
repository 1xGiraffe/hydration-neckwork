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
-- Subsquid call addresses ('root', '0', '1.2', …) are unique only WITHIN an
-- extrinsic, so extrinsic_index must be part of the key — without it the
-- ReplacingMergeTree collapses same-address calls of different extrinsics in a
-- block to one survivor (ifNull keeps the sort key non-nullable).
ORDER BY (block_height, ifNull(extrinsic_index, 4294967295), call_address)
SETTINGS index_granularity = 8192;
