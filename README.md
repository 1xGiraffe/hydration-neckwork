# Hydration Neckwork

Hydration Neckwork is a ClickHouse-backed data platform containing two applications: the Explorer and Preis. It combines a block-level USD price indexer, a raw on-chain data lake, a shared API, a live block explorer, and market charts.

## Product surfaces

- **Explorer:** blocks, extrinsics, events, assets, holders, accounts, identities, tags, proxies, multisigs, and portfolio history.
- **Activity:** transfers, swaps, DCA schedules, OTC orders, cross-chain activity, liquidity, money markets, staking, and governance votes.
- **Protocol dashboards:** HDX supply, locks, flows, and unlocks; HOLLAR peg, Stability Module, and liquidity.
- **Preis charts:** block-level USD prices and OHLCV candles for Hydration assets.
- **API:** Fastify endpoints for explorer data, prices, candles, volume, and indexer status.

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
| ClickHouse HTTP | <http://localhost:18123> | Local database endpoint |

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
                                      Fastify API (:3000)
                                         ┌───┴───┐
                                  Explorer UI   Preis UI
                                     (:5174)     (:5173)
```

- `src/` contains the price and raw-data indexers, ingestion utilities, and maintenance scripts.
- `clickhouse/schema/` contains ordered, idempotent schema initialization and migrations.
- `api/` serves indexed data through cached read models; Compose snapshot services refresh bounded current-state datasets.
- `explorer-ui/` is the block explorer; `preis-ui/` is the price-chart application.
- `ops/` contains the ingestion supervisor image.

Historical raw ranges are finalized only after block counts and parent links validate. The supervisor promotes completed raw ranges into the price index and maintains the live pipelines. Writes and checkpoints are designed for replay and crash recovery.

## Configuration

Docker Compose provides working defaults. Override them in an untracked `.env` file when needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPC_URL` | `https://rpc.hydradx.cloud` | Price indexer RPC |
| `RAW_LIVE_RPC_URL` | `https://rpc.hydradx.cloud` | Live raw-indexer RPC |
| `RAW_RPC_URL` | `https://rpc.coke.hydration.cloud` | Historical raw-worker RPC |
| `RAW_EVM_RPC_URL` | `https://rpc.coke.hydration.cloud` | Historical EVM state reads |
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
| `EXPLORER_OCELLOIDS_TOKEN` | unset | Enables optional XCM journey enrichment |

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

## Upgrading existing installations

The project and default container/image names changed from `hydration-preis` to
`hydration-neckwork`. Before starting the renamed stack, preserve an existing
ClickHouse volume by selecting its current name in `.env`; the conventional old
default was:

```bash
CLICKHOUSE_VOLUME_NAME=hydration-preis_clickhouse_data
```

The renamed stack mounts that volume directly; no copy is required. A fresh
installation should leave the variable unset and will use
`hydration-neckwork-clickhouse-data`. Stop the old Compose project before bringing
up the renamed one so its host ports do not overlap. Stop the supervisor first,
then the remaining containers carrying the old project label:

```bash
OLD_COMPOSE_PROJECT=hydration-preis
docker ps -q --filter "label=com.docker.compose.project=$OLD_COMPOSE_PROJECT" \
  --filter "label=com.docker.compose.service=ingestion-supervisor" \
  | xargs -r docker stop
docker ps -q --filter "label=com.docker.compose.project=$OLD_COMPOSE_PROJECT" \
  | xargs -r docker stop
docker compose up -d clickhouse
```

Keep the stopped old containers until the renamed stack and preserved ClickHouse
volume have been validated; remove them only as a separate cleanup step.

Installations created before the Explorer schemas must run the offline migrator
before starting the new services. It discovers every checked-in schema from the
selected baseline onward, rebuilds derived indexes from existing raw data,
validates the result, and upgrades checkpoint precision without discarding indexed
data. Back up the ClickHouse volume before scheduling the migration.

```bash
docker compose --profile worker stop \
  ingestion-supervisor api raw-live indexer raw-indexer \
  identity-snapshot balance-snapshot mm-snapshot \
  mm-supplemental-snapshot atoken-anchor
docker ps --format '{{.Names}}' \
  | grep -E '(main-live|main-backfill-|raw-backfill-)' \
  | xargs -r docker stop

docker compose build indexer
docker compose --profile worker run --rm --no-deps indexer \
  src/scripts/migrate-schema.ts --apply-offline --from-schema=29
```

Restart application services only after the command reports
`[schema-migrations] complete`. The command is idempotent and keeps replaced
checkpoint tables as `*_datetime64_backup` rollback copies. Then resume the normal
stack with `docker compose up --build -d`.

## Operational safety

- Keep ClickHouse data and checkpoints together; do not wipe tables to resolve an ingestion problem.
- Let `ingestion-supervisor` own its dynamically created historical workers. Do not manually start or stop those containers.
- Use bounded, explicit block ranges and distinct pipeline IDs for manual backfills.
- Stop writers before offline schema migrations, and validate the migration result before restarting services.
- Back up the ClickHouse volume before production schema or checkpoint maintenance.

## License

ISC
