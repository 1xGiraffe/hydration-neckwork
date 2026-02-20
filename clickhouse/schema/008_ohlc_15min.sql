-- OHLCV 15-Minute Candles
-- Purpose: Aggregate raw price data into 15-minute OHLCV candles
--
-- Target table: ohlc_15min (AggregatingMergeTree with -State aggregates)
-- Materialized view: ohlc_15min_mv (triggers on INSERT to prices table)
-- Time function: toStartOfInterval(b.block_timestamp, INTERVAL 15 MINUTE)
--
-- This view automatically creates/updates OHLCV candles whenever prices are inserted.
-- Uses wall-clock UTC timestamps from blocks table via JOIN.

-- ============================================================================
-- Target Table: 15-Minute OHLCV Candles
-- ============================================================================

CREATE TABLE IF NOT EXISTS price_data.ohlc_15min
(
    asset_id UInt32,
    interval_start DateTime,
    open_state AggregateFunction(argMin, Decimal128(12), DateTime),
    high_state AggregateFunction(max, Decimal128(12)),
    low_state AggregateFunction(min, Decimal128(12)),
    close_state AggregateFunction(argMax, Decimal128(12), DateTime),
    volume_buy_state AggregateFunction(sum, Decimal128(12)),
    volume_sell_state AggregateFunction(sum, Decimal128(12))
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(interval_start)
ORDER BY (asset_id, interval_start)
SETTINGS index_granularity = 8192;

-- ============================================================================
-- Materialized View: Auto-populate 15-Minute OHLCV from prices
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.ohlc_15min_mv
TO price_data.ohlc_15min
AS SELECT
    p.asset_id,
    toStartOfInterval(b.block_timestamp, INTERVAL 15 MINUTE) AS interval_start,
    argMinState(p.usdt_price, b.block_timestamp) AS open_state,
    maxState(p.usdt_price) AS high_state,
    minState(p.usdt_price) AS low_state,
    argMaxState(p.usdt_price, b.block_timestamp) AS close_state,
    sumState(p.usdt_volume_buy) AS volume_buy_state,
    sumState(p.usdt_volume_sell) AS volume_sell_state
FROM price_data.prices p
INNER JOIN price_data.blocks b ON p.block_height = b.block_height
GROUP BY p.asset_id, interval_start;
