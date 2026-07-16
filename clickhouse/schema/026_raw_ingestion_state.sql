CREATE TABLE IF NOT EXISTS price_data.raw_ingestion_state
(
    pipeline_id String,
    last_block UInt32,
    last_hash String,
    mode LowCardinality(String),
    state_json String DEFAULT '{}' CODEC(ZSTD(6)),
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY pipeline_id
SETTINGS index_granularity = 8192;
