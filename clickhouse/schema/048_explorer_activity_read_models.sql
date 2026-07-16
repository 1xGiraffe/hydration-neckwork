-- Replay-safe, narrow activity sources for the Explorer's exact feed shapes.
-- Historical rows are copied by the API's bounded partition backfills; these
-- declarations intentionally contain no unbounded INSERT ... SELECT.

CREATE TABLE IF NOT EXISTS price_data.transfer_activity_by_time
(
    block_height UInt32,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    block_timestamp DateTime,
    event_name LowCardinality(String),
    from_account String,
    to_account String,
    amount String,
    asset_id UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index);

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.transfer_activity_by_time_mv
TO price_data.transfer_activity_by_time AS
SELECT
    block_height, event_index, extrinsic_index, block_timestamp, event_name,
    JSONExtractString(args_json, 'from') AS from_account,
    JSONExtractString(args_json, 'to') AS to_account,
    JSONExtractString(args_json, 'amount') AS amount,
    toUInt32(if(event_name = 'Balances.Transfer', 0, multiIf(
      JSONHas(args_json, 'currencyId'), JSONExtractInt(args_json, 'currencyId'),
      JSONHas(args_json, 'currency_id'), JSONExtractInt(args_json, 'currency_id'),
      JSONHas(args_json, 'assetId'), JSONExtractInt(args_json, 'assetId'),
      JSONHas(args_json, 'asset_id'), JSONExtractInt(args_json, 'asset_id'), 0))) AS asset_id
FROM price_data.raw_events
WHERE event_name IN ('Balances.Transfer', 'Tokens.Transfer', 'Currencies.Transferred');

CREATE TABLE IF NOT EXISTS price_data.transfer_activity_by_time_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

CREATE TABLE IF NOT EXISTS price_data.swap_activity
(
    block_height UInt32,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    block_timestamp DateTime,
    event_name LowCardinality(String),
    who String,
    asset_in UInt32,
    asset_out UInt32,
    amount_in String,
    amount_out String,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index);

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.swap_activity_mv
TO price_data.swap_activity AS
SELECT
    block_height, event_index, extrinsic_index, block_timestamp, event_name,
    JSONExtractString(args_json, 'who') AS who,
    toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn'))) AS asset_in,
    toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut'))) AS asset_out,
    JSONExtractString(args_json, 'amountIn') AS amount_in,
    JSONExtractString(args_json, 'amountOut') AS amount_out,
    ingested_at
FROM price_data.raw_events
WHERE event_name IN ('Router.Executed','Omnipool.SellExecuted','Omnipool.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted');

CREATE TABLE IF NOT EXISTS price_data.swap_activity_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

CREATE TABLE IF NOT EXISTS price_data.otc_activity
(
    block_height UInt32,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    block_timestamp DateTime,
    event_name LowCardinality(String),
    args_json String,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.otc_activity_mv
TO price_data.otc_activity AS
SELECT block_height, event_index, extrinsic_index, block_timestamp,
       event_name, args_json, ingested_at
FROM price_data.raw_events
WHERE event_name IN ('OTC.Placed','OTC.Cancelled','OTC.Filled','OTC.PartiallyFilled');

CREATE TABLE IF NOT EXISTS price_data.otc_activity_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

CREATE TABLE IF NOT EXISTS price_data.liquidity_activity
(
    block_height UInt32,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    block_timestamp DateTime,
    event_name LowCardinality(String),
    who String,
    asset_id UInt32,
    amount String,
    amount_a String,
    asset_b UInt32,
    pool_account String,
    asset_refs Array(UInt32),
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 4096;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.liquidity_activity_mv
TO price_data.liquidity_activity AS
SELECT
    block_height, event_index, extrinsic_index, block_timestamp, event_name,
    JSONExtractString(args_json,'who') AS who,
    toUInt32(greatest(0, multiIf(
      JSONHas(args_json,'rewardCurrency'), JSONExtractInt(args_json,'rewardCurrency'),
      JSONHas(args_json,'assetId'), JSONExtractInt(args_json,'assetId'),
      JSONHas(args_json,'poolId'), JSONExtractInt(args_json,'poolId'),
      JSONHas(args_json,'assetA'), JSONExtractInt(args_json,'assetA'),
      JSONExtractInt(args_json,'asset_id')))) AS asset_id,
    multiIf(
      JSONHas(args_json,'claimed'), JSONExtractString(args_json,'claimed'),
      JSONHas(args_json,'amount'), JSONExtractString(args_json,'amount'),
      JSONExtractString(args_json,'shares')) AS amount,
    JSONExtractString(args_json,'amountA') AS amount_a,
    toUInt32(greatest(0, JSONExtractInt(args_json,'assetB'))) AS asset_b,
    JSONExtractString(args_json,'pool') AS pool_account,
    arrayDistinct(arrayConcat(
      if(JSONHas(args_json,'rewardCurrency'), [toUInt32(greatest(0, JSONExtractInt(args_json,'rewardCurrency')))], emptyArrayUInt32()),
      if(JSONHas(args_json,'assetId'), [toUInt32(greatest(0, JSONExtractInt(args_json,'assetId')))], emptyArrayUInt32()),
      if(JSONHas(args_json,'asset_id'), [toUInt32(greatest(0, JSONExtractInt(args_json,'asset_id')))], emptyArrayUInt32()),
      if(JSONHas(args_json,'poolId'), [toUInt32(greatest(0, JSONExtractInt(args_json,'poolId')))], emptyArrayUInt32()),
      if(JSONHas(args_json,'assetA'), [toUInt32(greatest(0, JSONExtractInt(args_json,'assetA')))], emptyArrayUInt32()),
      if(JSONHas(args_json,'assetB'), [toUInt32(greatest(0, JSONExtractInt(args_json,'assetB')))], emptyArrayUInt32()),
      arrayMap(item -> toUInt32(greatest(0, JSONExtractInt(item,'assetId'))), JSONExtractArrayRaw(args_json,'assets'))
    )) AS asset_refs,
    ingested_at
FROM price_data.raw_events
WHERE event_name IN ('Omnipool.LiquidityAdded','Omnipool.LiquidityRemoved','Stableswap.LiquidityAdded','Stableswap.LiquidityRemoved','XYK.LiquidityAdded','XYK.LiquidityRemoved','XYK.PoolCreated','OmnipoolLiquidityMining.RewardClaimed','XYKLiquidityMining.RewardClaimed');

CREATE TABLE IF NOT EXISTS price_data.liquidity_activity_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;
