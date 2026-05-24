-- Per-account trade volume used by Omniwatch markers and candle detail modals.
-- This table is populated by the final price indexer from decoded swap events.
-- The raw indexer is intentionally not involved.

CREATE TABLE IF NOT EXISTS price_data.trade_volume_by_account
(
    asset_id UInt32,
    block_height UInt32,
    account String,
    native_volume_buy Decimal128(0) DEFAULT 0,
    native_volume_sell Decimal128(0) DEFAULT 0,
    usd_volume_buy Decimal128(12) DEFAULT 0,
    usd_volume_sell Decimal128(12) DEFAULT 0,
    trade_count UInt32
)
ENGINE = ReplacingMergeTree(block_height)
PARTITION BY toYYYYMM(toDateTime(block_height * 12))
ORDER BY (asset_id, block_height, account)
SETTINGS index_granularity = 8192;
