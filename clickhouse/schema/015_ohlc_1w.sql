-- OHLCV 1-Week Candles
-- Purpose: Aggregate raw price data into 1-week OHLCV candles
--
-- Target table: ohlc_1w (AggregatingMergeTree with -State aggregates)
-- Materialized view: ohlc_1w_mv (triggers on INSERT to prices table)
-- Time function: toStartOfWeek(b.block_timestamp, 1)
--   Mode 1 = ISO week standard, Monday-start (as opposed to mode 0 = Sunday-start)
--
-- This view automatically creates/updates OHLCV candles whenever prices are inserted.
-- Uses wall-clock UTC timestamps from blocks table via JOIN.

-- ============================================================================
-- Target Table: 1-Week OHLCV Candles
-- ============================================================================

CREATE TABLE IF NOT EXISTS price_data.ohlc_1w
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
-- Materialized View: Auto-populate 1-Week OHLCV from prices
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.ohlc_1w_mv
TO price_data.ohlc_1w
AS SELECT
    p.asset_id,
    toStartOfWeek(b.block_timestamp, 1) AS interval_start,
    argMinState(p.usd_price, b.block_timestamp) AS open_state,
    maxState(p.usd_price) AS high_state,
    minState(p.usd_price) AS low_state,
    argMaxState(p.usd_price, b.block_timestamp) AS close_state,
    sumState(p.usd_volume_buy) AS volume_buy_state,
    sumState(p.usd_volume_sell) AS volume_sell_state
FROM price_data.prices p
INNER JOIN price_data.blocks b ON p.block_height = b.block_height
GROUP BY p.asset_id, interval_start;
