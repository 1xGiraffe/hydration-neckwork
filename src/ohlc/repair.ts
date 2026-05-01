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

export function buildDeleteOHLCQuery(spec: OHLCTableSpec, startTime: string, endTime: string): string {
  const startExpr = spec.literalExpr(startTime)
  const endExpr = spec.literalExpr(endTime)

  return `DELETE FROM price_data.${spec.table}
WHERE interval_start >= ${startExpr}
  AND interval_start <= ${endExpr}`
}

export function buildRestoreRollbackPrefixQuery(spec: OHLCTableSpec, startTime: string): string {
  const startExpr = spec.literalExpr(startTime)

  return `INSERT INTO price_data.${spec.table}
SELECT
    p.asset_id,
    ${spec.bucketExpr} AS interval_start,
    argMinState(p.usd_price, b.block_timestamp) AS open_state,
    maxState(p.usd_price) AS high_state,
    minState(p.usd_price) AS low_state,
    argMaxState(p.usd_price, b.block_timestamp) AS close_state,
    sumState(p.usd_volume_buy) AS volume_buy_state,
    sumState(p.usd_volume_sell) AS volume_sell_state
FROM price_data.prices p
INNER JOIN price_data.blocks b ON p.block_height = b.block_height
WHERE ${spec.bucketExpr} = ${startExpr}
  AND b.block_timestamp < toDateTime('${startTime}')
GROUP BY p.asset_id, interval_start`
}

export function buildRebuildOHLCQuery(spec: OHLCTableSpec, startTime: string, endTime: string): string {
  const startExpr = spec.literalExpr(startTime)
  const endExpr = spec.literalExpr(endTime)

  return `INSERT INTO price_data.${spec.table}
SELECT
    p.asset_id,
    ${spec.bucketExpr} AS interval_start,
    argMinState(p.usd_price, b.block_timestamp) AS open_state,
    maxState(p.usd_price) AS high_state,
    minState(p.usd_price) AS low_state,
    argMaxState(p.usd_price, b.block_timestamp) AS close_state,
    sumState(p.usd_volume_buy) AS volume_buy_state,
    sumState(p.usd_volume_sell) AS volume_sell_state
FROM price_data.prices p
INNER JOIN price_data.blocks b ON p.block_height = b.block_height
WHERE ${spec.bucketExpr} >= ${startExpr}
  AND ${spec.bucketExpr} <= ${endExpr}
GROUP BY p.asset_id, interval_start`
}

export async function clearOHLCForTimeRange(
  client: ClickHouseClient,
  startTime: string,
  endTime: string
): Promise<void> {
  for (const spec of OHLC_TABLE_SPECS) {
    await client.command({
      query: buildDeleteOHLCQuery(spec, startTime, endTime),
      clickhouse_settings: { mutations_sync: '1' },
    })
  }
}

export async function restoreRollbackOHLCPrefix(
  client: ClickHouseClient,
  startTime: string
): Promise<void> {
  for (const spec of OHLC_TABLE_SPECS) {
    await client.command({
      query: buildRestoreRollbackPrefixQuery(spec, startTime),
    })
  }
}

export async function rebuildOHLCForTimeRange(
  client: ClickHouseClient,
  startTime: string,
  endTime: string
): Promise<void> {
  await clearOHLCForTimeRange(client, startTime, endTime)

  for (const spec of OHLC_TABLE_SPECS) {
    await client.command({
      query: buildRebuildOHLCQuery(spec, startTime, endTime),
    })
  }
}
