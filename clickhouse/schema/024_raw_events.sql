CREATE TABLE IF NOT EXISTS price_data.raw_events
(
    block_height UInt32,
    block_timestamp DateTime,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    call_address Nullable(String),
    phase LowCardinality(String),
    event_name LowCardinality(String),
    args_json String CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 8192;
