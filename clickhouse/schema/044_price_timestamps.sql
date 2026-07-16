-- Price write-path optimization
--
-- Apply while the main price indexer is stopped. This is metadata-only: it
-- preserves prices, blocks, and all OHLC target tables. Existing price rows get
-- the epoch default; new indexer writes provide the actual block timestamp.
-- The materialized views deliberately ignore epoch rows so older repair tools
-- cannot create a bogus 1970 candle.

ALTER TABLE price_data.prices
    ADD COLUMN IF NOT EXISTS block_timestamp DateTime DEFAULT toDateTime(0)
    AFTER block_height;

DROP VIEW IF EXISTS price_data.ohlc_5min_mv;
DROP VIEW IF EXISTS price_data.ohlc_15min_mv;
DROP VIEW IF EXISTS price_data.ohlc_30min_mv;
DROP VIEW IF EXISTS price_data.ohlc_1h_mv;
DROP VIEW IF EXISTS price_data.ohlc_4h_mv;
DROP VIEW IF EXISTS price_data.ohlc_1d_mv;
DROP VIEW IF EXISTS price_data.ohlc_1w_mv;
DROP VIEW IF EXISTS price_data.ohlc_1m_mv;

CREATE MATERIALIZED VIEW price_data.ohlc_5min_mv
TO price_data.ohlc_5min AS
SELECT
    asset_id,
    toStartOfFiveMinute(block_timestamp) AS interval_start,
    argMinState(usd_price, block_timestamp) AS open_state,
    maxState(usd_price) AS high_state,
    minState(usd_price) AS low_state,
    argMaxState(usd_price, block_timestamp) AS close_state,
    sumState(usd_volume_buy) AS volume_buy_state,
    sumState(usd_volume_sell) AS volume_sell_state
FROM price_data.prices
WHERE block_timestamp > toDateTime(0)
GROUP BY asset_id, interval_start;

CREATE MATERIALIZED VIEW price_data.ohlc_15min_mv
TO price_data.ohlc_15min AS
SELECT
    asset_id,
    toStartOfInterval(block_timestamp, INTERVAL 15 MINUTE) AS interval_start,
    argMinState(usd_price, block_timestamp) AS open_state,
    maxState(usd_price) AS high_state,
    minState(usd_price) AS low_state,
    argMaxState(usd_price, block_timestamp) AS close_state,
    sumState(usd_volume_buy) AS volume_buy_state,
    sumState(usd_volume_sell) AS volume_sell_state
FROM price_data.prices
WHERE block_timestamp > toDateTime(0)
GROUP BY asset_id, interval_start;

CREATE MATERIALIZED VIEW price_data.ohlc_30min_mv
TO price_data.ohlc_30min AS
SELECT
    asset_id,
    toStartOfInterval(block_timestamp, INTERVAL 30 MINUTE) AS interval_start,
    argMinState(usd_price, block_timestamp) AS open_state,
    maxState(usd_price) AS high_state,
    minState(usd_price) AS low_state,
    argMaxState(usd_price, block_timestamp) AS close_state,
    sumState(usd_volume_buy) AS volume_buy_state,
    sumState(usd_volume_sell) AS volume_sell_state
FROM price_data.prices
WHERE block_timestamp > toDateTime(0)
GROUP BY asset_id, interval_start;

CREATE MATERIALIZED VIEW price_data.ohlc_1h_mv
TO price_data.ohlc_1h AS
SELECT
    asset_id,
    toStartOfHour(block_timestamp) AS interval_start,
    argMinState(usd_price, block_timestamp) AS open_state,
    maxState(usd_price) AS high_state,
    minState(usd_price) AS low_state,
    argMaxState(usd_price, block_timestamp) AS close_state,
    sumState(usd_volume_buy) AS volume_buy_state,
    sumState(usd_volume_sell) AS volume_sell_state
FROM price_data.prices
WHERE block_timestamp > toDateTime(0)
GROUP BY asset_id, interval_start;

CREATE MATERIALIZED VIEW price_data.ohlc_4h_mv
TO price_data.ohlc_4h AS
SELECT
    asset_id,
    toStartOfInterval(block_timestamp, INTERVAL 4 HOUR) AS interval_start,
    argMinState(usd_price, block_timestamp) AS open_state,
    maxState(usd_price) AS high_state,
    minState(usd_price) AS low_state,
    argMaxState(usd_price, block_timestamp) AS close_state,
    sumState(usd_volume_buy) AS volume_buy_state,
    sumState(usd_volume_sell) AS volume_sell_state
FROM price_data.prices
WHERE block_timestamp > toDateTime(0)
GROUP BY asset_id, interval_start;

CREATE MATERIALIZED VIEW price_data.ohlc_1d_mv
TO price_data.ohlc_1d AS
SELECT
    asset_id,
    toStartOfDay(block_timestamp) AS interval_start,
    argMinState(usd_price, block_timestamp) AS open_state,
    maxState(usd_price) AS high_state,
    minState(usd_price) AS low_state,
    argMaxState(usd_price, block_timestamp) AS close_state,
    sumState(usd_volume_buy) AS volume_buy_state,
    sumState(usd_volume_sell) AS volume_sell_state
FROM price_data.prices
WHERE block_timestamp > toDateTime(0)
GROUP BY asset_id, interval_start;

CREATE MATERIALIZED VIEW price_data.ohlc_1w_mv
TO price_data.ohlc_1w AS
SELECT
    asset_id,
    toStartOfWeek(block_timestamp, 1) AS interval_start,
    argMinState(usd_price, block_timestamp) AS open_state,
    maxState(usd_price) AS high_state,
    minState(usd_price) AS low_state,
    argMaxState(usd_price, block_timestamp) AS close_state,
    sumState(usd_volume_buy) AS volume_buy_state,
    sumState(usd_volume_sell) AS volume_sell_state
FROM price_data.prices
WHERE block_timestamp > toDateTime(0)
GROUP BY asset_id, interval_start;

CREATE MATERIALIZED VIEW price_data.ohlc_1m_mv
TO price_data.ohlc_1m AS
SELECT
    asset_id,
    toStartOfMonth(block_timestamp) AS interval_start,
    argMinState(usd_price, block_timestamp) AS open_state,
    maxState(usd_price) AS high_state,
    minState(usd_price) AS low_state,
    argMaxState(usd_price, block_timestamp) AS close_state,
    sumState(usd_volume_buy) AS volume_buy_state,
    sumState(usd_volume_sell) AS volume_sell_state
FROM price_data.prices
WHERE block_timestamp > toDateTime(0)
GROUP BY asset_id, interval_start;
