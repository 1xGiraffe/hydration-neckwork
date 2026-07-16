CREATE TABLE IF NOT EXISTS price_data.raw_xcm_activity
(
    block_height UInt32,
    block_timestamp DateTime,
    source_kind LowCardinality(String),
    source_index String,
    event_index Nullable(UInt32),
    extrinsic_index Nullable(UInt32),
    call_address Nullable(String),
    name LowCardinality(String),
    direction LowCardinality(String),
    sender Nullable(String),
    recipient Nullable(String),
    message_hash Nullable(String),
    assets_json String CODEC(ZSTD(6)),
    location_json String CODEC(ZSTD(6)),
    external_link_hints Array(String),
    args_json String CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, source_kind, source_index, name);

CREATE TABLE IF NOT EXISTS price_data.raw_bridge_evidence
(
    block_height UInt32,
    block_timestamp DateTime,
    source_kind LowCardinality(String),
    source_index String,
    event_index Nullable(UInt32),
    extrinsic_index Nullable(UInt32),
    call_address Nullable(String),
    name LowCardinality(String),
    bridge_kind LowCardinality(String),
    direction LowCardinality(String),
    account_id Nullable(String),
    external_account Nullable(String),
    asset_id Nullable(String),
    amount Nullable(String),
    evidence_json String CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, bridge_kind, source_kind, source_index);

CREATE TABLE IF NOT EXISTS price_data.raw_operation_traces
(
    block_height UInt32,
    block_timestamp DateTime,
    trace_id String,
    event_index Nullable(UInt32),
    extrinsic_index Nullable(UInt32),
    call_address Nullable(String),
    operation_name LowCardinality(String),
    account_id Nullable(String),
    operation_stack_json String CODEC(ZSTD(6)),
    assets_json String CODEC(ZSTD(6)),
    amounts_json String CODEC(ZSTD(6)),
    evidence_json String CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, trace_id);
