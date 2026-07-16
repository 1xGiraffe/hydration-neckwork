CREATE TABLE IF NOT EXISTS price_data.raw_balance_observations
(
    block_height UInt32,
    block_timestamp DateTime,
    observation_id String,
    account_id String,
    asset_kind LowCardinality(String),
    asset_id String,
    free Nullable(String),
    reserved Nullable(String),
    frozen Nullable(String),
    total Nullable(String),
    nonce Nullable(UInt64),
    flags Nullable(String),
    source_kind LowCardinality(String),
    source_name LowCardinality(String),
    source_event_index Nullable(UInt32),
    source_call_address Nullable(String),
    evidence_json String CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, account_id, asset_kind, asset_id, observation_id)
SETTINGS index_granularity = 8192;
