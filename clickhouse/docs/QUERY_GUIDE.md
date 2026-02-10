# ClickHouse Query Guide

## Overview

This guide covers how to query Hydration price data using ClickHouse parameterized views. Price data is stored in the `prices` table ordered by `(asset_id, block_height)`, with corresponding metadata in the `blocks` table (timestamps) and `assets` table (symbols). All prices are USDT-denominated, stored as `Decimal64(12)`, and rounded to 8 decimals in view output.

## Prerequisites

**ClickHouse Connection:**
- Host: Your ClickHouse server endpoint
- Port: 8123 (HTTP) or 9000 (native)
- Database: `price_data`
- Authentication: Username/password if configured

**Schema Deployment:**
- Views must be deployed from `clickhouse/schema/006_query_views.sql`
- Underlying tables: `prices`, `blocks`, `assets`

**ClickHouse Client:**
```bash
clickhouse-client --host=<host> --port=9000 --database=price_data
```

## Query Patterns

### 1. Point Query (QUERY-01): Price at Specific Block

Retrieve a single asset's price at a specific block height.

**View:** `price_at_block(asset_id, block_height)`

**Example (by asset_id):**
```sql
SELECT * FROM price_data.price_at_block(asset_id=5, block_height=7000000);
```

**Example (by symbol):**
```sql
SELECT * FROM price_data.price_at_block_by_symbol(symbol='DOT', block_height=7000000);
```

**Expected Output:**
```
┌─asset_id─┬─block_height─┬─usdt_price─┐
│        5 │      7000000 │  5.23456789 │
└──────────┴──────────────┴────────────┘
```

**Output Format:** `(asset_id, block_height, usdt_price)`

**Performance:** <100ms (ClickHouse sparse index reads minimum 8192-row granules even for single-row point queries)

**Direct Table Query (without view):**
```sql
SELECT asset_id, block_height, round(usdt_price, 8) AS usdt_price
FROM price_data.prices FINAL
WHERE asset_id = 5 AND block_height = 7000000;
```

 For querying the raw `prices` table directly, always use `FROM price_data.prices FINAL`. The `FINAL` modifier is required for ReplacingMergeTree tables to ensure deduplicated results. All views already include `FINAL` internally.

---

### 2. Range Query (QUERY-02): Price Series Over Block Range

Retrieve a continuous price series for a single asset across a block range. Missing blocks are filled forward with the last known price (LOCF - Last Observation Carried Forward).

**View:** `price_range(asset_id, start_block, end_block)`

**Example:**
```sql
SELECT * FROM price_data.price_range(asset_id=5, start_block=7000000, end_block=7001000);
```

**Expected Output:**
```
┌─block_height─┬─usdt_price─┐
│      7000000 │  5.23456789 │
│      7000001 │  5.23456789 │  -- filled forward (no price update)
│      7000002 │  5.24012345 │  -- new price recorded
│      7000003 │  5.24012345 │  -- filled forward
...
│      7001000 │  5.31567890 │
└──────────────┴────────────┘
```

**Output Format:** Continuous series with no gaps (1001 rows for 1000-block range: start_block through end_block inclusive)

**Performance:** <1 second for 1000s of blocks

**Fill-Forward Behavior:**
The view uses ClickHouse's `WITH FILL` clause combined with `INTERPOLATE` to carry the last known price forward for blocks where no price was recorded. This ensures output has one row per block with no gaps.

**Tip:** For very large ranges (100,000+ blocks), add `LIMIT N` to avoid excessive result sets:
```sql
SELECT * FROM price_data.price_range(asset_id=5, start_block=7000000, end_block=7100000)
LIMIT 10000;
```

**Direct Table Query (without LOCF):**
```sql
SELECT block_height, round(usdt_price, 8) AS usdt_price
FROM price_data.prices FINAL
WHERE asset_id = 5
  AND block_height BETWEEN 7000000 AND 7001000
ORDER BY block_height;
```
This returns only blocks where prices were actually recorded (sparse output with gaps).

---

### 3. Cross-Asset Comparison (QUERY-03): Multiple Assets Over Range

Compare prices for multiple assets across a block range in pivot format. This pattern is NOT implemented as a view because the asset column list is dynamic.

**SQL Template:**

```sql
SELECT
  block_height,
  round(maxIf(usdt_price, asset_id = <ASSET_ID_1>), 8) AS <asset_1_symbol>_price,
  round(maxIf(usdt_price, asset_id = <ASSET_ID_2>), 8) AS <asset_2_symbol>_price,
  round(maxIf(usdt_price, asset_id = <ASSET_ID_3>), 8) AS <asset_3_symbol>_price
FROM price_data.prices FINAL
WHERE asset_id IN [<ASSET_ID_1>, <ASSET_ID_2>, <ASSET_ID_3>]
  AND block_height BETWEEN <START_BLOCK> AND <END_BLOCK>
GROUP BY block_height
ORDER BY block_height ASC
WITH FILL FROM <START_BLOCK> TO <END_BLOCK> + 1 STEP 1
  INTERPOLATE (<asset_1_symbol>_price, <asset_2_symbol>_price, <asset_3_symbol>_price);
```

 Each column alias must be unique. Use descriptive names like `dot_price`, `hdx_price` — never reuse `price` as an alias for multiple columns.

**Example (3 assets: DOT=5, USDT=10, HDX=0):**
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

**Expected Output:**
```
┌─block_height─┬─dot_price─┬─usdt_value─┬─hdx_price─┐
│      7000000 │  5.234567 │  1.000000  │  0.012345 │
│      7000001 │  5.234567 │  1.000000  │  0.012345 │
│      7000002 │  5.240123 │  1.000000  │  0.012450 │
...
│      7000500 │  5.315678 │  1.000000  │  0.013012 │
└──────────────┴───────────┴────────────┴───────────┘
```

**Output Format:** `(block_height, asset_A_price, asset_B_price, ...)`

**How to Customize:**
To add/remove assets, modify these three parts:
1. **SELECT columns:** Add/remove `round(maxIf(usdt_price, asset_id = <ID>), 8) AS <name>` for each asset
2. **WHERE asset_id IN list:** Include all asset IDs you're querying
3. **INTERPOLATE list:** Include all column aliases from step 1

**Performance:** <2 seconds for typical queries

**Recommendations:**
- Limit to 5-10 assets per query for optimal performance
- Always include `WHERE asset_id IN [...]` to use primary key `(asset_id, block_height)` optimization
- Use narrower block ranges for more assets to keep result sets manageable

**How it Works:**
- `maxIf(usdt_price, asset_id = X)` is a ClickHouse conditional aggregator that extracts the price for a specific asset_id within each block_height group
- `GROUP BY block_height` pivots asset rows into columns
- `WITH FILL` + `INTERPOLATE` provides LOCF gap-filling across all asset columns

---

### 4. Timestamp Query (QUERY-04): Price at Wall-Clock Time

Retrieve an asset's price at a specific wall-clock timestamp by finding the nearest block.

**View:** `price_at_timestamp(asset_id, target_timestamp)`

**Example:**
```sql
SELECT * FROM price_data.price_at_timestamp(asset_id=5, target_timestamp='2024-12-01 12:00:00');
```

**Expected Output:**
```
┌─asset_id─┬─block_height─┬──usdt_price──┐
│        5 │      7000123 │  5.23456789  │
└──────────┴──────────────┴──────────────┘
```

**Output Format:** `(asset_id, block_height, usdt_price)`

To also get the block timestamp, join with the blocks table:
```sql
SELECT p.*, b.block_timestamp
FROM price_data.price_at_timestamp(asset_id=5, target_timestamp='2024-12-01 12:00:00') p
JOIN price_data.blocks b ON p.block_height = b.block_height;
```

**Nearest Block Logic:**
The view finds the block with the closest timestamp to your target within a **±1 hour window**. This limits the scan to approximately 300 blocks (at Hydration's ~12 seconds per block average).

**Performance:** <200ms (scans ~300 blocks in the ±1 hour window)

**Timestamp Format:**
Use ClickHouse `DateTime` format: `'YYYY-MM-DD HH:MM:SS'`
- Example: `'2024-12-01 12:00:00'`
- Timezone: ClickHouse server timezone (typically UTC)

**Empty Results:**
If no blocks exist within ±1 hour of the target timestamp, the query returns empty. This can occur for:
- Future timestamps beyond current chain height
- Historical timestamps before chain genesis
- Timestamps during network downtime (if any)

**Direct Table Query (manual timestamp lookup):**
```sql
-- Step 1: Find nearest block
WITH nearest_block AS (
  SELECT argMin(block_height, abs(toUnixTimestamp(block_timestamp) - toUnixTimestamp('2024-12-01 12:00:00'))) AS block_height
  FROM price_data.blocks
  WHERE block_timestamp BETWEEN '2024-12-01 12:00:00' - INTERVAL 1 HOUR
                            AND '2024-12-01 12:00:00' + INTERVAL 1 HOUR
)
-- Step 2: Get price at that block
SELECT
  asset_id,
  block_height,
  round(usdt_price, 8) AS usdt_price
FROM price_data.prices FINAL
WHERE asset_id = 5
  AND block_height = (SELECT block_height FROM nearest_block);
```

---

## ClickHouse Notes

For developers comfortable with SQL but new to ClickHouse, here are key concepts used in these queries:

### FINAL Modifier

**What:** Ensures deduplicated results when querying ReplacingMergeTree tables.

**Why:** The `prices` and `assets` tables use `ReplacingMergeTree` engine, which performs deduplication asynchronously during background merges. The `FINAL` modifier forces immediate deduplication at query time.

**Usage:** Always use `FROM price_data.prices FINAL` when querying the base `prices` table directly. All views already include `FINAL` internally, so you don't need to specify it when using views.

**Performance Impact:** `FINAL` adds overhead (~10-20ms) for point queries, negligible for range queries. This is why ClickHouse point queries are slower than traditional OLTP databases.

### Parameterized Views

**What:** ClickHouse views that accept parameters like functions.

**Syntax:** `view_name(param1=value1, param2=value2)`

**Example:**
```sql
SELECT * FROM price_data.price_at_block(asset_id=5, block_height=7000000);
```

**Type Safety:** Parameters are strongly typed in the view definition (e.g., `{asset_id:UInt32}`). ClickHouse validates types at query time.

### WITH FILL Clause

**What:** ClickHouse's native gap-filling mechanism for generating continuous series.

**Syntax:**
```sql
ORDER BY block_height ASC
WITH FILL FROM <start> TO <end> STEP 1
```

**Behavior:** Generates missing rows to create a continuous series from `start` to `end` (exclusive) with specified step size.

**Example:** `WITH FILL FROM 7000000 TO 7001001 STEP 1` generates rows for blocks 7000000 through 7001000 (inclusive).

### INTERPOLATE Clause

**What:** Carries forward the last non-null value for specified columns during `WITH FILL` gap-filling.

**Syntax:**
```sql
WITH FILL ... INTERPOLATE (column1, column2, ...)
```

**Behavior:** Implements Last Observation Carried Forward (LOCF) semantics. When `WITH FILL` generates a missing row, `INTERPOLATE` copies the value from the previous row.

**Example:**
```sql
WITH FILL FROM 7000000 TO 7000501 STEP 1
  INTERPOLATE (dot_price, usdt_value, hdx_price);
```

**Use Case:** Ensures price series have no gaps by repeating the last known price for blocks where no price update occurred.

### Performance Characteristics

**ClickHouse Optimization:**
ClickHouse is optimized for **analytical/range queries** over large datasets, not single-row point lookups.

**Sparse Primary Index:**
The primary key `(asset_id, block_height)` uses sparse indexing with 8192-row granules. Even point queries must read entire granules, resulting in 50-100ms latency.

**When to Use ClickHouse:**
- Range queries over 1000s-millions of blocks: <1 second
- Cross-asset analytical queries: <2 seconds
- Historical aggregations and time-series analysis

**When NOT to Use:**
- Real-time point lookups (<10ms required): Consider caching layer or OLTP database
- Frequent small queries (<100 rows): Batch into larger range queries if possible

---

## Schema Reference

### prices Table

```sql
CREATE TABLE price_data.prices (
  asset_id UInt32,
  block_height UInt32,
  usdt_price Decimal64(12)
) ENGINE = ReplacingMergeTree(block_height)
ORDER BY (asset_id, block_height);
```

**Columns:**
- `asset_id`: Hydration asset ID (UInt32)
- `block_height`: Block number (UInt32)
- `usdt_price`: Price in USDT (Decimal64(12), views round to 8 decimals)

**Primary Key:** `(asset_id, block_height)` — optimized for single-asset range queries

### blocks Table

```sql
CREATE TABLE price_data.blocks (
  block_height UInt32,
  block_timestamp DateTime,
  spec_version UInt32
) ENGINE = MergeTree()
ORDER BY block_height;
```

**Columns:**
- `block_height`: Block number (UInt32)
- `block_timestamp`: Block production time (DateTime, UTC)
- `spec_version`: Runtime version at this block (UInt32)

**Primary Key:** `block_height` — optimized for timestamp-to-block lookups

### assets Table

```sql
CREATE TABLE price_data.assets (
  asset_id UInt32,
  symbol String,
  name String,
  decimals UInt8
) ENGINE = ReplacingMergeTree()
ORDER BY asset_id;
```

**Columns:**
- `asset_id`: Hydration asset ID (UInt32)
- `symbol`: Asset ticker symbol (String, e.g., 'DOT', 'HDX')
- `name`: Full asset name (String)
- `decimals`: Decimal precision (UInt8)

**Primary Key:** `asset_id` — optimized for symbol-to-ID lookups

 The `assets` table contains current metadata only. Historical symbol changes are not tracked.

---

## OHLC Candlestick Queries

Hydration price data includes pre-computed OHLC (Open, High, Low, Close) candles at multiple time intervals. OHLC data is automatically generated via materialized views whenever new prices are inserted, providing efficient access to candlestick data for charting and technical analysis.

### Available Intervals

Five OHLC intervals are available, each with its own query view:

- **5-minute candles** — `ohlc_5min_query`
- **15-minute candles** — `ohlc_15min_query`
- **1-hour candles** — `ohlc_1h_query`
- **4-hour candles** — `ohlc_4h_query`
- **1-day candles** — `ohlc_1d_query`

All intervals use UTC timestamps aligned to standard boundaries (e.g., hourly candles start at XX:00:00).

### Basic OHLC Query

Retrieve OHLC candles for an asset over a time range using the parameterized query views.

**View:** `ohlc_{interval}_query(asset_id, start_time, end_time)`

**Example (1-hour candles for 30 days):**
```sql
SELECT * FROM price_data.ohlc_1h_query(
    asset_id=5,
    start_time='2025-01-01 00:00:00',
    end_time='2025-01-31 23:59:59'
);
```

**Expected Output:**
```
┌─asset_id─┬─interval_start──────┬──────open─┬─────high─┬──────low─┬────close─┐
│        5 │ 2025-01-01 00:00:00 │  5.234567 │ 5.289012 │ 5.210345 │ 5.256789 │
│        5 │ 2025-01-01 01:00:00 │  5.256789 │ 5.298765 │ 5.243210 │ 5.278901 │
│        5 │ 2025-01-01 02:00:00 │  5.278901 │ 5.312345 │ 5.267890 │ 5.301234 │
...
└──────────┴─────────────────────┴───────────┴──────────┴──────────┴──────────┘
```

**Output Format:** `(asset_id, interval_start, open, high, low, close)`

**Column Semantics:**
- `interval_start`: UTC timestamp marking the start of the candle interval
- `open`: First price recorded during the interval (by timestamp)
- `high`: Highest price recorded during the interval
- `low`: Lowest price recorded during the interval
- `close`: Last price recorded during the interval (by timestamp)

### Query All Intervals

**5-minute candles (highest granularity):**
```sql
SELECT * FROM price_data.ohlc_5min_query(asset_id=5, start_time='2025-01-01 00:00:00', end_time='2025-01-01 23:59:59');
```

**15-minute candles:**
```sql
SELECT * FROM price_data.ohlc_15min_query(asset_id=5, start_time='2025-01-01 00:00:00', end_time='2025-01-07 23:59:59');
```

**4-hour candles:**
```sql
SELECT * FROM price_data.ohlc_4h_query(asset_id=5, start_time='2025-01-01 00:00:00', end_time='2025-03-31 23:59:59');
```

**1-day candles (daily):**
```sql
SELECT * FROM price_data.ohlc_1d_query(asset_id=5, start_time='2025-01-01 00:00:00', end_time='2025-12-31 23:59:59');
```

### Direct Query (Without View)

For advanced users who want to query the underlying OHLC tables directly, use `-Merge` combinators with `GROUP BY`.

**Example (1-hour candles):**
```sql
SELECT
    asset_id,
    interval_start,
    argMinMerge(open_state) AS open,
    maxMerge(high_state) AS high,
    minMerge(low_state) AS low,
    argMaxMerge(close_state) AS close
FROM price_data.ohlc_1h
WHERE asset_id = 5
  AND interval_start BETWEEN '2025-01-01 00:00:00' AND '2025-01-31 23:59:59'
GROUP BY asset_id, interval_start
ORDER BY interval_start ASC;
```

**Why GROUP BY is required:**
The OHLC tables use `AggregatingMergeTree` engine, which stores data in `-State` aggregate functions. ClickHouse may have unmerged parts (background merges are asynchronous), so `GROUP BY` ensures correct aggregation across all parts. The `-Merge` combinators extract final OHLC values from `-State` functions.

### Cross-Pair OHLC Derivation

Derive OHLC candles for asset pairs (e.g., DOT/HDX) by dividing two asset's OHLC series at query time.

**Example (DOT/HDX hourly candles):**
```sql
WITH dot AS (
    SELECT interval_start, open AS dot_open, high AS dot_high, low AS dot_low, close AS dot_close
    FROM price_data.ohlc_1h_query(asset_id=5, start_time='2025-01-01 00:00:00', end_time='2025-01-31 23:59:59')
),
hdx AS (
    SELECT interval_start, open AS hdx_open, high AS hdx_high, low AS hdx_low, close AS hdx_close
    FROM price_data.ohlc_1h_query(asset_id=0, start_time='2025-01-01 00:00:00', end_time='2025-01-31 23:59:59')
)
SELECT
    dot.interval_start,
    round(dot.dot_open / hdx.hdx_open, 8) AS open,
    round(dot.dot_high / hdx.hdx_low, 8) AS high,   -- High of ratio = high/low
    round(dot.dot_low / hdx.hdx_high, 8) AS low,    -- Low of ratio = low/high
    round(dot.dot_close / hdx.hdx_close, 8) AS close
FROM dot
INNER JOIN hdx ON dot.interval_start = hdx.interval_start
ORDER BY dot.interval_start ASC;
```

 For cross-pair high/low calculation:
- **Pair high** = numerator high / denominator low (ratio maximized)
- **Pair low** = numerator low / denominator high (ratio minimized)

**Use Cases:**
- Trading pairs not directly available (e.g., DOT/HDX, BTC/ETH)
- Custom synthetic pairs (e.g., stablecoin ratios, portfolio indices)
- Cross-exchange arbitrage analysis

### Performance Expectations

OHLC queries are highly optimized due to pre-aggregation:

| Interval | 30-Day Range      | 1-Year Range      |
|----------|-------------------|-------------------|
| 5min     | ~8,640 candles    | ~500ms            |
| 15min    | ~2,880 candles    | ~300ms            |
| 1h       | ~720 candles      | ~500ms            |
| 4h       | ~180 candles      | ~100ms            |
| 1d       | ~30 candles       | ~365 candles <1s  |

**Key Performance Factors:**
- Pre-aggregation via materialized views (no runtime aggregation)
- Efficient `(asset_id, interval_start)` ordering for time-series scans
- Monthly partitioning reduces scan volume for time-range filters

### Important Notes

**Partial Candles:**
The most recent candle for each interval may be **partial** (incomplete). For example, querying 1-hour candles at 14:30 UTC will include a partial candle for 14:00-14:30. The `close` value represents the latest price so far, not the final close.

**Absent Candles:**
If no prices were recorded during an interval, no candle exists for that interval. This can occur during:
- Network downtime or block production gaps
- Assets with low trading activity (no price changes)
- Early chain history before asset was tradeable

**Timezone:**
All `interval_start` timestamps are in **UTC**. ClickHouse does not store timezone offsets.

**Price Precision:**
OHLC values are returned as `Decimal64(12)` with full precision. Views do not round output (unlike the basic price views which round to 8 decimals).

### Weekly and Monthly Candles

Weekly and monthly candles are not pre-aggregated but can be derived from daily candles at query time.

**Weekly Candles (Sunday-start weeks):**
```sql
SELECT
    toStartOfWeek(interval_start) AS week_start,
    asset_id,
    argMin(open, interval_start) AS open,
    max(high) AS high,
    min(low) AS low,
    argMax(close, interval_start) AS close
FROM price_data.ohlc_1d_query(asset_id=5, start_time='2025-01-01 00:00:00', end_time='2025-12-31 23:59:59')
GROUP BY week_start, asset_id
ORDER BY week_start ASC;
```

**Monthly Candles:**
```sql
SELECT
    toStartOfMonth(interval_start) AS month_start,
    asset_id,
    argMin(open, interval_start) AS open,
    max(high) AS high,
    min(low) AS low,
    argMax(close, interval_start) AS close
FROM price_data.ohlc_1d_query(asset_id=5, start_time='2025-01-01 00:00:00', end_time='2025-12-31 23:59:59')
GROUP BY month_start, asset_id
ORDER BY month_start ASC;
```

**How it Works:**
- `toStartOfWeek` / `toStartOfMonth` round timestamps to week/month boundaries
- `argMin(open, interval_start)` gets the first day's open price
- `max(high)` gets the highest high across all days
- `min(low)` gets the lowest low across all days
- `argMax(close, interval_start)` gets the last day's close price

**Performance:** Weekly/monthly derivation from daily candles is <1 second for multi-year ranges.

---

## Additional Resources

**Schema Files:**
- `clickhouse/schema/001_prices.sql` — prices table definition
- `clickhouse/schema/002_blocks.sql` — blocks table definition
- `clickhouse/schema/003_assets.sql` — assets table definition
- `clickhouse/schema/006_query_views.sql` — view definitions (source of truth)

**ClickHouse Documentation:**
- [Parameterized Views](https://clickhouse.com/docs/en/sql-reference/statements/create/view#parameterized-view)
- [WITH FILL](https://clickhouse.com/docs/en/sql-reference/statements/select/order-by#filling-missing-values)
- [ReplacingMergeTree](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/replacingmergetree)
- [Conditional Aggregators (maxIf)](https://clickhouse.com/docs/en/sql-reference/aggregate-functions/combinators)
