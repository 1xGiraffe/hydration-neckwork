-- Application-level address tags / groups for the Explorer UI.
-- NOT part of the raw indexer pipeline — this table is written and read only by
-- the API (api/src/services/tagService.ts). It lets several accounts be grouped
-- under one human tag (e.g. two Kraken deposit addresses -> "Kraken") so that
-- aggregate lists (Holders, Transfers, ...) display and combine them as a single
-- entity, while the individual account pages stay separate.
--
-- One row per (label_id, account_id) membership. Tag display metadata
-- (label_name, color, note, icon) is denormalised onto every member row so a
-- rename is a single re-insert per member. Soft-delete via `deleted` +
-- ReplacingMergeTree so removals are replay-safe; always read with FINAL and
-- `WHERE deleted = 0`.
CREATE TABLE IF NOT EXISTS price_data.account_tags
(
    label_id String,
    label_name String,
    color String DEFAULT '',
    note String DEFAULT '',
    icon String DEFAULT '',             -- explicit icon URL/emoji, or '' to derive from first member
    account_id String,                 -- normalized 0x-prefixed 64-hex AccountId32
    deleted UInt8 DEFAULT 0,
    created_at DateTime DEFAULT now(),
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (label_id, account_id)
SETTINGS index_granularity = 8192;
