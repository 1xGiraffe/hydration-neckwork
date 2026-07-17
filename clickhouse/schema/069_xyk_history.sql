-- XYK historical principal read models for the account value-history chart (LP value-
-- history, Phase 2). Same conventions as 068: replay-safe ReplacingMergeTree with stable
-- keys, no time partitioning (so pool/asset/account-first ORDER BY prunes), sampled pool
-- state (~hourly), and coverage-gated readiness. Total LP-share supply is reconstructed from
-- raw_balance_observations (approach A: no RPC), verified against pinned RPC parity before
-- the XYK path is enabled. Direct XYK LP tokens currently value to null on the chart, so the
-- NAV contribution is additive (no proxy price to double-count).

-- 1) Pool registry: lp_asset_id (shareToken) <-> pool_account <-> asset pair, from
--    XYK.PoolCreated. The mapping is effectively immutable per pool, so latest-wins is safe.
CREATE TABLE IF NOT EXISTS price_data.xyk_pool_registry
(
    lp_asset_id Int32,
    pool_account String,
    asset_a Int32,
    asset_b Int32,
    created_block UInt32,
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY tuple()
ORDER BY lp_asset_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.xyk_pool_registry_mv
TO price_data.xyk_pool_registry AS
SELECT
    toInt32(JSONExtractInt(args_json, 'shareToken')) AS lp_asset_id,
    JSONExtractString(args_json, 'pool') AS pool_account,
    toInt32(JSONExtractInt(args_json, 'assetA')) AS asset_a,
    toInt32(JSONExtractInt(args_json, 'assetB')) AS asset_b,
    block_height AS created_block,
    ingested_at
FROM price_data.raw_events
WHERE event_name = 'XYK.PoolCreated';

CREATE TABLE IF NOT EXISTS price_data.xyk_pool_registry_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

-- 2) Sampled XYK pool reserves projected from the snapshot xyk.pools array (one snapshot per
--    ~600 blocks; the chart prices at daily granularity so sub-hourly reserves are moot).
CREATE TABLE IF NOT EXISTS price_data.xyk_pool_reserve_history
(
    pool_account String,
    block_height UInt32,
    block_timestamp DateTime,
    asset_a Int32,
    asset_b Int32,
    reserve_a_raw String,
    reserve_b_raw String,
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY tuple()
ORDER BY (pool_account, block_height);

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.xyk_pool_reserve_history_mv
TO price_data.xyk_pool_reserve_history AS
SELECT
    JSONExtractString(p, 'pool_account') AS pool_account,
    block_height,
    block_timestamp,
    toInt32(JSONExtractInt(p, 'asset_a')) AS asset_a,
    toInt32(JSONExtractInt(p, 'asset_b')) AS asset_b,
    JSONExtractString(p, 'reserve_a') AS reserve_a_raw,
    JSONExtractString(p, 'reserve_b') AS reserve_b_raw,
    ingested_at
FROM price_data.raw_block_snapshots
ARRAY JOIN JSONExtractArrayRaw(JSONExtractRaw(payload_json, 'xyk'), 'pools') AS p
WHERE block_height % 600 = 0;

CREATE TABLE IF NOT EXISTS price_data.xyk_pool_reserve_history_backfill
(partition String, completed_at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree(completed_at) ORDER BY partition;

-- 3) Reconstructed total LP-share supply per (lp_asset_id, block): a step function of the
--    cumulative net shareToken balance changes across all holders (LiquidityAdded omits the
--    minted share amount, so events alone cannot do this — balances can). Written by the
--    reconstruction job; the loader forward-fills to each sampled block. Gated behind an
--    RPC-sampled parity check vs Tokens.TotalIssuance before enabling the XYK path.
CREATE TABLE IF NOT EXISTS price_data.xyk_lp_total_shares_history
(
    lp_asset_id Int32,
    block_height UInt32,
    total_shares_raw String,
    run_id UInt64,
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(run_id)
PARTITION BY tuple()
ORDER BY (lp_asset_id, block_height);

-- 4) XYK farm-deposit (collection 5389) ownership intervals with principal, written by the
--    checkpointed builder (buildXykFarmIntervals). principal = SharesDeposited.amount of
--    lpToken; redeposit restates the same amount; the 5389 NFT lifecycle + DepositDestroyed
--    bound ownership (SharesWithdrawn is not a principal boundary).
CREATE TABLE IF NOT EXISTS price_data.xyk_farm_principal_intervals
(
    account_id String,
    deposit_id String,
    lp_asset_id Int32,
    principal_shares_raw String,
    valid_from_block UInt32,
    valid_from_extrinsic Int64,
    valid_from_event UInt32,
    valid_from_ts DateTime,
    valid_to_block UInt32,
    valid_to_extrinsic Int64,
    valid_to_event UInt32,
    source_event_kind LowCardinality(String),
    run_id UInt64,
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(run_id)
PARTITION BY tuple()
ORDER BY (account_id, deposit_id, valid_from_block, valid_from_event);
