CREATE TABLE IF NOT EXISTS price_data.prices
(
    asset_id UInt32,
    block_height UInt32,
    usdt_price Decimal128(12),
    native_volume_buy Decimal128(0) DEFAULT 0,
    native_volume_sell Decimal128(0) DEFAULT 0,
    usdt_volume_buy Decimal128(12) DEFAULT 0,
    usdt_volume_sell Decimal128(12) DEFAULT 0
)
ENGINE = ReplacingMergeTree(block_height)
PARTITION BY toYYYYMM(toDateTime(block_height * 12))
ORDER BY (asset_id, block_height)
SETTINGS index_granularity = 8192;
