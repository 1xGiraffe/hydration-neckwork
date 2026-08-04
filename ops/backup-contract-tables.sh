#!/bin/sh
# Nightly export of the contract verification tables (see
# clickhouse/schema/005_contracts.sql). Public data, but api-authored rather
# than derived from raw chain data, so a projection rebuild cannot regenerate
# it — the same reason the user_* tables are backed up, in a separate script
# because ops/backup-user-tables.sh's TABLES= list is contractually tied to
# 004_user.sql and the read-only endpoint's privacy grant script. One Parquet
# file per table per day, pruned after $RETAIN_DAYS; runs as a small loop
# container (contract-backup in docker-compose.yml).
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
TABLES="contract_abis contract_sources contract_verifications"

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
  echo "[contract-backup] exported $day"
  sleep 86400
done
