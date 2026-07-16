-- Replay-safe signed integer deltas for money-market scaled balances and the
-- HOLLAR ERC-20 wrapper. The API backfills one source month at a time and only
-- enables these read paths after every active source partition is marked.

CREATE TABLE IF NOT EXISTS price_data.atoken_scaled_deltas
(
    contract_address String,
    holder String,
    block_height UInt32,
    event_index UInt32,
    block_timestamp DateTime,
    event_name LowCardinality(String),
    leg_index UInt8,
    scaled_delta Int256,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (holder, contract_address, block_height, event_index, leg_index)
SETTINGS index_granularity = 4096;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.atoken_scaled_deltas_mv
TO price_data.atoken_scaled_deltas AS
WITH
    decoded_args_json AS ar,
    [
      if(event_name='Mint', JSONExtractString(ar,'onBehalfOf'), if(event_name='Burn', JSONExtractString(ar,'from'), JSONExtractString(ar,'to'))),
      if(event_name='BalanceTransfer', JSONExtractString(ar,'from'), '')
    ] AS holders,
    [
      multiIf(
        event_name='Mint', intDiv(
          (toInt256(toUInt256OrZero(JSONExtractString(ar,'value'))) - toInt256(toUInt256OrZero(JSONExtractString(ar,'balanceIncrease')))) * toInt256(toUInt256('1000000000000000000000000000')),
          greatest(toInt256(toUInt256OrZero(JSONExtractString(ar,'index'))), toInt256(1))),
        event_name='Burn', -intDiv(
          (toInt256(toUInt256OrZero(JSONExtractString(ar,'value'))) + toInt256(toUInt256OrZero(JSONExtractString(ar,'balanceIncrease')))) * toInt256(toUInt256('1000000000000000000000000000')),
          greatest(toInt256(toUInt256OrZero(JSONExtractString(ar,'index'))), toInt256(1))),
        toInt256(toUInt256OrZero(JSONExtractString(ar,'value')))),
      if(event_name='BalanceTransfer', -toInt256(toUInt256OrZero(JSONExtractString(ar,'value'))), toInt256(0))
    ] AS deltas,
    arrayJoin(arrayZip(holders, deltas, arrayEnumerate(holders))) AS leg
SELECT
    lower(contract_address) AS contract_address,
    lower(tupleElement(leg, 1)) AS holder,
    block_height,
    event_index,
    block_timestamp,
    ifNull(event_name, '') AS event_name,
    toUInt8(tupleElement(leg, 3)) AS leg_index,
    tupleElement(leg, 2) AS scaled_delta,
    ingested_at
FROM price_data.raw_evm_logs
WHERE event_name IN ('Mint','Burn','BalanceTransfer')
  AND tupleElement(leg, 1) != '';

CREATE TABLE IF NOT EXISTS price_data.atoken_scaled_deltas_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;

CREATE TABLE IF NOT EXISTS price_data.erc20_transfer_deltas
(
    contract_address String,
    holder String,
    block_height UInt32,
    event_index UInt32,
    block_timestamp DateTime,
    leg_index UInt8,
    balance_delta Int256,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (holder, contract_address, block_height, event_index, leg_index)
SETTINGS index_granularity = 4096;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.erc20_transfer_deltas_mv
TO price_data.erc20_transfer_deltas AS
WITH
    decoded_args_json AS ar,
    [lower(JSONExtractString(ar,'to')), lower(JSONExtractString(ar,'from'))] AS holders,
    [toInt256OrZero(JSONExtractString(ar,'value')), -toInt256OrZero(JSONExtractString(ar,'value'))] AS deltas,
    arrayJoin(arrayZip(holders, deltas, arrayEnumerate(holders))) AS leg
SELECT
    lower(contract_address) AS contract_address,
    tupleElement(leg,1) AS holder,
    block_height,
    event_index,
    block_timestamp,
    toUInt8(tupleElement(leg,3)) AS leg_index,
    tupleElement(leg,2) AS balance_delta,
    ingested_at
FROM price_data.raw_evm_logs
WHERE contract_address='0x531a654d1696ed52e7275a8cede955e82620f99a'
  AND event_name='Transfer'
  AND tupleElement(leg,1) != '';

CREATE TABLE IF NOT EXISTS price_data.erc20_transfer_deltas_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
