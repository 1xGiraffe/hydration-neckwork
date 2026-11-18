#!/bin/sh
# Re-applies every erasure the forum's public moderation log records — an author's
# 'delete', a moderator's 'purge' and 'media-remove' — after a restore from a forum
# backup (ops/backup-forum-tables.sh). A restored export can predate an erasure, and a
# ReplacingMergeTree keeps superseded row versions until a merge, so without this the
# erased text (or a removed image) would be readable again.
#
# Run it AFTER importing the tables, with the NEWEST forum_moderation_log.parquet
# imported first (an older day's log lacks the newest erasures):
#   docker compose exec -T forum-backup sh -s < ops/forum-reapply-erasures.sh
# Idempotent: it blanks only rows that still carry text and deletes only what is left.
set -eu
HOST="${CLICKHOUSE_HOST:-clickhouse}"
PASSWORD="${CLICKHOUSE_PASSWORD:-dev}"
IPFS="${IPFS_API_URL:-http://hydration-neckwork-ipfs:5001}"
q() { clickhouse-client --host "$HOST" --password "$PASSWORD" --mutations_sync=2 --lightweight_deletes_sync=2 --query "$1"; }

ERASED="SELECT target_id FROM price_data.forum_moderation_log FINAL WHERE action IN ('delete', 'purge')"
PURGED="SELECT target_id FROM price_data.forum_moderation_log FINAL WHERE action = 'purge'"
DELETED="SELECT target_id FROM price_data.forum_moderation_log FINAL WHERE action = 'delete'"
TEXT="(body != '' OR title != '' OR tldr != '')"

# 1. A blank tombstone version for every erased post/comment that still carries text.
q "INSERT INTO price_data.forum_posts SELECT * REPLACE ('' AS title, '' AS body, '' AS tldr, 1 AS deleted, 'native' AS authority, now64(3) AS updated_at)
   FROM price_data.forum_posts FINAL WHERE post_id IN ($DELETED) AND $TEXT"
q "INSERT INTO price_data.forum_posts SELECT * REPLACE ('' AS title, '' AS body, '' AS tldr, 1 AS hidden, 'purged' AS hidden_reason, 1 AS moderated, 'native' AS authority, now64(3) AS updated_at)
   FROM price_data.forum_posts FINAL WHERE post_id IN ($PURGED) AND $TEXT"
q "INSERT INTO price_data.forum_comments SELECT * REPLACE ('' AS body, 1 AS deleted, 'native' AS authority, now64(3) AS updated_at)
   FROM price_data.forum_comments FINAL WHERE comment_id IN ($DELETED) AND body != ''"
q "INSERT INTO price_data.forum_comments SELECT * REPLACE ('' AS body, 1 AS hidden, 'purged' AS hidden_reason, 1 AS moderated, 'native' AS authority, now64(3) AS updated_at)
   FROM price_data.forum_comments FINAL WHERE comment_id IN ($PURGED) AND body != ''"

# 2. Every older version that still holds the text, and every revision of it.
q "DELETE FROM price_data.forum_posts WHERE post_id IN ($ERASED) AND $TEXT"
q "DELETE FROM price_data.forum_comments WHERE comment_id IN ($ERASED) AND body != ''"
q "DELETE FROM price_data.forum_revisions WHERE target_id IN ($ERASED)"

# 3. Images moderators removed: tombstoned again (never served, never re-uploaded) and unpinned.
q "INSERT INTO price_data.forum_media SELECT * REPLACE (1 AS deleted, now64(3) AS updated_at)
   FROM price_data.forum_media FINAL WHERE cid IN (SELECT target_id FROM price_data.forum_moderation_log FINAL WHERE action = 'media-remove') AND deleted = 0"
for cid in $(q "SELECT DISTINCT target_id FROM price_data.forum_moderation_log FINAL WHERE action = 'media-remove' FORMAT TSV"); do
  case "$cid" in *[!A-Za-z0-9]*|'') continue ;; esac
  wget -q -O /dev/null --post-data='' "$IPFS/api/v0/pin/rm?arg=$cid" || true
done
wget -q -O /dev/null --post-data='' "$IPFS/api/v0/repo/gc?quiet=true" || true
echo "[forum-reapply-erasures] done"
