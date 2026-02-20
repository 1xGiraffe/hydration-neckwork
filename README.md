# preis

Block-level USDT price indexer for Hydration DEX

- Indexes every tradeable asset's USDT price at every block from genesis to live
- Supports Omnipool, XYK, and Stableswap pool types
- Sub-second query performance (point queries <100ms, range queries <1s)
- OHLCV candlestick data (with trading volume) at 5 intervals (5min, 15min, 1h, 4h, 1d)
- Backfills via SQD archive gateway, follows chain head in real-time
- ClickHouse storage with ReplacingMergeTree deduplication

## Architecture

preis uses SQD SubstrateBatchProcessor to ingest blockchain data, calculates prices in TypeScript, and stores results in ClickHouse. Historical data comes from SQD's archive gateway for fast bulk ingestion. Live data follows the chain head via HotDatabase.

Writes are batched to ClickHouse. Checkpoints are persisted for crash recovery. Block parent hashes are validated to detect reorgs. On shutdown, pending data is flushed before exit.

## Prerequisites

- Node.js 22+
- Docker and Docker Compose
- (Optional) ClickHouse client for direct queries

## Quick Start

1. Clone the repository:
```bash
git clone https://github.com/1xGiraffe/hydration-preis.git
cd hydration-preis
```

2. Start ClickHouse and the indexer:
```bash
docker compose up -d
```
The indexer starts from genesis (or resumes from its last checkpoint) and logs progress as it processes blocks.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| RPC_URL | wss://hydration.dotters.network | WebSocket RPC endpoint |
| CLICKHOUSE_HOST | http://localhost:18123 | ClickHouse HTTP endpoint |
| CLICKHOUSE_PASSWORD | (empty) | ClickHouse password |

## CLI Usage

```bash
# Resume from checkpoint (or start from genesis)
npm start

# Start from specific block
npm start -- --from-block=1000000

# Process a specific range
npm start -- --from-block=1000000 --to-block=1100000

# Rollback data to a block height
npm start -- --rollback-to-block=1000000

# Detect gaps in indexed data
npm run detect-gaps

# Show help
npm start -- --help
```

## Querying Prices

For advanced queries including cross-pair OHLC derivation and weekly/monthly candles, see [clickhouse/docs/QUERY_GUIDE.md](clickhouse/docs/QUERY_GUIDE.md).

### Connecting to ClickHouse

```bash
docker exec -it preis-clickhouse clickhouse-client --database=price_data
```

### Point Query: Price at a Block

```sql
SELECT * FROM price_data.price_at_block(asset_id=5, block_height=7000000);
```

By symbol:
```sql
SELECT * FROM price_data.price_at_block_by_symbol(symbol='DOT', block_height=7000000);
```

### Range Query: Price Series

Continuous price series over a block range, with LOCF gap-filling (one row per block, no gaps):
```sql
SELECT * FROM price_data.price_range(asset_id=5, start_block=7000000, end_block=7001000);
```

### Timestamp Query: Price at Wall-Clock Time

Finds the nearest block within a +/-1 hour window:
```sql
SELECT * FROM price_data.price_at_timestamp(asset_id=5, target_timestamp='2024-12-01 12:00:00');
```

### OHLC Candlestick Data

```sql
SELECT * FROM price_data.ohlc_1h_query(
    asset_id=5,
    start_time='2025-01-01 00:00:00',
    end_time='2025-01-31 23:59:59'
);
```

Available intervals:
- `ohlc_5min_query` -- 5-minute candles
- `ohlc_15min_query` -- 15-minute candles
- `ohlc_1h_query` -- 1-hour candles
- `ohlc_4h_query` -- 4-hour candles
- `ohlc_1d_query` -- 1-day candles

All timestamps are UTC, aligned to standard interval boundaries.

Each OHLCV query returns volume data alongside OHLC prices:
- `volume_buy` -- Total USDT value of buy-side volume (asset acquired)
- `volume_sell` -- Total USDT value of sell-side volume (asset sold)
- `volume_total` -- Combined USDT volume (buy + sell)

All volume values are denominated in USDT for cross-asset comparability.

### Cross-Asset Comparison

Pivot query comparing multiple assets across a block range:

```sql
SELECT
  block_height,
  round(maxIf(usdt_price, asset_id = 5), 8) AS dot_price,
  round(maxIf(usdt_price, asset_id = 10), 8) AS usdt_value,
  round(maxIf(usdt_price, asset_id = 0), 8) AS hdx_price
FROM price_data.prices FINAL
WHERE asset_id IN [5, 10, 0]
  AND block_height BETWEEN 7000000 AND 7000500
GROUP BY block_height
ORDER BY block_height ASC
WITH FILL FROM 7000000 TO 7000501 STEP 1
  INTERPOLATE (dot_price, usdt_value, hdx_price);
```

For the complete query reference including cross-pair OHLC derivation and weekly/monthly candles, see [clickhouse/docs/QUERY_GUIDE.md](clickhouse/docs/QUERY_GUIDE.md).

## Database Schema

| Table | Engine | Description |
|-------|--------|-------------|
| prices | ReplacingMergeTree | Asset prices by block (asset_id, block_height, usdt_price, volume_buy, volume_sell, volume_total) |
| blocks | MergeTree | Block metadata (block_height, block_timestamp, spec_version) |
| assets | ReplacingMergeTree | Asset registry (asset_id, symbol, name, decimals) |
| indexer_state | ReplacingMergeTree | Checkpoint persistence |
| runtime_upgrades | MergeTree | Runtime version transitions |
| ohlc_5min | AggregatingMergeTree | Pre-computed 5-minute OHLCV candles |
| ohlc_15min | AggregatingMergeTree | Pre-computed 15-minute OHLCV candles |
| ohlc_1h | AggregatingMergeTree | Pre-computed 1-hour OHLCV candles |
| ohlc_4h | AggregatingMergeTree | Pre-computed 4-hour OHLCV candles |
| ohlc_1d | AggregatingMergeTree | Pre-computed 1-day OHLCV candles |

The `prices` table uses `(asset_id, block_height)` ordering for efficient single-asset queries. All OHLC tables are automatically populated via materialized views when new prices are inserted.

## Development

```bash
npm install          # Install dependencies
npm test             # Run tests (vitest)
npm start            # Start indexer
npm run detect-gaps  # Check for missing blocks
```

## License

ISC
