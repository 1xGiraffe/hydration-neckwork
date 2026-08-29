-- User-authored explorer state (profiles, sessions, tag lists, notification
-- subscriptions and their inbox). Unlike every
-- other table, this data is NOT reproducible from raw chain data: it is written
-- only by the api service and must be preserved across projection rebuilds and
-- backed up (see ops/backup-user-tables.sh). Same idiom as account_tags:
-- ReplacingMergeTree(updated_at) upsert-by-key with a soft-delete tombstone.
CREATE TABLE IF NOT EXISTS price_data.user_profiles (account_id String, display_name String DEFAULT '', avatar_version UInt32 DEFAULT 0, deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY account_id SETTINGS index_granularity = 64;
CREATE TABLE IF NOT EXISTS price_data.user_avatars (account_id String, image String, deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY account_id SETTINGS index_granularity = 8;
CREATE TABLE IF NOT EXISTS price_data.user_sessions (token_hash String, account_id String, expires_at DateTime, label String DEFAULT '', created_via LowCardinality(String) DEFAULT 'wallet', last_seen DateTime DEFAULT now(), deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY token_hash SETTINGS index_granularity = 64;
CREATE TABLE IF NOT EXISTS price_data.user_lists (list_id String, owner_account_id String, name String, note String DEFAULT '', visibility LowCardinality(String) DEFAULT 'private', is_personal UInt8 DEFAULT 0, deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY list_id SETTINGS index_granularity = 64;
CREATE TABLE IF NOT EXISTS price_data.user_tags (list_id String, tag_id String, name String, color String DEFAULT '', icon String DEFAULT '', note String DEFAULT '', deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (list_id, tag_id) SETTINGS index_granularity = 64;
CREATE TABLE IF NOT EXISTS price_data.user_tag_members (list_id String, tag_id String, account_id String, position UInt32 DEFAULT 0, deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (list_id, tag_id, account_id) SETTINGS index_granularity = 256;
CREATE TABLE IF NOT EXISTS price_data.user_list_subscriptions (list_id String, account_id String, status LowCardinality(String), origin LowCardinality(String), deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (list_id, account_id) SETTINGS index_granularity = 64;
CREATE TABLE IF NOT EXISTS price_data.user_list_order (account_id String, list_ids Array(String), deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY account_id SETTINGS index_granularity = 64;
-- Notifications. `config` and `params` are opaque JSON blobs written and read
-- only by the api service: a channel config holds a push endpoint + its keys or
-- a Telegram chat id, and rule params hold whatever the rule kind's schema
-- accepts — both are private user data that no other read path may surface.
-- The inbox is the durable record of every notification that was produced,
-- whether or not any channel actually delivered it; its TTL bounds that history
-- to 180 days. `user_notification_state` is the evaluator's small key/value
-- store (live-head cursor, per-rule armed state for threshold triggers).
CREATE TABLE IF NOT EXISTS price_data.user_notification_channels (channel_id String, account_id String, kind LowCardinality(String), config String DEFAULT '', label String DEFAULT '', verified UInt8 DEFAULT 0, deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY channel_id SETTINGS index_granularity = 64;
CREATE TABLE IF NOT EXISTS price_data.user_notification_rules (rule_id String, account_id String, kind LowCardinality(String), name String DEFAULT '', params String DEFAULT '', channels Array(String) DEFAULT [], muted UInt8 DEFAULT 0, cooldown_s UInt32 DEFAULT 0, deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY rule_id SETTINGS index_granularity = 64;
CREATE TABLE IF NOT EXISTS price_data.user_notification_inbox (notification_id String, account_id String, rule_id String, kind LowCardinality(String), title String, body String DEFAULT '', url String DEFAULT '', block_height UInt32 DEFAULT 0, read UInt8 DEFAULT 0, deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY notification_id TTL created_at + INTERVAL 180 DAY SETTINGS index_granularity = 256;
CREATE TABLE IF NOT EXISTS price_data.user_notification_state (key String, value String DEFAULT '', deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY key SETTINGS index_granularity = 64;
-- Data API (hydration-data host) control plane. Tokens store the sha256 of the
-- raw `hdd_…` secret only — the raw value is shown once at creation and never
-- persisted; `token_prefix` (first 12 chars) exists purely so the owner can
-- recognize a token in a list. Written by the explorer api (mint/revoke) and by
-- api-data's throttled last_used_at refresh, which re-reads the current row via
-- INSERT…SELECT so it can never resurrect a revoked token with stale fields.
CREATE TABLE IF NOT EXISTS price_data.user_api_tokens (token_hash String, account_id String, label String DEFAULT '', token_prefix String DEFAULT '', created_at DateTime DEFAULT now(), last_used_at DateTime DEFAULT toDateTime(0), deleted UInt8 DEFAULT 0, updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY token_hash SETTINGS index_granularity = 64;
-- Per-account rate-limit overrides for the Data API; absence of a row means the
-- env defaults (DATA_API_DEFAULT_PER_MINUTE / DATA_API_DEFAULT_PER_DAY) apply.
CREATE TABLE IF NOT EXISTS price_data.user_api_limits (account_id String, per_minute UInt32, per_day UInt32, note String DEFAULT '', updated_by String DEFAULT '', deleted UInt8 DEFAULT 0, updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY account_id SETTINGS index_granularity = 64;
-- Data API usage metering: one row per (account, UTC hour), REPLACED with the
-- running total on each flush (never summed additively — api-data seeds its
-- in-memory counter from the stored row after a restart, so a flush is
-- idempotent under replay and a restart loses at most one flush interval).
CREATE TABLE IF NOT EXISTS price_data.user_api_usage (account_id String, hour_start DateTime, requests UInt64, rejected UInt64, updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (account_id, hour_start) TTL hour_start + INTERVAL 400 DAY SETTINGS index_granularity = 256;
