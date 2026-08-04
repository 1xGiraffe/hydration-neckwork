-- Contract verification artifacts. PUBLIC chain-adjacent data, but AUTHORED by
-- verification submissions (api-written), NOT reproducible from raw — excluded
-- from projection rebuilds and exported nightly by ops/backup-contract-tables.sh
-- (contract-backup service). Never add these to 004_user.sql: the read-only
-- endpoint's grant script derives revokes from that file and these must stay
-- publicly readable.
--
-- Same upsert idiom as the user_* tables: ReplacingMergeTree keyed by the thing
-- being described, so re-verifying a contract replaces its rows instead of
-- accumulating history, with soft-delete tombstones for shrunken file sets.

-- Address → ABI plus the verification identity card. `source` distinguishes how
-- the ABI got here: 'verified' (bytecode actually matched by our verifier),
-- 'import:blockscout' (externally verified corpus), 'manual'. `code_hash` is
-- the registry's code hash at verification time: a CREATE2 redeploy at the same
-- address surfaces as "verified against superseded bytecode" instead of
-- silently mislabelling the new code.
CREATE TABLE IF NOT EXISTS price_data.contract_abis (`address` String, `abi_json` String CODEC(ZSTD(6)), `contract_name` String DEFAULT '', `compiler_version` String DEFAULT '', `source` LowCardinality(String), `match_type` LowCardinality(String) DEFAULT '', `code_hash` String DEFAULT '', `deleted` UInt8 DEFAULT 0, `updated_at` DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY address SETTINGS index_granularity = 64;

-- One row per source file of a verified contract, keyed (address, path) so a
-- re-verification replaces files in place; paths absent from the newest
-- verification are tombstoned (deleted=1) rather than left live beside it.
CREATE TABLE IF NOT EXISTS price_data.contract_sources (`address` String, `path` String, `content` String CODEC(ZSTD(6)), `evm_version` String DEFAULT '', `optimizer_enabled` UInt8 DEFAULT 0, `optimizer_runs` UInt32 DEFAULT 0, `constructor_arguments` String DEFAULT '', `compiler_settings` String DEFAULT '' CODEC(ZSTD(6)), `deleted` UInt8 DEFAULT 0, `updated_at` DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (address, path) SETTINGS index_granularity = 64;

-- Verification attempts, keyed by the opaque id handed back to the client. The
-- Sourcify protocol polls by this id, so it survives a restart: an api redeploy
-- mid-verification must not turn a client's poll into "job not found".
-- `deployed_bytecode` is cached here at submit time precisely so the read paths
-- never have to call eth_getCode (AGENTS.md forbids per-request RPC).
CREATE TABLE IF NOT EXISTS price_data.contract_verifications (`verification_id` String, `address` String, `status` LowCardinality(String), `match_type` LowCardinality(String) DEFAULT '', `contract_identifier` String DEFAULT '', `compiler_version` String DEFAULT '', `error_code` LowCardinality(String) DEFAULT '', `error_message` String DEFAULT '', `deployed_bytecode` String DEFAULT '' CODEC(ZSTD(6)), `submitted_at` DateTime DEFAULT now(), `completed_at` Nullable(DateTime), `updated_at` DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY verification_id SETTINGS index_granularity = 64;
