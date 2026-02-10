CREATE TABLE IF NOT EXISTS price_data.blocks
(
    block_height UInt32,
    block_timestamp DateTime,
    spec_version UInt32
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY block_height
SETTINGS index_granularity = 8192;
