CREATE TABLE IF NOT EXISTS price_data.indexer_state
(
    id String,
    last_block UInt32,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id
SETTINGS index_granularity = 8192;
