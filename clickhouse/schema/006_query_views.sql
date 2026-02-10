-- Query Views for Price Data Access
-- Purpose: Encapsulate common query patterns with parameterized views
--
-- Views provided:
--   1. price_at_block - Point query by asset_id
--   2. price_at_block_by_symbol - Point query by symbol
--   3. price_range - Range query with LOCF gap filling
--   4. price_at_timestamp - Timestamp-based nearest-block lookup
--
-- Note: Cross-asset pivot queries (QUERY-03) use a SQL template documented
--       separately because the column list is dynamic. See QUERY_GUIDE.md.

-- ============================================================================
-- 1. Point Query View (by asset_id)
-- ============================================================================
-- Retrieves single asset price at specific block
-- Returns: asset_id, block_height, usdt_price (rounded to 8 decimals)
-- Performance: ~50-100ms (ClickHouse sparse index limitation for point queries)

CREATE OR REPLACE VIEW price_data.price_at_block AS
SELECT
  asset_id,
  block_height,
  round(usdt_price, 8) AS usdt_price
FROM price_data.prices FINAL
WHERE asset_id = {asset_id:UInt32}
  AND block_height = {block_height:UInt32};

-- ============================================================================
-- 2. Point Query View (by symbol)
-- ============================================================================
-- Retrieves single asset price at specific block using symbol lookup
-- Returns: asset_id, block_height, usdt_price (no symbol in output)
-- Note: Symbol is used only for filtering, not projected in results

CREATE OR REPLACE VIEW price_data.price_at_block_by_symbol AS
SELECT
  asset_id,
  block_height,
  round(usdt_price, 8) AS usdt_price
FROM price_data.prices FINAL
WHERE asset_id = (SELECT asset_id FROM price_data.assets FINAL WHERE symbol = {symbol:String} LIMIT 1)
  AND block_height = {block_height:UInt32};

-- ============================================================================
-- 3. Range Query View with Fill-Forward (LOCF)
-- ============================================================================
-- Retrieves asset price series across block range with gap filling
-- Returns: block_height, usdt_price (continuous series, no gaps)
-- LOCF semantics: Last observation carried forward for missing blocks

CREATE OR REPLACE VIEW price_data.price_range AS
WITH base AS (
  SELECT
    block_height,
    round(usdt_price, 8) AS usdt_price
  FROM price_data.prices FINAL
  WHERE asset_id = {asset_id:UInt32}
    AND block_height BETWEEN {start_block:UInt32} AND {end_block:UInt32}
)
SELECT
  block_height,
  usdt_price
FROM base
ORDER BY block_height ASC
WITH FILL
  FROM {start_block:UInt32}
  TO {end_block:UInt32} + 1
  STEP 1
  INTERPOLATE (usdt_price);

-- ============================================================================
-- 4. Timestamp Query View (Nearest Block Lookup)
-- ============================================================================
-- Maps wall-clock timestamp to nearest block and retrieves price
-- Returns: asset_id, block_height, usdt_price
-- Window: ±1 hour from target limits scan to ~300 blocks at 12s/block
-- Note: Use this view's block_height to query blocks table for timestamp if needed

CREATE OR REPLACE VIEW price_data.price_at_timestamp AS
WITH nearest_block AS (
  SELECT argMin(block_height, abs(toUnixTimestamp(block_timestamp) - toUnixTimestamp({target_timestamp:DateTime}))) AS block_height
  FROM price_data.blocks
  WHERE block_timestamp BETWEEN {target_timestamp:DateTime} - INTERVAL 1 HOUR
                            AND {target_timestamp:DateTime} + INTERVAL 1 HOUR
)
SELECT
  asset_id,
  block_height,
  round(usdt_price, 8) AS usdt_price
FROM price_data.prices FINAL
WHERE asset_id = {asset_id:UInt32}
  AND block_height = (SELECT block_height FROM nearest_block);
