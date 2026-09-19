# Hydration Neckwork

Hydration Neckwork is a ClickHouse-backed data platform containing two applications: the Explorer and Preis. It combines a block-level USD price indexer, a raw on-chain data lake, a shared API, a live block explorer, and market charts, plus three machine-facing read surfaces over the same dataset.

## Product surfaces

- **Explorer:** blocks, extrinsics, events, assets, holders, accounts, identities, tags, proxies, multisigs, verified EVM contracts, and portfolio history.
- **Activity:** transfers, swaps, DCA schedules, OTC orders, cross-chain activity, liquidity, money markets, staking, and governance votes.
- **Protocol dashboards:** HDX supply, locks, flows, and unlocks; HOLLAR peg, Stability Module, and liquidity; protocol revenue by stream; governance referenda.
- **Security:** circuit-breaker limits and their consumption, deposit lockdowns, paused calls, tradability freezes, money-market solvency, and the origins that can lift each control.
- **Alerts:** per-account notification rules delivered to web push or Telegram, evaluated forward from the live ingestion head.
- **Preis charts:** block-level USD prices and OHLCV candles for Hydration assets.
- **API:** Fastify endpoints for explorer data, prices, candles, volume, and indexer status — plus three separate, independently contracted processes over the same read models: the versioned **public REST API** for the Hydration UI and external feeds, the token-authenticated **Data API** for external developers, and an **MCP server** that serves LLM agents the interpreted dataset.

## Quick start

The containerized stack requires Docker with Compose. Local development additionally requires Node.js 22+.

```bash
git clone https://github.com/1xGiraffe/hydration-neckwork.git
cd hydration-neckwork
docker compose up --build -d
```

Local services:

| Service | URL | Purpose |
| --- | --- | --- |
| Explorer | <http://localhost:5174> | Live chain explorer and protocol dashboards |
| Preis | <http://localhost:5173> | Asset price and OHLCV charts |
| API | <http://localhost:3000> | Explorer and market-data API |
| Public API | <http://localhost:3002> | Versioned REST API for the Hydration UI and external feeds (Swagger at `/docs`) |
| Public API cache | <http://localhost:8081> | nginx micro-cache in front of the public API |
| Data API | <http://localhost:3003> | Token-authenticated REST API for external developers (Scalar portal at `/docs`) |
| MCP server | <http://localhost:3004> | Model Context Protocol endpoint for LLM agents (`POST /mcp`, orientation at `/llms.txt`) |
| ClickHouse HTTP | <http://localhost:18123> | Local database endpoint |

Every port binds to `127.0.0.1`: the services are reached through a reverse proxy on
the Docker network, so publishing them on all interfaces would only offer a way past
its caching, rate limiting and logging.

The remaining sixteen services run without a port of their own: the raw/live ingestion
and snapshot tier, `schema-bootstrap`, `derivations`, `smart-contract-verifier` (which
compiles and matches submitted contract sources), and `user-backup`/`contract-backup`,
which export the two api-authored datasets no projection rebuild can regenerate.

The live pipelines start immediately. Historical ingestion continues in the background, so a fresh installation fills older explorer and price history over time.

Useful status commands:

```bash
docker compose ps
docker logs -f hydration-neckwork-ingestion-supervisor
docker exec -it hydration-neckwork-clickhouse clickhouse-client \
  --database=price_data --password "${CLICKHOUSE_PASSWORD:-dev}"
```

## Architecture

```text
SQD archive + Hydration RPC
          │
          ├─ raw-live + supervised backfill ── raw chain and derived tables
          └─ live + historical price indexers ─ prices and OHLCV
                                             │
                                         ClickHouse
                                             │
                  ┌──────────────────────────┴──────┬─────────────────────────┐
         Fastify API (:3000)               Public API (:3002)         Data API (:3003)
      ┌───────────┼────────────┐                    │                         │
 Explorer UI  Preis UI    MCP (:3004)      nginx cache (:8081)        developer tokens
   (:5174)     (:5173)    LLM agents      Hydration UI / feeds          (API tokens)
```

- `src/` contains the price and raw-data indexers, ingestion utilities, and maintenance scripts.
- `clickhouse/schema/` is the single declarative schema (tables + materialized views), applied once to an empty database by the `schema-bootstrap` service — see [Database model](#database-model). There are no migrations.
- `api/` serves indexed data through cached read models; Compose snapshot services refresh bounded current-state datasets. It is one image running five processes: the explorer `api`, plus three independently contracted external surfaces and the `derivations` worker.
  - `api/src/public/` — the `api-public` service, a versioned REST contract for the Hydration UI and external feeds.
  - `api/src/data/` — the `api-data` service, a token-authenticated, per-account rate-limited REST surface for external developers.
  - `api/src/mcp/` — the `api-mcp` service, a Model Context Protocol surface for LLM agents. It owns no tables and no SQL: every answer is an HTTP call to the explorer `api`, so a number an agent reads is the number the Explorer page shows.
  - Each tree's imports are pinned by an isolation test, so the private `user_*` tables stay unreachable from the external surfaces. See the Public API, Data API, and MCP server sections in [AGENTS.md](AGENTS.md).
- `explorer-ui/` is the block explorer; `preis-ui/` is the price-chart application.
- `ops/` contains the ingestion supervisor's image and the nightly backup scripts; the
  supervisor script itself is `scripts/ingestion-supervisor.sh`.

Historical raw ranges are finalized only after block counts and parent links validate. The supervisor promotes completed raw ranges into the price index and maintains the live pipelines. Writes and checkpoints are designed for replay and crash recovery.

## Configuration

Docker Compose provides working defaults. Override them in an untracked `.env` file when needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPC_URL` | `https://hydration-rpc.neckwork.net` | The one Hydration RPC. Every service and every supervisor-spawned worker reads it, for both substrate calls and the Money Market's `eth_call` reads — Hydration answers both on the same endpoint. Historical ranges and money-market position reads need an archive node |
| `IDENTITY_CHAINS` | Polkadot/Kusama People chains and their testnets | Extra identity sources, `key=url[@block]` and highest display priority first; empty for Hydration only |
| `SQD_GATEWAY` | Hydration SQD archive | Historical block source |
| `CLICKHOUSE_HOST` | `http://localhost:18123` outside Compose | ClickHouse HTTP endpoint |
| `CLICKHOUSE_PASSWORD` | empty outside Compose; `dev` in Compose | ClickHouse password |
| `CLICKHOUSE_VOLUME_NAME` | `hydration-neckwork-clickhouse-data` | Docker volume containing ClickHouse data |
| `RAW_WORKERS` | `6` | Concurrent raw historical workers |
| `RANGE_SIZE` | `1000` | Blocks per raw historical range |
| `MAIN_WORKERS` | `3` | Concurrent historical price workers |
| `MAIN_MAX_RANGES` | `3` | Raw ranges consumed per price batch |
| `VITE_EXPLORER_URL` | local fallback | Public Explorer URL embedded in Preis UI |
| `VITE_PREIS_URL` | local fallback | Public Preis URL embedded in Explorer UI |
| `EXPLORER_PUBLIC_URL` | unset; deployment host for `api-mcp` | Public Explorer origin the API and the MCP records link back to |
| `EXPLORER_OCELLOIDS_TOKEN` | unset | Enables optional XCM journey enrichment |
| `PUBLIC_API_MASTER` | `true` | `master` flag in the public API's `/rest/service/metadata` probe |
| `ADMIN_ACCOUNT_IDS` | empty | Accounts that reach the Data API's admin surface and are exempt from its rate limits |
| `DATA_API_DEFAULT_PER_MINUTE` / `_PER_DAY` | service defaults | Default per-account Data API rate limits; per-account overrides live in `user_api_limits` |
| `MCP_ACCESS_KEYS` | empty | Comma-separated bearer keys for `POST /mcp`. Empty means open, which is the default posture: every tool reads public chain data only |

See [`docker-compose.yml`](docker-compose.yml) for service-specific tuning variables. Keep credentials in `.env`, never in tracked files. Vite URL changes require rebuilding the corresponding UI image.

### Host-specific Compose overrides

For changes that are not simple environment values—such as ports, networks,
volumes, commands, or build settings—create a gitignored
`docker-compose.override.yml` beside `docker-compose.yml`. Docker Compose loads
and merges it automatically:

```yaml
services:
  clickhouse:
    ports: !override
      - "127.0.0.1:28123:8123"

  ingestion-supervisor:
    environment:
      RAW_WORKERS: ${RAW_WORKERS:-2}
```

Compose normally appends list values such as `ports`; `!override` replaces the
tracked list instead. Inspect the fully merged configuration before starting it:

```bash
docker compose config
docker compose up --build -d
```

The ingestion supervisor starts historical `indexer` and `raw-indexer` workers
through Compose from inside its container. If the override changes either worker
service, mount the file into the supervisor so those dynamically created workers
inherit it:

```yaml
services:
  ingestion-supervisor:
    volumes:
      - ./docker-compose.override.yml:/etc/hydration-neckwork/docker-compose.override.yml:ro
```

Keep credentials in `.env`; do not put them in the override file.

## Querying prices

The query views support point-in-time prices, continuous block ranges, timestamp lookup, and OHLCV at 5-minute, 15-minute, 30-minute, 1-hour, 4-hour, 1-day, 1-week, and 1-month intervals.

```sql
SELECT *
FROM price_data.price_at_block(asset_id=5, block_height=7000000);

SELECT *
FROM price_data.ohlc_1h_query(
  asset_id=5,
  start_time='2026-01-01 00:00:00',
  end_time='2026-01-31 23:59:59'
);
```

See the [ClickHouse query guide](clickhouse/docs/QUERY_GUIDE.md) for the complete SQL reference.

## Development

Install each workspace, then run the repository-wide checks:

```bash
npm ci
npm --prefix api ci
npm --prefix explorer-ui ci
npm --prefix preis-ui ci
npm run check:all
```

Browser tests are separate because they require the relevant services:

```bash
npm --prefix explorer-ui run test:e2e
npm --prefix preis-ui run test:e2e
```

Common indexer commands:

```bash
npm start -- --help
npm run start:raw -- --help
npm run detect-gaps
npm run snapshot:balances -- --dry-run
```

## Database model

The blockchain is the source of truth; every table is a reproducible projection of
it, so the database is disposable and rebuildable — **there are no migrations**.

- **Schema is declarative.** `clickhouse/schema/*.sql` defines every table and
  materialized view (MV). The `schema-bootstrap` service applies it — in numeric
  order, idempotently (`CREATE ... IF NOT EXISTS`) — to an empty database **before**
  ingestion starts. Because the MVs exist first, every MV-backed read model populates
  itself as raw data is indexed, in any order, with **no backfill**.
- **Derived data comes from four places,** in order of preference. Most read models are
  **MVs** (automatic, and complete as soon as raw is). A per-entity stateful model an MV
  cannot express is **reconstructed at request time** from account-first tables, or kept
  in a small in-memory snapshot on the API's coordinated refresher (account-directory
  values). A **swept per-entity model** (`account_activity_totals`) holds a value whose
  definition lives in application code and cannot be afforded per request; entities are
  recounted one at a time, ordered by staleness, and the read path renders without the
  ones not yet swept. The **`derivations` service** runs the nine global, heavy models
  none of the above can express — per-trade netting, the hourly swap pre-aggregate, v3
  legs, revenue, XCM arrivals, and the stateful LP-history reconstructions — recomputing
  them continuously and idempotently, partition-incrementally or by atomic full replace.
- **To change a model, edit the declaration and rebuild the projection** — drop the
  table/MV and let it refill from raw, or reset the derived layer and let it rebuild.
  Never write an in-place migration; there is no version ledger.

Fresh-install order (enforced by Compose `depends_on`): `clickhouse` healthy →
`schema-bootstrap` completed → everything else in parallel. Ingestion, `derivations` and
`api` deliberately have no edges between them: each is correct against whatever raw is
indexed at the time, which is the point of the schema-first design above. `api-mcp` is
the one service with no schema edge at all — it never touches ClickHouse, and waits only
for `api` to start, not to be healthy, so the container name resolves. Applying the
schema to a non-empty database is a safe no-op, so redeploying never risks existing data.

## Operational safety

- Keep ClickHouse data and checkpoints together; do not wipe tables to resolve an ingestion problem.
- Let `ingestion-supervisor` own its dynamically created historical workers. Do not manually start or stop those containers.
- Use bounded, explicit block ranges and distinct pipeline IDs for manual backfills.
- Change a model by editing `clickhouse/schema/` and rebuilding that projection from raw; never patch derived data in place, and never wipe raw to fix a derived model.
- Back up the ClickHouse volume before production schema or checkpoint maintenance.

## License

ISC
