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
- Prefer an MV so a model populates automatically as raw is indexed, in any order. Reach for a continuous recompute job (the `derivations` service) only when an MV cannot express the model (cross-row netting, stateful reconstruction). Make jobs idempotent: partition-incremental where the computation is order-independent, bounded full-replace (staging table + `EXCHANGE TABLES`) for stateful reconstructions — a forward high-water cursor is wrong while backward backfill fills lower blocks.
- Do not gate read paths on backfill or readiness. Under schema-first a model is correct-by-construction — it reflects exactly the raw indexed so far — so there is no coverage gate and no divergent raw-scan fallback to maintain.
- Validate a new model against raw before relying on it: rebuild it on a scratch database and compare stable identities, boundary blocks/timestamps, and counts or integer sums, plus several real responses. A matching total row count alone is insufficient.
- For custody, receipt-token, wrapper, and folded-asset views, write and verify an integer conservation equation before routing traffic: direct holdings plus custody must equal displayed beneficial claims plus any explicitly unattributed custody remainder. Replace attributed custody—never add it—and never hide a holder-anchor gap by proportionally scaling known owners.
- Match price compaction to semantics. Historical flows use the latest price known at the event, and bucketed histories use only candles fully closed by the bucket boundary—never a future or current price. Current holdings use current prices.
- Do not gain speed by limiting before exact filters, valuation, classification, or de-duplication. If sources are fetched independently, each source needs a proven saturation/cutoff rule; otherwise rare matches and older pages can disappear.
- Design pagination and caching together. Candidate caches may reuse an exact source prefix, but pages must remain deterministic over the full filtered ordering. Verify at least consecutive pages and a cold later page for the expected row count, stable identities, no overlap, and no gaps at the boundaries.
- Data-skipping indexes help only when their predicate is selective and expressed in a form ClickHouse can use. Adding an index is metadata-only for new parts; materializing it across old parts is a broad mutation and requires separate justification rather than being hidden in startup.

### Schema and derivations

The database is a rebuildable projection of the chain; there are no migrations. Two layers:

- **Declarative schema** — `clickhouse/schema/*.sql` is the single source of truth for every table and MV. It is regenerated from a known-good database (`SHOW CREATE`), then applied in numeric order and idempotently by the `schema-bootstrap` service to an empty database before ingestion. Add or change a model by editing these files; never define schema in application code.
- **Derivations** — three mechanisms, in order of preference:
  1. **Materialized views** for row-wise models; they populate automatically from raw in any insertion order (live-forward and backward backfill alike), so a model's completeness tracks raw's completeness for free.
  2. **The `derivations` service** (`api/src/derivations/`) for models an MV cannot express. `account_trade_volume` is partition-incremental — it recomputes only the month-partitions whose raw changed, detected by an ingest-time watermark (`max(raw.ingested_at) > max(derived.computed_at)`), which is subset-safe and correct under backward backfill. The LP reconstructions (`omnipool_position_owner_intervals`, `xyk_farm_principal_intervals`, `xyk_lp_total_shares_history`) do a bounded full recompute with atomic replace (staging table + `EXCHANGE TABLES`), because a forward cursor is wrong while backfill fills lower blocks and shifted keys would otherwise leave stale rows.
  3. **API-timer snapshots** for current-state directory values (account-directory Omnipool claims, money-market account values) that neither MVs nor the derivations service compute.

Keep in mind for new models:
- Prefer an MV; add a recompute job only for genuine cross-row or stateful needs.
- Every derived table must be reproducible from raw — no derived-only state.
- MVs must exist before ingestion (add to the schema, then rebuild) — never rely on a one-time backfill to fill history.
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
- Every activity needs a stable event identity and canonical URL. DCA links represent schedules rather than individual executions. OTC cancellation is called **Pull** in product copy. Always write **HOLLAR** in uppercase.
- Activity is the sole domain and API term; do not restore Stream names, routes, or compatibility aliases.
- Display and copy user addresses as canonical SS58 or H160 forms, never raw AccountId public-key hex. Preserve real identity/tag context across local and cross-chain account pills.
- The primary and GIGAHDX money markets are isolated. Never blend their health factors. Primary-market directory/DefiSim figures stay primary-only; supplemental collateral backing must not be counted twice; tag risk uses the lowest real member health factor.
- Avoid request-time shortcuts that silently omit older history. Pagination, filtering, totals, and chart windows must operate on the full requested dataset.
- Multi-asset activity filters must match every referenced asset, including nested pool assets and both sides of a pair.
- Keep unresolved XCM origins and destinations explicit; enrichment runs asynchronously and must not delay explorer requests.
- Default tags and structural accounts must be reproducible and idempotent from a clean database. Vesting uses relay-chain height; conviction and GIGAHDX timing use parachain height.

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
- Never add co-author trailers or tool/assistant attribution to commit messages.
