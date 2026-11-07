-- Liquidity bootstrapping pools (pallet-lbp): every event the pallet emits — a pool's
-- creation and terms (PoolCreated, PoolUpdated), its liquidity (LiquidityAdded,
-- LiquidityRemoved: the seed and what was returned to the owner) and every trade in it
-- (SellExecuted, BuyExecuted). The HDX bonds' primary sales ran through two of these
-- pools (api/src/services/bondSales.ts, the LBP sale source), which read the whole
-- family on every registry load; from raw_events that is a scan of the event-name
-- index over all history for a few hundred rows. The pallet still emits SellExecuted /
-- BuyExecuted beside Broadcast.Swapped3, so this one family covers every era.
--
-- Narrow and replay-safe like 017's tables: keyed on the raw row's own
-- (block_height, event_index) under ReplacingMergeTree(ingested_at), so a replayed raw
-- range collapses onto the same rows. An upgrading database gets the history from raw
-- through the DATA_UPGRADES entry (api/src/db/schemaBootstrap.ts), which replays the
-- same predicate and select.
CREATE TABLE IF NOT EXISTS price_data.lbp_activity (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `args_json` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (block_height, event_index) SETTINGS index_granularity = 1024;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.lbp_activity_mv TO price_data.lbp_activity (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `args_json` String, `ingested_at` DateTime) AS SELECT block_height, event_index, extrinsic_index, block_timestamp, event_name, args_json, ingested_at FROM price_data.raw_events WHERE raw_events.event_name IN ('LBP.PoolCreated', 'LBP.PoolUpdated', 'LBP.LiquidityAdded', 'LBP.LiquidityRemoved', 'LBP.SellExecuted', 'LBP.BuyExecuted');
