#!/bin/sh
# Nightly export of the user_* tables — the ONLY state in ClickHouse that is not
# reproducible from raw chain data (see clickhouse/schema/004_user.sql). One
# Parquet file per table per day, pruned after $RETAIN_DAYS. Runs as a small
# loop container (user-backup in docker-compose.yml) instead of host cron so it
# ships with the stack.
#
# Restore: for each table, `clickhouse-client --host "$HOST" --password
# "$PASSWORD" --query "INSERT INTO price_data.<t> FORMAT Parquet" <
# <t>.parquet` — safe on a live table because every row carries its original
# `updated_at` ReplacingMergeTree version.
set -eu
HOST="${CLICKHOUSE_HOST:-clickhouse}"
PASSWORD="${CLICKHOUSE_PASSWORD:-dev}"
DEST="${BACKUP_DIR:-/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
TABLES="user_profiles user_avatars user_sessions user_lists user_tags user_tag_members user_list_subscriptions user_list_order user_notification_channels user_notification_rules user_notification_inbox user_notification_state user_api_tokens user_api_limits user_api_usage"

while true; do
  day="$(date -u +%Y-%m-%d)"
  mkdir -p "$DEST/$day"
  for t in $TABLES; do
    # FINAL collapses replaced versions so a restore INSERT never resurrects
    # superseded rows; tombstones (deleted=1) are kept — they are state.
    clickhouse-client --host "$HOST" --password "$PASSWORD" \
      --query "SELECT * FROM price_data.$t FINAL FORMAT Parquet" \
      > "$DEST/$day/$t.parquet.tmp"
    mv "$DEST/$day/$t.parquet.tmp" "$DEST/$day/$t.parquet"
  done
  find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETAIN_DAYS" -exec rm -rf {} +
  echo "[user-backup] exported $day"
  sleep 86400
done
