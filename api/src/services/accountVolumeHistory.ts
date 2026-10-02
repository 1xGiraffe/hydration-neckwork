// Trading volume over time for an account set (an account's related set, a tag's
// members), bucketed on the value chart's own grid (explorerService accountBucketing),
// so the explorer's Volume chart lines up with the Value chart and zooms with it.
//
// The figure is the account header's "Trading" figure — the netted per-trade
// volume in price_data.account_trade_volume (see accountTradeVolume.ts): one row per
// trade, volume_usd = max(net in, net out) at event time, route hops netted, aToken
// wraps and the ICE pot's routes excluded. A tag sums its members, so an OTC fill
// between two members counts once for each side. The header figure and the chart's
// all-time total come from ONE helper (tradingVolumeTotals), so they agree exactly.
//
// The model is a progressive fold (the derivations service recomputes the block
// buckets whose raw changed), so its newest trades lag the indexed head by up to
// one derivations cycle; `asOfBlock` names the newest block it holds a trade for.

import type { ClickHouseClient } from '../db/client.ts'
import type { Bucketing } from './bucketLadder.ts'
import { accountVolumeSource } from './accountTradeVolume.ts'
import { chDateTime } from './clickhouseTime.ts'
import { heightAtOrBefore, heightAtOrBeforeExact, type BlockClock } from './blockClock.ts'

export interface VolumeHistoryBucket {
  /** The bucket's START (`YYYY-MM-DD HH:MM:SS` UTC): a bar covers (ts, endTs]. */
  ts: string
  /** The bucket's END — the instant the value chart dates the same bucket by. */
  endTs: string
  /** The last block the bucket covers (its end height, the value chart's dating of the end). */
  blockHeight: number
  volumeUsd: number
  trades: number
}

/** Trailing totals in USD: the last 24 hours, 7, 30 and 365 days before the newest indexed block, and all time. */
export interface VolumeTotals { d1: number; d7: number; d30: number; d365: number; all: number }

export interface AccountVolumeHistory {
  stepSec: number
  buckets: VolumeHistoryBucket[]
  totals: VolumeTotals
  /** Newest block account_trade_volume holds a trade for (any account); null on an empty model. */
  asOfBlock: number | null
}

/** Block heights the trailing totals start AFTER: a trade counts in `d1` when its block is above `d1`. */
export interface VolumeCutHeights { d1: number; d7: number; d30: number; d365: number }

const EMPTY_VOLUME_TOTALS: VolumeTotals = { d1: 0, d7: 0, d30: 0, d365: 0, all: 0 }

const usd = (v: string | number | null | undefined): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * The trailing-window cut heights: the newest block at or before 1, 7, 30 and 365 days
 * before the newest indexed block's own time (never the wall clock, so a lagging
 * indexer does not shrink the windows), exact to the block. The chain clock
 * brackets each cut by the heights an hour either side of it, so each lookup reads
 * a primary-key range of price_data.blocks rather than the whole table.
 */
export async function volumeCutHeights(client: ClickHouseClient, clock: BlockClock): Promise<VolumeCutHeights | null> {
  const headSec = clock.lastTime ?? (clock.hours.length ? clock.hours[clock.hours.length - 1] : null)
  const headHeight = clock.heights.length ? clock.heights[clock.heights.length - 1] : null
  if (headSec == null || headHeight == null) return null
  const cut = (days: number) => {
    const sec = headSec - days * 86_400
    const lo = heightAtOrBeforeExact(clock, sec - 3_600) ?? 0
    const hi = heightAtOrBefore(clock, sec + 3_600) ?? headHeight
    return `(SELECT max(block_height) FROM price_data.blocks WHERE block_height >= ${lo} AND block_height <= ${hi} AND block_timestamp <= toDateTime(${Math.floor(sec)}))`
  }
  const res = await client.query({
    query: `SELECT ${cut(1)} AS d1, ${cut(7)} AS d7, ${cut(30)} AS d30, ${cut(365)} AS d365`,
    format: 'JSONEachRow',
  })
  const row = (await res.json<{ d1: number | string; d7: number | string; d30: number | string; d365: number | string }>())[0]
  if (!row) return null
  return { d1: Number(row.d1), d7: Number(row.d7), d30: Number(row.d30), d365: Number(row.d365) }
}

/**
 * All-time and trailing trading volume over an account set — THE figure the account
 * and tag headers show as "Trading" (cuts omitted) and the Volume chart's totals.
 * `list` is a pre-validated SQL account list (`'0x…','0x…'`). The decimal sum is
 * exact; it is rendered to a number once.
 */
export async function tradingVolumeTotals(client: ClickHouseClient, list: string, cuts?: VolumeCutHeights | null): Promise<VolumeTotals> {
  if (list === "''" || !list) return { ...EMPTY_VOLUME_TOTALS }
  const src = accountVolumeSource()
  const windows = cuts
    ? `,
        toString(sumIf(${src.col}, block_height > ${Math.floor(cuts.d1)})) AS d1,
        toString(sumIf(${src.col}, block_height > ${Math.floor(cuts.d7)})) AS d7,
        toString(sumIf(${src.col}, block_height > ${Math.floor(cuts.d30)})) AS d30,
        toString(sumIf(${src.col}, block_height > ${Math.floor(cuts.d365)})) AS d365`
    : ''
  const res = await client.query({
    query: `
      SELECT toString(sum(${src.col})) AS all_usd${windows}
      FROM ${src.table}
      WHERE account IN (${list})`,
    format: 'JSONEachRow',
  })
  const row = (await res.json<{ all_usd: string; d1?: string; d7?: string; d30?: string; d365?: string }>())[0]
  return { d1: usd(row?.d1), d7: usd(row?.d7), d30: usd(row?.d30), d365: usd(row?.d365), all: usd(row?.all_usd) }
}

/**
 * The newest block the model holds a trade for. The table is account-first, but its
 * partition key is a function of block_height, so the bound prunes to the newest
 * partitions (216,000 blocks each) instead of scanning the column.
 */
export async function tradingVolumeAsOfBlock(client: ClickHouseClient, headBlock: number): Promise<number | null> {
  const src = accountVolumeSource()
  const res = await client.query({
    query: `SELECT max(block_height) AS b, count() AS n FROM ${src.table} WHERE block_height >= ${Math.max(0, Math.floor(headBlock) - 432_000)}`,
    format: 'JSONEachRow',
  })
  const row = (await res.json<{ b: number | string; n: number | string }>())[0]
  return row && Number(row.n) > 0 ? Number(row.b) : null
}

/**
 * The first block the account set traded at, with its time — where the grid opens
 * when the set has no balance history to date it by.
 */
export async function firstTradeOf(client: ClickHouseClient, list: string): Promise<{ minb: number; mint: number } | null> {
  if (list === "''" || !list) return null
  const src = accountVolumeSource()
  const res = await client.query({
    query: `
      SELECT b.block_height AS minb, toUnixTimestamp(b.block_timestamp) AS mint
      FROM price_data.blocks AS b
      WHERE b.block_height = (SELECT min(block_height) FROM ${src.table} WHERE account IN (${list}))`,
    format: 'JSONEachRow',
  })
  const row = (await res.json<{ minb: number | string; mint: number | string }>())[0]
  return row && Number(row.minb) > 0 ? { minb: Number(row.minb), mint: Number(row.mint) } : null
}

/**
 * Per-bucket volume and trade count. Un-windowed every trade lands in a bucket (rows
 * outside the grid clamp to its first or last bucket), so the buckets sum to the
 * all-time total exactly. A window (a chart zoom) takes only trades with a block in
 * (fromBlock, toBlock]: the flow inside the window, so a window whose bounds are two
 * of the full grid's bucket-end heights sums to that slice of the full grid.
 */
export function volumeBucketsSql(list: string, bk: Bucketing, window?: { fromBlock: number; toBlock: number }): string {
  const src = accountVolumeSource()
  const bounds = window ? `AND block_height > ${Math.floor(window.fromBlock)} AND block_height <= ${Math.floor(window.toBlock)}` : ''
  return `
    SELECT ${bk.ofHeight('block_height')} AS b, toString(sum(${src.col})) AS volume_usd, toString(sum(trade_count)) AS trades
    FROM ${src.table}
    WHERE account IN (${list}) ${bounds}
    GROUP BY b ORDER BY b`
}

export async function loadVolumeBuckets(client: ClickHouseClient, list: string, bk: Bucketing, window?: { fromBlock: number; toBlock: number }): Promise<VolumeHistoryBucket[]> {
  const out: VolumeHistoryBucket[] = Array.from({ length: bk.N + 1 }, (_, b) => ({
    ts: chDateTime(new Date((b === 0 ? bk.t0 : bk.endSec(b - 1)) * 1000)),
    endTs: chDateTime(new Date(bk.endSec(b) * 1000)),
    blockHeight: bk.endHeight(b),
    volumeUsd: 0,
    trades: 0,
  }))
  if (list === "''" || !list) return out
  const res = await client.query({ query: volumeBucketsSql(list, bk, window), format: 'JSONEachRow' })
  for (const r of await res.json<{ b: number | string; volume_usd: string; trades: string }>()) {
    const b = Number(r.b)
    if (!(b >= 0 && b <= bk.N)) continue
    out[b].volumeUsd += usd(r.volume_usd)
    out[b].trades += Number(r.trades)
  }
  return out
}
