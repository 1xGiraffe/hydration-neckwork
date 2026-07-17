#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-price_data}"
CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-dev}"
RAW_WORKERS="${RAW_WORKERS:-6}"
RANGE_SIZE="${RANGE_SIZE:-1000}"
MAIN_MAX_RANGES="${MAIN_MAX_RANGES:-2}"
# Parallel price backfills keep event-time prices near the raw ingestion frontier.
MAIN_WORKERS="${MAIN_WORKERS:-3}"
POLL_SECONDS="${POLL_SECONDS:-60}"
RAW_FAILED_RETRY_LIMIT="${RAW_FAILED_RETRY_LIMIT:-3}"
# Blocked raw ranges are terminal for the hot retry loop, but archive gaps can
# heal later. Retry stale blocked ranges on a long cooldown so healed gaps do
# not stall the historical frontier forever.
RAW_BLOCKED_RETRY_AFTER_SECONDS="${RAW_BLOCKED_RETRY_AFTER_SECONDS:-21600}"

RAW_PREFIX="${RAW_PREFIX:-hydration-neckwork-raw-backfill-}"
MAIN_PREFIX="${MAIN_PREFIX:-hydration-neckwork-main-backfill-}"

RAW_RATE_LIMIT="${RAW_RATE_LIMIT:-50}"
RAW_CAPACITY="${RAW_CAPACITY:-10}"
RAW_BALANCE_READ_CONCURRENCY="${RAW_BALANCE_READ_CONCURRENCY:-20}"
RAW_BALANCE_READ_BATCH_SIZE="${RAW_BALANCE_READ_BATCH_SIZE:-250}"
RAW_BALANCE_READ_BATCH_CONCURRENCY="${RAW_BALANCE_READ_BATCH_CONCURRENCY:-4}"
RAW_SNAPSHOT_READ_BATCH_SIZE="${RAW_SNAPSHOT_READ_BATCH_SIZE:-100}"
RAW_SNAPSHOT_READ_BATCH_CONCURRENCY="${RAW_SNAPSHOT_READ_BATCH_CONCURRENCY:-2}"
RAW_MONEY_MARKET_POSITION_CONCURRENCY="${RAW_MONEY_MARKET_POSITION_CONCURRENCY:-8}"
RAW_MONEY_MARKET_BATCH_SIZE="${RAW_MONEY_MARKET_BATCH_SIZE:-50}"

MAIN_RPC_URL="${MAIN_RPC_URL:-https://rpc.hydradx.cloud}"
MAIN_RATE_LIMIT="${MAIN_RATE_LIMIT:-10}"
MAIN_CAPACITY="${MAIN_CAPACITY:-3}"

LIVE_MAIN_ENABLED="${LIVE_MAIN_ENABLED:-true}"
LIVE_MAIN_NAME="${LIVE_MAIN_NAME:-hydration-neckwork-main-live}"
LIVE_MAIN_PIPELINE_ID="${LIVE_MAIN_PIPELINE_ID:-main-live}"
LIVE_MAIN_RPC_URL="${LIVE_MAIN_RPC_URL:-https://rpc.hydradx.cloud}"
LIVE_MAIN_RATE_LIMIT="${LIVE_MAIN_RATE_LIMIT:-100}"
LIVE_MAIN_CAPACITY="${LIVE_MAIN_CAPACITY:-20}"
LIVE_MAIN_BATCH_SIZE="${LIVE_MAIN_BATCH_SIZE:-50000}"

# Use an operator-selected raw RPC when configured; otherwise rotate public RPCs.
if [[ -n "${RAW_RPC_URL:-}" ]]; then
  RPC_ENDPOINTS=("$RAW_RPC_URL")
else
  RPC_ENDPOINTS=(
    "https://rpc.coke.hydration.cloud"
    "https://rpc.sin.hydration.cloud"
    "https://hydration.rotko.net"
  )
fi
RPC_FALLBACKS="${RAW_EVM_RPC_FALLBACK_URLS:-https://rpc.sin.hydration.cloud,https://rpc.coke.hydration.cloud,https://hydration.rotko.net,https://rpc.hydradx.cloud}"

cd "$ROOT_DIR"

RAW_BACKFILL_COMPLETE_LOGGED=false
MAIN_BACKFILL_COMPLETE_LOGGED=false

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

if ! [[ "$RAW_BLOCKED_RETRY_AFTER_SECONDS" =~ ^[0-9]+$ ]]; then
  log "invalid RAW_BLOCKED_RETRY_AFTER_SECONDS='$RAW_BLOCKED_RETRY_AFTER_SECONDS'; using 21600"
  RAW_BLOCKED_RETRY_AFTER_SECONDS=21600
fi

ch_query() {
  docker compose exec -T clickhouse clickhouse-client \
    --password "$CLICKHOUSE_PASSWORD" \
    --database "$CLICKHOUSE_DATABASE" \
    --query "$1" </dev/null
}

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

range_from_name() {
  local name="$1"
  local range="${name#${RAW_PREFIX}}"
  printf '%s\n' "${range%-*}"
}

range_to_name() {
  local name="$1"
  local range="${name#${RAW_PREFIX}}"
  printf '%s\n' "${range#*-}"
}

container_exists() {
  local name="$1"
  docker ps -a --format '{{.Names}}' | grep -Fxq "$name"
}

container_status() {
  local name="$1"
  docker ps -a --format '{{.Names}}\t{{.Status}}' |
    awk -F '\t' -v name="$name" '$1 == name { print $2; found = 1 } END { if (!found) exit 1 }'
}

remove_container() {
  local name="$1"
  local error

  if ! error="$(docker rm "$name" 2>&1 >/dev/null)"; then
    if container_exists "$name"; then
      log "failed to remove container $name: $error"
      return 1
    fi
  fi
}

active_raw_count() {
  docker ps -a --format '{{.Names}}\t{{.Status}}' |
    awk -F '\t' -v prefix="$RAW_PREFIX" '$1 ~ "^" prefix && $2 ~ /^Up/ { count++ } END { print count + 0 }'
}

raw_worker_slots_full() {
  (( "$(active_raw_count)" >= RAW_WORKERS ))
}

active_main_count() {
  docker ps -a --format '{{.Names}}\t{{.Status}}' |
    awk -F '\t' -v prefix="$MAIN_PREFIX" '$1 ~ "^" prefix && $2 ~ /^Up/ { count++ } END { print count + 0 }'
}

range_status() {
  local from="$1"
  local to="$2"
  ch_query "
SELECT status
FROM raw_ingestion_ranges FINAL
WHERE from_block = $from AND to_block = $to
ORDER BY updated_at DESC
LIMIT 1
FORMAT TSV"
}

is_range_completed() {
  local from="$1"
  local to="$2"
  [[ "$(range_status "$from" "$to")" == "completed" ]]
}

mark_raw_range_failed_from_supervisor() {
  local from="$1"
  local to="$2"
  local reason="$3"
  local pipeline="raw-backfill-${from}-${to}"
  local range_id="${pipeline}:${from}-${to}"
  local expected=$((to - from + 1))
  local escaped_reason
  escaped_reason="$(sql_escape "$reason")"

  if ! ch_query "
INSERT INTO raw_ingestion_ranges
SELECT
  '$(sql_escape "$range_id")' AS range_id,
  '$(sql_escape "$pipeline")' AS pipeline_id,
  toUInt32($from) AS from_block,
  toUInt32($to) AS to_block,
  'failed' AS status,
  '' AS first_hash,
  '' AS first_parent_hash,
  '' AS last_hash,
  toUInt32(0) AS block_count,
  toUInt32($expected) AS expected_block_count,
  toUInt32(0) AS broken_parent_links,
  CAST('$escaped_reason', 'Nullable(String)') AS error,
  coalesce(
    (
      SELECT anyOrNull(started_at)
      FROM raw_ingestion_ranges FINAL
      WHERE range_id = '$(sql_escape "$range_id")'
    ),
    now()
  ) AS started_at,
  CAST(NULL, 'Nullable(DateTime)') AS completed_at,
  now64(3) AS updated_at
"; then
    log "failed to mark raw range $from-$to as failed"
  fi

  # Append-only failure log: raw_ingestion_ranges is a ReplacingMergeTree keyed on
  # range_id, so every attempt for the same range collapses to one physical row
  # once merges run, making a "count failed rows for this range" query
  # merge-dependent and nondeterministic. raw_ingestion_range_failures is a plain
  # MergeTree with no replacement semantics, so every attempt is an immutable row
  # and counts stay exact forever. Volume is tiny (one row per failed attempt), so
  # no cleanup/TTL is needed.
  if ! ch_query "
INSERT INTO raw_ingestion_range_failures (range_id, pipeline_id, from_block, to_block, reason)
SELECT
  '$(sql_escape "$range_id")' AS range_id,
  '$(sql_escape "$pipeline")' AS pipeline_id,
  toUInt32($from) AS from_block,
  toUInt32($to) AS to_block,
  '$escaped_reason' AS reason
"; then
    log "failed to record raw range failure $from-$to in failure log"
  fi
}

mark_raw_range_blocked_from_supervisor() {
  local from="$1"
  local to="$2"
  local reason="$3"
  local pipeline="raw-backfill-${from}-${to}"
  local range_id="${pipeline}:${from}-${to}"
  local expected=$((to - from + 1))
  local escaped_reason
  escaped_reason="$(sql_escape "$reason")"

  if ! ch_query "
INSERT INTO raw_ingestion_ranges
SELECT
  '$(sql_escape "$range_id")' AS range_id,
  '$(sql_escape "$pipeline")' AS pipeline_id,
  toUInt32($from) AS from_block,
  toUInt32($to) AS to_block,
  'blocked' AS status,
  '' AS first_hash,
  '' AS first_parent_hash,
  '' AS last_hash,
  toUInt32(0) AS block_count,
  toUInt32($expected) AS expected_block_count,
  toUInt32(0) AS broken_parent_links,
  CAST('$escaped_reason', 'Nullable(String)') AS error,
  coalesce(
    (
      SELECT anyOrNull(started_at)
      FROM raw_ingestion_ranges FINAL
      WHERE range_id = '$(sql_escape "$range_id")'
    ),
    now()
  ) AS started_at,
  CAST(NULL, 'Nullable(DateTime)') AS completed_at,
  now64(3) AS updated_at
"; then
    log "failed to mark raw range $from-$to as blocked"
  fi
}

# Counts from the append-only raw_ingestion_range_failures log (see the comment
# in mark_raw_range_failed_from_supervisor), not from raw_ingestion_ranges: that
# table is a ReplacingMergeTree keyed on range_id, so counting rows with
# status = 'failed' there is merge-dependent and can silently collapse to a
# single row, letting a permanently failing range retry forever.
failed_raw_attempt_count() {
  local from="$1"
  local to="$2"
  ch_query "
SELECT count()
FROM raw_ingestion_range_failures
WHERE from_block = $from
  AND to_block = $to
FORMAT TSV" |
    awk 'NR == 1 { print $1 + 0 }'
}

block_raw_range_if_retry_exhausted() {
  local from="$1"
  local to="$2"
  local context="$3"
  local attempts
  attempts="$(failed_raw_attempt_count "$from" "$to" || printf '0\n')"
  attempts="${attempts:-0}"

  if (( attempts >= RAW_FAILED_RETRY_LIMIT )); then
    log "raw range $from-$to reached retry limit ($attempts/$RAW_FAILED_RETRY_LIMIT); marking blocked"
    mark_raw_range_blocked_from_supervisor "$from" "$to" "retry limit $RAW_FAILED_RETRY_LIMIT reached after $attempts failed attempt(s): $context"
    return 0
  fi

  return 1
}

start_raw_range() {
  local from="$1"
  local to="$2"
  local name="${RAW_PREFIX}${from}-${to}"
  local pipeline="raw-backfill-${from}-${to}"
  local endpoint_index=$(( (from / RANGE_SIZE) % ${#RPC_ENDPOINTS[@]} ))
  local endpoint="${RPC_ENDPOINTS[$endpoint_index]}"

  if container_exists "$name"; then
    log "raw container already exists: $name"
    return 0
  fi

  log "starting raw range $from-$to on $endpoint"
  COMPOSE_IGNORE_ORPHANS=true docker compose run --no-deps --interactive=false -d --name "$name" \
    -e RAW_PIPELINE_ID="$pipeline" \
    -e RPC_URL="$endpoint" \
    -e RAW_EVM_RPC_URL="${RAW_EVM_RPC_URL:-$endpoint}" \
    -e RAW_EVM_RPC_FALLBACK_URLS="$RPC_FALLBACKS" \
    -e RPC_RATE_LIMIT="$RAW_RATE_LIMIT" \
    -e RPC_CAPACITY="$RAW_CAPACITY" \
    -e RAW_BALANCE_READ_CONCURRENCY="$RAW_BALANCE_READ_CONCURRENCY" \
    -e RAW_BALANCE_READ_BATCH_SIZE="$RAW_BALANCE_READ_BATCH_SIZE" \
    -e RAW_BALANCE_READ_BATCH_CONCURRENCY="$RAW_BALANCE_READ_BATCH_CONCURRENCY" \
    -e RAW_SNAPSHOT_READ_BATCH_SIZE="$RAW_SNAPSHOT_READ_BATCH_SIZE" \
    -e RAW_SNAPSHOT_READ_BATCH_CONCURRENCY="$RAW_SNAPSHOT_READ_BATCH_CONCURRENCY" \
    -e RAW_MONEY_MARKET_POSITION_CONCURRENCY="$RAW_MONEY_MARKET_POSITION_CONCURRENCY" \
    -e RAW_MONEY_MARKET_BATCH_SIZE="$RAW_MONEY_MARKET_BATCH_SIZE" \
    raw-indexer src/raw/cli.ts \
    --from-block="$from" \
    --to-block="$to" \
    --pipeline-id="$pipeline" </dev/null >/dev/null
}

start_main_range() {
  local from="$1"
  local to="$2"
  local name="${MAIN_PREFIX}${from}-${to}"
  local pipeline="main-backfill-${from}-${to}"

  if container_exists "$name"; then
    log "main container already exists: $name"
    return 0
  fi

  log "starting main range $from-$to"
  COMPOSE_IGNORE_ORPHANS=true docker compose run --no-deps --interactive=false -d --name "$name" \
    -e INDEXER_PIPELINE_ID="$pipeline" \
    -e RPC_URL="$MAIN_RPC_URL" \
    -e RPC_RATE_LIMIT="$MAIN_RATE_LIMIT" \
    -e RPC_CAPACITY="$MAIN_CAPACITY" \
    indexer src/cli.ts \
    --from-block="$from" \
    --to-block="$to" \
    --pipeline-id="$pipeline" </dev/null >/dev/null
}

live_main_checkpoint() {
  ch_query "
SELECT last_block
FROM indexer_state FINAL
WHERE id = '$LIVE_MAIN_PIPELINE_ID'
ORDER BY updated_at DESC
LIMIT 1
FORMAT TSV"
}

start_live_main() {
  if [[ "$LIVE_MAIN_ENABLED" != "true" ]]; then
    return 0
  fi

  if container_exists "$LIVE_MAIN_NAME"; then
    log "live main container already exists: $LIVE_MAIN_NAME"
    return 0
  fi

  local checkpoint
  checkpoint="$(live_main_checkpoint || true)"
  local args=("--pipeline-id=$LIVE_MAIN_PIPELINE_ID" "--allow-unfinalized-raw")

  if [[ -z "$checkpoint" || "$checkpoint" == "\\N" || "$checkpoint" == "0" ]]; then
    local main_blocks
    main_blocks="$(ch_query "SELECT count() FROM blocks FORMAT TSV")"
    if [[ -n "$main_blocks" && "$main_blocks" != "0" && "$main_blocks" != "\\N" ]]; then
      # Some main blocks exist (backfill ran): continue live just above them.
      local start_from
      start_from="$(ch_query "SELECT max(block_height) + 1 FROM blocks FORMAT TSV")"
      args=("--from-block=$start_from" "${args[@]}")
      log "starting live main indexer $LIVE_MAIN_NAME from block $start_from"
    else
      # Fresh database: let the main indexer default to chain head and follow
      # forward (no --from-block), matching the raw live follower.
      log "starting live main indexer $LIVE_MAIN_NAME at chain head (fresh; backfill fills history)"
    fi
  else
    log "starting live main indexer $LIVE_MAIN_NAME from checkpoint $checkpoint"
  fi

  COMPOSE_IGNORE_ORPHANS=true docker compose run --no-deps --interactive=false -d --name "$LIVE_MAIN_NAME" \
    -e INDEXER_PIPELINE_ID="$LIVE_MAIN_PIPELINE_ID" \
    -e MAIN_REQUIRE_FINALIZED_RAW=false \
    -e RPC_URL="$LIVE_MAIN_RPC_URL" \
    -e RPC_RATE_LIMIT="$LIVE_MAIN_RATE_LIMIT" \
    -e RPC_CAPACITY="$LIVE_MAIN_CAPACITY" \
    -e BATCH_SIZE="$LIVE_MAIN_BATCH_SIZE" \
    indexer src/cli.ts "${args[@]}" </dev/null >/dev/null
}

min_known_raw_from() {
  {
    docker ps -a --format '{{.Names}}' |
      awk -v prefix="$RAW_PREFIX" '$0 ~ "^" prefix {
        name = $0
        sub("^" prefix, "", name)
        split(name, parts, "-")
        print parts[1]
      }'
    ch_query "SELECT from_block FROM raw_ingestion_ranges FINAL FORMAT TSV"
    # Seed the backfill frontier from the live follower's head so that, on a fresh
    # database with no ranges yet, backfill starts just below chain head and walks
    # downward. Once ranges exist they are lower, so this never affects the min.
    ch_query "SELECT last_block FROM raw_ingestion_state FINAL WHERE pipeline_id = 'raw-live' AND last_block > 0 FORMAT TSV" || true
  } |
    awk '$1 ~ /^[0-9]+$/ { if (min == "" || $1 < min) min = $1 } END { print min }'
}

oldest_raw_frontier_blocked() {
  local from="$1"
  local counts
  counts="$(ch_query "
SELECT countIf(status != 'blocked') AS non_blocked, countIf(status = 'blocked') AS blocked
FROM raw_ingestion_ranges FINAL
WHERE from_block = $from
FORMAT TSV" || true)"
  local non_blocked
  local blocked
  read -r non_blocked blocked <<<"$counts"
  [[ "${blocked:-0}" != "0" && "${non_blocked:-0}" == "0" ]]
}

cleanup_stopped_raw() {
  docker ps -a --format '{{.Names}}\t{{.Status}}' |
    awk -F '\t' -v prefix="$RAW_PREFIX" '$1 ~ "^" prefix && $2 !~ /^Up/ { print $1 "\t" $2 }' |
    while IFS=$'\t' read -r name status; do
      local from
      local to
      from="$(range_from_name "$name")"
      to="$(range_to_name "$name")"

      if [[ "$status" == Exited\ \(0\)* ]]; then
        if is_range_completed "$from" "$to"; then
          log "removing completed raw container $name"
          remove_container "$name"
        else
          mark_raw_range_failed_from_supervisor "$from" "$to" "container exited 0 before range completed"
          if block_raw_range_if_retry_exhausted "$from" "$to" "container exited 0 before range completed"; then
            remove_container "$name"
            continue
          fi
          if raw_worker_slots_full; then
            log "raw container $name exited 0 but range is not completed; removing stopped container and deferring restart because raw worker cap is reached"
            remove_container "$name"
            continue
          fi
          log "raw container $name exited 0 but range is not completed; restarting same range"
          remove_container "$name"
          start_raw_range "$from" "$to"
        fi
      else
        mark_raw_range_failed_from_supervisor "$from" "$to" "container stopped with status: $status"
        if block_raw_range_if_retry_exhausted "$from" "$to" "container stopped with status: $status"; then
          remove_container "$name"
          continue
        fi
        if raw_worker_slots_full; then
          log "raw container $name failed with status '$status'; removing stopped container and deferring restart because raw worker cap is reached"
          remove_container "$name"
          continue
        fi
        log "raw container $name failed with status '$status'; restarting same range"
        remove_container "$name"
        start_raw_range "$from" "$to"
      fi
    done
}

# Recover raw ranges left in 'running'/'failed' with no backing container. Also
# retry stale 'blocked' ranges on a long cooldown: a range may be blocked because
# the archive temporarily returned an incomplete window, and that data can become
# available later. Re-running is safe: the raw pipeline upserts
# (ReplacingMergeTree) and marks the range 'completed' when it finishes. The
# staleness guards avoid racing active workers and keep blocked ranges out of the
# per-minute retry loop.
recover_orphaned_raw() {
  while IFS=$'\t' read -r from to status; do
    [[ -z "${from:-}" || -z "${to:-}" || -z "${status:-}" ]] && continue
    local name="${RAW_PREFIX}${from}-${to}"
    if ! container_exists "$name"; then
      if [[ "$status" == "running" ]]; then
        mark_raw_range_failed_from_supervisor "$from" "$to" "running range has no backing container"
        status="failed"
      fi
      if [[ "$status" == "failed" ]] && block_raw_range_if_retry_exhausted "$from" "$to" "orphaned failed range has no backing container"; then
        continue
      fi
      if raw_worker_slots_full; then
        log "deferring orphaned raw range recovery; raw worker cap is reached"
        return 0
      fi
      if [[ "$status" == "blocked" ]]; then
        log "retrying stale blocked raw range $from-$to after ${RAW_BLOCKED_RETRY_AFTER_SECONDS}s cooldown"
      else
        log "recovering orphaned raw range $from-$to (status=$status, no container)"
      fi
      start_raw_range "$from" "$to"
    fi
  done < <(ch_query "
SELECT from_block, to_block, status
FROM raw_ingestion_ranges AS range FINAL
WHERE (status = 'failed')
  OR (status = 'running' AND updated_at < now() - INTERVAL 15 MINUTE)
  OR (
    status = 'blocked'
    AND updated_at < now() - toIntervalSecond($RAW_BLOCKED_RETRY_AFTER_SECONDS)
    AND range_id NOT IN
    (
      SELECT parent.range_id
      FROM raw_ingestion_ranges AS parent FINAL
      INNER JOIN raw_ingestion_ranges AS child FINAL
        ON child.status = 'blocked'
        AND child.from_block >= parent.from_block
        AND child.to_block <= parent.to_block
        AND (child.from_block > parent.from_block OR child.to_block < parent.to_block)
      WHERE parent.status = 'blocked'
    )
  )
ORDER BY from_block DESC
FORMAT TSV")
}

cleanup_stopped_main() {
  docker ps -a --format '{{.Names}}\t{{.Status}}' |
    awk -F '\t' -v prefix="$MAIN_PREFIX" '$1 ~ "^" prefix && $2 !~ /^Up/ { print $1 "\t" $2 }' |
    while IFS=$'\t' read -r name status; do
      local range="${name#${MAIN_PREFIX}}"
      local from="${range%-*}"
      local to="${range#*-}"

      if [[ "$status" == Exited\ \(0\)* ]]; then
        log "removing completed main container $name"
        remove_container "$name"
      else
        log "main container $name failed with status '$status'; restarting same range"
        remove_container "$name"
        start_main_range "$from" "$to"
      fi
    done
}

cleanup_live_main() {
  if [[ "$LIVE_MAIN_ENABLED" != "true" ]]; then
    return 0
  fi

  if ! container_exists "$LIVE_MAIN_NAME"; then
    return 0
  fi

  local status
  status="$(container_status "$LIVE_MAIN_NAME")"
  if [[ "$status" != Up* ]]; then
    log "live main container $LIVE_MAIN_NAME is not running (status '$status'); restarting"
    remove_container "$LIVE_MAIN_NAME"
    start_live_main
  fi
}

ensure_live_main() {
  if [[ "$LIVE_MAIN_ENABLED" != "true" ]]; then
    return 0
  fi

  if container_exists "$LIVE_MAIN_NAME"; then
    return 0
  fi

  start_live_main
}

ensure_raw_workers() {
  while (( "$(active_raw_count)" < RAW_WORKERS )); do
    local min_from
    min_from="$(min_known_raw_from)"

    if [[ -z "$min_from" ]]; then
      log "cannot determine oldest raw range; skipping raw worker launch"
      return 0
    fi

    if oldest_raw_frontier_blocked "$min_from"; then
      log "oldest raw frontier starts at $min_from and is blocked; not starting lower raw ranges"
      return 0
    fi

    local next_to=$((min_from - 1))

    if (( next_to < 0 )); then
      if [[ "$RAW_BACKFILL_COMPLETE_LOGGED" != "true" ]]; then
        log "raw backfill reached block 0; no older range to start"
        RAW_BACKFILL_COMPLETE_LOGGED=true
      fi
      return 0
    fi

    local next_from=$((next_to - RANGE_SIZE + 1))
    if (( next_from < 0 )); then
      next_from=0
    fi

    start_raw_range "$next_from" "$next_to"
  done
}

parent_link_breaks() {
  local from="$1"
  local to="$2"
  ch_query "
SELECT count()
FROM (
  SELECT b.block_height, b.parent_hash, p.block_hash AS previous_hash
  FROM (SELECT block_height, parent_hash FROM raw_blocks FINAL WHERE block_height BETWEEN $((from + 1)) AND $to) AS b
  INNER JOIN (SELECT block_height, block_hash FROM raw_blocks FINAL WHERE block_height BETWEEN $from AND $((to - 1))) AS p
    ON p.block_height = b.block_height - 1
)
WHERE parent_hash != previous_hash
FORMAT TSV"
}

# Lowest block any main work has reached: the main `blocks` table min, plus the
# from-block of every in-flight main backfill container (so parallel workers each
# claim the next lower contiguous batch without overlapping).
min_known_main_from() {
  {
    docker ps -a --format '{{.Names}}' |
      awk -v prefix="$MAIN_PREFIX" '$0 ~ "^" prefix {
        name = $0; sub("^" prefix, "", name); split(name, parts, "-"); print parts[1]
      }'
    ch_query "SELECT min(block_height) FROM blocks FORMAT TSV"
  } |
    awk '$1 ~ /^[0-9]+$/ { if (min == "" || $1 < min) min = $1 } END { print min }'
}

# Keep up to MAIN_WORKERS main (price) backfill containers running, each processing
# the next contiguous block below the current main frontier, but only over raw
# ranges already 'completed' (the main pipeline reads raw output). Worker claims
# are coordinated through the current main frontier to avoid overlap.
ensure_main_workers() {
  while (( "$(active_main_count)" < MAIN_WORKERS )); do
    local frontier
    frontier="$(min_known_main_from)"
    if [[ -z "$frontier" || "$frontier" == "\\N" ]]; then
      log "main has no blocks/frontier yet; skipping main launch"
      return 0
    fi

    local target_to=$((frontier - 1))
    if (( target_to < 0 )); then
      if [[ "$MAIN_BACKFILL_COMPLETE_LOGGED" != "true" ]]; then
        log "main backfill reached block 0; no older range to start"
        MAIN_BACKFILL_COMPLETE_LOGGED=true
      fi
      return 0
    fi
    local expected_to="$target_to"
    local batch_from=""
    local ranges=0

    while IFS=$'\t' read -r from to; do
      [[ -z "${from:-}" || -z "${to:-}" ]] && continue
      if (( ranges == 0 )); then
        # The main frontier rarely lands on a raw range boundary (the live follower
        # checkpoints mid-range), so the topmost completed range only has to *cover*
        # the block just below the frontier. We clamp the launched batch's upper bound
        # to target_to, so consuming part of this range is fine.
        if (( from <= expected_to && to >= expected_to )); then
          batch_from="$from"
          expected_to=$((from - 1))
          ranges=$((ranges + 1))
          if (( ranges >= MAIN_MAX_RANGES )); then
            break
          fi
        else
          # No completed raw range covers the block just below the frontier yet.
          break
        fi
      elif (( to == expected_to )); then
        batch_from="$from"
        expected_to=$((from - 1))
        ranges=$((ranges + 1))
        if (( ranges >= MAIN_MAX_RANGES )); then
          break
        fi
      elif (( to < expected_to )); then
        break
      fi
    done < <(ch_query "
SELECT from_block, to_block
FROM raw_ingestion_ranges FINAL
WHERE status = 'completed' AND from_block <= $target_to
ORDER BY to_block DESC
FORMAT TSV")

    if (( ranges == 0 )); then
      # No contiguous completed raw range immediately below the frontier yet; wait
      # for the raw workers to finish it before launching more main work.
      return 0
    fi

    local breaks
    breaks="$(parent_link_breaks "$batch_from" "$((target_to + 1))")"
    if [[ "$breaks" != "0" ]]; then
      log "not starting main $batch_from-$target_to: parent link check found $breaks breaks"
      return 0
    fi

    start_main_range "$batch_from" "$target_to"
  done
}

health_snapshot() {
  local live
  local live_main
  local main_min
  local main_rows
  live="$(ch_query "
SELECT concat(toString(last_block), ' age=', toString(dateDiff('second', updated_at, now())), 's')
FROM raw_ingestion_state FINAL
WHERE pipeline_id = 'raw-live'
FORMAT TSV" || true)"
  live_main="$(ch_query "
SELECT concat(toString(last_block), ' age=', toString(dateDiff('second', updated_at, now())), 's')
FROM indexer_state FINAL
WHERE id = '$LIVE_MAIN_PIPELINE_ID'
FORMAT TSV" || true)"
  main_min="$(ch_query "SELECT min(block_height) FROM blocks FORMAT TSV" || true)"
  main_rows="$(ch_query "SELECT count() FROM blocks FORMAT TSV" || true)"
  log "snapshot live=${live:-unknown} live_main=${live_main:-unknown} main_min=${main_min:-unknown} main_blocks=${main_rows:-unknown} raw_active=$(active_raw_count) main_active=$(active_main_count)"
}

# Bootstrap the append-only failure log for databases created before this table
# was added to the schema; idempotent and safe to run on every supervisor start.
ch_query "
CREATE TABLE IF NOT EXISTS raw_ingestion_range_failures (
  \`range_id\` String,
  \`pipeline_id\` String,
  \`from_block\` UInt32,
  \`to_block\` UInt32,
  \`reason\` String,
  \`failed_at\` DateTime DEFAULT now()
) ENGINE = MergeTree
PARTITION BY toYYYYMM(failed_at)
ORDER BY (from_block, to_block, failed_at)
SETTINGS index_granularity = 8192
"

log "starting ingestion supervisor in $ROOT_DIR"

while true; do
  cleanup_stopped_raw
  cleanup_stopped_main
  cleanup_live_main
  recover_orphaned_raw
  ensure_raw_workers
  ensure_main_workers
  ensure_live_main
  health_snapshot
  sleep "$POLL_SECONDS"
done
