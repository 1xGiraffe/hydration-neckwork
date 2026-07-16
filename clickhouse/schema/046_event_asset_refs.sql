CREATE TABLE IF NOT EXISTS price_data.event_asset_refs
(
    asset_id UInt32,
    event_name LowCardinality(String),
    block_height UInt32,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    block_timestamp DateTime,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (asset_id, event_name, block_height, event_index)
SETTINGS index_granularity = 2048;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.event_asset_refs_mv
TO price_data.event_asset_refs
AS
SELECT
    arrayJoin(arrayDistinct(arrayConcat(
      if(event_name = 'Balances.Transfer', [toUInt32(0)], emptyArrayUInt32()),
      if(JSONHas(args_json, 'currencyId'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'currencyId')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'currency_id'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'currency_id')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'assetId'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetId')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'asset_id'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'asset_id')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'assetIn'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'assetOut'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'assetA'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetA')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'assetB'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetB')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'poolId'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'poolId')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'rewardCurrency'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'rewardCurrency')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'currency'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'currency')))], emptyArrayUInt32()),
      arrayMap(item -> toUInt32(greatest(0, JSONExtractInt(item, 'assetId'))), JSONExtractArrayRaw(args_json, 'assets'))
    ))) AS asset_id,
    event_name,
    block_height,
    event_index,
    extrinsic_index,
    block_timestamp,
    ingested_at
FROM price_data.raw_events;

CREATE TABLE IF NOT EXISTS price_data.event_asset_refs_backfill
(
    partition String,
    completed_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;

-- Materialized views only see inserts made after they are attached. Seed every
-- pre-existing raw partition before writers restart, and record completion so a
-- repeated offline upgrade does not replay the full history.
INSERT INTO price_data.event_asset_refs
SELECT
    arrayJoin(arrayDistinct(arrayConcat(
      if(event_name = 'Balances.Transfer', [toUInt32(0)], emptyArrayUInt32()),
      if(JSONHas(args_json, 'currencyId'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'currencyId')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'currency_id'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'currency_id')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'assetId'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetId')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'asset_id'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'asset_id')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'assetIn'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'assetOut'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'assetA'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetA')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'assetB'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'assetB')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'poolId'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'poolId')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'rewardCurrency'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'rewardCurrency')))], emptyArrayUInt32()),
      if(JSONHas(args_json, 'currency'), [toUInt32(greatest(0, JSONExtractInt(args_json, 'currency')))], emptyArrayUInt32()),
      arrayMap(item -> toUInt32(greatest(0, JSONExtractInt(item, 'assetId'))), JSONExtractArrayRaw(args_json, 'assets'))
    ))) AS asset_id,
    event_name,
    block_height,
    event_index,
    extrinsic_index,
    block_timestamp,
    ingested_at
FROM price_data.raw_events
WHERE toString(toYYYYMM(block_timestamp)) NOT IN
  (SELECT partition FROM price_data.event_asset_refs_backfill FINAL);

INSERT INTO price_data.event_asset_refs_backfill (partition)
SELECT DISTINCT toString(toYYYYMM(block_timestamp))
FROM price_data.raw_events
WHERE toString(toYYYYMM(block_timestamp)) NOT IN
  (SELECT partition FROM price_data.event_asset_refs_backfill FINAL);
