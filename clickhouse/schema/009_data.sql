-- Read models for the Data API (api/src/data/, host hydration-data.neckwork.net;
-- concept: ~/.g/hydraken-api-concept.md § 5). Every projection here exists so a
-- /v1 endpoint answers from a table whose ORDER BY starts with the request's
-- selective dimension — hash-first for the custodian lookups, account-first for
-- the per-account feeds, asset-first for holders, contract-first for EVM logs.
--
-- All are replay-safe ReplacingMergeTree twins keyed on the source row's own
-- stable identity. Where the natural source is itself an MV-fed table, the new
-- MV CHAINS off that table (ClickHouse cascades an insert into an MV's target
-- through MVs reading from it), so the extraction logic lives in exactly one
-- place; replay safety carries over because the twin shares the source's
-- replacement identity. Where the source is raw, the MV is a sibling of the
-- existing extraction with the same expressions (the xcm_event_activity_by_account
-- precedent).
--
-- On an existing deployment each table gets its history through the usual
-- one-time ad-hoc INSERT…SELECT mirroring its MV's exact SELECT/WHERE (run at
-- rollout, not committed); a fresh database is complete from this file alone.

-- ---------------------------------------------------------------------------
-- Hash indexes: full-history point lookups by extrinsic/block hash.
-- ---------------------------------------------------------------------------

-- /v1/extrinsics/{hash} with NO time bound (the public API's hash route scans a
-- bounded window; a custodian doing deposit detection needs the whole chain).
-- Deliberately unpartitioned so a point read never touches per-month parts
-- (precedent: evm_transactions). block/extrinsic complete the key: a signed
-- extrinsic's hash is unique, but unsigned/inherent hashes are not guaranteed
-- to be, so the identity is the position and a hash read takes the newest.
CREATE TABLE IF NOT EXISTS price_data.extrinsic_hash_index (`extrinsic_hash` String, `block_height` UInt32, `extrinsic_index` UInt32, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (extrinsic_hash, block_height, extrinsic_index) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.extrinsic_hash_index_mv TO price_data.extrinsic_hash_index (`extrinsic_hash` String, `block_height` UInt32, `extrinsic_index` UInt32, `ingested_at` DateTime) AS SELECT lower(extrinsic_hash) AS extrinsic_hash, block_height, extrinsic_index, ingested_at FROM price_data.raw_extrinsics;

-- /v1/blocks/{hash}: hash → height, enriched from raw_blocks by height. A
-- reader must re-check the hash against raw_blocks' current row for that
-- height: after a replace this index may still hold a superseded hash, which
-- must answer 404 rather than serve another block's header.
CREATE TABLE IF NOT EXISTS price_data.block_hash_index (`block_hash` String, `block_height` UInt32, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY block_hash SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.block_hash_index_mv TO price_data.block_hash_index (`block_hash` String, `block_height` UInt32, `ingested_at` DateTime) AS SELECT lower(block_hash) AS block_hash, block_height, ingested_at FROM price_data.raw_blocks;

-- ---------------------------------------------------------------------------
-- Account-first projections.
-- ---------------------------------------------------------------------------

-- /v1/accounts/{address}/extrinsics and the OTC-by-account fold: one row per
-- distinct non-null signer identity of a signed extrinsic (signer and
-- effective_signer are DISJOINT identities for EVM-originated extrinsics, so
-- both are indexed and a replay collapses per (account, position)). Carries the
-- columns the feed renders so the read never returns to raw_extrinsics.
CREATE TABLE IF NOT EXISTS price_data.extrinsics_by_signer (`account` String, `block_height` UInt32, `extrinsic_index` UInt32, `block_timestamp` DateTime, `extrinsic_hash` String, `call_name` LowCardinality(String), `success` UInt8, `fee` Nullable(String), `tip` Nullable(String), `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (account, block_height, extrinsic_index) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.extrinsics_by_signer_mv TO price_data.extrinsics_by_signer (`account` String, `block_height` UInt32, `extrinsic_index` UInt32, `block_timestamp` DateTime, `extrinsic_hash` String, `call_name` LowCardinality(String), `success` UInt8, `fee` Nullable(String), `tip` Nullable(String), `ingested_at` DateTime) AS SELECT arrayJoin(arrayDistinct(arrayFilter(a -> (a != ''), [lower(ifNull(signer, '')), lower(ifNull(effective_signer, ''))]))) AS account, block_height, extrinsic_index, block_timestamp, lower(extrinsic_hash) AS extrinsic_hash, call_name, success, fee, tip, ingested_at FROM price_data.raw_extrinsics;

-- /v1/accounts/{address}/trades: pool_swap_legs re-keyed swapper-first, chained
-- off the leg table itself so the five per-era extraction MVs stay the single
-- source of leg semantics. The empty swapper (legacy rows with no actor) and
-- the two placeholder swappers Broadcast uses when it has no local origin
-- (0x2a2a…, the 'Parent' XCM marker — see swap_actor_mv) are skipped: they are
-- not accounts and would render as one, and every skipped row remains
-- reachable through the venue-first parent.
CREATE TABLE IF NOT EXISTS price_data.pool_swap_legs_by_account (`swapper` String, `venue` LowCardinality(String), `pool_key` String, `block_height` UInt32, `event_index` UInt32, `leg_index` UInt16, `leg_kind` Enum8('in' = 1, 'out' = 2, 'fee' = 3), `asset_id` UInt32, `amount` String, `fee_dest` LowCardinality(String), `fee_recipient` String, `op_key` String, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (swapper, block_height, event_index, leg_kind, leg_index) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.pool_swap_legs_by_account_mv TO price_data.pool_swap_legs_by_account (`swapper` String, `venue` LowCardinality(String), `pool_key` String, `block_height` UInt32, `event_index` UInt32, `leg_index` UInt16, `leg_kind` Enum8('in' = 1, 'out' = 2, 'fee' = 3), `asset_id` UInt32, `amount` String, `fee_dest` LowCardinality(String), `fee_recipient` String, `op_key` String, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `ingested_at` DateTime) AS SELECT swapper, venue, pool_key, block_height, event_index, leg_index, leg_kind, asset_id, amount, fee_dest, fee_recipient, op_key, extrinsic_index, block_timestamp, ingested_at FROM price_data.pool_swap_legs WHERE swapper NOT IN ('', '0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a', '0x506172656e740000000000000000000000000000000000000000000000000000');

-- /v1/accounts/{address}/dca: dca_events re-keyed who-first, chained. The
-- source versions on block_height (it carries no ingested_at), so the twin
-- does too — the replacement semantics must match or a replay behaves
-- differently on the two tables.
CREATE TABLE IF NOT EXISTS price_data.dca_events_by_account (`who` String, `block_height` UInt32, `event_index` UInt32, `id` UInt64, `event_name` LowCardinality(String), `block_timestamp` DateTime, `extrinsic_index` Nullable(UInt32), `amount_in` String, `amount_out` String, `planned_block` UInt32, `error` String) ENGINE = ReplacingMergeTree(block_height) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (who, block_height, event_index) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.dca_events_by_account_mv TO price_data.dca_events_by_account (`who` String, `block_height` UInt32, `event_index` UInt32, `id` UInt64, `event_name` LowCardinality(String), `block_timestamp` DateTime, `extrinsic_index` Nullable(UInt32), `amount_in` String, `amount_out` String, `planned_block` UInt32, `error` String) AS SELECT who, block_height, event_index, id, event_name, block_timestamp, extrinsic_index, amount_in, amount_out, planned_block, error FROM price_data.dca_events WHERE who != '';

-- /v1/accounts/{address}/staking: staking_activity re-keyed who-first, chained.
-- Rows whose event carries no `who` (the parent stores '') stay global-only.
CREATE TABLE IF NOT EXISTS price_data.staking_activity_by_account (`who` String, `block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `args_json` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (who, block_height, event_index) SETTINGS index_granularity = 1024;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.staking_activity_by_account_mv TO price_data.staking_activity_by_account (`who` String, `block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `args_json` String, `ingested_at` DateTime) AS SELECT who, block_height, event_index, extrinsic_index, block_timestamp, event_name, args_json, ingested_at FROM price_data.staking_activity WHERE who != '';

-- /v1/accounts/{address}/liquidity: liquidity_activity re-keyed who-first,
-- chained.
CREATE TABLE IF NOT EXISTS price_data.liquidity_activity_by_account (`who` String, `block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `asset_id` UInt32, `amount` String, `amount_a` String, `asset_b` UInt32, `pool_account` String, `asset_refs` Array(UInt32), `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (who, block_height, event_index) SETTINGS index_granularity = 4096;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.liquidity_activity_by_account_mv TO price_data.liquidity_activity_by_account (`who` String, `block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `asset_id` UInt32, `amount` String, `amount_a` String, `asset_b` UInt32, `pool_account` String, `asset_refs` Array(UInt32), `ingested_at` DateTime) AS SELECT who, block_height, event_index, extrinsic_index, block_timestamp, event_name, asset_id, amount, amount_a, asset_b, pool_account, asset_refs, ingested_at FROM price_data.liquidity_activity WHERE who != '';

-- /v1/governance/votes?voter= and /v1/accounts/{address}/votes:
-- governance_vote_calls re-keyed voter-first, chained. Prefixing the voter to
-- the source's full key keeps the identity unique per source row; PARTITION BY
-- tuple() matches the parent (a few thousand rows — monthly parts would be
-- near-empty; see the governance_vote_calls note in 001).
CREATE TABLE IF NOT EXISTS price_data.governance_vote_calls_by_voter (`voter` String, `pallet` LowCardinality(String), `ref_index` UInt32, `block_height` UInt32, `extrinsic_index` Nullable(UInt32), `call_address` String, `block_timestamp` DateTime, `call_name` LowCardinality(String), `vote_kind` LowCardinality(String), `vote_byte` UInt16, `balance` String, `aye` String, `nay` String, `abstain` String, `success` UInt8, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY tuple() ORDER BY (voter, pallet, ref_index, block_height, ifNull(extrinsic_index, 4294967295), call_address) SETTINGS index_granularity = 1024;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.governance_vote_calls_by_voter_mv TO price_data.governance_vote_calls_by_voter (`voter` String, `pallet` LowCardinality(String), `ref_index` UInt32, `block_height` UInt32, `extrinsic_index` Nullable(UInt32), `call_address` String, `block_timestamp` DateTime, `call_name` LowCardinality(String), `vote_kind` LowCardinality(String), `vote_byte` UInt16, `balance` String, `aye` String, `nay` String, `abstain` String, `success` UInt8, `ingested_at` DateTime) AS SELECT who AS voter, pallet, ref_index, block_height, extrinsic_index, call_address, block_timestamp, call_name, vote_kind, vote_byte, balance, aye, nay, abstain, success, ingested_at FROM price_data.governance_vote_calls WHERE who != '';

-- ---------------------------------------------------------------------------
-- Asset-first and contract-first projections.
-- ---------------------------------------------------------------------------

-- /v1/assets/{id}/holders: the argMax twin of account_asset_latest_balances
-- with the key reversed to asset-first, fed from raw_balance_observations with
-- the same expressions (sibling, not a chain — the parent is an
-- AggregatingMergeTree whose states cannot be re-projected).
CREATE TABLE IF NOT EXISTS price_data.asset_account_latest_balances (`asset_id` String, `account_id` String, `total_state` AggregateFunction(argMax, Nullable(String), UInt32), `free_state` AggregateFunction(argMax, Nullable(String), UInt32), `reserved_state` AggregateFunction(argMax, Nullable(String), UInt32), `last_block_state` AggregateFunction(max, UInt32)) ENGINE = AggregatingMergeTree ORDER BY (asset_id, account_id) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.asset_account_latest_balances_mv TO price_data.asset_account_latest_balances (`asset_id` String, `account_id` String, `total_state` AggregateFunction(argMax, Nullable(String), UInt32), `free_state` AggregateFunction(argMax, Nullable(String), UInt32), `reserved_state` AggregateFunction(argMax, Nullable(String), UInt32), `last_block_state` AggregateFunction(max, UInt32)) AS SELECT asset_id, account_id, argMaxState(total, block_height) AS total_state, argMaxState(free, block_height) AS free_state, argMaxState(reserved, block_height) AS reserved_state, maxState(block_height) AS last_block_state FROM price_data.raw_balance_observations WHERE (account_id != '') AND (asset_id != '') GROUP BY asset_id, account_id;

-- /v1/evm/contracts/{address}/logs: a NARROW contract-first index over
-- raw_evm_logs — the page's rows are then enriched by (block_height,
-- event_index) primary-key lookups on raw_evm_logs itself (page-scoped
-- enrichment), so the heavy topics/data/decoded columns are never duplicated.
-- topic0 is carried (as '' for a topicless log) so the one common filter
-- prunes without touching the parent.
CREATE TABLE IF NOT EXISTS price_data.evm_logs_by_contract (`contract_address` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `topic0` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (contract_address, block_height, event_index) SETTINGS index_granularity = 4096;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.evm_logs_by_contract_mv TO price_data.evm_logs_by_contract (`contract_address` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `topic0` String, `ingested_at` DateTime) AS SELECT lower(contract_address) AS contract_address, block_height, event_index, block_timestamp, ifNull(topic0, '') AS topic0, ingested_at FROM price_data.raw_evm_logs;

-- ---------------------------------------------------------------------------
-- Current prices.
-- ---------------------------------------------------------------------------

-- /v1/assets, /v1/assets/{id}/price and every CURRENT-price valuation (account
-- balances, LP positions, TVL): the newest price row per asset. prices is
-- keyed (asset_id, block_height) and holds ~175 M rows, so "the latest price
-- of every asset" folded whole read 4 GiB; the argMax twin is ~120 rows. The
-- MV fires on every INSERT into prices, including a repair's re-insert (the
-- repair deletes and re-inserts rows, it does not swap partitions), and the
-- argMax by block_height is idempotent under replay.
CREATE TABLE IF NOT EXISTS price_data.asset_price_latest (`asset_id` UInt32, `price_state` AggregateFunction(argMax, Decimal(38, 12), UInt32), `block_state` AggregateFunction(max, UInt32), `time_state` AggregateFunction(argMax, DateTime, UInt32)) ENGINE = AggregatingMergeTree ORDER BY asset_id SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.asset_price_latest_mv TO price_data.asset_price_latest (`asset_id` UInt32, `price_state` AggregateFunction(argMax, Decimal(38, 12), UInt32), `block_state` AggregateFunction(max, UInt32), `time_state` AggregateFunction(argMax, DateTime, UInt32)) AS SELECT asset_id, argMaxState(usd_price, block_height) AS price_state, maxState(block_height) AS block_state, argMaxState(block_timestamp, block_height) AS time_state FROM price_data.prices GROUP BY asset_id;

-- ---------------------------------------------------------------------------
-- Account lifetime and NFT ownership, account-first.
-- ---------------------------------------------------------------------------

-- /v1/accounts/{address}: the first and last indexed event naming an account,
-- over every pallet and asset, as one row per account. Chained off
-- account_activity_v3; min/max states merge across inserts and partitions, so
-- a backfill in any order and a replay both land on the same bounds. Reading
-- the edges from account_activity_v3 directly (ORDER BY block_height … LIMIT 1
-- in each direction) touched one granule per part — 2.3 M rows for a whale.
CREATE TABLE IF NOT EXISTS price_data.account_activity_bounds (`account` String, `first_block_state` AggregateFunction(min, UInt32), `first_time_state` AggregateFunction(min, DateTime), `last_block_state` AggregateFunction(max, UInt32), `last_time_state` AggregateFunction(max, DateTime)) ENGINE = AggregatingMergeTree ORDER BY account SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.account_activity_bounds_mv TO price_data.account_activity_bounds (`account` String, `first_block_state` AggregateFunction(min, UInt32), `first_time_state` AggregateFunction(min, DateTime), `last_block_state` AggregateFunction(max, UInt32), `last_time_state` AggregateFunction(max, DateTime)) AS SELECT account, minState(block_height) AS first_block_state, minState(block_timestamp) AS first_time_state, maxState(block_height) AS last_block_state, maxState(block_timestamp) AS last_time_state FROM price_data.account_activity_v3 GROUP BY account;

-- /v1/accounts/{address}/liquidity/positions: every Uniques ownership event
-- naming an account (issued to it, transferred to or from it, burned while it
-- held), account-first. The account's CURRENT NFTs are then the candidates
-- here re-checked against nft_owner_latest by primary key — a bounded read,
-- where merging every NFT's owner to filter by account cost 241k rows per
-- request. Extraction mirrors nft_owner_latest_mv (same events, same fields).
CREATE TABLE IF NOT EXISTS price_data.nft_owner_events_by_account (`account` String, `collection` String, `item` String, `block_height` UInt32, `event_index` UInt32, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (account, collection, item, block_height, event_index) SETTINGS index_granularity = 8192;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.nft_owner_events_by_account_mv TO price_data.nft_owner_events_by_account (`account` String, `collection` String, `item` String, `block_height` UInt32, `event_index` UInt32, `ingested_at` DateTime) AS SELECT arrayJoin(arrayDistinct(arrayFilter(a -> (a != ''), [lower(JSONExtractString(args_json, 'owner')), lower(JSONExtractString(args_json, 'to')), lower(JSONExtractString(args_json, 'from'))]))) AS account, JSONExtractString(args_json, 'collection') AS collection, JSONExtractString(args_json, 'item') AS item, block_height, event_index, ingested_at FROM price_data.raw_events WHERE event_name IN ('Uniques.Issued', 'Uniques.Transferred', 'Uniques.Burned');
