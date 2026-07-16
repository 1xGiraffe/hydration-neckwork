CREATE TABLE IF NOT EXISTS price_data.dca_schedules
(
    id UInt64,
    block_height UInt32,
    block_timestamp DateTime,
    extrinsic_index Nullable(UInt32),
    who String,
    asset_in UInt32,
    asset_out UInt32,
    direction LowCardinality(String),
    amount_per String,
    total_amount String,
    period UInt32,
    max_retries UInt32
)
ENGINE = ReplacingMergeTree(block_height)
ORDER BY id
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.dca_schedules_mv
TO price_data.dca_schedules
AS
SELECT
    toUInt64(JSONExtractInt(args_json, 'id')) AS id,
    block_height,
    block_timestamp,
    extrinsic_index,
    JSONExtractString(args_json, 'who') AS who,
    toUInt32(JSONExtractInt(args_json, 'order', 'assetIn')) AS asset_in,
    toUInt32(JSONExtractInt(args_json, 'order', 'assetOut')) AS asset_out,
    JSONExtractString(args_json, 'order', '__kind') AS direction,
    if(JSONHas(args_json, 'order', 'amountIn'), JSONExtractString(args_json, 'order', 'amountIn'), JSONExtractString(args_json, 'order', 'amountOut')) AS amount_per,
    JSONExtractString(args_json, 'totalAmount') AS total_amount,
    toUInt32(JSONExtractInt(args_json, 'period')) AS period,
    toUInt32(JSONExtractInt(args_json, 'maxRetries')) AS max_retries
FROM price_data.raw_events
WHERE event_name = 'DCA.Scheduled'
  AND JSONExtractInt(args_json, 'id') > 0;

CREATE TABLE IF NOT EXISTS price_data.dca_events
(
    id UInt64,
    event_name LowCardinality(String),
    block_height UInt32,
    block_timestamp DateTime,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    who String,
    amount_in String,
    amount_out String,
    planned_block UInt32
)
ENGINE = ReplacingMergeTree(block_height)
ORDER BY (event_name, block_height, event_index, id)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.dca_events_mv
TO price_data.dca_events
AS
SELECT
    toUInt64(JSONExtractInt(args_json, 'id')) AS id,
    event_name,
    block_height,
    block_timestamp,
    event_index,
    extrinsic_index,
    JSONExtractString(args_json, 'who') AS who,
    JSONExtractString(args_json, 'amountIn') AS amount_in,
    JSONExtractString(args_json, 'amountOut') AS amount_out,
    toUInt32(JSONExtractInt(args_json, 'block')) AS planned_block
FROM price_data.raw_events
WHERE event_name IN ('DCA.TradeExecuted', 'DCA.Completed', 'DCA.Terminated', 'DCA.ExecutionPlanned')
  AND JSONExtractInt(args_json, 'id') > 0;

-- Kept separate from dca_events_mv so existing deployments can add failed
-- attempts online without dropping the original materialized view.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.dca_failed_events_mv
TO price_data.dca_events
AS
SELECT
    toUInt64(JSONExtractInt(args_json, 'id')) AS id,
    event_name,
    block_height,
    block_timestamp,
    event_index,
    extrinsic_index,
    JSONExtractString(args_json, 'who') AS who,
    '' AS amount_in,
    '' AS amount_out,
    toUInt32(0) AS planned_block
FROM price_data.raw_events
WHERE event_name = 'DCA.TradeFailed'
  AND JSONExtractInt(args_json, 'id') > 0;
