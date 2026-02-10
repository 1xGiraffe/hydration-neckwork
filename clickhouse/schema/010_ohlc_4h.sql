-- OHLC 4-Hour Candles
-- Purpose: Aggregate raw price data into 4-hour OHLC candles
--
-- Target table: ohlc_4h (AggregatingMergeTree with -State aggregates)
-- Materialized view: ohlc_4h_mv (triggers on INSERT to prices table)
-- Time function: toStartOfInterval(b.block_timestamp, INTERVAL 4 HOUR)
--
-- This view automatically creates/updates OHLC candles whenever prices are inserted.
-- Uses wall-clock UTC timestamps from blocks table via JOIN.

-- ============================================================================
-- Target Table: 4-Hour OHLC Candles
-- ============================================================================

CREATE TABLE IF NOT EXISTS price_data.ohlc_4h
(
    asset_id UInt32,
    interval_start DateTime,
    open_state AggregateFunction(argMin, Decimal128(12), DateTime),
    high_state AggregateFunction(max, Decimal128(12)),
    low_state AggregateFunction(min, Decimal128(12)),
    close_state AggregateFunction(argMax, Decimal128(12), DateTime)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(interval_start)
ORDER BY (asset_id, interval_start)
SETTINGS index_granularity = 8192;

-- ============================================================================
-- Materialized View: Auto-populate 4-Hour OHLC from prices
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.ohlc_4h_mv
TO price_data.ohlc_4h
AS SELECT
    p.asset_id,
    toStartOfInterval(b.block_timestamp, INTERVAL 4 HOUR) AS interval_start,
    argMinState(p.usdt_price, b.block_timestamp) AS open_state,
    maxState(p.usdt_price) AS high_state,
    minState(p.usdt_price) AS low_state,
    argMaxState(p.usdt_price, b.block_timestamp) AS close_state
FROM price_data.prices p
INNER JOIN price_data.blocks b ON p.block_height = b.block_height
GROUP BY p.asset_id, interval_start;
