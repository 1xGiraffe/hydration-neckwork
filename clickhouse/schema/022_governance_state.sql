-- Chain-derived governance state, account-first, from the raw account-state
-- observations (raw_account_state_observations: ConvictionVoting.VotingFor and
-- Balances.Locks of every account a block's governance/lock events — or a vote
-- removal / unlock call, which emit none — name, read at that block; seeded for
-- every account by one pinned full read at block 15,622,703).
--
-- Per block and complete by construction: the views fill as raw is indexed, in any
-- order, so each table holds every observation, keyed (account_id, block_height).
-- The CURRENT state of an account is its newest row (argMax over the account's key
-- prefix); an AS-OF read is the newest row at or below a block, from the same table.
-- Replay-safe: a replayed raw range collapses onto the same (account, block) key
-- under ReplacingMergeTree(ingested_at). An upgrading database gets the history from
-- raw through the DATA_UPGRADES entries (api/src/db/schemaBootstrap.ts), which replay
-- the same predicate and select.

-- ConvictionVoting.VotingFor of every class, as decoded by the raw indexer: a JSON
-- object keyed by class (track id) whose values are `Casting{votes, delegations,
-- prior}` or `Delegating{balance, target, conviction, delegations, prior}`; '{}'
-- when the account holds no voting state. Read by api/src/services/convictionState.ts
-- (current votes, locks, unlock schedule, delegation attribution).
CREATE TABLE IF NOT EXISTS price_data.conviction_voting_state (`account_id` String, `block_height` UInt32, `block_timestamp` DateTime, `value_json` String CODEC(ZSTD(6)), `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (account_id, block_height) SETTINGS index_granularity = 256;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.conviction_voting_state_mv TO price_data.conviction_voting_state (`account_id` String, `block_height` UInt32, `block_timestamp` DateTime, `value_json` String, `ingested_at` DateTime) AS SELECT account_id, block_height, block_timestamp, value_json, ingested_at FROM price_data.raw_account_state_observations WHERE raw_account_state_observations.kind = 'conviction_voting';

-- The governance-relevant HDX locks per account and block, from Balances.Locks: the
-- conviction-voting lock ('pyconvot', the max of every class's lock — what an unlock
-- frees), and the two staking locks that make a LOSING vote lock too on Hydration
-- (legacy staking 'stk_stks' and GIGAHDX 'ghdxlock'; VotingHooks::
-- lock_balance_on_unsuccessful_vote). Exact planck as decimal strings; '0' when the
-- lock is absent. JSON functions return defaults on malformed input, so the view
-- never throws into the source insert.
CREATE TABLE IF NOT EXISTS price_data.account_vote_locks_state (`account_id` String, `block_height` UInt32, `block_timestamp` DateTime, `conviction_lock` String, `staking_lock` String, `gigahdx_lock` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (account_id, block_height) SETTINGS index_granularity = 256;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.account_vote_locks_state_mv TO price_data.account_vote_locks_state (`account_id` String, `block_height` UInt32, `block_timestamp` DateTime, `conviction_lock` String, `staking_lock` String, `gigahdx_lock` String, `ingested_at` DateTime) AS SELECT account_id, block_height, block_timestamp, if(JSONExtractString(arrayFirst(l -> (JSONExtractString(l, 'id') = '0x7079636f6e766f74'), JSONExtractArrayRaw(value_json)), 'amount') = '', '0', JSONExtractString(arrayFirst(l -> (JSONExtractString(l, 'id') = '0x7079636f6e766f74'), JSONExtractArrayRaw(value_json)), 'amount')) AS conviction_lock, if(JSONExtractString(arrayFirst(l -> (JSONExtractString(l, 'id') = '0x73746b5f73746b73'), JSONExtractArrayRaw(value_json)), 'amount') = '', '0', JSONExtractString(arrayFirst(l -> (JSONExtractString(l, 'id') = '0x73746b5f73746b73'), JSONExtractArrayRaw(value_json)), 'amount')) AS staking_lock, if(JSONExtractString(arrayFirst(l -> (JSONExtractString(l, 'id') = '0x676864786c6f636b'), JSONExtractArrayRaw(value_json)), 'amount') = '', '0', JSONExtractString(arrayFirst(l -> (JSONExtractString(l, 'id') = '0x676864786c6f636b'), JSONExtractArrayRaw(value_json)), 'amount')) AS gigahdx_lock, ingested_at FROM price_data.raw_account_state_observations WHERE raw_account_state_observations.kind = 'balances_locks';

-- Every Treasury event that names a proposal or a spend: legacy proposals (Proposed,
-- Awarded, Rejected), the native SpendApproved, and the asset spends of the
-- treasurer/spender tracks with their validity window and payout (AssetSpendApproved
-- {index, amount, beneficiary, validFrom, expireAt}, Paid, PaymentFailed,
-- SpendProcessed, AssetSpendVoided) — the governance calendar's spend dates and the
-- spend pages' status. A few dozen rows in all history, which raw_events could only
-- answer by an event-name index scan over every block. Narrow and replay-safe like
-- 020's lbp_activity: keyed on the raw row's own (block_height, event_index).
CREATE TABLE IF NOT EXISTS price_data.treasury_events (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `args_json` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (block_height, event_index) SETTINGS index_granularity = 1024;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.treasury_events_mv TO price_data.treasury_events (`block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `args_json` String, `ingested_at` DateTime) AS SELECT block_height, event_index, extrinsic_index, block_timestamp, event_name, args_json, ingested_at FROM price_data.raw_events WHERE raw_events.event_name IN ('Treasury.Proposed', 'Treasury.Awarded', 'Treasury.Rejected', 'Treasury.SpendApproved', 'Treasury.AssetSpendApproved', 'Treasury.Paid', 'Treasury.PaymentFailed', 'Treasury.SpendProcessed', 'Treasury.AssetSpendVoided');
