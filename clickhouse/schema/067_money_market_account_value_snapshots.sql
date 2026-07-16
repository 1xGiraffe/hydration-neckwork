-- Atomic current money-market principal claims for whole-account-directory
-- ranking. A bounded background rebuild combines replay-safe scaled aToken /
-- variable-debt balances with the latest reserve indices and aggregate risk
-- snapshot. The singleton state row advances only after a complete generation
-- has been inserted and verified.

CREATE TABLE IF NOT EXISTS price_data.money_market_account_value_snapshots
(
    snapshot_id String,
    account_id String,
    holder String,
    pool_address String,
    market_key LowCardinality(String),
    reserve_present UInt8,
    asset_id UInt32,
    supplied UInt256,
    debt UInt256,
    total_collateral_base UInt256,
    total_debt_base UInt256,
    available_borrows_base UInt256,
    liquidation_threshold UInt32,
    ltv UInt256,
    health_factor UInt256,
    block_height UInt32,
    block_timestamp DateTime,
    computed_at DateTime
)
ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY snapshot_id
ORDER BY (snapshot_id, account_id, pool_address, reserve_present, asset_id)
SETTINGS index_granularity = 1024;

CREATE TABLE IF NOT EXISTS price_data.money_market_account_value_snapshot_state
(
    snapshot_key LowCardinality(String),
    snapshot_id String,
    source_holding_count UInt32,
    source_position_count UInt32,
    claim_count UInt32,
    source_checksum String,
    computed_at DateTime
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY snapshot_key
SETTINGS index_granularity = 64;
