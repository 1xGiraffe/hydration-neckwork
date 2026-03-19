-- OHLCV Query Views for New Intervals (30min, 1w, 1m)
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
-- 1. 30-Minute OHLCV Query View
-- ============================================================================

CREATE OR REPLACE VIEW price_data.ohlc_30min_query AS
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
FROM price_data.ohlc_30min
WHERE asset_id = {asset_id:UInt32}
  AND interval_start BETWEEN {start_time:DateTime} AND {end_time:DateTime}
GROUP BY asset_id, interval_start
ORDER BY interval_start ASC;

-- ============================================================================
-- 2. 1-Week OHLCV Query View (ISO Monday-start)
-- ============================================================================

CREATE OR REPLACE VIEW price_data.ohlc_1w_query AS
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
FROM price_data.ohlc_1w
WHERE asset_id = {asset_id:UInt32}
  AND interval_start BETWEEN {start_time:DateTime} AND {end_time:DateTime}
GROUP BY asset_id, interval_start
ORDER BY interval_start ASC;

-- ============================================================================
-- 3. 1-Month OHLCV Query View
-- ============================================================================

CREATE OR REPLACE VIEW price_data.ohlc_1m_query AS
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
FROM price_data.ohlc_1m
WHERE asset_id = {asset_id:UInt32}
  AND interval_start BETWEEN {start_time:DateTime} AND {end_time:DateTime}
GROUP BY asset_id, interval_start
ORDER BY interval_start ASC;
