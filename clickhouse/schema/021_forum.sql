-- Governance forum content: discussions, the description of every on-chain subject
-- (referenda, motions, tips, treasury proposals and spends), comments, their
-- revisions, the images they reference, and the public moderation log.
--
-- PUBLIC, but NOT reproducible from raw: written by the api (native posts, later) and
-- by the governance-content-sync service (the Subsquare import, src/governance/
-- subsquare/). The same class as 005_contracts.sql — excluded from every projection
-- rebuild and exported nightly by the forum-backup service
-- (ops/backup-forum-tables.sh). Never move these into 004_user.sql: the read-only
-- endpoint's grant script derives its revokes from that file, and this content is
-- public by nature. Anything private about a person (reports, sanctions) is a user_*
-- table instead.
--
-- Same upsert idiom as the user_* tables: ReplacingMergeTree(updated_at) keyed by the
-- thing described, so an edit or a re-import replaces its row; hiding and deletion are
-- flags, never a hard delete (the backup keeps the record). Readers take FINAL on a
-- primary-key prefix or over these small tables whole.
--
-- Every byte of imported text is HOSTILE (live XSS probes exist on Subsquare): it is
-- stored exactly as received and made safe only at render time, by the one renderer.
--
-- Identifiers:
--   post_id / thread_key  '<n>' a native discussion, 's<uid>' an imported Subsquare
--                         discussion, '<prefix>:<subject>' an on-chain subject's
--                         description: 'opengov:<i>', 'democracy:<i>',
--                         'democracy_proposal:<i>', 'external:<hash>@<height>',
--                         'council:<motion index>', 'tc:<motion index>' (a motion
--                         with no index: '<body>:<hash>@<height>'),
--                         'treasury:<i>' (a treasury proposal), 'spend:<i>' (a treasury
--                         spend), 'tip:<hash>@<height>' (a tip hash recurs when a
--                         retracted tip is reopened).
--   comment_id            's<Subsquare _id>' imported, 'c<ULID>' native.
--   author_account_id     the canonical AccountId32 hex (0x + 64), the join key every
--                         other table uses; '' for an address-less legacy author, who
--                         is named by author_legacy_name alone.
--
-- `row_fp` is the importer's fingerprint of the normalized source fields: a row is
-- written only when it is missing or its fingerprint changed, so a quiet sync cycle
-- writes nothing. `seq` is the forum notification lane's ordering key: 0 for imported
-- history and anything not new, never reused.

-- Root documents: discussions and on-chain subjects' descriptions.
-- `authority`: who owns the current text ('subsquare' until the first native edit,
-- then 'native'; later Subsquare edits are kept as revisions only).
-- `linked`: the other post_ids/subjects of one merged Subsquare thread (council
-- motion ↔ external ↔ TC motion ↔ democracy referendum), so a reader on any of them
-- finds the one thread.
-- `source_activity_at`: Subsquare's lastActivityAt — the sync's high-water mark per
-- collection is max() of it, read from this table, so the sync keeps no state table.
CREATE TABLE IF NOT EXISTS price_data.forum_posts (`post_id` String, `kind` LowCardinality(String), `title` String, `body` String CODEC(ZSTD(6)), `body_format` LowCardinality(String) DEFAULT 'markdown', `tldr` String DEFAULT '', `labels` Array(LowCardinality(String)) DEFAULT [], `linked` Array(String) DEFAULT [], `author_account_id` String DEFAULT '', `author_legacy_name` String DEFAULT '', `authority` LowCardinality(String) DEFAULT 'native', `source` LowCardinality(String) DEFAULT '', `source_id` String DEFAULT '', `source_cid` String DEFAULT '', `source_hash` String DEFAULT '', `source_activity_at` DateTime64(3) DEFAULT toDateTime64(0, 3), `source_removed` UInt8 DEFAULT 0, `source_comments_count` UInt32 DEFAULT 0, `poll_json` String DEFAULT '', `banner_cid` String DEFAULT '', `revision` UInt32 DEFAULT 0, `hidden` UInt8 DEFAULT 0, `hidden_reason` LowCardinality(String) DEFAULT '', `deleted` UInt8 DEFAULT 0, `created_at` DateTime64(3), `edited_at` DateTime64(3) DEFAULT toDateTime64(0, 3), `last_activity_at` DateTime64(3), `seq` UInt64 DEFAULT 0, `row_fp` String DEFAULT '', `updated_at` DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY post_id SETTINGS index_granularity = 256;

-- Comments, two levels: `parent_id` names the top-level comment a reply files under,
-- `reply_to_id` the comment it answers (an @reply inside that thread). `kind` is
-- 'comment', or 'update' for a proposer's append-only note under a description
-- (Subsquare's appendants), which renders as the description's Updates, not in the
-- discussion.
-- `source_height`: the chain height Subsquare stamped on the comment (0 when none).
CREATE TABLE IF NOT EXISTS price_data.forum_comments (`thread_key` String, `comment_id` String, `kind` LowCardinality(String) DEFAULT 'comment', `parent_id` String DEFAULT '', `reply_to_id` String DEFAULT '', `author_account_id` String DEFAULT '', `author_legacy_name` String DEFAULT '', `body` String CODEC(ZSTD(6)), `body_format` LowCardinality(String) DEFAULT 'markdown', `authority` LowCardinality(String) DEFAULT 'native', `source` LowCardinality(String) DEFAULT '', `source_id` String DEFAULT '', `source_cid` String DEFAULT '', `source_hash` String DEFAULT '', `source_height` UInt32 DEFAULT 0, `source_removed` UInt8 DEFAULT 0, `revision` UInt32 DEFAULT 0, `hidden` UInt8 DEFAULT 0, `hidden_reason` LowCardinality(String) DEFAULT '', `deleted` UInt8 DEFAULT 0, `created_at` DateTime64(3), `edited_at` DateTime64(3) DEFAULT toDateTime64(0, 3), `seq` UInt64 DEFAULT 0, `row_fp` String DEFAULT '', `updated_at` DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (thread_key, comment_id) SETTINGS index_granularity = 256;

-- Every version of a post's or a comment's text. Revision 0 of an imported item is the
-- version first seen; a later Subsquare change (its contentHash moved) is the next
-- revision with source 'subsquare'. Append-only in practice; the key makes an import
-- replay idempotent.
CREATE TABLE IF NOT EXISTS price_data.forum_revisions (`target_id` String, `revision` UInt32, `title` String DEFAULT '', `body` String CODEC(ZSTD(6)), `editor_account_id` String DEFAULT '', `source` LowCardinality(String) DEFAULT '', `created_at` DateTime64(3)) ENGINE = ReplacingMergeTree(created_at) ORDER BY (target_id, revision) SETTINGS index_granularity = 256;

-- Images pinned to the forum's IPFS node. Only a CID with a live row here is served at
-- /ipfs/<cid> (we are not an open gateway); `mime` is what the server validated, never
-- what kubo or the original host claimed. `origin`: 'upload' | 'subsquare-rehost' |
-- 'subsquare-cid' (an imported image pinned by its existing CID).
CREATE TABLE IF NOT EXISTS price_data.forum_media (`cid` String, `mime` LowCardinality(String), `bytes` UInt32, `width` UInt16, `height` UInt16, `sha256` String, `uploader_account_id` String DEFAULT '', `origin` LowCardinality(String), `original_url` String DEFAULT '', `deleted` UInt8 DEFAULT 0, `created_at` DateTime64(3), `updated_at` DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY cid SETTINGS index_granularity = 256;

-- The importer's rewrite map: an image URL written in an imported body → the CID it
-- was re-hosted under. `status` 'ok' carries the cid; 'failed' records why the URL
-- could not be re-hosted (refused by the SSRF guard, unreachable, not an image), and
-- such an image renders as a plain link to its original host, never a hot-linked
-- <img>. Stored bodies stay byte-identical to the source; the renderer rewrites.
CREATE TABLE IF NOT EXISTS price_data.forum_media_urls (`original_url` String, `cid` String DEFAULT '', `status` LowCardinality(String), `reason` String DEFAULT '', `attempts` UInt16 DEFAULT 1, `updated_at` DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY original_url SETTINGS index_granularity = 256;

-- The public moderation log: what was hidden or restored, why, by whom and when.
-- Report contents and reporters are private (user_forum_reports) and never here.
-- `moderator_account_id` is 'subsquare' for a hide imported from Subsquare's own
-- moderation (reason 'imported-hidden', or 'spam' for its isMalicious flag). Keyed by
-- a deterministic `action_id` under ReplacingMergeTree, so a replayed import never
-- logs one action twice.
CREATE TABLE IF NOT EXISTS price_data.forum_moderation_log (`action_id` String, `target_id` String, `action` LowCardinality(String), `reason_code` LowCardinality(String), `moderator_account_id` String DEFAULT '', `created_at` DateTime64(3)) ENGINE = ReplacingMergeTree(created_at) ORDER BY (target_id, action_id) SETTINGS index_granularity = 256;

-- State decided HERE that the Subsquare sync must carry, never overwrite, when it
-- rewrites an imported row:
--   `moderated` 1 when the row's current visibility (hidden / hidden_reason) is a
--               moderator's decision on this forum (a hide, or a restore of something
--               Subsquare hid); the sync then keeps hidden/hidden_reason as stored.
--   `locked`    1 when a moderator locked the thread: no new comments or replies.
-- `deleted` is set only by the api (an author's delete) and the sync always carries
-- the stored value; `authority = 'native'` keeps the text (see above).
ALTER TABLE price_data.forum_posts ADD COLUMN IF NOT EXISTS `moderated` UInt8 DEFAULT 0;
ALTER TABLE price_data.forum_posts ADD COLUMN IF NOT EXISTS `locked` UInt8 DEFAULT 0;
ALTER TABLE price_data.forum_comments ADD COLUMN IF NOT EXISTS `moderated` UInt8 DEFAULT 0;
