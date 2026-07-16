-- Current omnipool LP position state + NFT ownership, maintained from indexed
-- substrate events so the API can list an account's LP/farm positions WITHOUT
-- per-request substrate storage reads.
--
-- These aggregates keep request paths off the raw event table. argMax (keyed by
-- block_height·2^32+event_index) is idempotent to the
-- duplicate inserts a ReplacingMergeTree source can produce, so — unlike a sum MV —
-- it is dedup-safe. They rebuild automatically on a full reindex (the MV fires for
-- every re-inserted event); the offline schema migrator seeds existing data.

-- Latest omnipool position state (assetId, shares, amount, price) per position id.
-- price is the event's FixedU128 (= priceNum/priceDen · 1e18); the API pairs it with
-- priceDen = 1e18 to reproduce the on-chain (num,den) rational for the withdraw math.
CREATE TABLE IF NOT EXISTS price_data.omnipool_position_latest
(
    position_id String,
    asset_id AggregateFunction(argMax, Int32, UInt64),
    shares AggregateFunction(argMax, String, UInt64),
    amount AggregateFunction(argMax, String, UInt64),
    price AggregateFunction(argMax, String, UInt64)
)
ENGINE = AggregatingMergeTree ORDER BY position_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.omnipool_position_latest_mv TO price_data.omnipool_position_latest AS
SELECT JSONExtractString(args_json,'positionId') AS position_id,
    argMaxState(toInt32(JSONExtractInt(args_json,'asset')), toUInt64(block_height)*4294967296 + event_index) AS asset_id,
    argMaxState(JSONExtractString(args_json,'shares'), toUInt64(block_height)*4294967296 + event_index) AS shares,
    argMaxState(JSONExtractString(args_json,'amount'), toUInt64(block_height)*4294967296 + event_index) AS amount,
    argMaxState(JSONExtractString(args_json,'price'), toUInt64(block_height)*4294967296 + event_index) AS price
FROM price_data.raw_events
WHERE event_name IN ('Omnipool.PositionCreated','Omnipool.PositionUpdated')
GROUP BY position_id;

-- Current NFT owner per (collection, item). owner = '' means burned/no owner.
CREATE TABLE IF NOT EXISTS price_data.nft_owner_latest
(
    collection String,
    item String,
    owner AggregateFunction(argMax, String, UInt64)
)
ENGINE = AggregatingMergeTree ORDER BY (collection, item);

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.nft_owner_latest_mv TO price_data.nft_owner_latest AS
SELECT JSONExtractString(args_json,'collection') AS collection,
    JSONExtractString(args_json,'item') AS item,
    argMaxState(multiIf(event_name='Uniques.Burned', '', event_name='Uniques.Transferred', lower(JSONExtractString(args_json,'to')), lower(JSONExtractString(args_json,'owner'))), toUInt64(block_height)*4294967296 + event_index) AS owner
FROM price_data.raw_events
WHERE event_name IN ('Uniques.Issued','Uniques.Transferred','Uniques.Burned')
GROUP BY collection, item;

-- Liquidity-mining deposit id → underlying omnipool position id.
CREATE TABLE IF NOT EXISTS price_data.farm_deposit_latest
(
    deposit_id String,
    position_id AggregateFunction(argMax, String, UInt64)
)
ENGINE = AggregatingMergeTree ORDER BY deposit_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.farm_deposit_latest_mv TO price_data.farm_deposit_latest AS
SELECT JSONExtractString(args_json,'depositId') AS deposit_id,
    argMaxState(JSONExtractString(args_json,'positionId'), toUInt64(block_height)*4294967296 + event_index) AS position_id
FROM price_data.raw_events
WHERE event_name IN ('OmnipoolLiquidityMining.SharesDeposited','OmnipoolLiquidityMining.SharesRedeposited')
  AND JSONExtractString(args_json,'positionId') != ''
GROUP BY deposit_id;
