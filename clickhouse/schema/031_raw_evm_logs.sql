CREATE TABLE IF NOT EXISTS price_data.raw_evm_logs
(
    block_height UInt32,
    block_timestamp DateTime,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    call_address Nullable(String),
    contract_address String,
    topic0 Nullable(String),
    topics Array(String),
    data String,
    decode_status LowCardinality(String),
    event_signature Nullable(String),
    event_name Nullable(String),
    decoded_args_json String CODEC(ZSTD(6)),
    participants Array(String),
    assets Array(String),
    warning Nullable(String),
    raw_log_json String CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 8192;
