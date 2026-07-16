-- On-chain identities (Identity.IdentityOf) snapshotted from the Hydration chain.
-- NOT part of the raw indexer pipeline — populated out-of-band by an identity
-- snapshot job and read by the API (api/src/services/identityService.ts) to show
-- verified display names on account pills. Created here (empty) so a fresh
-- database starts cleanly; the explorer falls back to the deterministic emoji
-- name when no identity row is present.
--
-- One row per account_id; refreshed by re-insert. ReplacingMergeTree(updated_at)
-- so re-snapshots dedup; read with FINAL.
CREATE TABLE IF NOT EXISTS price_data.account_identities
(
    account_id String,                 -- normalized 0x-prefixed 64-hex AccountId32
    display String DEFAULT '',
    verified UInt8 DEFAULT 0,
    email String DEFAULT '',
    web String DEFAULT '',
    twitter String DEFAULT '',
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY account_id
SETTINGS index_granularity = 8192;
