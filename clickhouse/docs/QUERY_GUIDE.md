# ClickHouse query guide

Hydration Neckwork stores price data in the `price_data` database. The schema exposes
parameterized views for common price and OHLCV queries; use those views unless a
direct table query is necessary.

## Connect

Docker Compose exposes ClickHouse HTTP on port `18123` and the native protocol on
port `19000`:

```bash
docker exec -it hydration-neckwork-clickhouse \
  clickhouse-client --database=price_data --password "${CLICKHOUSE_PASSWORD:-dev}"
```

For a non-Compose deployment, pass the host, native port, database, and any
configured credentials to `clickhouse-client`.

## Price views

The views in `clickhouse/schema/006_query_views.sql` read the deduplicated
`prices` and `assets` tables.

### Price at a block

```sql
SELECT *
FROM price_data.price_at_block(
  asset_id=5,
  block_height=7000000
);
```

Parameters are `asset_id UInt32` and `block_height UInt32`. The result columns
are `asset_id`, `block_height`, and `usd_price`; the view rounds the price to
eight decimal places.

The symbol form resolves the current asset metadata first:

```sql
SELECT *
FROM price_data.price_at_block_by_symbol(
  symbol='DOT',
  block_height=7000000
);
```

`symbol` is a `String`. The result does not include the symbol. Symbols are not
historical identifiers, so prefer `asset_id` when reproducibility matters.

### Price range by block

```sql
SELECT *
FROM price_data.price_range(
  asset_id=5,
  start_block=7000000,
  end_block=7001000
);
```

All parameters are `UInt32`. The range is inclusive and the result columns are
`block_height` and `usd_price`. `WITH FILL ... INTERPOLATE` emits a row for each
block and carries an observed value forward. The view only reads observations
inside the requested range, so it does not seed leading missing blocks from a
price before `start_block`.

### Price near a timestamp

```sql
SELECT *
FROM price_data.price_at_timestamp(
  asset_id=5,
  target_timestamp='2026-01-15 12:00:00'
);
```

Parameters are `asset_id UInt32` and `target_timestamp DateTime`. The view finds
the nearest indexed block within one hour before or after the target, then
returns `asset_id`, `block_height`, and `usd_price`. It returns no row when no
matching block and price exist in that window.

To include the selected block timestamp:

```sql
SELECT p.*, b.block_timestamp
FROM price_data.price_at_timestamp(
  asset_id=5,
  target_timestamp='2026-01-15 12:00:00'
) AS p
INNER JOIN price_data.blocks AS b USING (block_height);
```

## OHLCV views

All OHLCV query views accept the same parameters:

- `asset_id UInt32`
- `start_time DateTime`, inclusive
- `end_time DateTime`, inclusive

They return:

- `asset_id`
- `interval_start`
- `open`, `high`, `low`, `close`
- `volume_buy`, `volume_sell`, `volume_total`

Prices and USD volumes use `Decimal128(12)` aggregate states. Native volumes are
not exposed by these OHLCV views. The current candle may be incomplete.

| Interval | Query view | Boundary |
| --- | --- | --- |
| 5 minutes | `ohlc_5min_query` | five-minute UTC interval |
| 15 minutes | `ohlc_15min_query` | fifteen-minute UTC interval |
| 30 minutes | `ohlc_30min_query` | thirty-minute UTC interval |
| 1 hour | `ohlc_1h_query` | hourly UTC interval |
| 4 hours | `ohlc_4h_query` | four-hour UTC interval |
| 1 day | `ohlc_1d_query` | UTC day |
| 1 week | `ohlc_1w_query` | ISO week, Monday start |
| 1 month | `ohlc_1m_query` | calendar month |

Example:

```sql
SELECT *
FROM price_data.ohlc_1h_query(
  asset_id=5,
  start_time='2026-01-01 00:00:00',
  end_time='2026-01-31 23:59:59'
);
```

Use the corresponding view name for another interval. Ordered definitions and
upgrade migrations live in `clickhouse/schema/`.

## Direct table queries

### ReplacingMergeTree tables

`prices` uses `ReplacingMergeTree(block_height)` ordered by
`(asset_id, block_height)`. Replayed writes can coexist until background merges
run, so direct correctness-sensitive reads must use `FINAL`:

```sql
SELECT
  asset_id,
  block_height,
  block_timestamp,
  usd_price,
  native_volume_buy,
  native_volume_sell,
  usd_volume_buy,
  usd_volume_sell
FROM price_data.prices FINAL
WHERE asset_id = 5
  AND block_height BETWEEN 7000000 AND 7001000
ORDER BY block_height;
```

The stored price and USD volume columns are `Decimal128(12)`; native volumes are
`Decimal128(0)`. The parameterized price views already apply `FINAL`.

`assets` is also a `ReplacingMergeTree`, so direct current-metadata queries use
`FINAL` as well:

```sql
SELECT asset_id, symbol, name, decimals
FROM price_data.assets FINAL
ORDER BY asset_id;
```

`blocks` is a `MergeTree` keyed by `block_height` and does not require `FINAL`.

### AggregatingMergeTree OHLCV tables

The underlying `ohlc_*` tables store aggregate states and may contain multiple
unmerged parts for one candle. Merge states while grouping by the complete
candle key:

```sql
SELECT
  asset_id,
  interval_start,
  argMinMerge(open_state) AS open,
  maxMerge(high_state) AS high,
  minMerge(low_state) AS low,
  argMaxMerge(close_state) AS close,
  sumMerge(volume_buy_state) AS volume_buy,
  sumMerge(volume_sell_state) AS volume_sell,
  sumMerge(volume_buy_state) + sumMerge(volume_sell_state) AS volume_total
FROM price_data.ohlc_1h
WHERE asset_id = 5
  AND interval_start BETWEEN '2026-01-01 00:00:00'
                         AND '2026-01-31 23:59:59'
GROUP BY asset_id, interval_start
ORDER BY interval_start;
```

The OHLCV query views already apply these `*Merge` combinators and grouping.

## Cross-asset queries

For several assets, keep `asset_id` in the result rather than deriving a pivot
with a fixed symbol list:

```sql
SELECT asset_id, block_height, usd_price
FROM price_data.prices FINAL
WHERE asset_id IN (0, 5, 10)
  AND block_height BETWEEN 7000000 AND 7000500
ORDER BY block_height, asset_id;
```

Do not derive exact pair-candle highs and lows by dividing independently
aggregated numerator and denominator candles: their extrema may occur at
different timestamps. Exact pair OHLC requires time-aligned underlying price
observations before aggregation.

## Schema sources

- `clickhouse/schema/001_prices.sql`: `prices`
- `clickhouse/schema/002_blocks.sql`: `blocks`
- `clickhouse/schema/003_assets.sql`: `assets`
- `clickhouse/schema/006_query_views.sql`: block and timestamp price views
- `clickhouse/schema/007_ohlc_5min.sql`, `008_ohlc_15min.sql`,
  `009_ohlc_1h.sql`, `010_ohlc_4h.sql`, `011_ohlc_1d.sql`,
  `014_ohlc_30min.sql`, `015_ohlc_1w.sql`, and `016_ohlc_1m.sql`: OHLCV tables
- `clickhouse/schema/012_ohlc_query_views.sql`, `013_volume_migration.sql`, and
  `017_ohlc_query_views_new.sql`: OHLCV query views

Treat the ordered schema files as the source of truth when this guide and a
deployed database disagree.
