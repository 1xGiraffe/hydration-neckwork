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
- Prefer an MV so a model populates automatically as raw is indexed, in any order. For a per-entity stateful model an MV cannot express, prefer bounded request-time reconstruction from account-first MV-fed tables (a pure domain function over the entity's own rows, with page-scoped enrichment via primary-key lookups) or an in-memory snapshot on the existing coordinated refresher when TS-side computation (for example address derivation) is unavoidable. Reach for a continuous recompute job (the `derivations` service) only for global, heavy models none of the above can express; avoid adding new scheduled batch recompute jobs. Make jobs idempotent: partition-incremental where the computation is order-independent, bounded full-replace (staging table + `EXCHANGE TABLES`) for stateful reconstructions — a forward high-water cursor is wrong while backward backfill fills lower blocks.
- Do not gate read paths on backfill or readiness. Under schema-first a model is correct-by-construction — it reflects exactly the raw indexed so far — so there is no coverage gate and no divergent raw-scan fallback to maintain.
- Validate a new model against raw before relying on it: rebuild it on a scratch database and compare stable identities, boundary blocks/timestamps, and counts or integer sums, plus several real responses. A matching total row count alone is insufficient.
- For custody, receipt-token, wrapper, and folded-asset views, write and verify an integer conservation equation before routing traffic: direct holdings plus custody must equal displayed beneficial claims plus any explicitly unattributed custody remainder. Replace attributed custody—never add it—and never hide a holder-anchor gap by proportionally scaling known owners.
- Match price compaction to semantics. Historical flows use the latest price known at the event, and bucketed histories use only candles fully closed by the bucket boundary—never a future or current price. Current holdings use current prices.
- Do not gain speed by limiting before exact filters, valuation, classification, or de-duplication. If sources are fetched independently, each source needs a proven saturation/cutoff rule; otherwise rare matches and older pages can disappear.
- Design pagination and caching together. Candidate caches may reuse an exact source prefix, but pages must remain deterministic over the full filtered ordering. Verify at least consecutive pages and a cold later page for the expected row count, stable identities, no overlap, and no gaps at the boundaries.
- A cache key may drop the live head only for a window that can no longer gain rows — an upper bound whose day has already ended. A dated window that reaches today is a LIVE window wearing a historical key: it keeps growing, so it must stay head-keyed however long its TTL is (`datedWindowIsClosed` / `liveFeedTag` / `liveHeadTag`). Treating "has a date filter" as "is historical" is the trap, and it is invisible in tests that only assert a cold read.
- Data-skipping indexes help only when their predicate is selective and expressed in a form ClickHouse can use. Adding an index is metadata-only for new parts; materializing it across old parts is a broad mutation and requires separate justification rather than being hidden in startup.

### Schema and derivations

The database is a rebuildable projection of the chain; there are no migrations. Two layers:

- **Declarative schema** — `clickhouse/schema/*.sql` is the single source of truth for every table and MV. It is regenerated from a known-good database (`SHOW CREATE`), then applied in numeric order and idempotently by the `schema-bootstrap` service to an empty database before ingestion. Add or change a model by editing these files; never define schema in application code.
- **Derivations** — three mechanisms, in order of preference:
  1. **Materialized views** for anything expressible row-wise; they populate automatically from raw in any insertion order (live-forward and backward backfill alike), so a model's completeness tracks raw's completeness for free.
  2. **Bounded request-time reconstruction, or an in-memory snapshot on the existing coordinated refresher**, for per-entity stateful models an MV cannot express. Prefer a pure domain function over the entity's own rows in account-first MV-fed tables, with page-scoped enrichment via primary-key lookups. Reach for a small in-memory snapshot on the existing coordinated refresher only when TS-side computation is unavoidable (for example deriving a multisig address via `createKeyMulti`), or for current-state directory values neither an MV nor request-time reconstruction compute (account-directory Omnipool claims, money-market account values).
  3. **A swept per-entity model** when the value is neither row-wise (no MV) nor affordable per request, and its definition lives in application code rather than SQL. Entities are recounted continuously on the existing coordinated refresher — one at a time, ordered by staleness and by an ingest-time watermark — into a keyed table the read path `LEFT JOIN`s. `account_activity_totals` is the case: an activity total IS the feed's classification, so it is produced by calling the same scoped-total function the detail page calls, and at ~0.76s per account the directory's 114k rows can be neither counted per request nor restated in SQL. Its obligations are in **Swept models** below.
  4. **The `derivations` service** (`api/src/derivations/`) ONLY for global, heavy models none of the above can express — avoid adding new scheduled batch recompute jobs. `account_trade_volume` and `pool_swap_hourly` are partition-incremental — they recompute only the month-partitions whose raw changed, detected by an ingest-time watermark (`max(raw.ingested_at) > max(derived.computed_at)`), which is subset-safe and correct under backward backfill. `pool_swap_hourly` is also the case where an MV is impossible rather than merely awkward: its source is a `ReplacingMergeTree`, so the legs must be deduplicated BEFORE they are summed, and an insert-trigger MV cannot do a cross-row deduplication. Readers of a partition-incremental model take the closed part from it and the tail from raw, so a lagging partition costs time rather than rows — but raw backfilled BELOW the reader's cut under-reports until the next cycle, which is a freshness bound to state, not to hide. The LP reconstructions (`omnipool_position_owner_intervals`, `xyk_farm_principal_intervals`, `xyk_lp_total_shares_history`) do a bounded full recompute with atomic replace (staging table + `EXCHANGE TABLES`), because a forward cursor is wrong while backfill fills lower blocks and shifted keys would otherwise leave stale rows.

**Swept models.** A swept per-entity model earns its keep only under all of these:
- **It calls the surface's own function.** The stored value must come from the same code path the entity's detail page calls, never a SQL re-statement of it. A directory that computes a number a second way will disagree with the page it links to, which is the symmetry rule under **Explorer semantics**.
- **Never approximate a classified value with a cheap proxy.** Measured on the activity feed: raw event references over-count by 11–15×, unsuppressed transfer candidates by 32×, and the ratio is not stable across accounts, because the feed's number is dominated by what its classification REMOVES. A "close enough" estimate of a classified quantity is a wrong number, not a cheap one.
- **The read path renders without it.** An entity not yet swept shows no value — never a zero standing in for one, and never a gate on the page.
- **Replacement is per entity**, so recounting is idempotent and a partial sweep is always a valid state.
- **An ingest-time watermark re-queues an entity whose raw changed**, so backward backfill corrects a stored value instead of leaving it wrong until its TTL expires (the same guard `account_trade_volume` uses, applied per entity rather than per partition).
- **The rate is sized against the entity count and the freshness window, and that arithmetic is pinned by a test** — otherwise the sweep silently stops covering its own set.

Keep in mind for new models:
- Prefer an MV; for per-entity stateful needs an MV cannot express, prefer bounded request-time reconstruction or an in-memory snapshot on the existing coordinated refresher; reach for a swept per-entity model only when the value's definition lives in application code and cannot be afforded per request; add a new `derivations` job only for genuinely global, heavy models none of the above can express, and avoid new scheduled batch recompute jobs.
- Every derived table must be reproducible from raw — no derived-only state.
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
- Every activity needs a stable event identity and canonical URL. DCA activity links represent schedules; an individual execution is addressable via its execution event (`/dca/<block>-e<eventIndex>`) from the schedule page and from the block/extrinsic pages, whose DCA rows link to executions (a scheduling extrinsic shows only its schedule's first execution). OTC cancellation is called **Pull** in product copy. Always write **HOLLAR** in uppercase.
- The Omnipool hub asset (registry id 1) is called **H2O** everywhere — UI copy, API field descriptions, docs, comments. Never write LRNA (its legacy name) except when quoting an on-chain identifier that literally spells it.
- Activity is the sole domain and API term; do not restore Stream names, routes, or compatibility aliases.
- Display and copy user addresses as canonical SS58 or H160 forms, never raw AccountId public-key hex. Preserve real identity/tag context across local and cross-chain account pills.
- The primary and GIGAHDX money markets are isolated. Never blend their health factors. Primary-market directory/DefiSim figures stay primary-only; supplemental collateral backing must not be counted twice; tag risk uses the lowest real member health factor.
- Avoid request-time shortcuts that silently omit older history. Pagination, filtering, totals, and chart windows must operate on the full requested dataset.
- Multi-asset activity filters must match every referenced asset, including nested pool assets and both sides of a pair.
- Keep unresolved XCM origins and destinations explicit; enrichment runs asynchronously and must not delay explorer requests.
- Default tags and structural accounts must be reproducible and idempotent from a clean database. Vesting uses relay-chain height; conviction and GIGAHDX timing use parachain height.

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
- `api/src/public/**` may import only the allow-list pinned by `api/tests/public/isolation.test.ts`
  (`db/client`, `config`, `types`, and the `cache`/`explorerAssets`/`ohlcvService`/`poolService`/
  `volumeService`/`valuation`/`revenueStreams`/`moneyMarketCaps` services). Never `explorerService`. The one sanctioned transitive coupling —
  `initPoolService` wiring an explorerService client when none is set — is documented at the
  guard in `poolService.ts`; keep it non-clobbering.
- Numeric semantics (single-side netted volume, fee/protocol-fee split, APR/APY definitions,
  window anchoring) are normative in
  `docs/superpowers/specs/2026-08-12-public-rest-api-design.md` § Semantics, including the
  documented deviations from the Hydration Data Lake. Swagger descriptions must stay in sync with
  that section; do not "fix" a deviation without updating both.
- The public read models live in `clickhouse/schema/006_public.sql` (`pool_swap_legs` with its
  `op_key` routed-trade key, `farm_config_events`, `otc_order_events`, and the `pool_swap_hourly`
  pre-aggregate that keeps the fees charts and the DefiLlama backfill off a full leg scan).
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
- Four surfaces answer without a token (`AUTH_EXEMPT` in `data/app.ts`): `/v1/status`,
  `/openapi.json`, `/docs`, and `/llms.txt`. The last is RENDERED from the OpenAPI document
  (`data/services/llmsTxt.ts`) — a compact orientation for automated clients, never a
  hand-written second copy of the route list, so a new route appears in it the moment it
  registers. Keep it a map: framing text and per-route summaries only, no parameters or
  response schemas (`api/tests/data/llmsTxt.test.ts` pins completeness and the size budget).
- `api/src/data/**` may import only the allow-list pinned by
  `api/tests/data/isolation.test.ts` (`db/client`, `config`, `types`, and the
  `cache`/`explorerAssets`/`valuation`/`lpMath` services). Never `explorerService`, never
  `userAuthService`, never `public/**`; nothing outside `src/data/` imports from it.
  Address parsing/rendering is self-contained in `data/services/address.ts`. Pure domain
  arithmetic both surfaces need (the LP position math) lives in a leaf module under
  `services/` that `explorerService` re-exports — never restated in the data tree.
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
  MV-fed sources (`pool_swap_legs`, `dca_events`, `staking_activity`,
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
- Do not commit task plans, agent reports, screenshots, generated logs/results, ad hoc probes, or one-account repair scripts.
- Add focused regression coverage for durable behavior, not fixtures coupled to one transient production example.
- Keep shared domain logic centralized; avoid near-duplicate helpers or divergent activity builders.

## Commits

- Use Conventional Commits, matching the existing history: `type(scope): subject`, with the subject in lowercase imperative and no trailing period. Types: `feat`, `fix`, `refactor`, `perf`, `style`, `chore`, `docs`. Common scopes: `explorer`, `api`, `ui`, `prices`, `indexer`, `raw`, `preis`, `schema`, `compose`. Keep each commit focused on a single change.
- Never add co-author trailers or tool/assistant attribution (`Co-Authored-By`, "Generated with", and the like) to commit messages or PR descriptions. This holds unconditionally, including when a commit was AI-assisted — the commit author is the only attribution.
