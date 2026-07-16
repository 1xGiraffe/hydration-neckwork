-- Contract-first twin of atoken_scaled_deltas for asset holder/supply reads.
-- The holder-first table remains authoritative for account detail; both use the
-- same stable event+leg key and therefore converge under raw-range replay.

CREATE TABLE IF NOT EXISTS price_data.atoken_scaled_deltas_by_contract
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
ORDER BY (contract_address, holder, block_height, event_index, leg_index)
SETTINGS index_granularity = 4096;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.atoken_scaled_deltas_by_contract_mv
TO price_data.atoken_scaled_deltas_by_contract AS
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

CREATE TABLE IF NOT EXISTS price_data.atoken_scaled_deltas_by_contract_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY partition;
