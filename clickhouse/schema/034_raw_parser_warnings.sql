CREATE TABLE IF NOT EXISTS price_data.raw_parser_warnings
(
    block_height UInt32,
    block_timestamp DateTime,
    parser LowCardinality(String),
    source_kind LowCardinality(String),
    source_name LowCardinality(String),
    source_index String,
    warning_code LowCardinality(String),
    warning String,
    evidence_json String CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, parser, source_kind, source_index, warning_code)
SETTINGS index_granularity = 8192;
