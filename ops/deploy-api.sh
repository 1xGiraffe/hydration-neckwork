#!/usr/bin/env bash
# Deploy the shared api image (api, api-public, api-data, api-mcp, derivations).
#
# The only sanctioned way to ship api/ code. Never `docker cp` source into a
# running api-family container: each container then carries its own drifting
# /app/src, and a module present in one and missing in another crash-loops the
# others on ERR_MODULE_NOT_FOUND.
#
#   0. One deploy at a time (flock -n on $DEPLOY_LOCK). The git revision and the
#      number of uncommitted paths in the build context (api/, clickhouse/schema/)
#      are logged; DEPLOY_REQUIRE_CLEAN=1 refuses a dirty context.
#   1. PAIR_PRICE_SOURCE is resolved from compose + .env (`docker compose config`)
#      for api and api-public BEFORE anything is built: the two must agree, and if
#      EXPECT_PAIR_PRICE_SOURCE is set it must equal them. The script has no
#      default of its own, so it can never contradict compose's.
#   2. `npm --prefix api run check` must be green (typecheck + tests).
#   3. `docker compose build api` builds the one image all five services run; it
#      is also tagged :<git-sha>[-dirty].
#   4. Every process entrypoint is imported INSIDE the new image, in a throwaway
#      container with no network and no volumes, so it can reach nothing: a
#      missing module, a missing export or a top-level throw fails the deploy
#      before any live container is touched.
#   5. Schema: the new image's `schema-bootstrap --apply` runs against the live
#      ClickHouse — every schema file (idempotent CREATE … IF NOT EXISTS), the
#      MV_UPGRADES view swaps and the bounded DATA_UPGRADES backfills (see
#      api/src/db/schemaBootstrap.ts) — and then VALIDATES: every declared table
#      and view exists, every declared table column exists with its declared type
#      (system.columns), every upgraded view carries its marker, no data upgrade
#      has a missing range. Nonzero → nothing is recreated.
#   6. Services are recreated one at a time — derivations, api-mcp, api-data,
#      api-public, then api (stop first: its host port stays bound otherwise) —
#      each checked for the new image, its health signal (derivations: its first
#      `cycle complete` log line with no FAILED job; the others: their health
#      endpoint), a stable running state, zero restarts and no module errors
#      before the next one is touched.
#   7. Before anything is recreated (from the build through the smoke imports
#      and the schema step) an interim trap re-points :latest at the image it
#      named before the build on ANY non-zero exit or interrupt (EXIT and
#      INT/TERM/HUP), so an untested image never stays on :latest — compose would
#      otherwise start it on the next incidental recreate. On ANY failure once
#      services move — a failed check, an unexpected command failure (EXIT trap)
#      or an interrupt (INT/TERM/HUP trap) — every service already moved, and the
#      one that failed, goes back to the image it ran before this deploy
#      (recorded per service at the start), in REVERSE rollout order (api
#      first: it is the last moved and the one users wait on, and the
#      derivations' health signal — a full cycle — can take up to
#      DERIVATIONS_CYCLE_TIMEOUT_S), every restore is recreated BEFORE any is
#      health-checked, then each is checked in the same order, and :latest is
#      re-pointed at the image it named before the build. :previous is written
#      only after a successful rollout (the image that was live before it); a
#      failure to write it is a WARN, never silent. The rollback runs with
#      errexit off: a failing step is logged and it continues through every
#      service, always restores :latest and logs each service's final state. A
#      derivations cycle with a FAILED or SKIPPED job fails.
#   8. api and api-public are checked to run with the PAIR_PRICE_SOURCE resolved
#      in step 1.
#
# Usage: ops/deploy-api.sh [--skip-check]   (--skip-check only when the same tree
# was just checked; the build context is the working tree, committed or not)
#
# Downtime: none for api-mcp/api-data/api-public/derivations beyond their own
# container restart (a few seconds each, one at a time); api is stopped before it
# is recreated (port 3001), so the explorer API is down for its boot (~5-15 s).
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE=hydration-neckwork-api
HEALTH_TIMEOUT_S=${HEALTH_TIMEOUT_S:-240}
DERIVATIONS_CYCLE_TIMEOUT_S=${DERIVATIONS_CYCLE_TIMEOUT_S:-1800}
SETTLE_S=${SETTLE_S:-20}
DEPLOY_LOCK=${DEPLOY_LOCK:-/tmp/hydration-neckwork-deploy-api.lock}
ORDER=(derivations api-mcp api-data api-public api)
ENTRYPOINTS=(src/derivations/runner.ts src/mcp/server.ts src/data/server.ts src/public/server.ts src/server.ts src/db/schemaBootstrap.ts)

log() { printf '[deploy-api %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# ── 0. lock, revision ─────────────────────────────────────────────────────────
exec 9>"$DEPLOY_LOCK"
flock -n 9 || { log "FAIL: another deploy holds $DEPLOY_LOCK"; exit 1; }

GIT_SHA=$(git rev-parse --short=12 HEAD)
DIRTY=$(git status --porcelain -- api clickhouse/schema | wc -l | tr -d ' ')
DIRTY_ALL=$(git status --porcelain | wc -l | tr -d ' ')
REV_TAG=$GIT_SHA
[[ "$DIRTY" != 0 ]] && REV_TAG="$GIT_SHA-dirty"
log "git $GIT_SHA, $DIRTY uncommitted path(s) in the build context (api/, clickhouse/schema/), $DIRTY_ALL in the tree"
if [[ "${DEPLOY_REQUIRE_CLEAN:-0}" == 1 && "$DIRTY" != 0 ]]; then
  log "FAIL: DEPLOY_REQUIRE_CLEAN=1 and the build context is dirty"; exit 1
fi

# ── 1. PAIR_PRICE_SOURCE, resolved before anything moves ─────────────────────
compose_env() { # service var → the value compose (with .env) gives it
  docker compose config --format json | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const env = JSON.parse(s).services?.[process.argv[1]]?.environment ?? {}
      const v = Array.isArray(env) ? (env.find(e => e.startsWith(process.argv[2] + "=")) ?? "").split("=").slice(1).join("=") : env[process.argv[2]]
      process.stdout.write(v ?? "")
    })' "$1" "$2"
}
PPS_API=$(compose_env api PAIR_PRICE_SOURCE)
PPS_PUBLIC=$(compose_env api-public PAIR_PRICE_SOURCE)
[[ -n "$PPS_API" && "$PPS_API" == "$PPS_PUBLIC" ]] || { log "FAIL: compose resolves PAIR_PRICE_SOURCE api='$PPS_API' api-public='$PPS_PUBLIC' (must agree)"; exit 1; }
if [[ -n "${EXPECT_PAIR_PRICE_SOURCE:-}" && "$EXPECT_PAIR_PRICE_SOURCE" != "$PPS_API" ]]; then
  log "FAIL: compose resolves PAIR_PRICE_SOURCE=$PPS_API, EXPECT_PAIR_PRICE_SOURCE=$EXPECT_PAIR_PRICE_SOURCE"; exit 1
fi
log "PAIR_PRICE_SOURCE resolves to $PPS_API on api and api-public"

# ── 2. check ─────────────────────────────────────────────────────────────────
if [[ "${1:-}" != "--skip-check" ]]; then
  log "npm --prefix api run check"
  CHECK_LOG=$(mktemp)
  npm --prefix api run check >"$CHECK_LOG" 2>&1 || { tail -40 "$CHECK_LOG"; log "FAIL: api check is red"; exit 1; }
fi

# ── state for rollback ───────────────────────────────────────────────────────
container_of() { echo "hydration-neckwork-$1"; }
PREV_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)
declare -A ORIG
for svc in "${ORDER[@]}"; do
  ORIG[$svc]=$(docker inspect -f '{{.Image}}' "$(container_of "$svc")" 2>/dev/null || true)
  log "$svc currently on ${ORIG[$svc]:-<no container>}"
done
log ":latest currently ${PREV_ID:-<none>}"
MOVED=()
NEW_ID=""

restore_latest() {
  if [[ -n "$PREV_ID" ]]; then
    docker tag "$PREV_ID" "$IMAGE" || { log ":latest could NOT be restored to $PREV_ID"; return 1; }
    log ":latest restored to $PREV_ID"
  elif [[ -n "$NEW_ID" ]]; then docker rmi "$IMAGE:latest" >/dev/null 2>&1 || true; log ":latest removed (there was none before)"
  fi
}

# ── health ───────────────────────────────────────────────────────────────────
# Probed from inside each container on its own port 3000 (the host-published
# ports are not uniformly reachable from the host).
health_path() {
  case "$1" in
    api) echo "/health" ;;
    api-public) echo "/rest/service/health" ;;
    api-data) echo "/v1/status" ;;
    api-mcp) echo "/health" ;;
    *) echo "" ;;
  esac
}
probe() {
  docker exec "$1" node -e "fetch('http://127.0.0.1:3000$2',{signal:AbortSignal.timeout(10000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null
}
running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == true ]]; }

# derivations has no endpoint: its health signal is its first completed cycle
# since this container started, with no job FAILED. Logs are captured into a
# variable first and grepped there (a `docker logs | grep -q` under pipefail can
# fail on SIGPIPE).
wait_derivations_cycle() {
  local c=$1 since t=0 logs line
  since=$(docker inspect -f '{{.State.StartedAt}}' "$c")
  while :; do
    logs=$(docker logs --since "$since" "$c" 2>&1 || true)
    line=$(grep -m1 '\[derivations\] cycle complete:' <<<"$logs" || true)
    if [[ -n "$line" ]]; then
      # SKIPPED is a failure too: a needsAssets job is skipped when the cycle's
      # registry refresh failed, so the new image never proved those jobs run.
      if grep -qE '=(FAILED|SKIPPED)' <<<"$line"; then log "derivations first cycle has FAILED/SKIPPED jobs: $(grep -oE '[a-z0-9_]+=(FAILED|SKIPPED)' <<<"$line" | tr '\n' ' ')"; return 1; fi
      log "derivations first cycle complete after ${t}s"; return 0
    fi
    running "$c" || { log "derivations exited before completing a cycle"; return 1; }
    t=$((t + 10)); [[ $t -ge $DERIVATIONS_CYCLE_TIMEOUT_S ]] && { log "derivations: no completed cycle after ${DERIVATIONS_CYCLE_TIMEOUT_S}s"; return 1; }
    sleep 10
  done
}

check_service() { # svc expected-image-id
  local svc=$1 want=$2 c; c=$(container_of "$svc")
  local img; img=$(docker inspect -f '{{.Image}}' "$c" 2>/dev/null || true)
  [[ "$img" == "$want" ]] || { log "$svc runs ${img:-nothing}, not $want"; return 1; }
  local url; url=$(health_path "$svc")
  if [[ "$svc" == derivations ]]; then
    wait_derivations_cycle "$c" || return 1
  elif [[ -n "$url" ]]; then
    local t=0
    until probe "$c" "$url"; do
      t=$((t + 5)); [[ $t -ge $HEALTH_TIMEOUT_S ]] && { log "$svc health $url not OK after ${HEALTH_TIMEOUT_S}s"; return 1; }
      running "$c" || { log "$svc exited while waiting for health"; return 1; }
      sleep 5
    done
  fi
  sleep "$SETTLE_S"
  local restarts; restarts=$(docker inspect -f '{{.RestartCount}}' "$c")
  running "$c" && [[ "$restarts" == 0 ]] || { log "$svc running=$(docker inspect -f '{{.State.Running}}' "$c") restarts=$restarts"; return 1; }
  local logs; logs=$(docker logs --since "$(docker inspect -f '{{.State.StartedAt}}' "$c")" "$c" 2>&1 || true)
  if grep -qE 'ERR_MODULE_NOT_FOUND|does not provide an export' <<<"$logs"; then
    log "$svc logged a module error"; return 1
  fi
  log "$svc healthy on $want${url:+ ($url)}"
}

recreate() {
  local svc=$1
  [[ "$svc" == api ]] && docker compose stop api
  docker compose up -d --no-deps --force-recreate "$svc"
}

# Put every moved service (and the failed one) back on the image it ran before
# this deploy, health-check each, then re-point :latest. Compose recreates from
# :latest, so each service's original id is tagged :latest just for its recreate.
# Runs with errexit OFF and every step error-tolerant: a failing restore step is
# logged and the rollback carries on through every touched service, always
# restores :latest, and ends with each service's final state. Signals are ignored
# while it runs (an interrupted rollback is the state it exists to prevent).
ROLLING_BACK=0
service_state() { # svc → "image=<id> running=<bool> restarts=<n>"
  local c; c=$(container_of "$1")
  docker inspect -f 'image={{.Image}} running={{.State.Running}} restarts={{.RestartCount}}' "$c" 2>/dev/null || echo "no container"
}
rollback() {
  local why=$1 failed=0 svc i
  [[ $ROLLING_BACK == 1 ]] && return 0
  ROLLING_BACK=1
  set +e
  trap 'log "signal ignored: rollback in progress"' INT TERM HUP
  trap - ERR EXIT
  log "ROLLBACK: $why"
  # Reverse rollout order: api (moved last) is restored first, derivations last.
  local reversed=() restored=()
  for ((i = ${#MOVED[@]} - 1; i >= 0; i--)); do reversed+=("${MOVED[$i]}"); done
  # 1. Put every touched service back, without waiting on any health signal.
  for svc in "${reversed[@]}"; do
    local orig=${ORIG[$svc]}
    if [[ -z "$orig" ]]; then
      log "rollback $svc: it had no container before this deploy; stopping it"
      docker compose stop "$svc" || { log "rollback $svc: stop failed"; failed=1; }
      continue
    fi
    log "rollback $svc → $orig"
    if ! docker tag "$orig" "$IMAGE"; then log "rollback $svc: cannot tag $orig as :latest — manual attention needed"; failed=1; continue; fi
    if ! recreate "$svc"; then log "rollback $svc: recreate failed — manual attention needed"; failed=1; continue; fi
    restored+=("$svc")
  done
  restore_latest || { log "restoring :latest FAILED — manual attention needed"; failed=1; }
  # 2. Then health-check them, in the same order (derivations' full cycle last).
  for svc in "${restored[@]}"; do
    if check_service "$svc" "${ORIG[$svc]}"; then log "rollback $svc healthy"; else log "rollback $svc NOT healthy — manual attention needed"; failed=1; fi
  done
  for svc in "${ORDER[@]}"; do log "final state $svc: $(service_state "$svc") (before deploy: ${ORIG[$svc]:-<no container>})"; done
  [[ $failed == 0 ]] && log "rollback complete: every touched service back on its original image" || log "rollback INCOMPLETE"
  log "FAIL: $why"
  exit 1
}

# ── 3. build ─────────────────────────────────────────────────────────────────
# Interim traps, until the rollout installs its own: the build re-points :latest
# at an image nothing has tested yet, so ANY non-zero exit or interrupt before a
# service moves puts :latest back (an interrupt exits non-zero, so the EXIT trap
# is the one restore path).
trap 'log "interrupted before any service moved"; exit 130' INT TERM HUP
trap 'rc=$?; if [[ $rc -ne 0 ]]; then restore_latest || log "restoring :latest FAILED — manual attention needed"; fi' EXIT
log "docker compose build api"
docker compose build api || { log "FAIL: build failed"; exit 1; }
NEW_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE")
docker tag "$NEW_ID" "$IMAGE:$REV_TAG"
log "new image $NEW_ID (tagged $IMAGE:$REV_TAG)"

# ── 4. smoke ─────────────────────────────────────────────────────────────────
# Link and evaluate each entrypoint in an isolated container. Linking (the phase
# ERR_MODULE_NOT_FOUND and missing named exports fail in) completes before any
# module code runs; past it the process either keeps running, or the
# entrypoint's own start() calls process.exit because ClickHouse is unreachable.
# Both count as linked. A rejected import() or an uncaught throw is a failure.
SMOKE_JS='
const realExit = process.exit.bind(process);
process.exit = (code) => { console.log("SMOKE_EXIT_CALLED", code); realExit(0); };
process.on("uncaughtException", (e) => { console.log("SMOKE_FAIL uncaught", e && (e.code || e.name), e && e.message); realExit(3); });
setTimeout(() => { console.log("SMOKE_ALIVE"); realExit(0); }, 10000);
import(process.env.SMOKE_ENTRY).then(
  () => console.log("SMOKE_EVALUATED"),
  (e) => { console.log("SMOKE_FAIL import", e && (e.code || e.name), e && e.message); realExit(2); });
'
for entry in "${ENTRYPOINTS[@]}"; do
  out=$(timeout 60 docker run --rm --network none -e SMOKE_ENTRY="/app/$entry" \
        --entrypoint node "$NEW_ID" --import tsx -e "$SMOKE_JS" 2>&1) && rc=0 || rc=$?
  if [[ $rc -ne 0 ]] || grep -q 'SMOKE_FAIL\|ERR_MODULE_NOT_FOUND' <<<"$out" \
     || ! grep -q 'SMOKE_ALIVE\|SMOKE_EVALUATED\|SMOKE_EXIT_CALLED' <<<"$out"; then
    grep -E 'SMOKE_|ERR_|Error' <<<"$out" | head -20 || true
    log "FAIL: smoke import of $entry failed in $NEW_ID (rc=$rc); nothing was recreated"; exit 1
  fi
  log "smoke ok: $entry ($(grep -oE 'SMOKE_(ALIVE|EVALUATED|EXIT_CALLED)' <<<"$out" | head -1))"
done

# ── 5. schema apply + validate (new image, live ClickHouse) ──────────────────
log "schema-bootstrap --apply (+ validate) on $NEW_ID"
SCHEMA_LOG=$(docker compose run --rm --no-deps -T schema-bootstrap 2>&1) && rc=0 || rc=$?
grep -E 'upgrading|backfilling|applied|valid|INVALID|failed' <<<"$SCHEMA_LOG" | tail -30 || true
if [[ $rc -ne 0 ]]; then
  log "FAIL: schema apply/validate failed (rc=$rc); nothing was recreated"; exit 1
fi

# ── 6. rollout ───────────────────────────────────────────────────────────────
# From here services move: an interrupt, or any command failing outside the
# explicit `|| rollback` checks (errexit), rolls back instead of leaving a
# half-moved fleet. Cleared once the rollout has fully succeeded.
trap 'rollback "interrupted"' INT TERM HUP
trap 'rc=$?; [[ $rc -ne 0 ]] && rollback "unexpected exit (rc=$rc) during rollout"' EXIT
for svc in "${ORDER[@]}"; do
  log "recreating $svc"
  docker tag "$NEW_ID" "$IMAGE"
  MOVED+=("$svc")
  recreate "$svc" || rollback "$svc failed to recreate"
  check_service "$svc" "$NEW_ID" || rollback "$svc failed its checks on $NEW_ID"
done

# ── 8. PAIR_PRICE_SOURCE on the running services ─────────────────────────────
for svc in api api-public; do
  got=$(docker exec "$(container_of "$svc")" printenv PAIR_PRICE_SOURCE || true)
  [[ "$got" == "$PPS_API" ]] || rollback "$svc runs PAIR_PRICE_SOURCE=$got, compose resolved $PPS_API"
done
log "PAIR_PRICE_SOURCE=$PPS_API on api and api-public"

# Success: the image that was live before is :previous, :latest is the new one.
if [[ -n "$PREV_ID" && "$PREV_ID" != "$NEW_ID" ]]; then
  if docker tag "$PREV_ID" "$IMAGE:previous"; then log "$IMAGE:previous = $PREV_ID"
  else log "WARN: could not tag $PREV_ID as $IMAGE:previous — the rollback target is NOT recorded; tag it by hand"; fi
fi
docker tag "$NEW_ID" "$IMAGE"
trap - INT TERM HUP EXIT
log "done: all api-family services on $NEW_ID ($IMAGE:$REV_TAG)"
