# Public REST API for the Hydration UI and external feeds

Date: 2026-08-12
Status: approved (correct semantics, clean redesign, separate service, full host surface in phase 1)

## Goal

Serve the official Hydration UI (github.com/galacticcouncil/hydration-ui) from this indexer,
replacing the Hydration Data Lake (subsquid → Postgres → PostGraphile GraphQL), and provide the
foundation for external data feeds (CoinGecko, DefiLlama, hydration.net stats). The surface is a
dedicated, versioned, Swagger-documented REST API with maximal materialization behind it and
deliberate caching, isolated from the explorer/preis contract so both sides can evolve without
touching each other.

Reference inputs: the Hydration developers' assessment ("Giraffe indexer" column), the live
data-lake schema at orca-prod-pool-01, `hydration-ui` `packages/indexer` (the exact GraphQL
operations), `../EXTERNAL-FEEDS-BRIEF.md`, and the data-lake source (parity semantics extracted
2026-08-12 from commit `49ecbbd`).

## Non-goals

- No GraphQL compatibility layer. The UI team repoints their data layer at REST.
- No bug-for-bug numeric parity with the data lake (see "Semantics" — deviations are documented).
- Multisig queries (Multix) are out of scope ("not needed" per the assessment sheet). Staking
  events and transaction-toast lookups were originally out of scope but are served since Phase 2
  (§ First-party /v1 additions) so the UI can retire the archive indexer entirely.
- External feed facades (`/coingecko/v1`, `/defillama/v1`) are structured for but implemented in a
  later phase; this spec pins the namespaces only.

## Topology

- **New Fastify process** `api/src/public/server.ts`, run as compose service **`api-public`** from
  the same image as `api` (the `derivations` pattern: same build context, different command).
  Container port 3000, tracked host default `3002:3000`, `restart: unless-stopped`,
  `depends_on: clickhouse (healthy) + schema-bootstrap (completed_successfully)`.
- **nginx sidecar** compose service **`api-public-nginx`** (`public-nginx/nginx.conf` +
  Dockerfile at repo root, mirroring `explorer-ui/nginx.conf`'s proxy setup without static files):
  `proxy_cache_path keys_zone=public_api_cache:10m max_size=200m inactive=15m`,
  `proxy_cache_key "$request_uri"`, `proxy_cache_lock on`, `proxy_cache_use_stale error timeout`,
  `proxy_cache_revalidate on`, `add_header X-Cache-Status`, `gzip_http_version 1.0`, upstream by
  unique container name `hydration-neckwork-api-public:3000`. The external reverse proxy (outside
  this repo) routes a public hostname to this sidecar. `/proxy/` locations bypass the micro-cache
  (the app layer caches those itself, per upstream).
- Single replica each (`container_name` set); scale via the micro-cache, not replicas.

### Isolation rule (enforced by a test)

`api/src/public/**` may import ONLY from:
`api/src/db/client.ts`, `api/src/config.ts`, `api/src/services/cache.ts`,
`api/src/services/explorerAssets.ts`, `api/src/services/ohlcvService.ts`,
`api/src/services/poolService.ts`, `api/src/services/volumeService.ts`,
`api/src/services/valuation.ts`, `api/src/services/revenueStreams.ts`,
`api/src/services/moneyMarketCaps.ts`, `api/src/services/foreignCandles.ts`, `api/src/types.ts`,
node builtins, npm packages, and anything under `api/src/public/` itself.
A vitest test walks `api/src/public/**` imports and fails on anything else (notably
`explorerService.ts`). Conversely nothing outside `api/src/public/` may import from it except
tests. Shared domain logic that both surfaces need lives in the allowed shared services.

## Wire conventions (all /v1 endpoints)

- **Addresses**: hex-encoded 32-byte public keys (`0x…`, lowercase) in requests and responses.
  H160 EVM addresses where the entity is an EVM contract/account. Never SS58.
- **Timestamps**: ISO-8601 UTC strings (`2026-08-12T15:00:00.000Z`) everywhere, inputs and outputs.
- **Enums**: lowercase, no underscore wrapping: periods `1h|24h|7d|30d|1y|all`, buckets
  `1m|5m|15m|30m|1h|4h|1d|1w`, venues `omnipool|stableswap|xyk|lbp|otc|aave|hsm|uniswapv3`
  (`uniswapv3` — the concentrated-liquidity pools on Hydration's EVM, runtime 443 — is keyed by
  the pool CONTRACT and written by the `uniswap_v3_legs` derivation, not by the Broadcast MV; see
  `docs/superpowers/specs/2026-09-09-uniswap-v3-pools-design.md`).
- **Asset ids**: the on-chain registry id as a decimal string (`"5"`, `"1000765"`). ERC-20 assets
  additionally expose `evmAddress`. Consumers resolve decimals via `GET /v1/assets`.
- **Amounts**: raw on-chain integer strings for token amounts (`"123450000000"`); USD values are
  decimal strings in fields suffixed `Usd`. Percentages are decimal strings in percent units
  (`"1.7353"` = 1.7353 %). No floats for money in JSON; numbers only for counts/heights.
  Every `Usd` field is a 2-decimal string rounded half-up at the wire (`"1500.00"`), while the
  arithmetic behind it stays integer/fixed-point at full scale and is rounded exactly once.
- **Pagination**: `?limit=<n>&offset=<n>` → `{ "items": [...], "totalCount": n }`.
  Default limit 20, max 200. Offsets bounded (400 beyond the cap, never a silent page 1).
- **Errors**: `{ "error": { "code": "bad_request" | "not_found" | ..., "message": "…" } }` with
  matching HTTP status.
- Every route declares zod request/response schemas via `fastify-type-provider-zod`;
  `@fastify/swagger` + `@fastify/swagger-ui` publish `/openapi.json` and `/docs`. Response
  validation is ON in tests, serializer-only in production.
- CORS `*`, `@fastify/compress`, global `@fastify/rate-limit` (generous default, e.g. 300/min per
  IP; `trustProxy` scoped to the sidecar like the existing api). Explicit `Cache-Control:
  public, max-age=<n>` set per route (see cache table) plus strong `ETag` (fastify/etag or
  hand-rolled hash) so the nginx micro-cache and browsers both revalidate cheaply.

## Endpoints

### Service / status

| Route | Replaces | Source | max-age |
|---|---|---|---|
| `GET /rest/service/metadata` | data-lake metadata probe | static + indexer status | 5 |
| `GET /rest/service/health` | data-lake health | static | 5 |
| `GET /v1/status` | LatestBlockHeightQuery | same logic as existing `GET /indexer` | 3 |

`/rest/service/metadata` must be shape-compatible with the data lake because the UI's provider
failover reads it:
```json
{ "metadataVersion": 1,
  "indexer": { "id": "giraffe-neckwork-mainnet", "version": "<pkg version>",
               "network": "hydration", "master": true },
  "coverage": { "blockBounds": { "minBlockHeight": 0, "maxBlockHeight": -1 } } }
```
`master: true` is static config (env `PUBLIC_API_MASTER`, default true).
`GET /v1/status` returns `{ blockHeight, blockTimestamp, lagSeconds, chainBlockHeight,
blocksBehindHead }` — reuse the query from `api/src/routes/indexer.ts` via a small shared helper
in `api/src/public/services/` (duplicating ~30 lines of SQL is acceptable to keep isolation; do
NOT import the route file).

### Assets

`GET /v1/assets` — max-age 300. Full registry from the shared assets snapshot:
`[{ id, symbol, name, decimals, assetType, evmAddress?, origin? }]`. `assetType` may be null until
the registry gains it (registry enrichment is a stretch goal, not a blocker).

### Accounts

`GET /v1/accounts/balances?accounts=0x…,0x…` (1–50 accounts) — max-age 3.
Batched replacement for the per-account LatestAccountsBalances fan-out. From
`account_asset_latest_balances` + current prices (+ aToken/ERC-20 composition via the same shared
sources the explorer account page uses, exposed through a public-owned query — see note below):
```json
{ "items": [ { "account": "0x…", "transferableUsd": "123.45", "lockedUsd": "1.00",
               "lpUsd": "50.00", "debtUsd": "10.00",
               "totalUsd": "174.45", "blockHeight": 123 } ] }
```
Semantics: `transferableUsd` = free balances of owned assets valued at current prices, including
aToken balances; `lockedUsd` = RESERVED balances valued (the frozen component is not carried by
`account_asset_latest_balances`, so it is not included); `lpUsd` = Omnipool LP claims (bare and
farmed, asset leg + hub/LRNA leg) from `omnipool_account_claim_snapshots`. `totalUsd` = transferable
+ locked + lp — GROSS assets, rounded from the exact sum, so it can differ by up to a cent from
adding the three rounded fields. `debtUsd` = money-market debt across every configured market,
exposed separately and NOT netted into any other field (deviation from data lake; documented):
**the data-lake account picker's value is `totalUsd - debtUsd`.** Sub-second precision is not the
point — the account picker sorts by it.

`lpUsd` and `debtUsd` are `null` — never `0.00` — when their snapshot is stale (>1 h) or missing,
and a null `lpUsd` is excluded from `totalUsd` rather than counted as zero; `"0.00"` means a fresh
snapshot in which the account holds nothing. An account known only by its LP positions is included
and reports `blockHeight` 0 (the claim snapshot carries no block height). Staking-backed markets
(GIGAHDX) are excluded from the supplied side only — their collateral never left the wallet — while
their debt is counted. Stableswap/XYK LP is still out of scope.

Both snapshot-backed reads PIN THEMSELVES to the live generation in SQL
(`WHERE snapshot_id = (SELECT argMax(snapshot_id, computed_at) FROM …_state WHERE snapshot_key =
'current')`), never to a cached pointer id: the refresher drops superseded partitions the instant
it flips the pointer, so a pointer cached even seconds earlier can name a dead partition, which
would read as "no LP / no debt" — a zero where the contract promises a value or a null. The cached
pointer decides only WHETHER to read (the 1 h gate) and salts the cache key.

`GET /v1/accounts/:account/balance-history?from=&to=&bucket=1h` — max-age 60.
Net-worth series for the wallet chart. Buckets from `account_balance_hourly` (bucket ≥ 1h; `1d`
allowed) with per-asset forward-fill and USD valuation at bucket close (closed candles only),
aToken/ERC-20 balances reconstructed the same way the explorer does:
```json
{ "referenceCurrency": "usd",
  "items": [ { "timestamp": "…", "transferableUsd": "…", "lockedUsd": "…", "debtUsd": "…" } ] }
```
`debtUsd` = money-market variable-debt valued (from `account_money_market_position_history` /
debt-token balances). The UI adds LP/farm positions client-side today; if trivially available
include `lpUsd`, otherwise omit and document.
Implementation note: the balance-history and balances composition logic is a NEW public-owned
service (`api/src/public/services/accountBalances.ts`) reading the same ClickHouse tables the
explorer reads (`account_balance_hourly`, `account_asset_latest_balances`,
`erc20_transfer_deltas`, `atoken_scaled_*`, `money_market_reserve_indices`) — do not import
explorerService. Keep it simpler than the explorer's 180-bucket adaptive logic: fixed requested
bucket, capped at 1000 points per request.

`GET /v1/accounts/:account/money-market-events?events=supply,borrow,…&search=&limit=&offset=` —
max-age 5.
From `account_money_market_activity` (+ `atoken_reserve_map` for H160→asset id):
```json
{ "items": [ { "eventName": "Supply", "assetId": "10", "amount": "1000000",
               "blockHeight": 1, "eventIndex": 2, "timestamp": "…",
               "categoryId": null } ],
  "totalCount": 12 }
```
Event names (pascal case values, filter accepts lowercase): Supply, Withdraw, Borrow, Repay,
LiquidationCall (amount = the SEIZED COLLATERAL, denominated in `assetId`),
ReserveUsedAsCollateralEnabled/Disabled (no amount), UserEModeSet.
`categoryId` is present in the shape but always null: the activity model carries no eMode category
column, and the value survives only in the raw event's decoded arguments, which cannot be read per
account within bounded cost. A liquidation's `liquidator`, `debtAssetId` and `debtAmount` are
likewise absent — the repaid debt is in a different asset and is not carried by the model — and all
four are possible additive extensions if the model gains the columns.
`search` filters by asset symbol/name (resolve to asset ids server-side, then filter).

### Trades / DCA

`GET /v1/trades?swapper=0x…&assets=5,10&limit=&offset=` — max-age 3.
Market swaps (ExactIn/ExactOut only), newest first, from `account_swap_activity` (swapper-scoped)
or `swap_activity` (global when `swapper` omitted) joined with `swap_actor` for DCA linkage:
```json
{ "items": [ { "blockHeight": 1, "eventIndex": 2, "extrinsicIndex": 3, "timestamp": "…",
               "swapper": "0x…", "operationType": "exactIn",
               "assetIn": "5", "amountIn": "…", "assetOut": "10", "amountOut": "…",
               "dca": null | { "scheduleId": 123 } } ],
  "totalCount": 456 }
```
`assets` filter matches either side. Amounts are the end-to-end trade legs (first input, last
output), not per-hop. `dca` names the schedule only; the schedule's `status` is a property of the
schedule (`GET /v1/dca/schedules`), not of one execution, so it is not repeated here — it can be
added additively later if a consumer needs it inline.

`GET /v1/trades/routed?participant=0x…&assets=&limit=&offset=` — max-age 3.
Same row shape; one row per routed trade (the netted end-to-end view). If `swap_activity` rows
already represent end-to-end Router trades for the modern era, `/v1/trades` and
`/v1/trades/routed` may share an implementation with different filters — implementer decides and
documents; both endpoints must exist so the UI's two tabs map 1:1.

`GET /v1/dca/schedules?owner=0x…&status=created,completed,terminated,cancelled&assets=&limit=&offset=`
— max-age 3. From `dca_schedules` + `dca_events`:
```json
{ "items": [ { "scheduleId": 1, "owner": "0x…", "assetIn": "5", "assetOut": "10",
               "singleTradeAmount": "…", "budget": "…" , "isRollingBudget": false,
               "executedAmountIn": "…", "executedAmountOut": "…",
               "periodBlocks": 7200, "status": "created",
               "createdAt": "…", "createdAtBlock": 1, "lastEventAt": "…" } ],
  "totalCount": 3 }
```
**Status is computed server-side**, including the data-lake UI rule: a schedule whose terminal
event is `Terminated` counts as `cancelled` when its last execution was still only `Planned`
(user-cancelled), else `terminated` (system). `isRollingBudget` = total budget 0. Sort: most
recently touched first (`lastEventAt` desc). `executedAmountIn/Out` = sums over `TradeExecuted`
events.

`GET /v1/dca/schedules/count?owner=0x…&status=created&assets=` — max-age 3.
`{ "totalCount": 2 }`.

`GET /v1/dca/schedules/:id/executions?limit=&offset=` — max-age 3.
```json
{ "items": [ { "status": "executed" | "failed" | "planned", "amountIn": "…", "amountOut": "…",
               "blockHeight": 1, "eventIndex": 2, "timestamp": "…",
               "errorState": null | { "kind": "…", "error": "…", "index": 0 } } ],
  "totalCount": 100, "assetIn": "5", "assetOut": "10" }
```
`errorState` object shape is load-bearing (the UI zod-parses `{kind,error,index}`).

### ICE intents

Runtime 443 (block 14,362,830) added the Intent pallet. An intent is a resting order — the
owner's `assetIn` sits under a named reserve until a solver's `ICE.submit_solution` fills it. A
**swap** intent is the product's **limit order**; a **dca** intent is the new DCA. They are their
own routes rather than rows in `/v1/dca/schedules`: the two live in different tables with
different terms, and widening the DCA contract's meaning would break its consumers.

`GET /v1/intents?owner=0x…&status=open,partially_filled,filled,cancelled,expired,completed&kind=swap,dca&assets=&limit=&offset=`
— max-age 3. Owner is REQUIRED, for the same reason `/v1/dca/schedules` requires it: status and
ordering are computed over the owner's whole set before the page is cut.
```json
{ "items": [ { "intentId": "33002353350733935917200834560076", "seq": 76, "owner": "0x…",
               "kind": "swap" | "dca", "assetIn": "0", "assetOut": "1000765",
               "amountIn": "…", "amountOut": "…", "partiallyFillable": true, "slippagePpm": 0,
               "budget": null, "isRollingBudget": null, "periodBlocks": null,
               "status": "open", "filledAmountIn": "…", "filledAmountOut": "…", "fillCount": 0,
               "remainingAmountIn": "…", "remainingBudget": null,
               "deadline": null, "createdAt": "…", "createdAtBlock": 1, "lastEventAt": null } ],
  "totalCount": 1 }
```
`GET /v1/intents/count?owner=0x…&status=open&kind=&assets=` — max-age 3. `{ "totalCount": 1 }`.

`GET /v1/intents/:id` — max-age 3. The same row object the listing publishes, for one order, built
by the SAME fold rather than a second one: a progress view reached from a list may not contradict
the list it came from. No owner: the id alone bounds both reads — `intent_orders` is
`ORDER BY intent_id`, so the placement is a point read, and the placement block it returns is the
lower bound of the event fold (`intent_events` is keyed `(block_height, event_index)` and cannot
prune on an id, and no event of an order can precede its submission). Unknown id → 404.

`GET /v1/intents/:id/events?limit=&offset=` — max-age 3.
```json
{ "items": [ { "kind": "dca_trade", "eventName": "Intent.DcaTradeExecuted",
               "blockHeight": 14519541, "eventIndex": 9, "extrinsicIndex": 1, "timestamp": "…",
               "amountIn": "…", "amountOut": "…", "remainingBudget": "…" } ],
  "totalCount": 125, "assetIn": "1000765", "assetOut": "0" }
```
`kind` is one of `submitted`, `resolved`, `partially_resolved`, `dca_trade`, `dca_completed`,
`cancelled`, `expired`, `callback_failed` — a DCA fill table is the `dca_trade` rows, a swap
intent's fills are `resolved`/`partially_resolved`. Amounts are the EVENT's, not the order's, and
an event that traded nothing reports them null rather than 0: a submission, a cancellation, an
expiry, and `Intent.DcaCompleted`, whose final trade states its amounts only in the solution's
settlement transfers. `remainingBudget` is the pallet's own figure after a dca trade and `"0"` on
the completion, which by definition spent the rest. The pair sits on the ENVELOPE because only the
submission names it and it labels every amount in the page — the same reason
`/v1/dca/schedules/:id/executions` carries it. Page and count filter on the identical event-name
list, so a count can never promise a page the caller cannot reach; both deduplicate on
`(block_height, event_index)`, the table's own replacement key. Unknown id → 404.

**Semantics.** `intentId` is a u128 carried as a DECIMAL STRING and is the identity; `seq` is its
low 64 bits, a display handle exact only below 2^53. Status folds from the order's own events at
read time and MUST agree with the explorer's intent page — a PARTIAL resolution is not terminal
(pallet_ice leaves the remainder resting), so `partially_filled` is a live state and an order
pulled after partial fills reports `cancelled`. A dca intent never resolves; it reports
`completed` once `Intent.DcaCompleted` fired. `amountIn` is the whole order on a swap intent and
ONE PERIOD's trade on a dca intent; `remainingAmountIn` is the placed amount (swap) or the budget
(dca) less what the fills took, integer arithmetic that never goes negative. `budget`,
`isRollingBudget` and `periodBlocks` are null together on a swap intent — "does not apply to this
kind", never zero — and `isRollingBudget: true` is a dca intent that set no budget (the pallet's
rolling re-reserve, the same shape as a schedule's `totalAmount: "0"`).

### Prices

`GET /v1/prices/pair?assetIn=5&assetOut=10&from=&to=&bucket=1h` — max-age 5.
Real OHLCV from the existing `ohlc_*` views / cross-pair logic (`ohlcvService` +
`crossPair` semantics; a thin public-owned wrapper may re-export the shared service):
```json
{ "referenceAsset": "usd",
  "items": [ { "timestamp": "…", "open": "…", "high": "…", "low": "…", "close": "…",
               "volumeUsd": "…" } ] }
```
Price = assetIn quoted in assetOut (how much assetOut one assetIn buys) to match the UI's pair
orientation; document the orientation prominently. Max 5000 candles per request (existing cap).

### Pools: volumes and yield (new models)

`GET /v1/pools/omnipool/volumes?period=24h` — max-age 60.
```json
{ "period": "24h", "asOf": "…",
  "items": [ { "assetId": "5", "volumeUsd": "…", "feeUsd": "…", "protocolFeeUsd": "…" } ] }
```
`GET /v1/pools/stableswap/volumes?period=24h` — max-age 60.
```json
{ "items": [ { "poolId": "690", "volumeUsd": "…", "feeUsd": "…" } ] }
```
`GET /v1/pools/xyk/volumes?period=24h&pools=0x…,0x…` — max-age 60. `pools` = pool account ids
(hex), optional (all active pools when omitted):
```json
{ "items": [ { "poolAccount": "0x…", "shareTokenId": "123",
               "assetA": "5", "assetB": "10", "volumeUsd": "…", "feeUsd": "…" } ] }
```
`GET /v1/pools/omnipool/yield?window=30d` — max-age 600.
```json
{ "window": "30d", "asOf": "…",
  "items": [ { "assetId": "5", "feeAprPerc": "0.7044", "feeApyPerc": "0.7069",
               "farmAprPerc": "12.1679", "farmRewardAssets": ["222"],
               "protocolFeeAprPerc": "…" } ] }
```
`GET /v1/pools/stableswap/yield?window=30d` — max-age 600.
```json
{ "items": [ { "poolId": "690", "feeAprPerc": "…", "feeApyPerc": "…", "farmAprPerc": null } ] }
```
`farmAprPerc` is the liquidity-mining rate from `farm_config_events` (Semantics 9), reported
separately from `feeAprPerc` and null where an input is missing; it stays null on stableswap
pools, whose own LPs earn no farm rewards.

### Platform stats

`GET /v1/stats/platform` — max-age 60.
```json
{ "asOf": "…", "blockHeight": 123,
  "tvl": { "omnipoolUsd": "…", "stableswapUsd": "…", "xykUsd": "…", "moneyMarketSupplyUsd": "…",
           "moneyMarketFoldedUsd": "…", "pooledATokenUsd": "…", "totalUsd": "…" },
  "volume24h": { "omnipoolUsd": "…", "stableswapUsd": "…", "xykUsd": "…",
                 "totalRoutedUsd": "…" } }
```
TVL from `poolService.getPoolsIndex()` composition (omnipool excludes the LRNA leg — matches the
data lake's intent). Volume from the new `pool_swap_legs` model (see Semantics).

`moneyMarketSupplyUsd` is every reserve's supplied side at current prices, from
`money_market_reserve_state_current` across all three isolated markets. Null — never `0` — when
that view has no rows (the aToken anchor has not been snapshotted; see the 007 header) or when
nothing in it could be priced, and a reserve missing from the reserve map's newest refresh
generation is DROPPED as delisted rather than frozen at its last balance (logged, since nothing
in a 200 would otherwise say so).

It is deliberately NOT part of `totalUsd`, which stays the pooled total, because the pooled and
money-market totals OVERLAP IN BOTH DIRECTIONS. Both folds are published so the surfaces
reconcile, and both are restricted to pools that HAVE a TVL — poolService gives a pool none
unless every leg is priced, so an unpriced pool added nothing and nothing of it may be
subtracted (guarding on the money-market reserve's own price instead is a weaker, wrong
condition; pool 10055 BIL/HOLLAR is the live near-miss). Measured 2026-08-13, against $52.1 M
supplied and $29.5 M pooled:
- `moneyMarketFoldedUsd` — $13.9 M of the money market is Stableswap SHARE tokens deposited as
  collateral, each a claim on a pool already inside `stableswapUsd`.
- `pooledATokenUsd` — $8.58 M of the POOLS is money-market aTokens, because Hydration's pools are
  themselves suppliers: pool 690 holds aDOT, 4200 aETH, the stablepools aUSDT/aUSDC/aEURC/aSOL,
  10055 BIL, and the Omnipool asset 1001 (aDOT) directly. aDOT alone is $3.23 M — 74% of the core
  market's DOT reserve is deposited by Hydration's own pools. Identified from
  `ATOKEN_UNDERLYING_ID`, so a newly listed aToken folds without a deploy.
- $10.9 M of staking-backed stHDX is NOT an overlap and stays in: that HDX is locked in its
  holder's own wallet and no pool holds it.

Conservation (AGENTS.md's folded-asset rule), with no unattributed remainder — the two custody
legs cannot intersect, since a pool share is never an aToken:

```
totalUsd + moneyMarketSupplyUsd - moneyMarketFoldedUsd - pooledATokenUsd
  == /hydration-web/v1/stats `tvl`
```

exactly, to the published cent, **within one computation**: that endpoint folds these very strings
rather than recomputing. Two HTTP requests cannot be made to share one computation, and there is no
recipe that forces it. `/hydration-web/v1/stats` is memoised 600 s (stale-while-revalidate to
1800 s) while `/v1/stats/platform` recomputes about every 60 s, so a back-to-back pair agrees
exactly only while the web endpoint still serves the generation its fold was built from — measured
2026-08-13, 21 back-to-back pairs over 7 minutes: **4 exact, 17 not**. Two recipes that look sound
and are not: a query-string cache-buster (it bypasses the nginx micro-cache only; both services
memoise under fixed keys) and polling until the web endpoint's ETag changes then reading platform at
once (still $179.07 out, because stale-while-revalidate computes the new value before the request
that first serves it). **The acceptance criterion is therefore magnitude, not equality:** over that
run the gap ran $179.07 to $8,254.19 on a ~$59.4 M base, ≤ 0.014 %, so agreement inside ~0.02 % is
correct and anything larger is worth investigating. Checkable in two requests.

### Proxies (data-lake host compatibility)

`GET /proxy/defillama/*`, `GET /proxy/kamino/*`, `GET /proxy/subsquare/*` — allow-listed
passthrough with app-layer caching:
- Allow-list per upstream, path-prefix based, mirroring what the UI actually calls:
  defillama `yields/chart/<uuid>` → `https://yields.llama.fi/chart/<uuid>`;
  kamino `yields/<addr>/history` → `https://api.kamino.finance/…`;
  subsquare `users/<addr>/referenda/votes` and `gov2/referendums` →
  `https://hydration-api.subsquare.io/…`.
  Verify each upstream base against the data-lake clone
  (`indexers/liquidity-pools/src/apiSupport/api/rest/proxyApiHandlers/`) before implementing.
- The surface is read-only: GET only, no request body, and every upstream is keyless and called
  anonymously — no credential of ours and none of the caller's is ever forwarded.
- Cache: `cached()` keyed by full URL, TTL 10 min (defillama, kamino), 60 s (subsquare). 502 with
  the error envelope on upstream failure; never cache failures.
- Requests not matching the allow-list → 404.
- 2026-08-12: the data lake's fourth proxy upstream was dropped before release — it was the only
  key-gated (paid-tier) leg and the Hydration UI has no caller for it, so the whole upstream went
  rather than dead plumbing being carried. That removal took the per-request cache gate, the
  API-key mechanism and POST support with it.

## New ClickHouse models

All declared in `clickhouse/schema/` (a new numbered file, e.g. `005_public.sql` if separation is
cleaner, else appended to `003_...` per existing layout conventions — follow the file layout that
`schema-bootstrap` applies in numeric order). All MV-fed from `raw_events` (raw ingestion is
unfiltered — verified: `src/raw/processor.ts` `.addEvent({})` with no name filter). Replay-safe
`ReplacingMergeTree(ingested_at)` with natural keys; no additive states over replayable raw.

### 1. `pool_swap_legs` — venue-dimensioned swap/fee legs

The single projection feeding pool volumes, fee revenue, platform totals, and later CoinGecko
tickers / DefiLlama volume.

Table:
```
pool_swap_legs
  venue            LowCardinality(String)   -- omnipool|stableswap|xyk|lbp|otc|aave|hsm|uniswapv3
  pool_key         String                   -- see below
  block_height     UInt32
  event_index      UInt32
  leg_index        UInt16                   -- position within the fill's legs
  leg_kind         Enum8('in'=1,'out'=2,'fee'=3)
  asset_id         String                   -- registry id as string (matches assets.asset_id type; verify)
  amount_raw       UInt256 or Decimal/String -- match house convention for 128-bit amounts
  fee_dest         LowCardinality(String)   -- ''|'account'|'burned' (fee legs only)
  fee_recipient    String                   -- '' unless fee leg with account destination
  swapper          String
  extrinsic_index  Nullable(UInt32)
  block_timestamp  DateTime
  ingested_at      DateTime64
ENGINE ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (venue, pool_key, block_height, event_index, leg_index)
```
Study `swap_activity_mv` / `hsm_activity_mv` / `accountTradeVolume.ts` for exact JSON paths and
the ExactOut inversion guard before writing the MV; verify amount column type against how existing
tables store u128 (they use String/UInt128 — match it).

**Modern era MV** (`block_height >= 6837788`, `event_name IN ('Broadcast.Swapped',
'Broadcast.Swapped2','Broadcast.Swapped3')`):
- `venue = lower(JSONExtractString(args_json,'fillerType','__kind'))`
- `pool_key`: stableswap → the Filler enum's inner pool id; xyk/lbp → the filler account;
  omnipool → `'omnipool'`; otc → order id; aave/hsm → filler account. Extract from
  `fillerType.value` where present else `filler`.
- legs: `ARRAY JOIN` over `inputs` (leg_kind=in), `outputs` (leg_kind=out), `fees` (leg_kind=fee,
  `fee_dest` from `destination.__kind`, `fee_recipient` from `destination.value` when Account).
- Apply the documented `Broadcast.Swapped` v1 ExactOut inversion correction exactly as
  `accountTradeVolume.ts` / `extractVolume.ts` do (reuse/centralize the guard expression).
- swapper from `args_json.swapper` (beware `0x2a2a…` router placeholder — keep as-is, do not
  resolve; the volume math doesn't need the actor).

**Legacy era MVs** (`block_height < 6837788`): the same table is fed by the per-pallet
events `Omnipool.SellExecuted/BuyExecuted` (assetFeeAmount →
fee leg on asset_out, EXCEPT on a `BuyExecuted` below block 4 221 778 — the runtime upgrade at
that height — where the fee is charged in the asset ENTERING the pool and the leg is on asset_in;
protocolFeeAmount → fee leg on LRNA asset 1),
`Stableswap.SellExecuted/BuyExecuted` (poolId; the single `fee` is on asset_out for a Sell and
asset_in for a Buy), `XYK.SellExecuted/BuyExecuted` (pool account; feeAsset/feeAmount), and
`LBP.SellExecuted/BuyExecuted`. Venue comes from the pallet and `op_key` is empty because the
legacy Router event carried no operation id. These projections give every trade surface full
indexed coverage back to the first Omnipool fill at block 1 708 104. A legacy Omnipool event
describes the user's direct pair rather than the modern router's internal LRNA hops, so a
consumer selecting Omnipool asset/LRNA legs sees legacy rows only when LRNA was itself traded.

**USD valuation is read-time**, not stored: join `ohlc_1h` closes (`argMaxMerge(close_state)`
where `interval_start + 1 HOUR <= block_timestamp`) per the house event-time pattern
(`accountTradeVolume.ts:234`). Window queries anchor "now" to the newest indexed swap leg
(`max(block_timestamp)` of `pool_swap_legs`), not wall clock and not the `blocks` head — a
blocks-head anchor advances past the newest leg during MV catch-up and silently undercounts
(this drift happened once; the leg-based form is pinned by a test in `poolVolumes.test.ts`).

**Validation**: scratch-DB rebuild; for a sample month, per-venue leg sums must reconcile with
direct `raw_events` aggregation (integer sums, not row counts); replay a raw range and prove
idempotence; pin the ExactOut guard and fee-destination extraction with unit tests on captured
args_json fixtures.

### 2. `farm_config_events` — liquidity-mining farm lifecycle

```
farm_config_events
  pallet           LowCardinality(String)   -- omnipool_lm | xyk_lm
  event_name       LowCardinality(String)   -- GlobalFarmCreated|GlobalFarmUpdated|GlobalFarmTerminated|
                                            -- YieldFarmCreated|YieldFarmUpdated|YieldFarmStopped|YieldFarmResumed|YieldFarmTerminated
  global_farm_id   UInt32
  yield_farm_id    Nullable(UInt32)
  block_height     UInt32
  event_index      UInt32
  block_timestamp  DateTime
  args_json        String
  ingested_at      DateTime64
ENGINE ReplacingMergeTree(ingested_at)
ORDER BY (global_farm_id, block_height, event_index)
```
MV filter: `event_name LIKE 'OmnipoolLiquidityMining.%Farm%' OR event_name LIKE
'XYKLiquidityMining.%Farm%'` narrowed to the lifecycle names (check actual names in `raw_events`
via `src/types/` before finalizing). Keep args_json raw and fold in TS (the
`stableswap_pool_params` pattern). Not consumed by an endpoint in this release — it exists so
farm APR can be added without a backfill later. Backfill note: on the live deployment, one-time
ad-hoc `INSERT…SELECT` mirroring the MV (not committed).

### 3. `otc_orders` — typed OTC order events

```
otc_order_events
  order_id         UInt32
  event_name       LowCardinality(String)   -- Placed|Filled|PartiallyFilled|Cancelled
  asset_in         UInt32                    -- from Placed
  asset_out        UInt32
  amount_in        String
  amount_out       String
  partially_fillable UInt8
  filler           String                    -- Filled/PartiallyFilled
  block_height     UInt32
  event_index      UInt32
  block_timestamp  DateTime
  ingested_at      DateTime64
ENGINE ReplacingMergeTree(ingested_at)
ORDER BY (order_id, block_height, event_index)
```
MV from `raw_events` `OTC.*` (check exact arg names in `src/types/`). Order state folds at read
time (open = Placed without terminal event). No /v1 endpoint in this release (the UI's OTC needs
are "not relevant" per the sheet); the model exists for feeds/DexScreener later and to retire the
untyped `otc_activity` eventually (leave `otc_activity` in place — removal is a separate cleanup).

## Semantics (documented deviations from the data lake)

These definitions are normative; each /v1 endpoint description in Swagger links to this section's
rules where numbers differ from the data lake.

1. **Pool volume** (per asset / per pool, window W): for each fill (unique
   `(block_height, event_index)` in `pool_swap_legs` for that venue/pool), volume contribution =
   USD value of the OUT legs at event time; if the out asset is unpriced, fall back to the IN
   legs' USD value; if both unpriced, the fill contributes 0 and a `coverage` note applies.
   Single-counted (deviation: data lake counts in+out ≈ 2×). Fees are not added to volume
   (deviation: data lake's totalVolNorm adds fee volume).
   For omnipool per-asset volume: a fill touching asset X contributes the X-side USD value to X's
   volume (both directions), LRNA legs are ignored for per-asset volume.
2. **Platform total volume 24h** = netted end-to-end routed value: per extrinsic-level trade, the
   max of (total in-USD, total out-USD) across the route's boundary legs — the
   `account_trade_volume` netting rule — so multi-hop routes count once. Per-venue sums are also
   exposed and legitimately exceed the netted total. One deliberate departure from the
   `account_trade_volume` rule: a trade whose EVERY fill is an `aave` leg (a pure aToken
   wrap/unwrap, 1:1 by construction) is excluded from the netted platform/DEX totals — it is
   custody movement, not exchange volume. An aave leg inside a longer route still counts as part
   of that route's netted value.
3. **Omnipool fee APR** (per asset, window W days): `feeAprPerc = 100 × (asset_fee_amount_W /
   avg_reserve_W) × (365/W)`, where `asset_fee_amount_W` = sum of fee legs in asset X paid to the
   pool account (LP-accruing; `fee_dest != 'burned'`, recipient = pool where distinguishable) and
   `avg_reserve_W` = time-weighted average of `omnipool_pool_state_history.reserve_raw` samples in
   the window. Raw-unit ratio — no USD conversion needed (same asset numerator and denominator).
   `feeApyPerc = 100 × ((1 + apr_period)^(365/W) − 1)` with `apr_period = fee/avg_reserve`.
   NO ÷2 (deviation). Protocol fee (LRNA-denominated) is reported separately as
   `protocolFeeAprPerc` on the LRNA reserve, not blended in.
4. **Stableswap yield** (per pool, window W): USD-weighted:
   `feeAprPerc = 100 × (Σ fee_legs_usd_W / avg_pool_tvl_usd_W) × (365/W)` (deviation: data lake
   averages per-asset raw ratios unweighted). Fee legs valued event-time; TVL averaged over the
   600-block-grid samples in the window.
5. **XYK fees**: correct per-asset attribution (deviation: data-lake multi-block bug reports B's
   fee in A's field).
6. **Windows**: rolling, anchored to the latest indexed block timestamp (not wall clock — correct
   under indexing lag). `asOf` in responses states the anchor.
7. **Account balances**: `transferableUsd` includes aToken balances (money-market SUPPLIED, which
   REPLACES the pallet-side aToken rows — never added to them); `debtUsd` is separate (not netted
   from transferable — deviation, documented); `lockedUsd` = RESERVED balances only (the frozen
   component is not carried by the latest-balance model).
   On `GET /v1/accounts/balances`, Omnipool LP claims ship as `lpUsd` (bare + farmed, asset leg +
   hub/LRNA leg, from the persisted claim snapshot) and are included in `totalUsd`; the data-lake
   account picker's total is `totalUsd - debtUsd`. Stableswap/XYK LP remains omitted. Each field is
   rounded independently from its own exact sum, so `totalUsd` can differ by up to a cent from
   adding the rounded parts — `totalUsd` is the accurate one.
   Every snapshot-backed slice is staleness-gated at 1 h and reports `null` (excluded from
   `totalUsd`) rather than a zero or an out-of-date figure when its generation is stale or missing;
   the data reads self-pin to the live generation in SQL so a dropped partition can never be read
   as a zero.
   On `GET /v1/accounts/:account/balance-history` LP positions are still omitted entirely: the
   claim snapshot is current-state only, so applying it to a past bucket would be the future-price
   mistake rule 8's closed-candle rule exists to prevent.
8. **Prices**: real OHLC from trade-derived candles (upgrade over data lake's AVG-only buckets);
   closed-candle rule for bucketed history per AGENTS.md.
9. **Farm APR** (`farmAprPerc`, per Omnipool asset): the pallet's own reward rule, as the
   Hydration SDK's `LiquidityMiningApi.farmData` implements it for the UI. A global farm pays
   `min(total_shares_z · price_adjustment · yield_per_period, max_reward_per_period)` per period
   and a yield farm takes the share its `multiplier` buys, so per unit of stake the rate is
   `apr = min(multiplier · yield_per_period · periodsPerYear,
   max_reward_per_period · periodsPerYear · reward_price / staked_value)`
   with `periodsPerYear = 365.2425 d / (6 s · blocks_per_period)` (a period is counted in RELAY
   blocks). The capped term carries NO `multiplier`: `total_shares_z` is
   `Σ(valued_shares · multiplier)`, so with the one live yield farm per global farm this chain
   has always run, the factor cancels — and `staked_value` here is un-weighted stake, so
   re-applying it would halve a `multiplier = 0.5` farm's rate. A global farm folding to more
   than one live yield farm reports null for all its assets, which is what protects that
   cancellation. Farm state is folded in TS from `farm_config_events` in chain order; the
   `GlobalFarmUpdated` event carries no `max_reward_per_period`, which the pallet keeps at
   `total_rewards / planned_yielding_periods`. An asset's value is the SUM over the farms
   running on it, and `farmRewardAssets` names the assets they pay in. It is reported separately
   from `feeAprPerc`, never blended (a consumer wanting the total adds them).
   **Deviation (indexed, not chain state).** `total_shares_z` is pallet state no event carries:
   the sum of each entry's `valued_shares`, its position's LRNA value FROZEN at its deposit block.
   The denominator here is instead the CURRENT value of the Omnipool positions that are currently
   farmed (`omnipool_position_owner_intervals` `ownership_kind='farmed'`, at the newest pool-state
   sample and newest closed candle). The two differ by two terms, and the error is
   **downward-biased, not centred**: deposits left in since-stopped farms keep an open farmed
   interval and so keep counting toward the current value while earning nothing, a term that can
   only ENLARGE the denominator (measured +0.15 %, +0.4 %, +0.8 %, +4.4 %, +6.2 %, +9.4 % of
   stake — every one positive) and only push the published rate DOWN; and a stake that has
   appreciated since its deposits is worth more than the frozen `Z`, pushing it down again, while
   one that fell pushes it up. Net, measured against chain state on 2026-08-12: −9.0 %, −2.6 %,
   −1.9 %, −0.7 %, +7.1 %, +8.7 % relative across all six live farms.
   **Not folded in**: the loyalty curve (the published rate is what a matured deposit earns, the
   top of the UI's range), and any farm past its planned schedule — what it still pays depends on
   whether its pot was topped up, and pot balances read 0 in the indexed balances for the
   ERC20-backed reward assets these farms use, so such a farm's rate is not guessed.
   Nulls: past the planned schedule, no fresh pool-state sample, an unpriced reward asset, a
   global farm with more than one live yield farm, or a farmed-position model reporting no farmed
   position anywhere (an outage, not six empty farms). A null rate with a NON-EMPTY
   `farmRewardAssets` means "a farm runs here, its rate is unknown"; an empty `farmRewardAssets`
   means no farm at all. Every farm now running was created in one block with the same
   `plannedYieldingPeriods` and is scheduled to end 2026-10-26T21:10:36Z, so absent a
   `GlobalFarmUpdated` extending the schedule (a pot top-up alone does not), every
   `farmAprPerc` goes null on that date.
   Stableswap `farmAprPerc` is always null — mining incentivises Omnipool positions and XYK
   shares, and a pool-share token that is itself an Omnipool asset carries its farm on the
   Omnipool item for that id.
10. **GIGAHDX staking APR** (`GET /v1/staking/gigahdx/apr`): `totalAprPerc = baseAprPerc +
    votingAprPerc`, each stream at `max(measured, programme floor)`. The wire carries exactly
    the UI's fields — the three percentages plus the two personalization terms
    (`paidOutPerYear`, `medianWeightedVotes`) and `asOf`; the internal terms (floors, measured
    components, window bookkeeping) are additive later if a surface needs them, per the
    /v1 rule.
    **Voting — realized, not projected**: `100 × 8 × paidOutPerYear / medianWeightedVotes`,
    where `paidOutPerYear` is the HDX actually paid into referendum reward pools
    (GigaHdxRewards.RewardPoolAllocated events, `gigahdx_reward_allocations`) over a trailing
    60-day window clamped to the GIGAHDX launch (2026-07-01), annualized by block timestamps
    (never blocks × an assumed block time), and `medianWeightedVotes` is the window's upper
    median of per-referendum `totalWeightedVotes`. ×8 is the Locked6x reward multiplier; the
    headline is the zero-stake limit and the personalized rate is
    `100 · paidOutPerYear · s·m / (medianWeighted + s·m) / s`, computed client-side.
    Chosen over the two rejected alternatives deliberately: the pallet DELETES its
    per-referendum storage as voters claim (a storage-sampled rate cliffs to its floor when the
    last pool is claimed off — observed live, 23.8 % → 8.7 % in 2 h on 2026-08-11), and the
    accumulator pot's balance is a growing backlog (a pot-stock × refs/yr rate inflates without
    bound while inflow outruns allocation). Events can do neither. The realized rate lags a
    building backlog (understates the forward rate while inflow > allocations) and decays
    gradually while governance is quiet — both are stated, not hidden.
    **Base — exchange-rate appreciation**: the median of the 7/14/28-day slopes of the gigaHDX
    rate `max(1, (TotalLocked + gigahdx! pot) / stHDX supply)`, each annualized by timestamps.
    A median of three windows, not one two-point delta: a single anomalous boundary sample
    would otherwise move the annualized figure ×13 at 28d. Windows longer than the pallet's age
    are skipped, so the base is floor-only in its first 7 days (the launch gate). Both rate
    endpoints are exact integer reconstructions — TotalLocked and supply from the deduplicated
    `gigahdx_stake_events` flows (Σ Staked + Σ YieldRealized − Σ Unstaked; MigratedFromLegacy
    is excluded because every migration double-emits Staked, verified on the full history;
    TotalLocked matched pallet storage to 3e8 planck on 1.24e21 at rollout), the pot from
    `account_balance_history`.
    **Floors** = `100 × programmePerYear / totalStake` per stream, from the treasury drips
    (4,109.59 HDX / 600 blocks base, 6,164.38 voting ≈ 36 M + 54 M HDX/yr at the 6 s cadence,
    HDX ref #101). The programme is a fixed schedule ending ~mid-2027, so the floors are
    guaranteed only while it runs; the measured terms follow a programme change with their
    windows' lag. A stream with neither term is null, and a total missing a stream is null —
    never a zero standing in for one.

## Caching

| Route group | in-process | HTTP max-age |
|---|---|---|
| status/metadata | 3 s cached | 3–5 |
| accounts balances / trades / DCA lists | 3 s cached, head-tagged keys | 3 |
| balance-history | 60 s swr 300 s | 60 |
| MM events | 5 s | 5 |
| prices pair | 5 s | 5 |
| pool volumes | 60 s swr 300 s | 60 |
| yield | 600 s swr 1800 s | 600 |
| platform stats | 60 s swr 300 s | 60 |
| assets | 300 s | 300 |
| proxies | 60 s–10 min per upstream | passthrough (no nginx cache) |

Uncached paths must be bounded first (selective ORDER BY on the new MVs, primary-key predicates);
cache keys include the version prefix and normalized params; deliberate cardinality (cap
`accounts=` batch keys by sorting the list).

## Testing

- Route contract tests per endpoint (`app.inject`, fake ClickHouse client dispatching on SQL
  substrings — `api/tests/indexerRoute.test.ts` template), pinning exact response shapes.
- OpenAPI document test: builds the server, asserts `/openapi.json` contains every /v1 route and
  that response schemas validate the same fixtures the contract tests use.
- Isolation test (import walker) as described above.
- MV tests: replay-idempotence fixtures, ExactOut inversion, fee-destination extraction, venue and
  pool_key mapping for every filler type, legacy/modern era boundary.
- Semantics unit tests: netting rule, APR/APY math (pinned numeric examples), unpriced-asset
  fallbacks, window anchoring.
- Pagination boundary tests (consecutive pages, no overlap/gap, offset caps).
- `npm --prefix api run check` covers all of it (public tests live in `api/tests/public/`).

## Rollout

1. Schema files land; on the live deployment the new MVs are backfilled with one-time ad-hoc
   `INSERT…SELECT` mirroring each MV (replay-safe; not committed) — per AGENTS.md.
2. `docker compose build api-public api-public-nginx && docker compose up -d --no-deps
   api-public api-public-nginx` — never recreating ClickHouse/ingestion.
3. Verify: service logs, `/docs`, cache-controlled curl profile of every endpoint (cold + warm),
   `system.query_log` reads for the heavy ones, parity spot-checks against
   orca-prod-pool-01 (expected diffs = documented deviations).
4. External reverse proxy + public hostname wiring is a host-side step (outside repo).

## AGENTS.md extension (same change set)

Add a "Public API" subsection: the public surface is a versioned frozen contract (additive-only
within /v1; breaking changes require /v2); every public route carries zod schemas + OpenAPI and a
documented Cache-Control; the `api/src/public/**` import allow-list; semantics deviations live in
this spec and must stay in sync with Swagger descriptions; the check commands are unchanged.

## Phase 2 — external feeds & full-network coverage (added 2026-08-12, approved)

Goal: this API becomes the only data provider the network needs. Everything below lives on
the same `api-public` service, same conventions, same isolation rules. External-facing
facades mirror the exact shapes their consumers already parse (base-URL swap, zero consumer
code change); first-party additions follow the /v1 conventions.

### Legacy-era trade projection (unblocks DefiLlama backfill)

Extend `clickhouse/schema/006_public.sql` with pre-Broadcast MVs (`block_height <
6_837_788`) into the SAME `pool_swap_legs` table: `Omnipool.SellExecuted/BuyExecuted`
(assetFeeAmount → fee leg on asset_out, but on asset_in for a `BuyExecuted` below block
4 221 778, where the pre-upgrade runtime charges the fee in the asset entering the pool —
measured: 25 913 of 25 913 such buys below that height read as a fraction of amountIn and
265 339 of 265 421 at or above it read as a fraction of amountOut, with no buy between the last
of one and the first of the other; protocolFeeAmount → fee leg on asset 1),
`Stableswap.SellExecuted/BuyExecuted` (poolId; `fee` on asset_out for Sell and asset_in for Buy),
`XYK.SellExecuted/BuyExecuted` (pool account; feeAsset/feeAmount), `LBP.*` if present.
Venue from the pallet; `op_key` = '' (no Router-id in that era — Router.Executed grouping
optional later); `swapper` = who. Verify arg names per spec_version in `src/types/`.
One-time uncommitted backfill at rollout; every endpoint documents the full era and the legacy
Omnipool hub-shape exception.

### Money-market read models (unblocks fees page + platform TVL)

New `clickhouse/schema/007_money_market_history.sql`:
- `money_market_reserve_rates` — MV from `raw_money_market_reserves`
  (`ReserveDataUpdated`): pool_address, reserve_address, block_height, event_index,
  block_timestamp, liquidity_rate UInt256, variable_borrow_rate UInt256 (RAY units,
  extracted from metrics_json), ingested_at. ORDER BY (pool_address, reserve_address,
  block_height, event_index).
- `money_market_reserve_state_history` — reserve-level supply/debt over time (from the
  reserve events' scaled totals or the atoken anchor+delta model — implementer picks the
  cheapest correct source and documents), enough to serve per-reserve TVL history and
  current `moneyMarketSupplyUsd`.

### CoinGecko facade (shapes fixed by CoinGecko's DEX ticker spec)

- `GET /coingecko/v1/tickers` — array of `{ticker_id, base_currency, target_currency,
  last_price, base_volume, target_volume, pool_id, liquidity_in_usd, high, low}` per active
  pool-pair over rolling 24h, from `pool_swap_legs` (+ registry symbols/decimals + pool
  reserves for liquidity_in_usd — the field the old feed hardcoded to 0). Cached/SWR 60s,
  max-age 60; never a 503-on-cold (compute on demand). Field names, field ORDER and field TYPES
  are the old feed's: `last_price`, `base_volume`, `target_volume`, `liquidity_in_usd`, `high`
  and `low` are JSON numbers, the other four strings (probed field-by-field against the live old
  feed), which makes this another inherited-contract exception to Wire conventions. Every
  computation behind them is exact integer arithmetic at 18 decimals; the single float
  conversion happens at the wire. `last_price`, `high` and `low` are published BASE-PER-TARGET (how many base units one target unit buys) — the incumbent feed's orientation, which CoinGecko's integration for this exchange compensates by inverting on ingestion (verified 2026-09-08: CoinGecko's `last` equals the reciprocal of our `last_price` on 31 of 34 matched tickers). This is the reciprocal of the standard CoinGecko ticker definition (target per base); flipping it requires CoinGecko to drop their inversion in the same step. `base_volume`/`target_volume` are each side's own units. The ROW MODEL is CoinGecko's, not the old feed's: each POOL is
  a market, so the row key is the `(ticker_id, pool_id)` composite and a pair traded in several
  pools has one row per pool with its own depth — where the old feed emitted one row per pair with
  `pool_id` repeating `ticker_id`. That composite MUST be unique, which constrains naming: a pool's
  own share token keeps its OWN registry symbol wherever the `SHARE_TOKEN_UNDERLYING_ID` alias would
  name a symbol a DIFFERENT asset of the same pool already claims. Without that rule pool 146
  published its underlying pair and its share pair under one `HOLLAR_apyUSD` key at prices 36%
  apart (1.3447 over 61 fills; 0.9855 over 3), which is the same mislabelling the incumbent made
  with `DOT_vDOT`. The rule is scoped to real collisions rather than applied to every share token:
  measured over a live 24-hour window, scoped changes exactly one published `ticker_id` while
  unconditional renaming changes eleven, including the already-announced `DOT_GDOT` and `ETH_GETH`.
- `GET /coingecko/v1/totalsupply/:token` for `hollar|gigadot|gigaeth|h2o` — plain number
  (match the old endpoint's exact body format). Supplies derived from ClickHouse (HOLLAR:
  the hollarSupplySql model; GDOT/GETH: ERC-20 mint−burn reconstruction from evm transfer
  deltas; H2O: total issuance from balances/omnipool state) — NO per-request RPC. max-age 300.

### DefiLlama facade (shapes fixed by their adapter)

- `GET /defillama/v1/volume` → `[{volume_usd}]` rolling 24h netted total.
- `GET /defillama/v1/backfill?startDate&endDate` → per-day
  `[{date, volume_usd, dailyFees}]` over the full era range (needs the legacy projection).
- Fee split fields as the adapter expects (document the 80/20, 50/50 splits it applies
  client-side — we serve raw totals + fee destinations honestly).

### DexScreener adapter (shapes fixed by DexScreener's public adapter spec)

`/dexscreener/latest-block`, `/dexscreener/asset?id=`, `/dexscreener/pair?id=`,
`/dexscreener/events?fromBlock&toBlock` — implementer verifies exact field names against the
published DexScreener adapter spec (fetch it) and the kril adapter's behavior. Events from
`pool_swap_legs` (swap) + `liquidity_activity` (join/exit); reserves-at-block from the pool
state history tables (600-block grid, nearest-at-or-before block, documented). Bounded:
block-range windows capped, max-age 5–15.

IDENTIFIERS are the kril adapter's, byte for byte, so an aggregator's existing per-pair history
survives a base-URL swap: an XYK pair id is the bare pool ACCOUNT; an Omnipool pair is
`<omnipool pallet account>-<asset0>-<asset1>`; a stableswap pair is `<pool account>-<asset0>-<asset1>`
(the pool's on-chain account, derived from the `filler` field of its own `Broadcast.Swapped*`
events, not its pool id); an ERC-20-registered asset is named by its contract address (from the
registry's `assetType=Erc20` plus a `parents=0`/`X1`/`AccountKey20` `LocationSet`), not its
registry id; and the two sides are ordered CLASS-FIRST and then by integer value — a plain registry
id always precedes a contract address, registry ids ascending among themselves, contracts ascending
among themselves. The class flag is explicit rather than implied by a contract's 160-bit value
exceeding 2^32: a registry location naming an address below 2^32 would otherwise silently flip a
pair's orientation, and orientation decides whether `priceNative` is a price or its reciprocal.
`/asset` and `/pair` accept both asset-id forms and the legacy pool-component shapes, and always
answer with the canonical id.

TWO fields deliberately differ from kril, and neither affects the stream as EMITTED. `txnId` VALUES
are ours (the extrinsic, the router operation, or the event) rather than kril's chain operation id
(the outermost non-DCA `operationStack` entry) — reproducing kril's would need that operation id
projected into `pool_swap_legs`, and it is opaque to DexScreener anyway. `txnIndex` SEMANTICS: ours
is constant 0 with `eventIndex` carrying the whole order, which is the true on-chain order, because
two thirds of fills are hook-dispatched with no extrinsic and sort after the block's extrinsic
events; kril's is a per-ROUTE hop counter restarting inside each `txnId` group (measured 0..n-1 in
229 of 229 groups), which does not order a block across routes. A consumer that SORTS by
`(txnIndex, eventIndex)` therefore gets different sequences from the two feeds (measured 60 of 100
blocks; kril's own emitted order disagrees with that key in the same 60) — a deliberate correction,
not a match. `/dexscreener/asset` serves a subset of kril's optional fields: no `totalSupply`,
`circulatingSupply` or `metadata.assetType`, none of which this index can produce for every asset.

### Revenue / fees page (drop-in for the metrics aggregator)

`GET /api/v1/fees/charts?productType=&feeDestination=&streamType=&startTime=&endTime=&bucketSize=`
mirroring `hydration-metrics-aggregator` exactly (the UI zod-parses
`{ data: [{timestamp: string, value: number}], periodAggregate: number }`; bucketSize
`1hour|6hour|24hour|7day|30day`). Streams: `asset` and `protocol` trade fees (from
`pool_swap_legs` fee legs by destination), `liquidation_penalty` (the aToken
`BalanceTransfer` into the Aave collector inside each liquidation's block — the fee that
physically moved, per event; NOT the incumbent's figure, which was measured booking ~20x
the transferred fee on cascade days), `pepl_liquidation_profit`,
`hsm_revenue` (the HSM's stablepool arbitrage profit — its own `pool_swap_legs` fill,
HOLLAR at face and peg collateral at parity, admitted by an `HSM.ArbitrageExecuted`
block+amount match — plus buyback fees per the module's fee-configuration history; its
`periodAggregate` is the incumbent's MEAN rule), `borrow_apr` (from
`money_market_reserve_state_history`, the exact accrual identity), `asset_reserve` —
implementer maps each stream against what the aggregator serves today and documents any it
cannot reproduce (explicit 400 with a clear message, never fake zeros). USD values
event-time priced. Its values are JSON numbers (their
contract), which makes it one of the inherited-contract exceptions to Wire conventions — with
`/coingecko/v1/tickers`, `/defillama/v1`, `/hydration-web/v1` and `/lending/v1`, each of which
reproduces a shape this API did not write.

### hydration.net stats + lending caps

- `GET /hydration-web/v1/stats` — the old HydraDX-api response shape exactly:
  `{tvl, vol_30d, xcm_vol_30d, assets_count, accounts_count}` as JSON numbers (the field is
  `vol_30d`, not 24h). max-age 600, the incumbent's Redis TTL.
  - `tvl` = pooled TVL + the money market's supplied side, de-duplicated in BOTH directions:
    minus `moneyMarketFoldedUsd` (market collateral that is pool-share tokens) and minus
    `pooledATokenUsd` (pool reserves that are money-market aTokens — the pools are suppliers
    too). Staking-backed stHDX stays in: no pool holds it. Folded from the exact strings
    /v1/stats/platform publishes, so the two reconcile to the cent; see the conservation
    equation under "Platform stats".
  - `vol_30d` = the netted routed total over 30 days. `routedTradesUsd`'s row-per-trade fold
    cannot reach 30 days (200 301 trades against the client's 100 000-row cap), so the
    `greatest(side_in, side_out)` fold moves into SQL over the shared `routedNettedCteSql`,
    pinned against `nettedTradeScaled` in tests. Measured 1.8 s cold. It runs ~0.350× the
    incumbent's per-fill figure (measured 2026-08-13: $18.90 M against $53.97 M) for the
    netting reasons in Semantics 2. Null, not `0`, while no swap leg is indexed at all.
  - `xcm_vol_30d` = Ocelloids `POST /query/xcm` `{op:'transfers_total', criteria:{timeframe:
    '1 months', network:'urn:ocn:polkadot:2034'}}` → `items[0].volumeUsd.current` (there is no
    "30 days" timeframe; "1 months" is it, and an invalid op returns 200 with `{"items":[]}`,
    so exactly one item is asserted). Verified against the incumbent to 0.11%. Null without
    `EXPLORER_OCELLOIDS_TOKEN` or on failure past a bounded grace window; never estimated.
  - `assets_count` is the registry (measured 2026-08-13: 123 against the incumbent's 443, whose
    indexer carries non-registry assets); `accounts_count` is accounts that have ever held a
    balance, so it only grows.
- `GET /lending/v1/caps` — per-reserve supply/borrow caps + current utilization, a superset of
  the old shape. max-age 60. No per-request RPC or GraphQL: Aave caps are decoded from the pool
  configurator's UNDECODED `SupplyCapChanged`/`BorrowCapChanged` logs in `raw_evm_logs` (87 cap
  events + 27 `ReserveInitialized`, read by topic in ~0.18 s, denominated in whole tokens), and
  HOLLAR — which has no Aave cap because it is minted, not deposited — takes its market's
  facilitator bucket capacity from `FacilitatorAdded`/`FacilitatorBucketCapacityUpdated`. A
  facilitator IS a market's HOLLAR aToken (verified against `atoken_reserve_map`), which is what
  attributes a capacity to a market and excludes the HSM pallet's facilitator. `currentBorrow`
  is the reserve's debt from `money_market_reserve_state_current` — the same quantity the
  incumbent read as the variable-debt token's `totalSupply`, verified equal to the interest
  accrued between the two reads. The incumbent returned exactly one element (core HOLLAR), so
  that row stays at index 0.

### First-party /v1 additions (retire the archive indexer + Grafana for the UI)

- `GET /v1/extrinsics/:hash` and `GET /v1/extrinsics/:blockHeight/:index` — success/error +
  block/timestamp, for transaction toasts (from raw_extrinsics; runtime error names via the
  existing runtimeErrorNames service if allow-listed, else raw error JSON).
- `GET /v1/otc/orders/:orderId` — typed order state from `otc_order_events` (placed
  amounts, fills, partial-fillable, open/filled/cancelled).
- `GET /v1/staking/events?types=AccumulatedRpsUpdated,StakingInitialized&from=&limit=` —
  the two event streams the staking UI scrapes, typed from raw_events.
- Farm APR: fill `farmAprPerc` on both yield endpoints from `farm_config_events` (fold
  GlobalFarm/YieldFarm state per pool/asset: reward rate × reward-asset price / TVL,
  annualized; loyalty ignored — document) — the UI can drop its client-side SDK farm math.
- `moneyMarketSupplyUsd` in `/v1/stats/platform` from the new MM reserve state model.
- `GET /v1/staking/gigahdx/apr` — the GIGAHDX staking rate, base + voting, from
  `gigahdx_reward_allocations` + `gigahdx_stake_events` + `account_balance_history`
  (Semantics 10), replacing the UI's chain-storage sampling (whose per-referendum entries are
  deleted as voters claim), its ~400-read referendum scan, and its balance-scanner fallback
  with one cached read.

### Explicitly out of scope

Multix (cross-chain multisig discovery — different domain), DefiLlama TVL (their own
service), Kamino/DeFiLlama-yields third-party data (already proxied).

## Phasing (implementation)

- **Phase 1a** (agent): ClickHouse models + validation tests.
- **Phase 1b** (agent, parallel): service skeleton — server.ts, swagger/zod plumbing, cache
  headers, rate limit, compose + nginx sidecar, `/rest/service/*`, `/v1/status`, `/v1/assets`,
  `/proxy/*`.
- **Phase 2** (two agents after 1b): (a) accounts group (balances, balance-history, MM events);
  (b) trades/DCA/prices group.
- **Phase 3** (agent after 1a+1b): volumes, yield, platform stats.
- **Phase 4** (main loop): AGENTS.md, README service table, live deploy + verification.

Nothing is committed until the user has reviewed the full working tree.
