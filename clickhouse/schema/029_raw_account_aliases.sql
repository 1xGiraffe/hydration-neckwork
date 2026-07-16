CREATE TABLE IF NOT EXISTS price_data.raw_account_aliases
(
    block_height UInt32,
    block_timestamp DateTime,
    event_index Nullable(UInt32),
    extrinsic_index Nullable(UInt32),
    account_id Nullable(String),
    alias_type LowCardinality(String),
    alias_value String,
    evm_address Nullable(String),
    primary_profile String,
    relationship LowCardinality(String),
    evidence_json String CODEC(ZSTD(6)),
    confidence Float32,
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, primary_profile, alias_type, alias_value)
SETTINGS index_granularity = 8192;
