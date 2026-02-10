CREATE TABLE IF NOT EXISTS price_data.assets
(
    asset_id UInt32,
    symbol String,
    name String,
    decimals UInt8
)
ENGINE = ReplacingMergeTree
ORDER BY asset_id
SETTINGS index_granularity = 8192;
