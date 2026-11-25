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
# clickhouse-client reads the password from CLICKHOUSE_PASSWORD in its environment —
# never from --password, which the host's process list shows. No default: unset, the
# script refuses to run.
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD must be set}"
export CLICKHOUSE_PASSWORD
IPFS="${IPFS_API_URL:-http://hydration-neckwork-ipfs:5001}"
# The node's RPC wants this client's bearer token (IPFS_TOKEN_BACKUP, scoped to
# dag/export, pin/rm and repo/gc; ops/ipfs-init.sh). It never goes on a command line,
# which the host's process list shows: wget reads the header from a wgetrc file (named
# by WGETRC) that the shell's builtin printf writes under /tmp (a tmpfs), mode 600.
IPFS_WGETRC=""
if [ -n "${IPFS_TOKEN_BACKUP:-}" ]; then
  IPFS_WGETRC="$(umask 077; mktemp /tmp/ipfs-wgetrc.XXXXXX)"
  trap 'rm -f "$IPFS_WGETRC"' EXIT
  trap 'exit 143' INT TERM
  printf 'header = Authorization: Bearer %s\n' "$IPFS_TOKEN_BACKUP" > "$IPFS_WGETRC"
fi
ipfs_rpc() { if [ -n "$IPFS_WGETRC" ]; then WGETRC="$IPFS_WGETRC" wget "$@"; else wget "$@"; fi; }
q() { clickhouse-client --host "$HOST" --mutations_sync=2 --lightweight_deletes_sync=2 --query "$1"; }

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
  ipfs_rpc -q -O /dev/null --post-data='' "$IPFS/api/v0/pin/rm?arg=$cid" || true
done
ipfs_rpc -q -O /dev/null --post-data='' "$IPFS/api/v0/repo/gc?quiet=true" || true
echo "[forum-reapply-erasures] done"
