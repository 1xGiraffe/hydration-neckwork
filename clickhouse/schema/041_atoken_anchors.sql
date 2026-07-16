-- aToken / variable-debt holder balances, reconstructed WITHOUT per-request RPC.
--
-- aTokens (aDOT=1001, …) and variable-debt tokens are Aave scaled-balance ERC-20s
-- that never hit substrate Tokens.Accounts, so the indexed balance tables don't see
-- them. Their current balance = scaledBalance · liquidityIndex (aToken) or
-- · variableBorrowIndex (vDebt). scaledBalance is reconstructable from the token's
-- Mint/Burn/BalanceTransfer logs in raw_evm_logs. Coverage before the pinned
-- anchor block is incomplete, so a node-sourced balanceOf at B0 establishes the
-- initial state and indexed event deltas carry it forward:
--
--   balance(holder) = ( scaled_anchor(holder) + Σ scaled_delta(events, block > B0) )
--                     · liquidityIndex_now / RAY
--
-- The anchor is re-created by src/scripts/snapshot-atoken-anchors.ts (idempotent,
-- reproducible: balanceOf@B0 is deterministic archive state), which MUST run as part
-- of any complete wipe & reindex. Deltas are computed at query time (raw_evm_logs is a
-- ReplacingMergeTree, so a sum-MV would double-count re-ingested rows).

-- Reserve → aToken / variable-debt / pool map (authoritative, from on-chain reserveData;
-- replaces the per-request reservesList/reserveData RPC in the API).
CREATE TABLE IF NOT EXISTS price_data.atoken_reserve_map
(
    asset_address String,          -- reserve underlying ERC-20 precompile address
    atoken String,                 -- aToken contract
    vdebt String,                  -- variable-debt token contract
    pool_proxy String,
    market_key LowCardinality(String),
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (asset_address, atoken);

-- Per-(token contract, holder) scaled-balance anchor at block anchor_block (= B0).
-- holder = '' is the contract's total-supply anchor (totalSupply@B0, scaled).
CREATE TABLE IF NOT EXISTS price_data.atoken_scaled_anchor
(
    contract_address String,       -- aToken OR vDebt contract
    holder String,                 -- h160 (lowercase); '' = totalSupply anchor
    scaled_balance Int256,         -- balanceOf@B0 · RAY / index@B0
    anchor_block UInt32,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (contract_address, holder);
