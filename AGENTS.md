# Repository guide

Hydration Neckwork indexes Hydration into ClickHouse and serves the Explorer and Preis through a Fastify API. `src/` owns price/raw ingestion and maintenance jobs, `clickhouse/schema/` owns storage, `api/` owns read models, `explorer-ui/` owns the explorer, and `preis-ui/` owns price charts.

## Working rules

- Prefer correctness and explicit incompleteness over plausible fallback data. Verify protocol assumptions against indexed rows, runtime metadata, or pinned chain state.
- Explorer request paths read ClickHouse, caches, or bounded background snapshots. Do not add per-request chain enumeration or RPC fan-out.
- Preserve replay safety. Raw ranges can be inserted again, so choose stable deduplication keys and explicitly deduplicate replayable `ReplacingMergeTree` inputs before aggregation. Do not build additive materialized views that double-count replays.
- Keep on-chain amounts as integer/raw-unit values until presentation. Use integer arithmetic for 128/256-bit values; do not route financial calculations through JavaScript or ClickHouse floating point when precision matters.
- Value historical flows at event-time prices; value current balances and positions at current prices. Shared asset-history charts use the longest available timeframe.
- Do not wipe ClickHouse, reset checkpoints, run broad historical backfills, or manually manage supervisor-owned workers unless the task explicitly requires it. Prefer bounded repairs that leave live ingestion healthy.
- Existing deployments matter. Schema changes must be idempotent and safe for both fresh databases and upgrades; destructive migrations need an explicit offline procedure and validation.
- Keep API response changes additive and backward-compatible unless a versioned break is explicitly planned.
- Inject credentials through environment variables; never commit tokens, keys, or populated environment files.
- Notifications evaluate only FORWARD, from a persisted cursor anchored on the live pipeline head (`raw_ingestion_state` where `pipeline_id = 'raw-live'`). Rows at or below that cursor never fire, so backfills, repair INSERTs, MV rebuilds and re-derivations — which all write below it by construction — are silent. This is the one place a forward high-water cursor is correct rather than wrong (contrast **Schema and derivations**); no code may widen the window past the clamp or fire from a backfill pipeline id.
- Each trigger kind keeps its OWN cursor (`cursor:<kind>`). A kind reading a shared cached snapshot rather than a block window advances only to the newest block that snapshot actually contained: anchoring it on the head would step the cursor over everything the cache had not revealed yet, which silences the lane entirely. The blind spot below the cursor is unchanged, so backfill immunity holds either way.
- Edge-triggered CURRENT-VALUE alerts (price, health factor, a money-market reserve's headroom under its cap) are the one sanctioned exception to window anchoring: they fire on a crossing of the value as it stands now, not on an indexed row, so there is no window to anchor and a repair that moves a current value is indistinguishable from the value moving. Persisted armed/hysteresis state per rule bounds how often one can refire. Every other source must be anchored on the live-head cursor.
- A new trigger kind must be finality-safe (never `finalized === false` or `mempool === true`, never a raw window above the live head) and must carry a deterministic dedup identity, so re-evaluating the same window delivers nothing twice.
- A lane advances its cursor only as far as its SOURCE has demonstrably reached, never to the ingestion head it anchored the window on. The two differ: the feed keys and builds on its own head (`indexedRawHead` — all pipelines, a 1.5s cache, an SSE-published floor) and ClickHouse orders nothing between the insert that moves `raw_ingestion_state` and the inserts carrying a block's rows, so a window can name blocks the page provably could not contain. Clamp with `windowCoveredTo` against a watermark that advances on EVERY block (`max(block_height)` over `raw_events`, not a source-specific max, which is only "the newest block that happened to hold one of these" and would strand the cursor through a quiet stretch).
- A lane's source read must never be served from a cache whose key omits the live head. The cursor only moves forward, so a page that is stale by even one block is not a late render — it is a permanent silent loss of every row the lane stepped over, with no error, no log line and an advancing cursor. When a lane bounds its fetch (dates, block ranges, any filter that changes the cache key's shape), re-check that the key still turns over per block; adding a bound is exactly how a lane gets moved onto a constant tag by accident.
- Notification channels, rules and inbox rows live in `user_*` tables — the backup-list obligation in **Schema and derivations** applies — and channel configs and rule params are private user data: never log, export, or surface a push endpoint/key, a Telegram chat id, or a rule's parameters.
- Every notification message renders through the shared renderer (`api/src/notifications/render.ts`), which reproduces `AddrPill`'s account notation and the rough number scale. Do not format an account, an amount, or a link ad hoc at a trigger site.
- The `user_*` tables are the only private data in the database; everything else is public chain data. A deployment may expose a read-only ClickHouse endpoint to people outside the project, so treat them as never-exportable: no new read path, role, view, export, fixture, or log line may surface their contents. `user_sessions` holds session token hashes, so `system.query_log` is privileged too.

## Performance engineering

### Measure and prove

- Reproduce performance through the real UI with Playwright in a fresh browser context on desktop and 390px mobile. Exercise the actual route, tab, filter, sort, and pagination controls; a direct API request alone does not prove page performance or usability.
- Record cold and warm behavior separately. A browser cache-buster does not necessarily bypass an API cache whose key ignores unrelated query parameters, so confirm the cache key or restart only the affected service before claiming a cold result.
- Correlate one bounded test window across the browser waterfall, Fastify request/response logs, and `system.query_log`. Report browser completion/TTFB, API response time, and ClickHouse query duration, rows/bytes read, and peak memory. Repeat suspicious measurements without unrelated concurrent work before attributing a regression.
- Prove the slow query with representative production shapes, including selective value/token filters, rare matches, multi-source activity classification, and later pages. Inspect data distribution and query plans; do not infer the cause from table size or wall time alone.
- Treat cache hits as a latency optimization, not a query fix. Make the uncached path bounded and efficient first, then cache stable shared results with deliberate cardinality and freshness.

### Query and read-model design

- Large raw event, EVM-log, balance, position, and price tables are ingestion sources, not request-time indexes. When a proven page shape repeatedly scans them, build the smallest projection whose `ORDER BY` starts with the request's selective dimensions (for example account-first, asset-first, reserve-first, or time-first).
- Store the decoded fields and exact integer values the response needs. Avoid reparsing JSON, broad joins, global `FINAL`, or float conversion on hot paths. Use `FINAL` only where replacement deduplication is required and the primary-key predicate keeps it bounded.
- Prefer stable event/observation/leg identities in `ReplacingMergeTree` projections. For aggregate projections, use mergeable states whose result is idempotent under replay. Never feed replayable rows into an additive sum/count materialized view without first establishing unique replacement semantics.
- Define every table and materialized view in `clickhouse/schema/` — the single declarative schema, applied to an empty database before ingestion. Create the destination table before its MV and use a stable replacement key. Do not add completion-marker or backfill tables; there are no migrations or backfills (see **Schema and derivations**).
- Prefer an MV so a model populates automatically as raw is indexed, in any order. For a per-entity stateful model an MV cannot express, prefer bounded request-time reconstruction from account-first MV-fed tables (a pure domain function over the entity's own rows, with page-scoped enrichment via primary-key lookups) or an in-memory or persisted snapshot on the existing coordinated refresher when TS-side computation (for example address derivation) is unavoidable. Reach for a continuous recompute job (the `derivations` service) only for global, heavy models none of the above can express; avoid adding new scheduled batch recompute jobs. Make jobs idempotent: partition-incremental where the computation is order-independent, bounded full-replace (staging table + `EXCHANGE TABLES`) for stateful reconstructions — a forward high-water cursor is wrong while backward backfill fills lower blocks.
- Do not gate read paths on backfill or readiness. Under schema-first a model is correct-by-construction — it reflects exactly the raw indexed so far — so there is no coverage gate and no divergent raw-scan fallback to maintain.
- Validate a new model against raw before relying on it: rebuild it on a scratch database and compare stable identities, boundary blocks/timestamps, and counts or integer sums, plus several real responses. A matching total row count alone is insufficient.
- For custody, receipt-token, wrapper, and folded-asset views, write and verify an integer conservation equation before routing traffic: direct holdings plus custody must equal displayed beneficial claims plus any explicitly unattributed custody remainder. Replace attributed custody—never add it—and never hide a holder-anchor gap by proportionally scaling known owners.
- Match price compaction to semantics. Historical flows use the latest price known at the event, and bucketed histories use only candles fully closed by the bucket boundary—never a future or current price. Current holdings use current prices.
- Do not gain speed by limiting before exact filters, valuation, classification, or de-duplication. If sources are fetched independently, each source needs a proven saturation/cutoff rule; otherwise rare matches and older pages can disappear.
- Design pagination and caching together. Candidate caches may reuse an exact source prefix, but pages must remain deterministic over the full filtered ordering. Verify at least consecutive pages and a cold later page for the expected row count, stable identities, no overlap, and no gaps at the boundaries.
- A cache key may drop the live head only for a window that can no longer gain rows — an upper bound whose day has already ended. A dated window that reaches today is a LIVE window wearing a historical key: it keeps growing, so it must stay head-keyed however long its TTL is (`datedWindowIsClosed` / `liveFeedTag` / `liveHeadTag`). Treating "has a date filter" as "is historical" is the trap, and it is invisible in tests that only assert a cold read. Two justified exceptions, both bounded by a short lifetime rather than by the key: the explorer's WHOLE-RANGE LP and money-market histories and the all-time claimed LP rewards beside them (`cachedSwr`, fresh 60 s, then served stale while one rebuild replaces them — their last point is the head's), and the Data API's bucketed history windows, which end at the last ENDED bucket (`resolveBucketHistoryWindow`), so their key advances by itself as buckets end. Bucketed history windows then share ONE finality rule (`bucketWindowIsClosed` / `BUCKET_HISTORY_FINALITY_SEC` in `services/lpHistory.ts`): 600 s once the indexed head is an hour past the window's end, 60 s before — on the Data API's history routes and on the explorer's chart-zoom value, LP and money-market windows alike (`windowedHistoryTtlMs`, which dates the end block from above by the chain clock, so a window closes late, never early).
- Data-skipping indexes help only when their predicate is selective and expressed in a form ClickHouse can use. Adding an index is metadata-only for new parts; materializing it across old parts is a broad mutation and requires separate justification rather than being hidden in startup.

### Schema and derivations

The database is a rebuildable projection of the chain; there are no migrations. Two layers:

- **Declarative schema** — `clickhouse/schema/*.sql` is the single source of truth for every table and MV. It is regenerated from a known-good database (`SHOW CREATE`), then applied in numeric order and idempotently by the `schema-bootstrap` service to an empty database before ingestion. Add or change a model by editing these files; never define schema in application code.
- **Derivations** — three mechanisms, in order of preference:
  1. **Materialized views** for anything expressible row-wise; they populate automatically from raw in any insertion order (live-forward and backward backfill alike), so a model's completeness tracks raw's completeness for free.
  2. **Bounded request-time reconstruction, or an in-memory or persisted snapshot on the existing coordinated refresher**, for per-entity stateful models an MV cannot express. Prefer a pure domain function over the entity's own rows in account-first MV-fed tables, with page-scoped enrichment via primary-key lookups. Reach for a small in-memory or persisted snapshot on the existing coordinated refresher only when TS-side computation is unavoidable (for example deriving a multisig address via `createKeyMulti`), or for current-state directory values neither an MV nor request-time reconstruction compute (account-directory Omnipool claims, money-market account values).
  3. **A swept per-entity model** when the value is neither row-wise (no MV) nor affordable per request, and its definition lives in application code rather than SQL. Entities are recounted continuously on the existing coordinated refresher — one at a time, ordered by staleness and by an ingest-time watermark — into a keyed table the read path `LEFT JOIN`s. `account_activity_totals` is the case: an activity total IS the feed's classification, so it is produced by calling the same scoped-total function the detail page calls, and at ~0.76s per account the directory's 114k rows can be neither counted per request nor restated in SQL. Its obligations are in **Swept models** below.
  4. **The `derivations` service** (`api/src/derivations/`) ONLY for global, heavy models none of the above can express — avoid adding new scheduled batch recompute jobs. `account_trade_volume` and `pool_swap_hourly` are partition-incremental — they recompute only the month-partitions whose raw changed, detected by an ingest-time watermark (`max(raw.ingested_at) > max(derived.computed_at)`), which is subset-safe and correct under backward backfill. `pool_swap_hourly` is also the case where an MV is impossible rather than merely awkward: its source is a `ReplacingMergeTree`, so the legs must be deduplicated BEFORE they are summed, and an insert-trigger MV cannot do a cross-row deduplication. Readers of a partition-incremental model take the closed part from it and the tail from raw, so a lagging partition costs time rather than rows — but raw backfilled BELOW the reader's cut under-reports until the next cycle, which is a freshness bound to state, not to hide. The LP reconstructions (`omnipool_position_owner_intervals`, `xyk_farm_principal_intervals`, `xyk_lp_total_shares_history`) do a bounded full recompute with atomic replace (staging table + `EXCHANGE TABLES`), because a forward cursor is wrong while backfill fills lower blocks and shifted keys would otherwise leave stale rows. The registered set is the `JOBS` array in `api/src/derivations/runner.ts` — today nine: the five named above plus `uniswap_v3_legs`, `revenue_events`, `account_revenue` and `xcm_arrivals`. They run in array order, which is load-bearing where a job reads another's output (`account_revenue` strictly after `revenue_events`). `account_trade_volume` and `revenue_events` carry the `needsAssets` registry guard — they bake valuation into their rows, so they are skipped for a cycle whose registry refresh failed rather than run on bad inputs.

**Swept models.** A swept per-entity model earns its keep only under all of these:
- **It calls the surface's own function.** The stored value must come from the same code path the entity's detail page calls, never a SQL re-statement of it. A directory that computes a number a second way will disagree with the page it links to, which is the symmetry rule under **Explorer semantics**.
- **Never approximate a classified value with a cheap proxy.** Measured on the activity feed: raw event references over-count by 11–15×, unsuppressed transfer candidates by 32×, and the ratio is not stable across accounts, because the feed's number is dominated by what its classification REMOVES. A "close enough" estimate of a classified quantity is a wrong number, not a cheap one.
- **The read path renders without it.** An entity not yet swept shows no value — never a zero standing in for one, and never a gate on the page.
- **Replacement is per entity**, so recounting is idempotent and a partial sweep is always a valid state.
- **An ingest-time watermark re-queues an entity whose raw changed**, so backward backfill corrects a stored value instead of leaving it wrong until its TTL expires (the same guard `account_trade_volume` uses, applied per entity rather than per partition).
- **The rate is sized against the entity count and the freshness window, and that arithmetic is pinned by a test** — otherwise the sweep silently stops covering its own set.

Keep in mind for new models:
- Prefer an MV; for per-entity stateful needs an MV cannot express, prefer bounded request-time reconstruction or an in-memory or persisted snapshot on the existing coordinated refresher; reach for a swept per-entity model only when the value's definition lives in application code and cannot be afforded per request; add a new `derivations` job only for genuinely global, heavy models none of the above can express, and avoid new scheduled batch recompute jobs.
- Every derived table must be reproducible from raw — no derived-only state.
- Exception: CHAIN STATE read at pinned blocks and CURRENT-STATE refresher snapshots are not reproducible from indexed raw, because their source is storage no event restates. Chain state: `atoken_scaled_anchor` and `mm_incentive_anchor` (the chain's own values at one anchor block B0) and `raw_lm_farm_entries` (entry storage at every entry-creating block) — rebuilt by the anchors loop (`atoken-anchor`) when empty and raw ingestion covers their source logs below B0 (the money market's from `MM_LOGS_FROM`, the controller's from `CONTROLLER_LOGS_FROM`; `--force` never skips that gate), or by the raw indexer and its repair pass. Both B0 anchors are also TOPPED UP every cycle (`anchorKeysToRead`; `incentiveKeysToRead`, whose grain is the user — a user with any row was read whole): a candidate any source names that has no row is read at B0. The aToken anchor's candidate sources reach beyond the money market's own logs — whose coverage before B0 is partial — to the collateral sweep, every decoded pool event and the Substrate legs of the registry assets over the aTokens, because a holder who received before B0 inside a log gap and never moved is named by nothing else (measured: 79 holders, the whole of each contract's total-minus-holders gap); the post-B0 deltas themselves are complete, Substrate-dispatched moves included (conservation held to the wei for every live contract at block 15,047,000). The incentive anchor's reach the aToken anchor and the Substrate legs of the registry assets over the programme aTokens (measured at B0: 155 users the controller's and aTokens' logs never named, 18 with a non-zero anchor state, several an unclaimed accrual — and a user no source names is no candidate of the `mm-incentives` refresher either, so its claimable went unpublished). Refresher snapshots: `lm_reward_snapshots`, `mm_incentive_snapshots` and the money-market account-value snapshot (`money_market_account_value_snapshots`) — a generation read at one block, republished by its refresher every cycle, so an empty table refills within one cadence.
- Exception: `user_*` tables (`clickhouse/schema/004_user.sql`) are user-authored source-of-record, written only by the api service — they are NOT reproducible from raw, are excluded from every drop-and-refill/projection rebuild, and are exported nightly by the user-backup service.
- Adding a `user_*` table means declaring it in `clickhouse/schema/004_user.sql` **and** adding it to `TABLES=` in `ops/backup-user-tables.sh` — the two lists must agree, or the table is silently never backed up despite being unreproducible. Where a deployment exposes the read-only ClickHouse endpoint, its host-side grant script (outside this repo) derives the reader's revokes from `004_user.sql` and must be re-run so the new table is unreadable; it also aborts if the two lists have diverged.
- A new or evolved MV table gets its history on an existing deployment through a one-time ad-hoc `INSERT … SELECT` from raw mirroring the MV's exact `SELECT`/`WHERE` (replay-safe through the table's replacement key), run during rollout and not committed — no migration or backfill scripts live in the repo, and a fresh database is complete from the declaration alone.
- That backfill — and every ad-hoc scan over raw history, **a read-only dry run included** — runs against the same ClickHouse the live deployment serves from, so it must be bounded BEFORE it is run: a `PREWHERE` on partition/sort-key columns, explicit `max_memory_usage` and `max_threads`, and block-range chunks (100k blocks is a proven size). Unbounded, a full-history pass over `raw_extrinsics`/`raw_events` reaches ~84 GiB RSS; the next container to allocate then trips the kernel's global OOM killer, which takes ClickHouse — and with it every service on the box — down. Writing nothing does not make a query safe. The same work bounded stays near 3 GiB.
- Recompute jobs must be idempotent and correct under out-of-order raw (partition-diff or atomic full-replace — never a forward high-water cursor).
- Evolving a model means editing the declaration and rebuilding the projection (drop and let it refill, or reset the derived layer) — never a version-numbered migration or an in-place data patch.
- Keep raw ingestion and derivation as separate concerns.

### Verify and deploy

- Add focused tests for durable invariants: replay/deduplication, integer arithmetic, event-time valuation, classification parity, filter completeness, and pagination boundaries.
- Rebuild and recreate only touched Compose services, normally with `docker compose build <services>` followed by `docker compose up -d --no-deps <services>`. Do not recreate ClickHouse or supervisor-owned ingestion as an incidental dependency update.
- After deployment, let MVs catch up as raw is indexed and the `derivations` service compute the non-MV models, then repeat the same cache-controlled Playwright/API profile against the live stack. Check affected service logs, ClickHouse health, raw ingestion progress, the derivations service, and the supervisor before declaring success.
- Once the new path is verified, remove superseded views, tables, caches, feature flags, fallback code, and migrations when safe. Do not leave two divergent implementations or unused ClickHouse data behind.
- Report before/after measurements with the exact route and parameters, cache state, viewport, API status/time, material ClickHouse reads, coverage/parity evidence, checks run, services rebuilt, and any remaining bottleneck with a safe implementation path.

## Explorer semantics

- Render the user's highest-level economic action and suppress internal plumbing legs. Classification must remain symmetric across global, block, extrinsic, account, asset, and tag activity surfaces.
- A dispatch that ran ON BEHALF of another account — `Proxy.proxy`/`proxy_announced` (its innermost `real`), `Multisig.as_multi` (the multisig) — is that account's activity, never the signatory's: ONE rule, `services/onBehalfActors.ts`, applied per rendered row by the block/extrinsic/global feeds (`actorsFor`) and at key time by the account-first swap projection (`db/accountSwapQueue.ts`, `account_swap_activity.account`), so the account page, its totals, the directory, a tag's feed and the public scoped trades name the proxied account and the signatory's page carries none of it. The signatory stays in `signer` as the extrinsic's own fact (it paid the fee) and is never rendered as `who`. EVM and permit dispatches are not on-behalf: their `effective_signer` IS the actor.
- Every activity needs a stable event identity and canonical URL. DCA activity links represent schedules; an individual execution is addressable via its execution event (`/dca/<block>-e<eventIndex>`) from the schedule page and from the block/extrinsic pages, whose DCA rows link to executions (a scheduling extrinsic shows only its schedule's first execution). OTC cancellation is called **Pull** in product copy. Always write **HOLLAR** in uppercase.
- The Omnipool hub asset (registry id 1) is called **H2O** everywhere — UI copy, API field descriptions, docs, comments. Never write LRNA (its legacy name) except when quoting an on-chain identifier that literally spells it.
- A pool account's holding of its OWN hub asset — the Omnipool pallet account's H2O, and nothing else (`POOL_OWN_HUB_HOLDINGS` / `isPoolOwnHubHolding` / `poolOwnHubHoldingSql` in `services/valuation.ts`; only the Omnipool has a hub asset) — is a balance and never a value. H2O is priced off the assets the pool holds (TVL ÷ hub reserve), so the reserve valued at that price restates the pooled assets the same figure already counts: the account read as twice its TVL. It is shown wherever balances are (`AddressBalance.uncounted` names the amount and the reason; the row's `valueUsd` covers the counted rest, 0 for a whole-row exclusion — priced, left out, never null) and counted nowhere: the account and tag values and their ex-HDX twins, `topAssets`, the value chart (`getAccountHistory` keeps it out of every bucket, so the live-pinned last point agrees), the accounts directory (`poolOwnHubHoldingSql` in `grouped`; a value-definition change bumps `accountDirectoryModelVersion`), the hover cards, the MCP (inherits, and names the amount), public `/v1/accounts/balances` (out of `transferableUsd`, `lockedUsd`, `totalUsd`) and the Data API's `/balances` totals (the item stays priced and is flagged `uncounted`). Everyone else's H2O — an LP position's hub leg, the treasury's, a wallet's — is a claim on the pool and counts as usual, and the asset page's holder list is a per-asset view that keeps the pool as H2O's largest holder.
- Activity is the sole domain and API term; do not restore Stream names, routes, or compatibility aliases.
- Display and copy user addresses as canonical SS58 or H160 forms, never raw AccountId public-key hex. Preserve real identity/tag context across local and cross-chain account pills.
- The money markets are isolated from each other — the primary market, GIGAHDX and BIL today, and the rule is per market rather than a closed list. Never blend their health factors. Primary-market directory/DefiSim figures stay primary-only; supplemental collateral backing must not be counted twice; tag risk uses the lowest real member health factor, and an account's risk is the lowest real health factor among the markets it is in, named with the market it came from.
- Avoid request-time shortcuts that silently omit older history. Pagination, filtering, totals, and chart windows must operate on the full requested dataset.
- Multi-asset activity filters must match every referenced asset, including nested pool assets and both sides of a pair. A token filter names an asset's DISPLAY face (`assetIdsForToken` / `idsDisplayedAs` in `explorerAssets.ts`, the one resolver for every feed, the MCP `token` pass-through and a notification rule's asset): a product-named Hydrated pool's name or wrapper id (`GDOT`, 69 — what the token picker sends, since shares stay out of the directory) matches the rows of the share displayed under it (2-Pool-GDOT 690); the share's own symbol or id names the share alone, and an id is only ever the whole token (`2-Pool-GDOT` is never asset 2).
- Keep unresolved XCM origins and destinations explicit; enrichment runs asynchronously and must not delay explorer requests.
- Default tags and structural accounts must be reproducible and idempotent from a clean database. Vesting uses relay-chain height; conviction and GIGAHDX timing use parachain height.
- Unclaimed liquidity-mining rewards are the CLAIMABLE-NOW amount (what one `claim_rewards` pays: loyalty-adjusted, less what the entry claimed — never the full-loyalty maximum; claiming early forfeits nothing, only withdrawing does). They come from the `lm-rewards` refresher (`services/lmRewardService.ts` → `lm_reward_snapshots`, read through `services/lmRewardSnapshot.ts`): every LM deposit and farm read at one finalized block, active farms brought to that block by one DryRunApi claim per farm whose own `RewardClaimed` must equal our arithmetic, else that farm publishes unprojected. They count in ACCOUNT value everywhere at once, always PRICED (an unpriced entry is in no sum and is counted aloud): `portfolioUsd` on the account and tag pages and their hover cards (`unclaimedRewardValue`; HDX-denominated rewards leave `portfolioExHdxUsd`), the value chart (`getAccountHistory` folds the reward history into both curves), the directory's value and ranking (`lm_acct` in `accountsPage`, per remapped account, joined into `grouped`; same generation and staleness gate via `currentLmRewardGenerationSql`) and the public `/v1/accounts/balances` (`farmRewardsUsd`, in `totalUsd`). They are never inside a POSITION's value: `farmRewards` on the page, `unclaimedRewards` on farmed LP rows and on the Data API's `/liquidity/positions` stay beside `valueUsd`. A reward is not a balance until claimed and a claim moves exactly what it pays into the wallet, so nothing counts twice: every read brings the snapshot forward over the indexed events after its block (`withPostSnapshotEvents` / `lmCountedRewardRowsSql`) — a `RewardClaimed` since is subtracted from its entry, floored at zero, and an entry withdrawn (or a deposit destroyed) since reads 0 — and adds nothing (accrual since waits for the next generation). A claim below the reward asset's existential deposit (AssetRegistry's) reaches the owner only while the owner's free balance of that asset is at least the deposit; otherwise the pallet sends it to the treasury (`claim_rewards` fails `ZeroClaimedRewards`, a withdraw pays it away). The refresher reads each such owner's balance at the snapshot block through the runtime's `CurrenciesApi.free_balance` (the pallet's own `Currencies::free_balance`, so HDX, Tokens and ERC-20 registry assets read one way) and stores the entry's `below_ed` as 2 — `payable: false`: its amount stays visible, it counts 0 everywhere (`lmCountedClaimable`) and is named aloud. A payable sub-ED entry (`below_ed` 1) counts in full. A stale (> 15 min) or missing snapshot drops them from every current figure together, never one surface alone. A tag build is cached and persisted reward-free; `withUnclaimedRewardsInValue` adds them per request, exactly once.
- Reward HISTORY (`services/lmRewardHistory.ts`, re-exported by `lpHistory.ts`) is the SETTLED claimable at each bucket end: each yield farm as of its last on-chain sync at or before the end (`lm_yield_farm_events`; periods are relay blocks from `block_relay_height`, the PREVIOUS block's for a sync in the Initialization phase, which a scheduled call runs before ParachainSystem sets the block's validation data), an entry's constants from `raw_lm_farm_entries`, and claimed = the latest capture's `claimed_raw` plus `RewardClaimed` after it (`lm_deposit_farm_events`). An entry's stake is storage-only, so `raw_lm_farm_entries` is RAW chain state captured by the raw indexer itself (`src/raw/lmFarmEntries.ts`, in every raw pipeline — raw-live and the backfill workers alike) at the end of every entry-creating block, decoded with the runtime that EXECUTED that block — its parent's code, subsquid's `header._runtime`: `blocks.spec_version` (`header.specVersion`) is the post-state's and differs at an upgrade block, and `_runtimeOfPrevBlock` is wrong on the block after one. A failed read is the money-market position reads' rule: no row for that deposit (never a `gone_at_block_end`), a `raw_parser_warnings` row (parser `raw_lm_farm_entries`), and the block still commits. A warning is OPEN while its (pallet, deposit, block) has no `raw_lm_farm_entries` row — that anti-join (`OPEN_LM_ENTRY_WARNINGS_SQL`, `src/scripts/lmEntryPorts.ts`) is the whole open/repaired distinction; the warning row is never rewritten, and the repair's row landing closes it. The anchors loop (`atoken-anchor`, an archive `RPC_URL`) repairs every cycle: each block with an open warning, plus each block the full check finds with an entry target and no row, is re-read with `captureRange` (`reconcileLmEntries`), and its `lm_entries_reconcile` log line carries `open_before`/`open_after`; a block that still cannot be read (pruned state, a layout the decoder refuses) stays open and is retried. `src/scripts/snapshot-lm-entries.ts` is the manual verify/repair tool (`--open` lists the open set). It rides beside the principal on both LP-history surfaces (`unclaimedRewards`/`unclaimedRewardsUsd`), never in `legs`/`valueUsd`, and it IS in the value chart's `portfolioSeries` (folded in, not published apart). History is SETTLED while the chart's live-pinned last point (`portfolioUsd`) is PROJECTED to the snapshot block, so the final step also carries each active farm's accrual since its last sync; an entry it cannot state is counted (`rewardsIncomplete`), never zero.
- Unclaimed money-market (lending) incentives are the Aave RewardsController's own CLAIMABLE-NOW figure: `getAllUserRewards(every programme aToken, holder)` at one pinned block (the indexed head), read by the `mm-incentives` refresher (`services/mmIncentiveService.ts` → `mm_incentive_snapshots`, read through `services/mmIncentiveSnapshot.ts`, same 15-min staleness gate). Beside it the refresher reconciles the log arithmetic — `mm_incentive_anchor` (the chain's `getUserAccruedRewards`/`getUserAssetIndex`/programme index at B0, captured by the anchors loop — `src/scripts/snapshot-atoken-anchors.ts --loop`, the `atoken-anchor` service, which also keeps `atoken_scaled_anchor` — whole once its table is empty and raw ingestion covers the controller's logs, then topped up every cycle with every key of each candidate user without a row; manual modes `src/scripts/snapshot-mm-incentive-anchors.ts`) plus every `Accrued` less every `RewardsClaimed` (`mm_incentive_accruals`/`_claims`, decoded in SQL from the controller's undecoded `raw_evm_logs`), plus scaled balance × (programme index − holder index) / 10^decimals per aToken — and publishes `reconciled`; the published amount is always the chain's. They count in account value by the farm-reward rules and through the SAME helpers (`unclaimedRewardValue`/`withUnclaimedRewardsInValue`/`getUnclaimedRewards`, applied once; tag builds stay reward-free): `portfolioUsd` and ex-HDX, the directory (`mmr_acct` joined into `grouped`, keyed like `mm_grouped` on the actor's ETH-form holder id, `currentMmIncentiveGenerationSql`), the value chart (`chartMmIncentiveSeries`), public `moneyMarketRewardsUsd` (in `totalUsd`, null when stale), the Data API (`/money-market/positions` `unclaimedRewards`/`totals.unclaimedRewardsUsd`/`rewardsAsOfBlock`). They are never inside a market's collateral or a reserve's USD. Every read subtracts the `RewardsClaimed` indexed after the snapshot block per (holder, reward), floored at zero (`withPostSnapshotClaims` / `mmCountedIncentiveRowsSql`), the farm-reward rule. An amount `0 < claimable < ED` of the reward asset is flagged `belowExistentialDeposit` (a `claimAllRewards` including it reverts until the account holds that deposit — owed, not paid away) and still counted. A reward whose programmes span several isolated markets is owed per market: beside its '' pair total the snapshot stores one `market:<key>` row per market with the chain's `getAllUserRewards` over that market's aTokens alone, and readers list it once per market; the history files each pending part under its aToken's market and the stored accrual (one figure per holder and reward — `RewardsClaimed` names no aToken) under the pair's primary market (`mmPrimaryMarket`). HISTORY (`services/mmIncentiveHistory.ts`, re-exported by `moneyMarketHistory.ts`) is SETTLED: the stored accrual at each bucket end plus pending up to each programme's last stored index (`mm_incentive_index_updates`: every `Accrued` and `AssetConfigUpdated`) at or before it, from B0 on; a (holder, reward) the NEWEST generation does not reconcile, whatever its age — or one the arithmetic cannot state — is counted in `rewardsIncomplete` for the whole series, never valued; a programme with no stored index yet has index 0 (the controller's own default), not an unknown one. Whose incentives: every surface stating them for an account or tag (page, tag, value chart, money-market history) takes the holder set from ONE helper, `moneyMarketIdentities` in explorerService, so the chart's live-pinned last point and its interior sum the same holders.
- A stableswap share token's CURRENT price is what one share redeems for: its pro-rata slice of every reserve in the newest `raw_block_snapshots` row (the proportional withdraw, `stableswapShareLegs`; peg multipliers shape only the curve and are not applied) valued at the surface's own current leg prices, in integers — ONE definition, `lpMath.stableswapSharePrices`/`withStableswapSharePrices`, which puts the figure under the share's own id in each current price map (the explorer's `ensurePrices`, public `currentPrices`, Data API `freshPriceMap`; pool state from `services/stableswapSharePools.ts`, or `data/services/poolSnapshot.ts` in the data tree). It REPLACES any feed the share has, and a share with an unpriced leg, no issuance, no pool in the snapshot, or a snapshot older than 1 h (the XYK pool-state bound; `SHARE_POOL_MAX_AGE_SECONDS` in `lpMath.ts`, which every surface imports; a failed pool-state read serves the last good one only inside that bound) is unpriced — never valued at its underlying. So wallets, supplied money-market collateral, the directory, tags, public `transferableUsd`, Data API balances and the Data API's `/v1/assets` prices (dated by the snapshot) value a share one way. Every current lookup is ONE helper, `currentPriceOf(map, id)` in `explorerAssets.ts`: the asset's own entry first, else the entry of `currentPriceAssetId(id)`, which stops the alias walk at a share — so an aToken with a feed of its own (GDOT over 2-Pool-GDOT) values at that feed, and one without values through the share; never restate `map.get(id) ?? map.get(currentPriceAssetId(id))` by hand; `priceAssetId` keeps the full walk and `SHARE_TOKEN_UNDERLYING_ID` stays the proxy for HISTORICAL (candle) valuation only, since a share has no redeemable-value history — so a chart's last closed bucket and the current value differ by the share's gap to its underlying. The money market's own collateral base (its oracle) is untouched. `SHARE_TOKEN_UNDERLYING_ID` still decides DISPLAY (`displayAssetId`): a folded share row shows the share count under the main asset's symbol, valued at the share's price.
- A yield-bearing token's OWN yield (vDOT, wstETH, jitoSOL, sUSDe, sUSDS, apyUSD, PRIME — the `token-yield` component of `/explorer/yields`, which the Liquidity APRs and the Borrow tab's supply APY and Net APY build on) is the CURRENT APY the Hydration UI shows, from the same sources and rule: DeFiLlama's latest `apyBase` (else `apy`), Kamino's latest hourly APY for PRIME (`services/externalTokenApy.ts`, ids mirrored from the app). It is read by a background refresher into memory — never from a request path — and an entry older than an hour is dropped. A token without a fresh external figure falls back to its on-chain rate: the growth of its stableswap peg multiplier (its redemption rate) over up to 180 days (`tokenAccrualAprs`; a 30-day window reads zero between the irregular bursts some rates move in). A peg is read as a rate only when it behaved like one: a redemption rate only accrues, so a peg that ended below where it started or gave back more than `TOKEN_YIELD_MAX_GIVE_BACK` (1 %; the oracle's own noise on a real rate measured at most 0.16 %) from its running high at any sample is a PRICE relayed through the peg — EUR/USD on 2-Pool-HEURC's aEURC leg, which gave back 4 % — and that leg accrues nothing: left out, never a negative yield or an FX drift. Every component names its source (`defillama` / `kamino` / `on-chain`), and the UI says it.
- A stableswap share that is itself a money-market reserve — the Hydration app's "Hydrated" pools (HUSDT over 2-Pool-HUSDT, GDOT over 2-Pool-GDOT, a3-Pool over 3-Pool), whose add-liquidity flow supplies the share and hands the holder the aToken — is paired with its wrapper from the reserve map at registry load (`SHARE_WRAPPER` / `shareWrapperOf` in `explorerAssets.ts`, a fact recorded whichever way the price alias runs). A wallet-held share row (`stableswapLpPositions`) carries it as `LpPosition.wrapper`, and the Liquidity tab then states the pool the way the app does: named by the wrapper exactly when the share already displays as it (`named`, the `SHARE_TOKEN_UNDERLYING_ID` fold, so HUSDT and GDOT but still 3-Pool), and rated as the wrapper earns — `/explorer/yields` `moneyMarket[market][aToken].supply`, the pool's fee and legs plus the reserve's supply APY and its incentives (PRIME) — while the position itself keeps the pool's own yield (`stableswap[pool]`), because unwrapped shares earn the fee and legs only; the hover says so. The wrapped holding proper is money-market collateral and stays on the Borrow tab, rated the same way.
- ONE display-name rule for pool shares (`displayDescriptor` / `SHARE_DISPLAY_FACE` in `explorerAssets.ts`): a stableswap share whose money-market wrapper is a NAMED PRODUCT — the wrapper's registry symbol is not the aToken default `a` + the share's symbol, so HUSDT over 2-Pool-HUSDT and GDOT over 2-Pool-GDOT but not a3-Pool over 3-Pool or a2-Pool-PRIME over 2-Pool-PRIME — shows under the wrapper's symbol and artwork on every reader-facing explorer surface, keeping its own id, decimals and amounts, with its on-chain name kept in `name` (an asset or pool page states "GDOT" and "2-Pool-GDOT" together). Derived at registry load from the reserve map, so a Hydrated pool opened tomorrow is named with no code change; `shareWrapperOf(...).named` is this rule. The explorer's AssetRef builder (`asset()` in explorerService) and every explorer-only renderer (pool, Hollar, ICE, OTC order, LP-claim, yield, notification and SEO builders) read `displayDescriptor`, so the Borrow tab, the Liquidity tab, balances, hover cards, activity rows (a money-market supply, an add-liquidity, a trade routed through the share) and the MCP renderer all say GDOT; the money-market HISTORY files a share reserve under the id the current row folds to (`foldShareHistoryReserves`, the twin of `foldShareReserves`), so the Borrow tab matches history to the current reserve on one key. `assetDescriptor` stays the registry's own name: the public and Data APIs (frozen contracts) and the surfaces that name a registry asset's OWN controls (circuit-breaker limits, reserve caps) keep 2-Pool-GDOT. Logic never keys on a symbol — a share is `isStableswapShareToken(id)`, a fold is `displayAssetId(id)` — and the fold (`SHARE_TOKEN_UNDERLYING_ID`, also the historical price proxy) stays hand-kept: the face names, it never merges or prices.

## Public API

The `api-public` service (`api/src/public/`, same image as `api`, own process behind the
`api-public-nginx` micro-cache) serves the official Hydration UI and external data feeds. It is a
**versioned frozen contract**, unlike the explorer/preis routes:

- Changes within `/v1` are additive-only; renaming, retyping, or removing a field or route
  requires a `/v2`. The data-lake-compatible surfaces (`/rest/service/metadata`, `/proxy/*`) are
  pinned to what the Hydration UI's provider-selection and proxy clients expect.
- Every public route declares zod request/response schemas (published via OpenAPI at
  `/openapi.json` and `/docs`) and an explicit entry in `api/src/public/cacheControl.ts`, anchored
  to the exact registered path so a neighbouring future route cannot inherit its TTL — unmatched
  routes deliberately ship `no-store`. The one exception is `/proxy/*`, which has no entry on
  purpose: those responses are cached in-process per upstream and must stay out of any shared
  cache, so they take the `no-store` default.
- `api/src/public/**` may import only the allow-list pinned by
  `api/tests/public/isolation.test.ts` — that test is the enforced contract, and this
  sentence must follow it: today `db/client`, `config`, `types`, the
  `cache`/`explorerAssets`/`ohlcvService`/`crossPair`/`poolService`/`volumeService`/`valuation`/
  `revenueStreams`/`moneyMarketCaps`/`foreignCandles`/`uniswapV3History`/`uniswapV3Positions`/`intentLimitPrice`/
  `lmRewardSnapshot`/`mmIncentiveSnapshot`/`lpMath`/`stableswapSharePools`/`poolVolumes`/`farmApr`/`poolYield`/
  `isoTimestamp` services, and the
  api package manifest (`../package.json`, for the version string
  `/rest/service/metadata` publishes). Never `explorerService`. The one sanctioned transitive coupling —
  `initPoolService` wiring an explorerService client when none is set — is documented at the
  guard in `poolService.ts`; keep it non-clobbering.
- Numeric semantics (single-side netted volume, fee/protocol-fee split, APR/APY definitions,
  window anchoring) are normative in the Swagger descriptions, including the documented
  deviations from the Hydration Data Lake. A deviation is deliberate: do not "fix" one
  without restating in the description why it exists.
- The public read models live in `clickhouse/schema/006_public.sql` (`pool_swap_legs` with its
  `op_key` routed-trade key, `farm_config_events`, `otc_order_events`, and the `pool_swap_hourly`
  pre-aggregate that keeps the pool/stats reads and the DefiLlama backfill off a full leg scan).
  External-feed facades
  (CoinGecko/DefiLlama) reuse `pool_swap_legs`, which covers the FULL era: the modern
  `Broadcast.Swapped*` MV plus four legacy per-pallet MVs (< 6,837,788, back to block 1,708,104).
  The legacy omnipool buy-fee side flips at the runtime upgrade at block 4,221,778 (fee on the IN
  asset before, OUT asset after) — the MV and its tests pin this; see the spec's legacy-era note.

## Data API

The `api-data` service (`api/src/data/`, same image as `api`, own process on port 3003,
host hydration-data.neckwork.net) serves external developers a token-authenticated,
per-account rate-limited REST surface over the public explorer dataset. Like the public
API it is a **versioned frozen contract**; concept: `~/.g/hydraken-api-concept.md`.

- Changes within `/v1` are additive-only; renaming, retyping, or removing a field or
  route requires a `/v2`. The full route set is pinned by
  `api/tests/data/openapi.test.ts` (EXPECTED_PATHS) — extending the surface means
  extending that list in the same change.
- Every route declares zod request/response schemas, carries its normative semantics in
  its OpenAPI `description` (the Scalar portal at `/docs` is the single documentation
  source), and has an explicit entry in `api/src/data/cacheControl.ts` — authenticated
  responses are `private, max-age=N`, unmatched routes ship `no-store`, and there is
  deliberately NO nginx micro-cache in front (URI-keyed shared caching is unsafe for
  authenticated responses, and per-account metering must see every request). In-process
  caches use `data:`-prefixed keys; live feeds key on the indexed head via
  `services/head.ts`.
- A few surfaces answer without a token (`AUTH_EXEMPT` in `data/app.ts` is the list):
  `/v1/status`, `/openapi.json`, `/docs`, `/llms.txt`, `/favicon.ico`, and the crawler files
  `/robots.txt` and `/sitemap.xml` that let `/docs/` be indexed. Those two MUST answer 200
  without a token: a 4xx on robots.txt means "no rules, crawl everything" to Google, so the
  Disallow protecting the keyed routes would simply not exist — and a 429 or 5xx there means
  the opposite, halting crawling of the whole host for 12 hours and degrading it for up to 30
  days, so robots.txt must never be rate-limited. Robots allows only exempt paths, which
  `api/tests/data/indexing.test.ts` pins. `/llms.txt` is RENDERED from the OpenAPI document
  (`data/services/llmsTxt.ts`) — a compact orientation for automated clients, never a
  hand-written second copy of the route list, so a new route appears in it the moment it
  registers. Keep it a map: framing text and per-route summaries only, no parameters or
  response schemas (`api/tests/data/llmsTxt.test.ts` pins completeness and the size budget).
- `api/src/data/**` may import only the allow-list pinned by
  `api/tests/data/isolation.test.ts` — that test is the enforced contract, and this
  sentence must follow it: today `db/client`, `config`, `types`, and the
  `cache`/`explorerAssets`/`ohlcvService`/`valuation`/`lpMath`/`liquidityLegs`/`lpHistory`/`bucketLadder`/`blockClock`/
  `uniswapV3Positions`/`uniswapV3Ranges`/`intentLimitPrice`/`lmRewardSnapshot`/`moneyMarketHistory`/`aaveMath`/`mmIncentiveSnapshot`
  services. Never `explorerService`, never
  `userAuthService`, never `public/**`; nothing outside `src/data/` imports from it.
  Address parsing/rendering is self-contained in `data/services/address.ts`. Pure domain
  arithmetic both surfaces need (the LP position math) lives in a leaf module under
  `services/` that `explorerService` re-exports — never restated in the data tree.
- LP history (`/v1/accounts/{address}/liquidity/history`, and the explorer's
  `/explorer/address/:a/liquidity-history` on the value chart's time grid) is one definition,
  `services/lpHistory.ts`: per bucket, the legs redeeming each position the account
  economically held at the bucket END would return, at the pool state sampled at or before
  that end (the 600-block state-history grid — up to 600 blocks old, never later), valued at
  the candle fully CLOSED by the end (≤30 days carry), integer USD rendered once. Never
  back-filled from a later price and never zero for a missing one: an unpriced leg nulls its
  position, which leaves the bucket total and is counted in `unpriced`. So the last point is
  NOT the current value (`/liquidity/positions`: per-block snapshot, current prices). Bucket
  ends are dated by `heightAtOrBeforeExact`; the value chart keeps `heightAtOrBefore`, which on
  an hour mark resolves to the END of the hour starting there (up to an hour late) — changing
  that moves every existing chart, so it is a separate decision. Weeks are Monday-anchored
  (`MONDAY_ANCHOR_SEC`), matching `/balances/history`. A bucket has ENDED when the INDEXED head
  (not the wall clock) has passed its end — a lagging indexer never publishes an open bucket.
  A window counts as closed (plain 600 s TTL) only once the head is a finality margin (1 h)
  past its end, which covers late candle rows and a derivations cycle; before that it is
  window-keyed with the route's 60 s TTL. Both caches key on the window, never the head.
- Money-market history (`/v1/accounts/{address}/money-market/history`, and the explorer's
  `/explorer/address/:a/money-market-history` on the value chart's grid) is one definition,
  `services/moneyMarketHistory.ts`, on the LP history's window, grid, pricing and cache rules
  (the window machinery is `bucketHistoryWindow`/`resolveBucketHistoryWindow`, one code path).
  A reserve point is EXACT at the bucket-end block: what the aToken's / variable-debt token's
  `balanceOf` returned there — the scaled principal (`atoken_scaled_anchor` at B0, the chain's
  own `scaledBalanceOf`, plus every indexed delta) times the reserve's last emitted index
  compounded to that block's timestamp by `services/aaveMath.ts`. The index accrued to the
  timestamp its ReserveDataUpdated EXECUTED under — the PARENT block's for one in the
  Initialization phase (a scheduled or DCA call), about half of all updates — its EVM.Log
  event's phase read per selected update from `raw_events` by primary key (the MV's source has no
  extrinsic column); an unresolved one leaves its reserve unstated and counted, never guessed. Buckets ending before B0 (`reserveHistoryFrom`) carry no
  reserve figures: null, never zero. Health factors and the base-currency aggregates are the
  chain's getUserAccountData AS OBSERVED at its own block at or before the end, per isolated
  market, never recomputed, interpolated or blended — an account with several EVM identities (the explorer's
  related set) sums every identity's legs and incentives but takes each market's observation from ONE identity,
  its primary H160 wherever it has one there (`chooseObservationHolders`); the account line sums priced legs ACROSS
  markets and carries no health factor. Unclaimed lending incentives ride beside the legs
  (`unclaimedRewards` per market point, `unclaimedRewardsUsd`/`rewardsIncomplete` per account
  point), SETTLED as in **Explorer semantics**, never inside `suppliedUsd`. CURRENT amounts (`/money-market/positions`, `/balances`,
  the explorer card) stay on the settled index, one current definition — so history's last point
  exceeds them by the interest since each reserve's last update. The market set and
  `stakingBacked` are declared once in `explorerAssets.ts` (`MM_MARKETS`).
- CURRENT pool state is the newest `raw_block_snapshots` row (`data/services/poolSnapshot.ts`,
  one point read per block, exact at the head); the 600-block state-history tables serve
  history only. Current prices are `asset_price_latest` (009); historical flows are priced
  through `data/services/eventTimePrices.ts` (closed hourly candle ≤30 days before the row).
- Auth/limits invariants (`data/services/auth.ts`): tokens are `hdd_` + 64 hex, stored
  as sha256 in `user_api_tokens`, resolved per request through a 30 s positive / 10 s
  negative in-process cache — no boot-time load, so mint/revoke on the explorer takes
  effect within seconds without restarts. All tokens of one account share the account's
  fixed per-minute and per-UTC-day windows (env defaults
  `DATA_API_DEFAULT_PER_MINUTE`/`_PER_DAY`, per-account overrides in
  `user_api_limits`); `ADMIN_ACCOUNT_IDS` accounts are exempt from enforcement but
  still metered. Usage flushes to `user_api_usage` by REPLACING the (account, hour) row
  with a running total seeded from storage after a restart — never an additive insert.
  The throttled `last_used_at` refresh must stay an INSERT…SELECT of the CURRENT row
  gated on `deleted = 0`, or it could resurrect a revoked token.
- The control plane lives on the explorer api (`api/src/routes/apiTokens.ts` +
  `services/userApiTokenService.ts`): token CRUD under `/user/api-tokens`
  (session-gated) and the admin surface under `/user/admin/*` (allowlist-gated,
  404-invisible to non-admins). `api-data` only ever reads
  `user_api_tokens`/`user_api_limits` and writes `user_api_usage`.
- Its read models live in `clickhouse/schema/009_data.sql` (hash-first, account-first,
  asset-first and contract-first projections). The by-account twins CHAIN off their
  MV-fed sources (`pool_swap_legs`, `dca_events`, `intent_orders`, `staking_activity`,
  `liquidity_activity`, `governance_vote_calls`) so extraction logic exists once;
  replay safety rides the source's replacement identity. Selective filters the sort key
  cannot prune (`call=`, `name=`) require a bounded window
  (`requireBoundedWindow`) rather than a wider timeout.
- Feed mechanics live once, in `data/services/feed.ts` (window quartet, `(block, index)`
  keyset cursor, replay dedup, `versionedPageSql`) and `data/schemas/common.ts`
  (`requireCursor`/`requirePositionCursor`/`feedPage`); a new feed composes them rather
  than restating them. A page over a key-prefixed table orders by the sort key ONLY and
  applies the `ingested_at` version tie-break outside the bounded read
  (`versionedPageSql`): appending it inside the `ORDER BY` defeats read-in-order and
  turns the page into a whole-prefix scan (measured 5–20× the rows). Mixed ASC/DESC
  over the key columns does the same.
- Never alias a SELECT expression to the name of a column it reads when the statement
  references that name again (`toString(x) AS x … WHERE x < …`, `argMax(b, b) AS b,
  argMax(a, b)`): ClickHouse resolves the later reference to the alias. The data test
  fake client runs every query through `tests/data/sqlGuard.ts`, so this fails the
  route's own test; HAVING is the one clause where targeting the alias is intended.
- One wire shape per entity: an entity reached through two routes (a vote under an
  account and under its referendum, a staking event globally and per account, an OTC
  event in an order's history and in an account's fills, a fee leg on a fill and on a
  netted trade) is the same zod object, declared once in a `routes/*Shared.ts` module.
  Every event row is `eventName`, every call `callName`; accounts on the wire are always
  `zAccountRef`, never raw hex. Caches over closed-hour/closed-day sources (`stats`, the
  600-block pool-state grid, the reserve-index fold) key on the window and a plain TTL,
  not the live head — a head key on a source that moves once an hour never hits.

## MCP server

The `api-mcp` service (`api/src/mcp/`, same image as `api`, own process on port 3004, host
hydration-mcp.neckwork.net) serves LLM agents a Model Context Protocol surface over the
*interpreted* explorer dataset.

- It is a **presentation layer, not a read model**. It owns no tables, no materialized views and
  no SQL: every answer comes from an HTTP call to the explorer `api` on the compose network, so a
  number here is by construction the number the Explorer page shows. That is what keeps the
  classification symmetry of **Explorer semantics** true across a third surface. Adding a query
  here instead of reusing an explorer route is the one change this service must never take
  (so `get_account_history` kind `liquidity` reads `/explorer/address/:a/liquidity-history`,
  the explorer's own LP-history route, and kind `money-market` reads
  `/explorer/address/:a/money-market-history`, rather than anything of their own).
- `api/src/mcp/**` may import **nothing** outside its own tree — not `db/client`, not `config.ts`,
  not `explorerService`, not `public/**` or `data/**`. `api/tests/mcp/isolation.test.ts` is the
  enforced contract and this sentence must follow it; the allow-list is deliberately empty.
  `api/tests/mcp/upstreamPaths.test.ts` pins the other half: every upstream path must start with
  `/explorer/`, `/candles`, `/assets`, `/market-stats` or `/health`, and `/user/` anywhere is a
  test failure. Together they are the structural guarantee that the private `user_*` data of
  **Schema and derivations** cannot reach an agent — the routes that read it are unreachable from
  this tree, rather than merely unused by it.
- The transport is Streamable HTTP, **stateless**: a fresh `McpServer` and transport per request,
  closed in `finally`, so no session state accumulates. `POST /mcp` carries every JSON-RPC
  message; `GET`/`DELETE` answer 405 because there is no stream to resume. Fastify has already
  parsed the body, so it must be passed to `transport.handleRequest` explicitly or the transport
  hangs on a consumed stream.
- A tool reply carries **one** text block and no `structuredContent`: a client that forwards both
  doubles every answer's token cost. `format: "json"` on every tool is how a caller asks for the
  structured record instead.
- Interpretation is the product. Amounts are scaled by the row's own `AssetRef.decimals` and
  carry their symbol and USD value, accounts render as identity/tag/SS58 (never raw
  AccountId32 hex), rows arrive classified by the explorer's own feed, and every record carries
  its canonical Explorer URL. The renderers live once in `api/src/mcp/format/` and reproduce the
  shared rough number scale of **UI** — they are a deliberate third parallel to
  `explorer-ui`'s `F`/`compactAmount` and `notifications/render.ts`, so a change to the scale
  belongs in all three.
- A tool's `description` is its interface, not its documentation: it is the only thing a model
  reads before choosing and calling it, so it must carry the parameter semantics and the traps
  (the activity `type` family behaviour, the isolated money markets, the unconfirmed rows). The
  registry test pins that every tool has one, carries the shared `format` parameter instance, and
  appears in `/llms.txt`.
- Load discipline: agent traffic must never out-compete the live UI on the shared explorer `api`.
  The upstream client bounds in-flight requests, de-duplicates concurrent identical reads, and
  caches responses per URL; the edge adds its own per-IP zones. Heavy explorer routes are called
  in their cheap form (`summary=1` on a tag is 56 KB against 1.5 MB) and every list is trimmed
  before rendering rather than after.

## UI

- Reuse existing components, formatting conventions, tokens, and interaction patterns before adding variants.
- Rounded display numbers use the shared rough scale (`compactAmount` / `F.amount` / `F.usd` in `explorer-ui/src/components/ui.tsx`): ~3 significant digits with k/M/B compaction — 500 · 537 · 4.87k · 40k · 112k · 4.59M. Values below 1 keep ~3 significant decimals ($0.12), and very small fractions use the subscript-zero notation (0.0₅7191) so high-decimal assets stay readable. Use `F.exact` only on surfaces that exist to show precision (tooltips, copyable detail values). Never hand-roll number compaction.
- Verify desktop and 390px mobile layouts, including horizontal overflow, long addresses, tables, dialogs, and charts. Respect `prefers-reduced-motion`.
- Mock data must be deterministic and preserve the same row identity across feeds, blocks, and detail pages.
- Keep nested controls usable inside clickable rows and preserve canonical navigation, keyboard behavior, and address-only copy actions.

## Checks

Run the smallest relevant checks while iterating, then the package check for every touched workspace:

```bash
npm run check
npm --prefix api run check
npm --prefix explorer-ui run check
npm --prefix preis-ui run check
npm run check:all
```

Playwright is separate: `npm --prefix explorer-ui run test:e2e` and `npm --prefix preis-ui run test:e2e`. Runtime claims require rebuilding the affected Compose service and checking the real API/UI; otherwise state that only static/unit checks ran.

## Hygiene

- Preserve unrelated working-tree changes.
- Comments and docs describe current behavior and rationale, not implementation history or a work session.
- Do not commit task plans, design specs, brainstorms, runbooks, agent reports, screenshots, generated logs/results, ad hoc probes, or one-account repair scripts. `docs/superpowers/` and `.superpowers/` are gitignored and stay that way — never un-ignore a path under them, never add a `!` exception, and never cite one of those documents from a tracked file. A document the repo cannot ship cannot be normative: if a rule, a semantic or a design decision matters to someone reading the code, write it into AGENTS.md or into the comment next to the code it governs, where a fresh clone can actually read it.
- Add focused regression coverage for durable behavior, not fixtures coupled to one transient production example.
- Keep shared domain logic centralized; avoid near-duplicate helpers or divergent activity builders.

## Commits

- Use Conventional Commits, matching the existing history: `type(scope): subject`, with the subject in lowercase imperative and no trailing period. Types: `feat`, `fix`, `refactor`, `perf`, `style`, `chore`, `docs`. Common scopes: `explorer`, `api`, `ui`, `prices`, `indexer`, `raw`, `preis`, `schema`, `compose`. Keep each commit focused on a single change.
- Never add co-author trailers or tool/assistant attribution (`Co-Authored-By`, "Generated with", and the like) to commit messages or PR descriptions. This holds unconditionally, including when a commit was AI-assisted — the commit author is the only attribution.
