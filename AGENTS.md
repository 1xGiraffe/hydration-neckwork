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
