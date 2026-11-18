-- HOLLAR's variable-debt tokens (one per market listing HOLLAR: core, GIGAHDX, BIL) are
-- GHO debt tokens: a borrower enrolled with the token's discount strategy (Juicer's
-- JuicerDiscount, installed on the core token at block 16,683,446) pays only part of
-- the interest its debt accrues. The token realizes that discount by BURNING scaled
-- debt at the borrower's next action, which no Mint/Burn amount states — the scaled
-- deltas (atoken_scaled_deltas) count the action's principal alone, so a discounted
-- borrower's indexed scaled debt drifts above the chain's by every burn. This table
-- keeps what folding the discount back needs (services/hollarDiscount.ts): every
-- Mint and Burn of those tokens with its exact value, balanceIncrease (the interest
-- the action settled, NET of the discount) and index, and every
-- DiscountPercentUpdated (the per-borrower rate the token caches between actions).
--
-- Narrow and replay-safe: keyed on the log's own (contract, holder, block, event)
-- under ReplacingMergeTree(ingested_at), holder-first so a borrower's history is one
-- range. Topics are 1-indexed (topics[1] is topic0):
--   Mint(address indexed caller, address indexed onBehalfOf, uint256 value, uint256 balanceIncrease, uint256 index)
--   Burn(address indexed from, address indexed target, uint256 value, uint256 balanceIncrease, uint256 index)
--   DiscountPercentUpdated(address indexed user, uint256 oldDiscountPercent, uint256 indexed newDiscountPercent)
-- The contract set is HOLLAR_DEBT_TOKENS in hollarDiscount.ts (pinned equal by
-- api/tests/hollarDiscount.test.ts); an upgrading database gets the history from raw
-- through the DATA_UPGRADES entry (api/src/db/schemaBootstrap.ts) whose SELECT/WHERE
-- is this MV's verbatim.
CREATE TABLE IF NOT EXISTS price_data.hollar_debt_logs (`contract_address` LowCardinality(String), `holder` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `kind` LowCardinality(String), `value` UInt256, `balance_increase` UInt256, `idx` UInt256, `pct_old` UInt256, `pct_new` UInt256, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (contract_address, holder, block_height, event_index) SETTINGS index_granularity = 1024;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.hollar_debt_logs_mv TO price_data.hollar_debt_logs (`contract_address` String, `holder` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `kind` String, `value` UInt256, `balance_increase` UInt256, `idx` UInt256, `pct_old` UInt256, `pct_new` UInt256, `ingested_at` DateTime) AS SELECT lower(raw_evm_logs.contract_address) AS contract_address, lower(concat('0x', substring(if(ifNull(raw_evm_logs.topic0, '') = '0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196', topics[3], topics[2]), 27, 40))) AS holder, block_height, event_index, block_timestamp, multiIf(ifNull(raw_evm_logs.topic0, '') = '0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196', 'Mint', ifNull(raw_evm_logs.topic0, '') = '0x4cf25bc1d991c17529c25213d3cc0cda295eeaad5f13f361969b12ea48015f90', 'Burn', 'DiscountPercentUpdated') AS kind, if(ifNull(raw_evm_logs.topic0, '') = '0x74ab9665e7c36c29ddb78ef88a3e2eac73d35b8b16de7bc573e313e320104956', toUInt256(0), reinterpretAsUInt256(reverse(unhex(substring(data, 3, 64))))) AS value, if(ifNull(raw_evm_logs.topic0, '') = '0x74ab9665e7c36c29ddb78ef88a3e2eac73d35b8b16de7bc573e313e320104956', toUInt256(0), reinterpretAsUInt256(reverse(unhex(substring(data, 67, 64))))) AS balance_increase, if(ifNull(raw_evm_logs.topic0, '') = '0x74ab9665e7c36c29ddb78ef88a3e2eac73d35b8b16de7bc573e313e320104956', toUInt256(0), reinterpretAsUInt256(reverse(unhex(substring(data, 131, 64))))) AS idx, if(ifNull(raw_evm_logs.topic0, '') = '0x74ab9665e7c36c29ddb78ef88a3e2eac73d35b8b16de7bc573e313e320104956', reinterpretAsUInt256(reverse(unhex(substring(data, 3, 64)))), toUInt256(0)) AS pct_old, if(ifNull(raw_evm_logs.topic0, '') = '0x74ab9665e7c36c29ddb78ef88a3e2eac73d35b8b16de7bc573e313e320104956', reinterpretAsUInt256(reverse(unhex(substring(topics[3], 3, 64)))), toUInt256(0)) AS pct_new, ingested_at FROM price_data.raw_evm_logs WHERE raw_evm_logs.topic0 IN ('0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196', '0x4cf25bc1d991c17529c25213d3cc0cda295eeaad5f13f361969b12ea48015f90', '0x74ab9665e7c36c29ddb78ef88a3e2eac73d35b8b16de7bc573e313e320104956') AND lower(raw_evm_logs.contract_address) IN ('0x342923782ccaebf9c38dd9cb40436e82c42c73b5', '0x6f731562cbf2c0da50a10e5ac922b95b42204863', '0xfa8793b777f86df01a71f898d9c65a339aee54bf') AND length(topics) >= 3;

-- The derivations' watermarks: an hour holding a discount-rate change re-marks the
-- hollar_borrow revenue hours from it forward (kind 'debt' cascades forward, the
-- folded discount being cumulative state), and the User Revenue money-market hours
-- the same way. Every Mint/Burn of these tokens is already an atoken_scaled_deltas row
-- whose own watermarks mark its hour; only the rate changes are new information, and
-- marking just those keeps a replay of the token's whole history from re-marking the
-- hours before any discount existed.
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.revenue_hour_watermarks_hollar_discount_mv TO price_data.revenue_hour_watermarks (`hour` DateTime, `kind` String, `src_ingest` DateTime, `src_minb` UInt32, `src_maxb` UInt32, `assets` Array(UInt32), `v3` UInt8) AS SELECT toStartOfHour(block_timestamp) AS hour, 'debt' AS kind, max(ingested_at) AS src_ingest, min(block_height) AS src_minb, max(block_height) AS src_maxb, [toUInt32(222)] AS assets, toUInt8(0) AS v3 FROM price_data.hollar_debt_logs WHERE kind = 'DiscountPercentUpdated' GROUP BY hour;
