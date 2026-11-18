#!/bin/sh
# Nightly export of the governance forum (see clickhouse/schema/021_forum.sql).
# Public content, but authored by the api and imported by the Subsquare sync rather
# than derived from raw chain data, so a projection rebuild cannot regenerate it —
# the same reason the contract tables are backed up (ops/backup-contract-tables.sh).
# The forum_* list lives here, never in ops/backup-user-tables.sh: that list is tied
# to 004_user.sql and the read-only endpoint's privacy grants, and forum content
# must stay publicly readable. The private forum tables (user_forum_reports,
# user_forum_sanctions) are in 004_user.sql and backed up by user-backup.
#
# Per day: one Parquet file per table, plus every live forum_media CID exported from
# the ipfs node as a CAR file (`dag/export` over its RPC), under images/<cid>.car —
# written once per CID (a CID's bytes never change) and kept while the CID is live.
# Days are pruned after $RETAIN_DAYS; a CAR whose CID was removed by moderation is
# pruned $RETAIN_DAYS after its removal.
#
# Restore: for each table, `clickhouse-client --host "$HOST" --password "$PASSWORD"
# --query "INSERT INTO price_data.<t> FORMAT Parquet" < <t>.parquet` — safe on a live
# table because every row carries its original ReplacingMergeTree version — then
# `ipfs dag import --pin-roots <cid>.car` for every image (pins it again), then
# ops/forum-reapply-erasures.sh (with the NEWEST forum_moderation_log.parquet imported
# first), which re-applies every author delete, moderator purge and image removal an
# older export predates.
set -eu
HOST="${CLICKHOUSE_HOST:-clickhouse}"
PASSWORD="${CLICKHOUSE_PASSWORD:-dev}"
IPFS="${IPFS_API_URL:-http://hydration-neckwork-ipfs:5001}"
DEST="${BACKUP_DIR:-/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
TABLES="forum_posts forum_comments forum_revisions forum_media forum_media_urls forum_moderation_log"

while true; do
  day="$(date -u +%Y-%m-%d)"
  mkdir -p "$DEST/$day" "$DEST/images"
  for t in $TABLES; do
    # FINAL collapses replaced versions so a restore INSERT never resurrects
    # superseded rows; hidden and deleted flags are kept — they are state.
    clickhouse-client --host "$HOST" --password "$PASSWORD" \
      --query "SELECT * FROM price_data.$t FINAL FORMAT Parquet" \
      > "$DEST/$day/$t.parquet.tmp"
    mv "$DEST/$day/$t.parquet.tmp" "$DEST/$day/$t.parquet"
  done
  # Images: every live CID not yet exported. A failure (node down) is logged and
  # retried the next night; the table export above has already landed.
  exported=0; failed=0
  for cid in $(clickhouse-client --host "$HOST" --password "$PASSWORD" \
      --query "SELECT cid FROM price_data.forum_media FINAL WHERE deleted = 0 FORMAT TSV"); do
    case "$cid" in *[!A-Za-z0-9]*|'') continue ;; esac
    [ -s "$DEST/images/$cid.car" ] && continue
    if wget -q -O "$DEST/images/$cid.car.tmp" --post-data='' "$IPFS/api/v0/dag/export?arg=$cid&progress=false"; then
      mv "$DEST/images/$cid.car.tmp" "$DEST/images/$cid.car"; exported=$((exported + 1))
    else
      rm -f "$DEST/images/$cid.car.tmp"; failed=$((failed + 1))
    fi
  done
  find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime "+$RETAIN_DAYS" -exec rm -rf {} +
  # A removed image (moderation tombstoned its forum_media row) keeps its CAR for
  # RETAIN_DAYS after the REMOVAL — dated by the row's updated_at, not by when the CAR
  # was exported — the same horizon the table exports age out on.
  for cid in $(clickhouse-client --host "$HOST" --password "$PASSWORD" --param_days="$RETAIN_DAYS" \
      --query "SELECT cid FROM price_data.forum_media FINAL WHERE deleted = 1 AND updated_at < now() - toIntervalDay({days:UInt32}) FORMAT TSV"); do
    case "$cid" in *[!A-Za-z0-9]*|'') continue ;; esac
    rm -f "$DEST/images/$cid.car"
  done
  echo "[forum-backup] exported $day (images: $exported new, $failed failed)"
  sleep 86400
done
