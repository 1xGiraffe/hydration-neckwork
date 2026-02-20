-- OHLCV Query Views for Price Data Access
-- Purpose: Parameterized query views for OHLCV candle data with -Merge combinators
--
-- These views hide the complexity of AggregateFunction/State/Merge operations from users.
-- Each view queries its corresponding OHLCV AggregatingMergeTree table and uses -Merge
-- combinators to extract final OHLCV values from -State aggregate functions.
--
-- Important: GROUP BY is required because AggregatingMergeTree tables may contain
-- unmerged parts during background merge operations. Without GROUP BY, you might get
-- duplicate rows for the same (asset_id, interval_start) combination.
--
-- All views accept the same 3 parameters:
--   - asset_id: UInt32 - Hydration asset ID
--   - start_time: DateTime - Interval start range (inclusive)
--   - end_time: DateTime - Interval end range (inclusive)

-- ============================================================================
-- 1. 5-Minute OHLCV Query View
-- ============================================================================
-- Returns OHLCV candles for 5-minute intervals
-- Performance: ~500ms for 30-day range (~8640 candles)

CREATE OR REPLACE VIEW price_data.ohlc_5min_query AS
SELECT
    asset_id,
    interval_start,
    argMinMerge(open_state) AS open,
    maxMerge(high_state) AS high,
    minMerge(low_state) AS low,
    argMaxMerge(close_state) AS close,
    sumMerge(volume_buy_state) AS volume_buy,
    sumMerge(volume_sell_state) AS volume_sell,
    sumMerge(volume_buy_state) + sumMerge(volume_sell_state) AS volume_total
FROM price_data.ohlc_5min
WHERE asset_id = {asset_id:UInt32}
  AND interval_start BETWEEN {start_time:DateTime} AND {end_time:DateTime}
GROUP BY asset_id, interval_start
ORDER BY interval_start ASC;

-- ============================================================================
-- 2. 15-Minute OHLCV Query View
-- ============================================================================
-- Returns OHLCV candles for 15-minute intervals
-- Performance: ~300ms for 30-day range (~2880 candles)

CREATE OR REPLACE VIEW price_data.ohlc_15min_query AS
SELECT
    asset_id,
    interval_start,
    argMinMerge(open_state) AS open,
    maxMerge(high_state) AS high,
    minMerge(low_state) AS low,
    argMaxMerge(close_state) AS close,
    sumMerge(volume_buy_state) AS volume_buy,
    sumMerge(volume_sell_state) AS volume_sell,
    sumMerge(volume_buy_state) + sumMerge(volume_sell_state) AS volume_total
FROM price_data.ohlc_15min
WHERE asset_id = {asset_id:UInt32}
  AND interval_start BETWEEN {start_time:DateTime} AND {end_time:DateTime}
GROUP BY asset_id, interval_start
ORDER BY interval_start ASC;

-- ============================================================================
-- 3. 1-Hour OHLCV Query View
-- ============================================================================
-- Returns OHLCV candles for 1-hour intervals
-- Performance: ~100ms for 30-day range (~720 candles)

CREATE OR REPLACE VIEW price_data.ohlc_1h_query AS
SELECT
    asset_id,
    interval_start,
    argMinMerge(open_state) AS open,
    maxMerge(high_state) AS high,
    minMerge(low_state) AS low,
    argMaxMerge(close_state) AS close,
    sumMerge(volume_buy_state) AS volume_buy,
    sumMerge(volume_sell_state) AS volume_sell,
    sumMerge(volume_buy_state) + sumMerge(volume_sell_state) AS volume_total
FROM price_data.ohlc_1h
WHERE asset_id = {asset_id:UInt32}
  AND interval_start BETWEEN {start_time:DateTime} AND {end_time:DateTime}
GROUP BY asset_id, interval_start
ORDER BY interval_start ASC;

-- ============================================================================
-- 4. 4-Hour OHLCV Query View
-- ============================================================================
-- Returns OHLCV candles for 4-hour intervals
-- Performance: ~50ms for 30-day range (~180 candles)

CREATE OR REPLACE VIEW price_data.ohlc_4h_query AS
SELECT
    asset_id,
    interval_start,
    argMinMerge(open_state) AS open,
    maxMerge(high_state) AS high,
    minMerge(low_state) AS low,
    argMaxMerge(close_state) AS close,
    sumMerge(volume_buy_state) AS volume_buy,
    sumMerge(volume_sell_state) AS volume_sell,
    sumMerge(volume_buy_state) + sumMerge(volume_sell_state) AS volume_total
FROM price_data.ohlc_4h
WHERE asset_id = {asset_id:UInt32}
  AND interval_start BETWEEN {start_time:DateTime} AND {end_time:DateTime}
GROUP BY asset_id, interval_start
ORDER BY interval_start ASC;

-- ============================================================================
-- 5. 1-Day OHLCV Query View
-- ============================================================================
-- Returns OHLCV candles for 1-day intervals
-- Performance: ~50ms for 1-year range (~365 candles)

CREATE OR REPLACE VIEW price_data.ohlc_1d_query AS
SELECT
    asset_id,
    interval_start,
    argMinMerge(open_state) AS open,
    maxMerge(high_state) AS high,
    minMerge(low_state) AS low,
    argMaxMerge(close_state) AS close,
    sumMerge(volume_buy_state) AS volume_buy,
    sumMerge(volume_sell_state) AS volume_sell,
    sumMerge(volume_buy_state) + sumMerge(volume_sell_state) AS volume_total
FROM price_data.ohlc_1d
WHERE asset_id = {asset_id:UInt32}
  AND interval_start BETWEEN {start_time:DateTime} AND {end_time:DateTime}
GROUP BY asset_id, interval_start
ORDER BY interval_start ASC;
