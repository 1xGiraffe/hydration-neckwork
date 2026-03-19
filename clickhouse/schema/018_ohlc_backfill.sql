-- OHLCV Historical Data Backfill for New Intervals (30min, 1w, 1m)
-- Purpose: Populate ohlc_30min, ohlc_1w, ohlc_1m tables with all existing price data
--
-- Run AFTER creating tables and MVs (014-017). Order: tables+MVs first, then backfill.
-- The materialized views only capture new inserts going forward; this script fills
-- historical data by replaying the MV SELECT logic against the full prices table.
--
-- Each INSERT mirrors the corresponding MV SELECT body exactly, using the same
-- -State aggregates and time functions.

-- ============================================================================
-- Backfill 30-Minute Candles
-- ============================================================================

INSERT INTO price_data.ohlc_30min
SELECT
    p.asset_id,
    toStartOfInterval(b.block_timestamp, INTERVAL 30 MINUTE) AS interval_start,
    argMinState(p.usdt_price, b.block_timestamp) AS open_state,
    maxState(p.usdt_price) AS high_state,
    minState(p.usdt_price) AS low_state,
    argMaxState(p.usdt_price, b.block_timestamp) AS close_state,
    sumState(p.usdt_volume_buy) AS volume_buy_state,
    sumState(p.usdt_volume_sell) AS volume_sell_state
FROM price_data.prices p
INNER JOIN price_data.blocks b ON p.block_height = b.block_height
GROUP BY p.asset_id, interval_start;

-- ============================================================================
-- Backfill 1-Week Candles (mode 1 = ISO Monday-start)
-- ============================================================================

INSERT INTO price_data.ohlc_1w
SELECT
    p.asset_id,
    toStartOfWeek(b.block_timestamp, 1) AS interval_start,
    argMinState(p.usdt_price, b.block_timestamp) AS open_state,
    maxState(p.usdt_price) AS high_state,
    minState(p.usdt_price) AS low_state,
    argMaxState(p.usdt_price, b.block_timestamp) AS close_state,
    sumState(p.usdt_volume_buy) AS volume_buy_state,
    sumState(p.usdt_volume_sell) AS volume_sell_state
FROM price_data.prices p
INNER JOIN price_data.blocks b ON p.block_height = b.block_height
GROUP BY p.asset_id, interval_start;

-- ============================================================================
-- Backfill 1-Month Candles
-- ============================================================================

INSERT INTO price_data.ohlc_1m
SELECT
    p.asset_id,
    toStartOfMonth(b.block_timestamp) AS interval_start,
    argMinState(p.usdt_price, b.block_timestamp) AS open_state,
    maxState(p.usdt_price) AS high_state,
    minState(p.usdt_price) AS low_state,
    argMaxState(p.usdt_price, b.block_timestamp) AS close_state,
    sumState(p.usdt_volume_buy) AS volume_buy_state,
    sumState(p.usdt_volume_sell) AS volume_sell_state
FROM price_data.prices p
INNER JOIN price_data.blocks b ON p.block_height = b.block_height
GROUP BY p.asset_id, interval_start;
