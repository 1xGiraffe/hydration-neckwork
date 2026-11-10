-- Each asset's newest hourly candle per UTC day: its hour (`last_hour`) and its close.
-- A dated window's event-time valuation ASOF-matches every row against the closed
-- hourly closes, and an asset quiet since before the window still needs its newest
-- close older than the window (historicalClosesRelationSql in
-- api/src/services/explorerService.ts). Found in ohlc_1h, that one close per asset is a
-- scan of the whole hourly history across every monthly part; here it is one read of
-- ~50k narrow rows, plus the window's own day from ohlc_1h.
--
-- Chained off ohlc_1h, not off prices, so it states exactly what ohlc_1h holds: every
-- INSERT into ohlc_1h reaches it — ohlc_1h_mv's per-block writes and the repair's
-- rebuilds alike (much of ohlc_1h's history was rebuilt from prices ⋈ blocks, which the
-- prices MVs never saw). The day's close is the merge of its hours' argMax states, so it
-- is the close of its newest hour. Replay-safe: max and argMax are idempotent, so a
-- re-inserted candle changes nothing. A DELETE on ohlc_1h does not reach a view, so the
-- OHLC repair and rollback clear and re-derive the days they touch
-- (src/ohlc/repair.ts). An upgrading database took a one-time fill from ohlc_1h by the
-- view's own SELECT; a fresh one is complete from the declaration.
CREATE TABLE IF NOT EXISTS price_data.ohlc_1h_day_closes (`asset_id` UInt32, `day` DateTime, `last_hour` SimpleAggregateFunction(max, DateTime), `close_state` AggregateFunction(argMax, Decimal(38, 12), DateTime)) ENGINE = AggregatingMergeTree ORDER BY (asset_id, day) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.ohlc_1h_day_closes_mv TO price_data.ohlc_1h_day_closes (`asset_id` UInt32, `day` DateTime, `last_hour` DateTime, `close_state` AggregateFunction(argMax, Decimal(38, 12), DateTime)) AS SELECT asset_id, toStartOfDay(interval_start) AS day, max(interval_start) AS last_hour, argMaxMergeState(close_state) AS close_state FROM price_data.ohlc_1h GROUP BY asset_id, day;
