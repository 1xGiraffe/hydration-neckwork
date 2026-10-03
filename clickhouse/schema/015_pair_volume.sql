-- Pair volume: the dollar value and token amounts of the trades BETWEEN two
-- assets, per 5-minute bucket — the volume a pair's candle carries on the pair
-- surfaces (/v1/prices/pair as the additive `pairVolumeUsd` / `volumeBase` /
-- `volumeQuote`, the preis /candles asset pairs, the explorer's pair chart). Not
-- read by the aggregator adapters (CoinGecko, DexScreener, DefiLlama), whose
-- volume definitions are their own.
--
-- Written only by the `pair_volume_5min` derivations job (api/src/derivations/
-- jobs.ts; the SQL in api/src/services/pairVolume.ts), an hourly fold over
-- pool_swap_legs on the volume folds' watermarks (pool_swap_hour_watermarks),
-- cut and registry fingerprint, republished per month partition through the
-- staging twin (REPLACE PARTITION). A trade is the routed volume's netted trade;
-- it belongs to the pair of its two net endpoints (route dust tolerated, see
-- pairVolume.ts), keyed through the price aliases. One row per (asset_lo,
-- asset_hi, 5-minute bucket):
--   volume_usd        greatest(side_in, side_out) at event time, both directions
--   volume_lo_in_usd  the part where asset_lo was paid in (asset_hi bought)
--   amount_lo/_hi     the endpoint amounts in whole units of each asset — exact
--                     (no price), so defined where volume_usd is not
--   trades, unpriced_trades
-- plus one MARKER row per folded hour (asset_lo = asset_hi = 0, interval_start =
-- the hour, zeros), so an hour with no pair trade still reads as folded.
--
-- On an existing deployment: create both tables; the job backfills the full
-- history progressively (every hour is stale until it holds its marker row).
CREATE TABLE IF NOT EXISTS price_data.pair_volume_5min (`asset_lo` UInt32, `asset_hi` UInt32, `interval_start` DateTime, `hour` DateTime, `volume_usd` Decimal(38, 12), `volume_lo_in_usd` Decimal(38, 12), `amount_lo` Decimal(38, 18), `amount_hi` Decimal(38, 18), `trades` UInt32, `unpriced_trades` UInt32, `registry_fp` UInt64, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY (asset_lo, asset_hi, interval_start) SETTINGS index_granularity = 8192;

-- Staging twin for pair_volume_5min, identical in every respect (REPLACE PARTITION source).
CREATE TABLE IF NOT EXISTS price_data.pair_volume_5min_staging (`asset_lo` UInt32, `asset_hi` UInt32, `interval_start` DateTime, `hour` DateTime, `volume_usd` Decimal(38, 12), `volume_lo_in_usd` Decimal(38, 12), `amount_lo` Decimal(38, 18), `amount_hi` Decimal(38, 18), `trades` UInt32, `unpriced_trades` UInt32, `registry_fp` UInt64, `computed_at` DateTime DEFAULT now()) ENGINE = ReplacingMergeTree(computed_at) PARTITION BY toYYYYMM(hour) ORDER BY (asset_lo, asset_hi, interval_start) SETTINGS index_granularity = 8192;
