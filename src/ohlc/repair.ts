import type { ClickHouseSettings } from '@clickhouse/client'
import type { ClickHouseClient } from '../db/client.js'

export interface OHLCTableSpec {
  table: string
  bucketExpr: string
  literalExpr: (value: string) => string
}

export const OHLC_TABLE_SPECS: readonly OHLCTableSpec[] = [
  {
    table: 'ohlc_5min',
    bucketExpr: 'toStartOfFiveMinute(b.block_timestamp)',
    literalExpr: value => `toStartOfFiveMinute(toDateTime('${value}'))`,
  },
  {
    table: 'ohlc_15min',
    bucketExpr: 'toStartOfInterval(b.block_timestamp, toIntervalMinute(15))',
    literalExpr: value => `toStartOfInterval(toDateTime('${value}'), toIntervalMinute(15))`,
  },
  {
    table: 'ohlc_30min',
    bucketExpr: 'toStartOfInterval(b.block_timestamp, toIntervalMinute(30))',
    literalExpr: value => `toStartOfInterval(toDateTime('${value}'), toIntervalMinute(30))`,
  },
  {
    table: 'ohlc_1h',
    bucketExpr: 'toStartOfHour(b.block_timestamp)',
    literalExpr: value => `toStartOfHour(toDateTime('${value}'))`,
  },
  {
    table: 'ohlc_4h',
    bucketExpr: 'toStartOfInterval(b.block_timestamp, toIntervalHour(4))',
    literalExpr: value => `toStartOfInterval(toDateTime('${value}'), toIntervalHour(4))`,
  },
  {
    table: 'ohlc_1d',
    bucketExpr: 'toStartOfDay(b.block_timestamp)',
    literalExpr: value => `toStartOfDay(toDateTime('${value}'))`,
  },
  {
    table: 'ohlc_1w',
    bucketExpr: 'toStartOfWeek(b.block_timestamp, 1)',
    literalExpr: value => `toStartOfWeek(toDateTime('${value}'), 1)`,
  },
  {
    table: 'ohlc_1m',
    bucketExpr: 'toStartOfMonth(b.block_timestamp)',
    literalExpr: value => `toStartOfMonth(toDateTime('${value}'))`,
  },
] as const

function assetIdPredicate(alias: string, assetIds?: readonly number[]): string {
  if (!assetIds || assetIds.length === 0) return ''
  const ids = [...new Set(assetIds)].filter(Number.isInteger)
  if (ids.length === 0) return ''
  const column = alias.length > 0 ? `${alias}.asset_id` : 'asset_id'
  return `\n  AND ${column} IN (${ids.join(', ')})`
}

export function buildDeleteOHLCQuery(
  spec: OHLCTableSpec,
  startTime: string,
  endTime: string,
  assetIds?: readonly number[],
): string {
  const startExpr = spec.literalExpr(startTime)
  const endExpr = spec.literalExpr(endTime)

  return `DELETE FROM price_data.${spec.table}
WHERE interval_start >= ${startExpr}
  AND interval_start <= ${endExpr}${assetIdPredicate('', assetIds)}`
}

/**
 * Candle aggregation over one deduplicated price row per `(asset_id,
 * block_height)`.
 *
 * `price_data.prices` is a `ReplacingMergeTree` keyed on `(asset_id,
 * block_height)`, so a re-indexed block leaves several rows for that key until a
 * merge collapses them. Summing that read directly multiplies a replayed block's
 * volume by however many copies happen to be unmerged, which is permanent once
 * it lands in a candle's `sumState`. The inner `GROUP BY p.asset_id,
 * p.block_height` collapses the copies first; its cardinality is one row per
 * priced block in the window, so it stays bounded by the repair range rather
 * than pulling `FINAL` over the whole table.
 *
 * The engine's version column IS `block_height`, which is constant inside a
 * replacement key, so no copy of a key outranks another and `any()` is exactly
 * the engine's own "keep one of them".
 */
function buildCandleAggregationQuery(spec: OHLCTableSpec, where: string): string {
  return `INSERT INTO price_data.${spec.table}
SELECT
    asset_id,
    interval_start,
    argMinState(price, block_time) AS open_state,
    maxState(price) AS high_state,
    minState(price) AS low_state,
    argMaxState(price, block_time) AS close_state,
    sumState(volume_buy) AS volume_buy_state,
    sumState(volume_sell) AS volume_sell_state
FROM
(
    SELECT
        p.asset_id AS asset_id,
        any(${spec.bucketExpr}) AS interval_start,
        any(b.block_timestamp) AS block_time,
        any(p.usd_price) AS price,
        any(p.usd_volume_buy) AS volume_buy,
        any(p.usd_volume_sell) AS volume_sell
    FROM price_data.prices p
    INNER JOIN price_data.blocks b ON p.block_height = b.block_height
    WHERE ${where}
    GROUP BY p.asset_id, p.block_height
)
GROUP BY asset_id, interval_start`
}

export function buildRestoreRollbackPrefixQuery(spec: OHLCTableSpec, startTime: string): string {
  const startExpr = spec.literalExpr(startTime)

  return buildCandleAggregationQuery(
    spec,
    `${spec.bucketExpr} = ${startExpr}
      AND b.block_timestamp < toDateTime('${startTime}')`,
  )
}

export function buildRebuildOHLCQuery(
  spec: OHLCTableSpec,
  startTime: string,
  endTime: string,
  assetIds?: readonly number[],
): string {
  const startExpr = spec.literalExpr(startTime)
  const endExpr = spec.literalExpr(endTime)

  return buildCandleAggregationQuery(
    spec,
    `${spec.bucketExpr} >= ${startExpr}
      AND ${spec.bucketExpr} <= ${endExpr}${assetIdPredicate('p', assetIds)}`,
  )
}

export async function clearOHLCForTimeRange(
  client: ClickHouseClient,
  startTime: string,
  endTime: string,
  assetIds?: readonly number[],
): Promise<void> {
  for (const spec of OHLC_TABLE_SPECS) {
    await client.command({
      query: buildDeleteOHLCQuery(spec, startTime, endTime, assetIds),
      clickhouse_settings: { mutations_sync: '1' },
    })
  }
}

export async function restoreRollbackOHLCPrefix(
  client: ClickHouseClient,
  startTime: string,
  settings: ClickHouseSettings = {},
): Promise<void> {
  for (const spec of OHLC_TABLE_SPECS) {
    await client.command({
      query: buildRestoreRollbackPrefixQuery(spec, startTime),
      clickhouse_settings: settings,
    })
  }
}

/**
 * Clear and recompute every OHLC table's buckets in the range (for the given
 * assets, or all) from `prices`. `settings` bounds each rebuild INSERT…SELECT —
 * a repair runs against the live ClickHouse, so a caller passes an explicit
 * memory/thread ceiling.
 */
export async function rebuildOHLCForTimeRange(
  client: ClickHouseClient,
  startTime: string,
  endTime: string,
  assetIds?: readonly number[],
  settings: ClickHouseSettings = {},
): Promise<void> {
  await clearOHLCForTimeRange(client, startTime, endTime, assetIds)

  for (const spec of OHLC_TABLE_SPECS) {
    await client.command({
      query: buildRebuildOHLCQuery(spec, startTime, endTime, assetIds),
      clickhouse_settings: settings,
    })
  }
}
