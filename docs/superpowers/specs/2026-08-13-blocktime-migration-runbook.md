# Migration-day runbook — Hydration 6s → 2s block time

**Status:** prepared 2026-08-13, chain still at 6s. Nothing here is applied yet.
**Sources:** `.superpowers/sdd/2026-08-12-public-rest-api/blocktime-throughput-report.md` (measured capacity, 2026-08-13) plus the block-time preparation lanes BT-1…BT-4 in this repo.
**Scope:** what an operator does on the day the 2s runtime goes live. Code changes that adapt on their own are listed only so nobody re-does them by hand.

---

## 0. BEFORE the migration — the one blocking item

### DISK RUNWAY on `/mnt/data` — plan this weeks ahead, not on the day

This is the binding constraint for the whole programme, and it is not a neckwork constraint: it is co-tenancy.

| Consumer on `/mnt/data` (3.5 TB, 95% used, **183 GiB free**) | Size | Growth at 6s | Growth at 2s |
|---|---|---|---|
| `node-full` — Hydration **archive** node (`--state-pruning archive --blocks-pruning archive`) | **1.924 TB** | ~1.19 GB/day (lifetime average) | ~2.4–3.6 GB/day |
| `hydration-neckwork-clickhouse-data` | ~156 GiB | 0.321 GiB/day | ~0.96 GiB/day |
| `efi-ch-dev_clickhouse-dev-data` | 117.7 GB | — | — |
| `node-relay`, `node2`, `node-ah2` | 23.1 GB + | — | — |

**Combined burn goes from ~1.5 GB/day to ~3.5–4.5 GB/day: roughly 120 days of runway becomes ~45–55 days.**

Caveat on that estimate, from the throughput report: the archive node's 1.19 GB/day is a **lifetime average** (1.924 TB / 1,615 days) and the current rate is already above it, so 45–55 days is the optimistic end. The 2–3x multiplier is a structural argument (per-block header/justification/state-commit components triple; per-extrinsic components stay flat at constant activity), not a measurement.

**Ops must decide before the cutover:** add capacity, relocate `node-full` or the 117.7 GB `efi-ch-dev` volume, or prune one of the two hydra-dx nodes. Do not rely on the levers in §2 — ClickHouse is the minor tenant, and even zeroing its growth entirely leaves the archive node's burn.

### Also before the cutover (engineering, not config)

- **Fees-chart 1Y/ALL and the DefiLlama backfill** already sit at ClickHouse's 4 GB memory cap and the 100k `max_result_rows` cap. At 3x rows these **fail rather than slow** (measured p95 7,713 ms → ~23 s against `max_execution_time: 20`). Report's recommendation: a pre-aggregated hourly fee-leg MV instead of a `pool_swap_legs FINAL` scan, plus re-chunking the backfill below the calendar-month boundary. Not covered by BT-1…BT-4.

---

## 1. Constants that must be RE-PINNED, with expected values

One manual pin remains, plus one self-correcting value with an env override. (BT-1's fix round
landed `api/src/services/runtimeConstants.ts`: the api reads `aura.slotDuration` and
`gigaHdx.cooldownPeriod` from runtime metadata at startup via the resident node connection, so
those two self-correct on the post-upgrade restart. Only the circuit-breaker fuse period is
genuinely unpublished and needs a hand flip.)

| What | Env var | Today | Set to | Verify against the new runtime | Source |
|---|---|---|---|---|---|
| Circuit-breaker deposit-fuse period (`pallet_circuit_breaker::Config::Period = DAYS`) | `SECURITY_FUSE_PERIOD_BLOCKS` | 14_400 | **43_200** | **Genuinely not readable.** BT-1 confirmed against the live runtime that `api.consts.circuitBreaker` publishes only `defaultMaxNetTradeVolumeLimitPerBlock` `[5000,10000]`, `defaultMaxAddLiquidityLimitPerBlock` `[500,10000]`, `defaultMaxRemoveLiquidityLimitPerBlock` `[500,10000]` — no `Period`, no `DAYS`. Derive it as `86_400_000 / MILLISECS_PER_BLOCK` and confirm `aura.slotDuration = 2000` on the new runtime | `api/src/services/securityService.ts` (the boxed MIGRATION-DAY ACTION comment above `DEFAULT_FUSE_PERIOD_BLOCKS`) |
| GIGAHDX unstake cooldown (`gigaHdx.cooldownPeriod`) | `GIGA_UNBONDING_BLOCKS` (override only — normally unset) | metadata (403_200 today) | **self-corrects** on the post-upgrade api restart | **IS** in metadata: `gigaUnbondingBlocks()` resolves env → metadata → pin. Leave the env UNSET so the metadata read stays authoritative — setting it permanently masks the self-correction. Set it only if the node connection is down or reads a wrong value | `api/src/services/lockBreakdownService.ts` (`gigaUnbondingBlocks()`), `api/src/services/runtimeConstants.ts` |

Both have self-detecting tripwires, so a missed flip is loud rather than silent:

- `securityService.checkFusePeriodPin()` runs on every 60s security-state refresh (not just boot), prefers the metadata slot duration, and warns at most hourly with three distinct outcomes: silent (pin matches), `FUSE PERIOD PIN UNVERIFIED` (could not measure — e.g. ClickHouse/node still warming), or `FUSE PERIOD PIN IS STALE: … Period = DAYS is now 43200 blocks, not the pinned 14400`. **Check the api log after the first post-migration restart — and note UNVERIFIED means "check again", never "fine".**
- Until the fuse pin moves, every fuse whose period started more than 14,400 blocks ago reads `expired` while still active, and its used/headroom figures read as a fresh period.
- A stale `GIGA_UNBONDING_BLOCKS` misdates every FUTURE unstake (hdxService `pendingUnstakes` expiry, the conditional 28-day GIGAHDX step in the binding timeline). Already-pending unstakes are absolute block numbers and stay correct.

Names and values above are BT-1's own, reconciled against `.superpowers/sdd/2026-08-12-public-rest-api/task-bt1-report.md` and the code it landed.

**Metadata facts, current state** (`aura.slotDuration` reads `6000` today and is the authoritative `MILLISECS_PER_BLOCK`; `gigaHdx.cooldownPeriod` reads `403200`; the circuit-breaker `Period` is absent). The api reads both published values at startup through `runtimeConstants.ts`, so `paraBlockMs` is metadata-authoritative (ladder-snapped measurement is the fallback when the node is unreachable) and the GIGA cooldown self-corrects. The fuse period is the one value that must be hand-flipped.

---

## 2. Env values to flip

| Env var | Today | At 2s | Why / caveat |
|---|---|---|---|
| `RAW_SNAPSHOT_EVERY_N_BLOCKS` (raw-live + raw backfill) | 1 | **3** — *blocked, see below* | Holds `raw_block_snapshots` volume constant across the change: the table is 273 KB/block, 36% of all ClickHouse growth, and the largest in the database. Only divisors of 600 are accepted (the pool-history MV grid); the raw indexer throws at startup otherwise. |
| `RAW_MM_SNAPSHOT_INTERVAL_MINUTES` | 720 (12h) | **no change** | Now chain time (BT-4). The old `RAW_MM_SNAPSHOT_INTERVAL_BLOCKS=7200` would have become 4h at 2s = 3x the eth_call fan-out over ~5,600 borrowers. |
| `RAW_ASSET_SNAPSHOT_INTERVAL_MINUTES` | 100 | **no change** | Same conversion; the old 1,000-block form would have become ~33 min. |
| `RPC_HEAD_POLL_MS` | 750 (BT-4 default; was 2000) | **no change** | 2000 was exactly one poll per block at 2s. Already fixed. |
| `RAW_LIVE_FINALITY_POLL_MS` (`src/raw/indexer.ts`, `liveFinalityPollIntervalMs`) | 4000 | **1500–2000** | Startup-only: how often a resumed raw worker re-checks finality before handing over to the follower. Its comment says "keeps the resume-into-follow handoff under one block" — true at 6s, but 4000 ms is **two blocks** at 2s. Cost is one extra `chain_getFinalizedHead` on a local RPC during startup, so this is nearly free; the ceiling on the miss is the poll interval itself. Left at 4000 by BT-4 because it is not a steady-state cost. |
| `RANGE_SIZE` (supervisor) | 1000 | **no change** | Block-denominated on purpose: 3x ranges/day at 2s, which is supervisor bookkeeping, not ingestion cost. raw-live maps at 5 blocks/s p50 against the 0.5 blocks/s a 2s chain demands. |

### `RAW_SNAPSHOT_EVERY_N_BLOCKS=3` is NOT ready to flip

The lever exists and is validated, but flipping it breaks the price pipeline as the code stands today:

`src/indexer.ts` (main / price) throws **`Missing finalized raw snapshot for historical block <n>`** for any non-live block that has no `raw_block_snapshots` row. Live mode reads state itself, so raw-live and main-live at head are fine — but **every main backfill range over thinned blocks fails**, and a re-derivation of the price layer over that period becomes impossible without re-indexing raw.

Two of the three consumers are already safe:
- the `% 600` pool-history MVs — guaranteed by the startup divisor check;
- `/v1/stats/platform` and `/hydration-web/v1/stats` TVL, which read the single latest snapshot row.

So the prerequisite is a paired change on the main pipeline (interpolate from the nearest retained snapshot, or read state for the gaps), after which `3` is safe. Until then the honest options at 2s are: accept ~345 MiB/day on disk for this table, or take the report's better lever — **store a reference/hash for the 70.2% of blocks whose pool state is unchanged** rather than re-serializing an identical 273 KB payload, which cuts the same volume without creating holes.

### Cache/TTL tightening candidates (optional, cost not correctness)

The D4 audit list was not in the repo when this was written; these were re-derived by inspection and each is a *candidate*, not a required flip. All are already "correct at any block time" — the question is only whether they still buy what they were sized to buy.

| Site | Value | Effect at 2s |
|---|---|---|
| `api/src/services/explorerService.ts` `LIVE_CACHE_MS = 5_000` | ~1 read/block at 6s | ~1 read per 2.5 blocks — feeds go up to 2.5 blocks stale; drop to ~1,500–2,000 ms to restore per-block freshness at 3x the read rate |
| `api/src/public/services/status.ts` `TTL_MS = 3_000` (`grep -n 'TTL_MS' api/src/public/services/status.ts`) | ~half a block | Becomes 1.5 blocks; tighten if the public status endpoint should track the head |
| `public-nginx/nginx.conf` `proxy_cache_valid 200 60s` (both location blocks) | 10 blocks | 30 blocks — fine for the shapes it fronts, revisit only if a public consumer complains about head lag |
| `api/src/routes/explorer.ts` `MAX_LIST_OFFSET = 20_000_000` | covers every block | Covered chain span shrinks 3x; expires within ~2 years |
| `api/src/public/services/dexscreener.ts` `RESERVE_GRID_BLOCKS = 600` / `RESERVE_MAX_STALE_BLOCKS` (`grep -n 'RESERVE_GRID_BLOCKS' …`) | 1h grid / 2h stale bound | Gets *tighter and better* at 2s (20 min / 40 min). No action |

### The two remaining hand-maintained UI constants (BT-2, copy verbatim)

BT-2 swept both UIs so that **no displayed value depends on a hand-maintained block-time constant any more** — the explorer resolves the chain's rate from the stats payload, and the 21 `staleTime` literals it replaced now ride `BLOCK_STALE_MS`. Two timers-only constants survive, and this is BT-2's own runbook line for them:

> **Optional, non-blocking (UI):** two fallback-poll constants still read 6s —
> `NOMINAL_BLOCK_SECONDS` in `explorer-ui/src/utils/dca.ts` and `NOMINAL_BLOCK_MS` in
> `preis-ui/src/hooks/useIndexerStatus.ts`. Neither is displayed: they set the SSE-fallback poll
> interval and query freshness only, so leaving them at 6 000 after the 2s upgrade merely polls a
> little behind the chain while the SSE stream is down. Set both to the 2s equivalents at
> convenience; nothing on screen is wrong until then.

`preis-ui`'s is the harder of the two to remove: preis has no stats payload at all, so it cannot be sourced from the chain without adding a field to `/api/indexer`. Its `STATUS_STALE_MS` is derived (`NOMINAL_BLOCK_MS * 2 / 3`), so moving the one constant moves both correctly.

---

## 3. Things that adapt on their own — do not "fix" these

- **Measured-block-time sites.** `api/src/services/blockTime.ts` resolves the chain's pace from indexed blocks and snaps it to the runtime slot ladder (12s / 6s / **2s**), so anything routed through it re-scales itself at the upgrade. `NOMINAL_RELAY_BLOCK_MS = 6_000` stays 6s — the relay is not migrating, and relay-anchored things (vesting, `LastRelayChainBlockNumber` extrapolation) must never be routed through the parachain pace.
- **Timestamp-bounded windows.** `cutoffHeightForWindow` / `feedWindowBoundSql` resolve cutoffs from `blocks` by timestamp; every `ohlc_*` candle read, `getVolume24h`, the fees bucket grid and the ASOF price joins are time-bucketed and flat.
- **The chain-time snapshot triggers (BT-4).** The money-market re-snapshot and both asset-registry scan intervals read elapsed time off the blocks' own timestamps, so their cadence is fixed through the change — live and during backfill alike (a historical block carries the time it was authored at). Deprecated block-count vars (`RAW_MM_SNAPSHOT_INTERVAL_BLOCKS`, `RAW_ASSET_SNAPSHOT_INTERVAL`, `SNAPSHOT_INTERVAL`) are still honoured, read at 6s per block, with a startup warning naming the replacement. **Remove them from any deployment `.env` at the cutover** — leaving them is not wrong, but the warning is there to be acted on.
- **The `block_height * 12` synthetic partition clock** (`clickhouse/schema/001_tables.sql` above `account_trade_volume`, `swap_source_partition_watermarks_mv` in `003_materialized_views.sql`, `api/src/services/accountTradeVolume.ts` `MS_PER_BLOCK`, `api/src/derivations/jobs.ts`). The 12 is **not** the chain's block time and never was. It maps block heights into evenly spaced pseudo-dates so block-keyed tables have something to partition on. **Do not re-pin it.** Re-keying it would orphan every existing partition under names no reader computes. The only real effect at 2s is that a "month" partition (216,000 blocks) spans ~5 real days instead of ~15, so ~3x more partitions go stale per real day and `account_trade_volume` rebuilds proportionally more often — a cost, not a bug. Ceiling: DateTime ends 2106-02-07 ≈ block 358M ≈ 22 years at 2s.
- **The `% 600` MV grid** — `omnipool_pool_state_history_mv`, `xyk_pool_reserve_history_mv`, `stableswap_pool_state_history_mv` in `clickhouse/schema/003_materialized_views.sql` (`grep -n 'block_height % 600' clickhouse/schema/003_materialized_views.sql`; named rather than cited by line, because that file's line numbers move). Verdict already taken: **grid unchanged**, accept 3x samples (~20 min resolution instead of ~1 h). Uniformity across the whole chain's history is worth more than the constant wall-clock spacing, and the bytes are negligible (55 MiB → ~166 MiB over the chain's life). Changing it would make old and new history sample at different rates.
- **The raw flush policy** (`src/raw/flushPolicy.ts`). Flushes are finality-driven, not block-driven, so cadence stays flat and rows per flush triple. See §4.
- **Wall-clock refreshers** — all immune: `xcmJourneyService` 5 min, api `backgroundRefresh` 60 s, public `cachedSwr` 60/300/900 s, identity-snapshot 1 h, referendum jobs 15/30 min, mm-supplemental 15 min, mm-snapshot / atoken-anchor 6 h, balance-snapshot 24 h, supervisor `POLL_SECONDS` 60 s.

---

## 4. RE-MEASURE after the migration

Everything below was measured at 6s and is *expected* to hold. Confirm, don't assume.

| What | Baseline (6s, 2026-08-13) | Expectation at 2s | How |
|---|---|---|---|
| **Raw flush cadence** — the premise of the whole flush policy | insert gaps p10 4.0 s / **median 8.1 s** / p90 20.1 s / p99 42 s; **2.1 blocks/flush**; ~7,364 new parts/day/table | same gaps, ~6 blocks/flush, part count flat | gaps between consecutive `raw_blocks` INSERTs in `system.query_log`; new parts in `system.part_log` |
| Pessimistic flush case | — | 43,200 flushes/day (5.9x), 454 ms flush in a 2 s window = 23% duty cycle, active parts 40–80 vs `parts_to_delay_insert` 1,000 | same; only a worry if finality cadence itself changed |
| **Fees / volume query family** | avg 2,867 ms, **p95 7,713 ms**; 1Y ≈ 10.3 M legs, ALL ≈ 17 M | ~23 s p95 → **exceeds `max_execution_time: 20`**, i.e. errors | time the real routes; this is the second constraint and should have been re-shaped before the cutover |
| **Disk burn rate** | ClickHouse 0.321 GiB/day; `/mnt/data` combined ~1.5 GB/day | ~0.96 GiB/day; combined 3.5–4.5 GB/day | month partitions in `system.parts`; `df` on `/mnt/data`. **Re-derive the runway within the first week** — the archive-node term is the uncertain one |
| `raw_block_snapshots` growth | 114.9 MiB/day on disk, 3.61 GiB/day uncompressed, 36% of all growth | ~345 MiB/day unless a lever lands | per-table month partitions |
| raw-live headroom | 5 blocks/s p50 mapping, 216 ms insert/block, 3.87% insert duty cycle, 0 errors in 6 h | 0.5 blocks/s required; duty cycle 5.7–23% | container logs + `system.query_log` |
| Money-market periodic snapshot | 3,216 positions from 5,598 borrowers per run, 2 runs/day | **unchanged** (chain-time trigger) — confirm it is still 2/day and not 6. **1/day is EXPECTED, not a fault, on any day raw-live restarted or replayed backwards**: the trigger skips a boundary that lands on a worker's first block, by design, and nothing alerts on a missed MM sample. The visible effect is a flat segment in a portfolio history chart (the previous position value is carried forward) — never a gap and never a zero — so the log line count is the only way to see it. | `[Raw][MM] Periodic snapshot @…` log lines per day |
| `account_trade_volume` rebuild rate | partitions ≈ 15 real days | partitions ≈ 5 real days → ~3x rebuilds/day | derivations service logs |
| Explorer `getStats()` | 45 MiB / 77 ms, cached per ingested block | ~9x total load (3x rows × 3x reads) — still small in absolute terms | `system.query_log` |

---

## 5. Cutover checklist

1. [ ] `/mnt/data` capacity plan executed and verified (§0). **Blocking.**
2. [ ] Fees-chart / DefiLlama backfill re-shaped, or accepted as broken at 1Y/ALL until it is.
3. [ ] Confirm the new runtime's `MILLISECS_PER_BLOCK = 2000` and read `gigaHdx.cooldownPeriod` from metadata.
4. [ ] Set `SECURITY_FUSE_PERIOD_BLOCKS=43200` in the deployment env (the one manual pin). Verify the api log shows the GIGA cooldown being read from metadata (`runtimeConstants`); set `GIGA_UNBONDING_BLOCKS` only if that read fails or returns a wrong value.
5. [ ] Remove deprecated `RAW_MM_SNAPSHOT_INTERVAL_BLOCKS` / `RAW_ASSET_SNAPSHOT_INTERVAL` / `SNAPSHOT_INTERVAL` from the deployment env if present.
6. [ ] Restart the api; **read the startup log** — `fuse period pin` must be silent, not `PIN IS STALE`.
7. [ ] Leave `RAW_SNAPSHOT_EVERY_N_BLOCKS=1` unless the main-pipeline prerequisite in §2 has shipped.
8. [ ] Within 24 h: re-measure flush cadence, disk burn and the MM snapshot rate (§4).
9. [ ] Within a week: re-derive the disk runway from real post-migration growth and re-plan if it is under 90 days.
10. [ ] At convenience, non-blocking: `RAW_LIVE_FINALITY_POLL_MS=2000`, the two UI fallback-poll constants (§2) and the cache/TTL candidates.

---

## 6. Future work — the self-correcting versions of these pins

Not migration-day actions. Each would remove a manual step from the *next* cadence change.

- **The startup metadata read SHIPPED** (BT-1 fix round): `api/src/services/runtimeConstants.ts` reads `aura.slotDuration` and `gigaHdx.cooldownPeriod` through the resident node connection, `paraBlockMs` is metadata-authoritative with the ladder-snapped measurement as fallback, and the GIGA cooldown self-corrects. The remaining future work is only the fuse period: if a later runtime ever publishes `circuitBreaker.Period` (or `DAYS`), read it and delete `SECURITY_FUSE_PERIOD_BLOCKS`.
- **`preis-ui` has no measured-pace payload**, so its `NOMINAL_BLOCK_MS` cannot follow the chain until `/api/indexer` carries a block-rate field. Until then it is the one UI constant that must be moved by hand.
- **`raw_block_snapshots` unchanged-state deduplication** — the lever that makes `RAW_SNAPSHOT_EVERY_N_BLOCKS` unnecessary: 70.2% of blocks reuse the previous pool state and still store a full ~273 KB payload. Storing a reference/hash instead cuts the same ~240 MiB/day at 2s without leaving snapshot holes for the price pipeline (§2).
- **The main pipeline's per-block snapshot requirement** (`src/indexer.ts`) is what blocks the thinning lever. Interpolating from the nearest retained snapshot, or reading state for the gaps, would unblock it.

---

## Restart order

Use the verified sequence (see the `neckwork-safe-restart-order` note): supervisor before main-live, ClickHouse last. Recreating the api needs a `stop` first — port 3001 stays bound and `--force-recreate` otherwise silently leaves the API down. `docker rm -f` on raw-live stops ingestion for good; it does not self-heal the way main-live does.
