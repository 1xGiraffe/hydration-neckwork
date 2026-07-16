-- Compact XCM context, replay-safe activity histograms, and sparse reward
-- ownership indexes. The API performs bounded historical backfills and only
-- enables reads after the marker tables cover every source partition.

CREATE TABLE IF NOT EXISTS price_data.xcm_event_activity
(
    block_height UInt32,
    event_index UInt32,
    extrinsic_index Nullable(UInt32),
    block_timestamp DateTime,
    event_name LowCardinality(String),
    asset_id UInt32,
    who String,
    amount String,
    args_json String,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (event_name, asset_id, block_height, event_index)
SETTINGS index_granularity = 4096;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.xcm_event_activity_mv
TO price_data.xcm_event_activity AS
SELECT
    block_height, event_index, extrinsic_index, block_timestamp, event_name,
    toUInt32(if(event_name IN ('Balances.Deposit','Balances.Issued','Balances.Endowed','Balances.Minted'), 0, multiIf(
      JSONHas(args_json,'currencyId'), greatest(0, JSONExtractInt(args_json,'currencyId')),
      JSONHas(args_json,'currency_id'), greatest(0, JSONExtractInt(args_json,'currency_id')),
      JSONHas(args_json,'assetId'), greatest(0, JSONExtractInt(args_json,'assetId')),
      JSONHas(args_json,'asset_id'), greatest(0, JSONExtractInt(args_json,'asset_id')), 0))) AS asset_id,
    JSONExtractString(args_json,'who') AS who,
    JSONExtractString(args_json,'amount') AS amount,
    args_json,
    ingested_at
FROM price_data.raw_events
WHERE event_name IN ('Currencies.Withdrawn','Currencies.Deposited','Tokens.Deposited','Balances.Deposit','Balances.Issued','Balances.Endowed','Tokens.Endowed','Balances.Minted','System.NewAccount','MessageQueue.Processed','XTokens.TransferredAssets','PolkadotXcm.Sent');

CREATE TABLE IF NOT EXISTS price_data.xcm_event_activity_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

CREATE TABLE IF NOT EXISTS price_data.activity_histogram_events
(
    day Date,
    block_height UInt32,
    event_index UInt32,
    activity_index UInt32,
    event_name LowCardinality(String),
    asset_refs Array(UInt32),
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(day)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.activity_histogram_events_mv
TO price_data.activity_histogram_events AS
SELECT
    toDate(block_timestamp) AS day,
    block_height,
    event_index,
    toUInt32(if(
      event_name IN ('Router.Executed','Omnipool.SellExecuted','Omnipool.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted'),
      ifNull(extrinsic_index, event_index), event_index)) AS activity_index,
    event_name,
    multiIf(
      event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred'),
        [toUInt32(if(event_name='Balances.Transfer', 0, multiIf(
          JSONHas(args_json,'currencyId'), greatest(0, JSONExtractInt(args_json,'currencyId')),
          JSONHas(args_json,'currency_id'), greatest(0, JSONExtractInt(args_json,'currency_id')),
          JSONHas(args_json,'assetId'), greatest(0, JSONExtractInt(args_json,'assetId')),
          JSONHas(args_json,'asset_id'), greatest(0, JSONExtractInt(args_json,'asset_id')), 0)))],
      event_name IN ('Router.Executed','Omnipool.SellExecuted','Omnipool.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted'),
        arrayDistinct([toUInt32(greatest(0, JSONExtractInt(args_json,'assetIn'))), toUInt32(greatest(0, JSONExtractInt(args_json,'assetOut')))]),
      event_name IN ('Omnipool.LiquidityAdded','Omnipool.LiquidityRemoved','Stableswap.LiquidityAdded','Stableswap.LiquidityRemoved','XYK.LiquidityAdded','XYK.LiquidityRemoved','XYK.PoolCreated','OmnipoolLiquidityMining.RewardClaimed','XYKLiquidityMining.RewardClaimed'),
        arrayDistinct(arrayConcat(
          if(JSONHas(args_json,'rewardCurrency'), [toUInt32(greatest(0, JSONExtractInt(args_json,'rewardCurrency')))], emptyArrayUInt32()),
          if(JSONHas(args_json,'assetId'), [toUInt32(greatest(0, JSONExtractInt(args_json,'assetId')))], emptyArrayUInt32()),
          if(JSONHas(args_json,'asset_id'), [toUInt32(greatest(0, JSONExtractInt(args_json,'asset_id')))], emptyArrayUInt32()),
          if(JSONHas(args_json,'poolId'), [toUInt32(greatest(0, JSONExtractInt(args_json,'poolId')))], emptyArrayUInt32()),
          if(JSONHas(args_json,'assetA'), [toUInt32(greatest(0, JSONExtractInt(args_json,'assetA')))], emptyArrayUInt32()),
          if(JSONHas(args_json,'assetB'), [toUInt32(greatest(0, JSONExtractInt(args_json,'assetB')))], emptyArrayUInt32()),
          arrayMap(item -> toUInt32(greatest(0, JSONExtractInt(item,'assetId'))), JSONExtractArrayRaw(args_json,'assets'))
        )),
      event_name IN ('ConvictionVoting.Voted','Democracy.Voted','Referrals.Claimed'), [toUInt32(0)],
      event_name IN ('CollatorRewards.CollatorRewarded','GigaHdx.Staked','GigaHdx.Unstaked','GigaHdx.UnstakeCancelled','GigaHdx.MigratedFromLegacy','GigaHdxRewards.RewardsClaimed','Staking.PositionCreated','Staking.StakeAdded','Staking.Unstaked','Staking.ForceUnstaked','Staking.RewardsClaimed'), [toUInt32(0),toUInt32(670)],
      event_name='OTC.Placed', arrayDistinct([toUInt32(greatest(0, JSONExtractInt(args_json,'assetIn'))), toUInt32(greatest(0, JSONExtractInt(args_json,'assetOut')))]),
      emptyArrayUInt32()) AS asset_refs,
    ingested_at
FROM price_data.raw_events
WHERE event_name IN ('Router.Executed','Omnipool.SellExecuted','Omnipool.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted','OTC.Placed','OTC.Cancelled','OTC.Filled','OTC.PartiallyFilled','Omnipool.LiquidityAdded','Omnipool.LiquidityRemoved','Stableswap.LiquidityAdded','Stableswap.LiquidityRemoved','XYK.LiquidityAdded','XYK.LiquidityRemoved','XYK.PoolCreated','OmnipoolLiquidityMining.RewardClaimed','XYKLiquidityMining.RewardClaimed','Balances.Transfer','Tokens.Transfer','Currencies.Transferred','ConvictionVoting.Voted','Democracy.Voted','CollatorRewards.CollatorRewarded','GigaHdx.Staked','GigaHdx.Unstaked','GigaHdx.UnstakeCancelled','GigaHdx.MigratedFromLegacy','GigaHdxRewards.RewardsClaimed','Staking.PositionCreated','Staking.StakeAdded','Staking.Unstaked','Staking.ForceUnstaked','Staking.RewardsClaimed','DCA.TradeExecuted','DCA.TradeFailed','Referrals.Claimed')
;

CREATE TABLE IF NOT EXISTS price_data.activity_histogram_events_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

CREATE TABLE IF NOT EXISTS price_data.referral_claim_activity
(
    block_height UInt32, event_index UInt32,
    extrinsic_index Nullable(UInt32), block_timestamp DateTime,
    event_name LowCardinality(String), call_address Nullable(String),
    args_json String, ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.referral_claim_activity_mv
TO price_data.referral_claim_activity AS
SELECT block_height, event_index, extrinsic_index, block_timestamp,
       event_name, call_address, args_json, ingested_at
FROM price_data.raw_events WHERE event_name='Referrals.Claimed';

CREATE TABLE IF NOT EXISTS price_data.incentive_reward_transfers
(
    block_height UInt32, event_index UInt32,
    extrinsic_index Nullable(UInt32), block_timestamp DateTime,
    event_name LowCardinality(String), call_address Nullable(String),
    args_json String, ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.incentive_reward_transfers_mv
TO price_data.incentive_reward_transfers AS
SELECT block_height, event_index, extrinsic_index, block_timestamp,
       event_name, call_address, args_json, ingested_at
FROM price_data.raw_events
WHERE event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')
  AND JSONExtractString(args_json,'from')='0x45544800112c208b900bcfc9ff8131d0f45769cb6c7c7d8d0000000000000000';

CREATE TABLE IF NOT EXISTS price_data.reward_claim_activity_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

CREATE TABLE IF NOT EXISTS price_data.incentive_claim_calls
(
    block_height UInt32,
    extrinsic_index Nullable(UInt32),
    call_address String,
    block_timestamp DateTime,
    ingested_at DateTime
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, ifNull(extrinsic_index, 4294967295), call_address)
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.incentive_claim_calls_mv
TO price_data.incentive_claim_calls AS
SELECT block_height, extrinsic_index, call_address, block_timestamp, ingested_at
FROM price_data.raw_calls
WHERE position(args_json, '7472a3d0891df2401d981a5954d07e364f05060f') > 0
  AND (position(args_json, 'bb492bf5') > 0
    OR position(args_json, '236300dc') > 0);

ALTER TABLE price_data.incentive_claim_calls_mv MODIFY QUERY
SELECT block_height, extrinsic_index, call_address, block_timestamp, ingested_at
FROM price_data.raw_calls
WHERE position(args_json, '7472a3d0891df2401d981a5954d07e364f05060f') > 0
  AND (position(args_json, 'bb492bf5') > 0
    OR position(args_json, '236300dc') > 0);

CREATE TABLE IF NOT EXISTS price_data.incentive_claim_calls_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;
