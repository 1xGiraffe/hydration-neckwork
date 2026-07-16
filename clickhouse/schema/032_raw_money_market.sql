CREATE TABLE IF NOT EXISTS price_data.raw_money_market_events
(
    block_height UInt32,
    block_timestamp DateTime,
    event_index UInt32,
    contract_address String,
    pool_address Nullable(String),
    event_name LowCardinality(String),
    user_address Nullable(String),
    account_id Nullable(String),
    asset_address Nullable(String),
    amount Nullable(String),
    participants Array(String),
    decoded_args_json String CODEC(ZSTD(6)),
    position_observation_id Nullable(String),
    evidence_json String CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index, event_name);

CREATE TABLE IF NOT EXISTS price_data.raw_money_market_positions
(
    block_height UInt32,
    block_timestamp DateTime,
    observation_id String,
    user_address String,
    account_id Nullable(String),
    pool_address String,
    total_collateral_base String,
    total_debt_base String,
    available_borrows_base String,
    current_liquidation_threshold String,
    ltv String,
    health_factor String,
    evidence_json String CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, user_address, pool_address, observation_id);

CREATE TABLE IF NOT EXISTS price_data.raw_money_market_reserves
(
    block_height UInt32,
    block_timestamp DateTime,
    event_index UInt32,
    contract_address String,
    pool_address String DEFAULT '',
    event_name LowCardinality(String),
    reserve_address Nullable(String),
    asset_address Nullable(String),
    metrics_json String CODEC(ZSTD(6)),
    decoded_args_json String CODEC(ZSTD(6)),
    evidence_json String CODEC(ZSTD(6)),
    ingest_source LowCardinality(String) DEFAULT 'sqd',
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index, event_name);
