// Time series of one concentrated-liquidity (Uniswap v3) pool, for the pool page's
// charts and the public API's history endpoint — the read side of
// price_data.uniswap_v3_events for a liquidity provider's questions:
//
//   * where did the price go (and how far did it swing inside a bucket, so a range
//     position's "in range" question is answerable per bucket),
//   * how much traded and what the swaps paid the LPs,
//   * how deep was the pool (the active liquidity L at the current tick) and what it held.
//
// Everything is one bounded read over the pool's own rows (PREWHERE on the pool
// contract, which leads the partition-local sort by block) folded onto the shared
// bucket ladder (historyGrain / bucketLadder), so the pool page's zoom lands on the
// same grains every other pool chart uses — and, below an hour, on the swaps
// themselves (`swap` grain: one point per Swap/Initialize log), which is what a
// dragged window of a few hours is asking for.
//
// Price is token1 per token0 in whole tokens: (sqrtPriceX96 / 2^96)^2 · 10^(d0−d1).
// It is read from the `sqrt_price_x96` a Swap or Initialize log reports, so a bucket
// with no swap has no price of its own and inherits the previous close (`swaps: 0`
// says so). Volume is the swaps' absolute leg amounts; LP fees are the input side's
// amount × fee tier (the LPs' share once a protocol fee is on is the caller's to
// apply — this reports the gross swap fee). Balances are what the pool's own logs
// imply it holds (mints + swap inflows − collects − protocol collects + flash fees),
// as a running sum, so a window opening mid-history carries the balance in.
//
// Active liquidity is NOT read off the Swap logs' `liquidity` field: that is only
// right at the instant of a swap, and a vault that mints into range after the last
// swap would read as an empty pool until the next one. Instead the pool's open
// ranges are replayed — every Mint adds its liquidity over [tickLower, tickUpper),
// every Burn removes it — and the figure at a bucket's end is the sum of the ranges
// straddling the current tick (the last Swap's or Initialize's). That is the same
// number the pool's `liquidity()` returns, at every event rather than at swaps only,
// and the same range book gives the liquidity distribution (`v3PoolLiquidity`).
// A Gamma vault's ZeroBurn poke — burn(0) followed by a collect — is not an event of
// the pool's history: it moves no liquidity and, when nothing was owed, no token,
// so those rows are skipped everywhere here (a swap-grain view would otherwise be
// mostly pokes).
// USD values come from the tokens' hourly/daily closes at the bucket (aToken sides
// through their reserve's price, the same alias every valuation uses).
//
// This module imports nothing from explorerService so the public tree (an import
// leaf) may read it; the caller supplies the pool's tokens and decimals.

import type { ClickHouseClient } from '../db/client.ts'
import { activeLiquidity, applyRangeDeltas, big, V3_MEANINGFUL_SQL, type V3RangeDelta } from './uniswapV3Ranges.ts'
import { chooseBucketStep, FINEST_STEP_SEC } from './bucketLadder.ts'
import { makeGrain, type HistoryGrain } from './historyGrain.ts'
import { priceAssetId } from './explorerAssets.ts'

export interface V3HistoryPool {
  address: string
  asset0: number
  asset1: number
  decimals0: number
  decimals1: number
  /** Fee tier in hundredths of a bip (3000 = 0.3%). */
  fee: number
}

/** One bucket (or one swap, on the `swap` grain). */
export interface V3HistoryPoint {
  /** Bucket key on a ladder grain (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`); the swap's timestamp on the swap grain. */
  bucket: string
  /** Unix seconds of the bucket's start (the swap's instant on the swap grain). */
  t: number
  /** token1 per token0; null before the pool was initialised. Buckets without a swap inherit the previous close. */
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  swaps: number
  /** Raw integer sums of the swaps' legs, both sides. */
  volume0: string
  volume1: string
  volumeUsd: number | null
  /** Gross swap fee the swaps paid, per input side, raw units. */
  fees0: string
  fees1: string
  feesUsd: number | null
  /** Active liquidity L at the bucket's end: the open ranges straddling the current tick. Null before the pool is initialised. */
  liquidity: string | null
  /** Event-implied holdings at the bucket's end (running sum). */
  balance0: string
  balance1: string
  tvlUsd: number | null
  /** The bucket's last block, for linking. */
  blockHeight: number | null
}

export type V3Grain = { kind: 'ladder'; grain: HistoryGrain } | { kind: 'swap' }

/** Swaps at or below which a window is served swap-by-swap instead of hourly. */
export const SWAP_GRAIN_MAX_POINTS = 600

// The range book lives in its own leaf (uniswapV3Ranges.ts) so the Data API may read
// it too; re-exported here because the pool page's series is built from both.
export {
  activeLiquidity, amountsInRange, applyRangeDeltas, liquiditySegments, priceAtTick,
  rangesToTicks, v3Price, v3PoolLiquidity,
  type V3PoolLiquidity, type V3RangeBook, type V3RangeDelta, type V3RangePool, type V3Tick,
} from './uniswapV3Ranges.ts'


/**
 * Which grain a window is served on. Below the hourly floor there is only the swaps
 * themselves: a window that holds at most SWAP_GRAIN_MAX_POINTS swaps and whose
 * hourly grid would fit fewer than `points / 4` buckets is served swap by swap —
 * the reader asked for detail the hour cannot give. Everything else follows the
 * shared ladder, so the pool chart zooms on the same steps as every other.
 */
export function chooseV3Grain(fromSec: number, toSec: number, points: number, swapsInWindow: number): V3Grain {
  const span = Math.max(0, toSec - fromSec)
  if (swapsInWindow <= SWAP_GRAIN_MAX_POINTS && span / FINEST_STEP_SEC < points / 4) return { kind: 'swap' }
  return { kind: 'ladder', grain: makeGrain(chooseBucketStep(fromSec, toSec, points, FINEST_STEP_SEC), fromSec) }
}

/** A fixed ladder grain for callers outside the services tree (the public API's buckets). */
export function fixedV3Grain(stepSec: number, windowFromSec?: number): HistoryGrain {
  return makeGrain(stepSec, windowFromSec)
}

/** The whole history at the coarsest grain that fits the point budget (the page's default view). */
export function fullRangeGrain(firstSec: number, nowSec: number, points: number): HistoryGrain {
  return makeGrain(chooseBucketStep(firstSec, nowSec, points, FINEST_STEP_SEC))
}

/** What stood before a window: the last close and tick, the holdings and the open ranges. */
export interface V3CarryIn { close: number | null; tick: number | null; balance0: bigint; balance1: bigint; ranges: V3RangeDelta[] }

/**
 * Fill the price forward through buckets that saw no swap, and turn raw per-bucket
 * rows (which exist only for buckets with events) into one point per grid bucket.
 * Pure, so the forward-fill rule is pinned without a database.
 */
export function assembleV3Series(
  grid: { bucket: string; t: number }[],
  rows: Map<string, V3RawBucket>,
  carryIn: V3CarryIn,
  prices: { p0: Map<string, number>; p1: Map<string, number> },
  decimals: { d0: number; d1: number },
): V3HistoryPoint[] {
  let close = carryIn.close
  let tick = carryIn.tick
  const book = applyRangeDeltas(new Map(), carryIn.ranges)
  let bal0 = carryIn.balance0
  let bal1 = carryIn.balance1
  const unit0 = 10 ** decimals.d0, unit1 = 10 ** decimals.d1
  const usd = (raw0: bigint, raw1: bigint, key: string, mean: boolean): number | null => {
    const p0 = prices.p0.get(key), p1 = prices.p1.get(key)
    const u0 = p0 != null ? Number(raw0) / unit0 * p0 : null
    const u1 = p1 != null ? Number(raw1) / unit1 * p1 : null
    if (u0 == null && u1 == null) return null
    if (mean) return u0 != null && u1 != null ? (u0 + u1) / 2 : (u0 ?? u1)
    return (u0 ?? 0) + (u1 ?? 0)
  }
  const out: V3HistoryPoint[] = []
  for (const g of grid) {
    const r = rows.get(g.bucket)
    if (r) {
      bal0 += r.flow0
      bal1 += r.flow1
      if (r.swaps > 0 || r.inits > 0) { close = r.close; tick = r.tick }
      applyRangeDeltas(book, r.ranges)
    }
    const traded = !!r && r.swaps > 0
    const liquidity = activeLiquidity(book, tick)?.toString() ?? null
    out.push({
      bucket: g.bucket, t: g.t,
      open: traded ? r.open : close, high: traded ? r.high : close, low: traded ? r.low : close, close,
      swaps: r?.swaps ?? 0,
      volume0: (r?.volume0 ?? 0n).toString(), volume1: (r?.volume1 ?? 0n).toString(),
      volumeUsd: r ? usd(r.volume0, r.volume1, g.bucket, true) : (prices.p0.has(g.bucket) || prices.p1.has(g.bucket) ? 0 : null),
      fees0: (r?.fees0 ?? 0n).toString(), fees1: (r?.fees1 ?? 0n).toString(),
      feesUsd: r ? usd(r.fees0, r.fees1, g.bucket, false) : (prices.p0.has(g.bucket) || prices.p1.has(g.bucket) ? 0 : null),
      liquidity,
      balance0: (bal0 > 0n ? bal0 : 0n).toString(), balance1: (bal1 > 0n ? bal1 : 0n).toString(),
      tvlUsd: usd(bal0 > 0n ? bal0 : 0n, bal1 > 0n ? bal1 : 0n, g.bucket, false),
      blockHeight: r?.lastBlock ?? null,
    })
  }
  return out
}

export interface V3RawBucket {
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  /** The tick after the bucket's last Swap/Initialize; null when none. */
  tick: number | null
  swaps: number
  inits: number
  volume0: bigint
  volume1: bigint
  fees0: bigint
  fees1: bigint
  /** The bucket's mints (+) and burns (−) of liquidity, in event order. */
  ranges: V3RangeDelta[]
  /** Net token flow into the pool this bucket (mints + swap-ins − collects − protocol collects + flash fees). */
  flow0: bigint
  flow1: bigint
  lastBlock: number
}


// The per-event contribution to the pool's holdings, in token0/token1 (Int256 in SQL).
const FLOW0 = `multiIf(event_name = 'Mint', amount0, event_name = 'Swap', amount0, event_name IN ('Collect', 'CollectProtocol'), -amount0, event_name = 'Flash', toInt256(aux0) - amount0, toInt256(0))`
const FLOW1 = `multiIf(event_name = 'Mint', amount1, event_name = 'Swap', amount1, event_name IN ('Collect', 'CollectProtocol'), -amount1, event_name = 'Flash', toInt256(aux1) - amount1, toInt256(0))`

function priceSql(d0: number, d1: number): string {
  // Float64 of a uint160 is exact to ~16 digits — plenty for a chart; the 2^96 shift
  // and the decimal scale are folded so the division cannot overflow.
  return `pow(toFloat64(sqrt_price_x96) / 79228162514264337593543950336, 2) * ${10 ** (d0 - d1)}`
}

/**
 * Per-bucket aggregates over the pool's rows for [fromSec, toSec], keyed by the grain.
 * The swap grain keys on the event itself (`toString(block_timestamp)` plus the event
 * index, so two swaps in one block stay two points).
 */
export async function loadV3Buckets(
  client: ClickHouseClient,
  pool: V3HistoryPool,
  grain: V3Grain,
  fromSec: number,
  toSec: number,
): Promise<Map<string, V3RawBucket>> {
  const price = priceSql(pool.decimals0, pool.decimals1)
  const fee = `toUInt256(${Math.trunc(pool.fee)})`
  const key = grain.kind === 'swap'
    ? `concat(toString(block_timestamp), '#', toString(event_index))`
    : grain.grain.keySql('block_timestamp')
  const res = await client.query({
    query: `-- v3:history:buckets
            SELECT ${key} AS d,
              argMinIf(${price}, (block_height, event_index), event_name IN ('Swap', 'Initialize')) AS open,
              maxIf(${price}, event_name IN ('Swap', 'Initialize')) AS high,
              minIf(${price}, event_name IN ('Swap', 'Initialize')) AS low,
              argMaxIf(${price}, (block_height, event_index), event_name IN ('Swap', 'Initialize')) AS close,
              argMaxIf(tick, (block_height, event_index), event_name IN ('Swap', 'Initialize')) AS tick,
              countIf(event_name = 'Swap') AS swaps, countIf(event_name = 'Initialize') AS inits,
              toString(sumIf(abs(amount0), event_name = 'Swap')) AS volume0,
              toString(sumIf(abs(amount1), event_name = 'Swap')) AS volume1,
              toString(sumIf(intDiv(toUInt256(amount0) * ${fee}, toUInt256(1000000)), event_name = 'Swap' AND amount0 > 0)) AS fees0,
              toString(sumIf(intDiv(toUInt256(amount1) * ${fee}, toUInt256(1000000)), event_name = 'Swap' AND amount1 > 0)) AS fees1,
              toString(sum(${FLOW0})) AS flow0, toString(sum(${FLOW1})) AS flow1,
              max(block_height) AS last_block
            FROM price_data.uniswap_v3_events FINAL
            PREWHERE contract_address = {pool:String} AND kind = 'pool'
            WHERE block_timestamp >= toDateTime({from:UInt32}) AND block_timestamp < toDateTime({to:UInt32}) AND ${V3_MEANINGFUL_SQL}
            GROUP BY d ORDER BY d
            SETTINGS max_memory_usage = 2000000000, max_threads = 4`,
    query_params: { pool: pool.address.toLowerCase(), from: Math.max(0, Math.trunc(fromSec)), to: Math.trunc(toSec) },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ d: string; open: number; high: number; low: number; close: number; tick: number | string; swaps: number | string; inits: number | string; volume0: string; volume1: string; fees0: string; fees1: string; flow0: string; flow1: string; last_block: number | string }>()
  const out = new Map<string, V3RawBucket>()
  for (const r of rows) {
    const priced = Number(r.swaps) + Number(r.inits) > 0
    out.set(r.d, {
      open: priced ? Number(r.open) : null, high: priced ? Number(r.high) : null, low: priced ? Number(r.low) : null, close: priced ? Number(r.close) : null,
      tick: priced ? Number(r.tick) : null,
      swaps: Number(r.swaps), inits: Number(r.inits),
      volume0: big(r.volume0), volume1: big(r.volume1), fees0: big(r.fees0), fees1: big(r.fees1),
      ranges: [],
      flow0: big(r.flow0), flow1: big(r.flow1), lastBlock: Number(r.last_block),
    })
  }
  return out
}

/**
 * The pool's mints and burns of liquidity up to `toSec`, in event order: those before
 * `fromSec` as the carry (the ranges already open when the window starts), the rest
 * keyed by the grain's bucket. Only Mint/Burn rows that moved liquidity — a pool's
 * range book is small next to its swaps, so this is one bounded read of a few rows
 * per position change.
 */
export async function loadV3RangeDeltas(
  client: ClickHouseClient,
  pool: V3HistoryPool,
  grain: V3Grain,
  fromSec: number,
  toSec: number,
): Promise<{ carry: V3RangeDelta[]; byBucket: Map<string, V3RangeDelta[]> }> {
  const key = grain.kind === 'swap'
    ? `concat(toString(block_timestamp), '#', toString(event_index))`
    : grain.grain.keySql('block_timestamp')
  const res = await client.query({
    query: `-- v3:history:ranges
            SELECT if(block_timestamp < toDateTime({from:UInt32}), '', ${key}) AS d,
                   tick_lower, tick_upper,
                   toString(if(event_name = 'Mint', toInt256(liquidity), -toInt256(liquidity))) AS delta
            FROM price_data.uniswap_v3_events FINAL
            PREWHERE contract_address = {pool:String} AND kind = 'pool'
            WHERE event_name IN ('Mint', 'Burn') AND liquidity > 0 AND block_timestamp < toDateTime({to:UInt32})
            ORDER BY block_height, event_index
            SETTINGS max_memory_usage = 1000000000, max_threads = 2`,
    query_params: { pool: pool.address.toLowerCase(), from: Math.max(0, Math.trunc(fromSec)), to: Math.trunc(toSec) },
    format: 'JSONEachRow',
  })
  const carry: V3RangeDelta[] = []
  const byBucket = new Map<string, V3RangeDelta[]>()
  for (const r of await res.json<{ d: string; tick_lower: number | string; tick_upper: number | string; delta: string }>()) {
    const delta = { tickLower: Number(r.tick_lower), tickUpper: Number(r.tick_upper), delta: big(r.delta) }
    if (r.d === '') { carry.push(delta); continue }
    const list = byBucket.get(r.d); if (list) list.push(delta); else byBucket.set(r.d, [delta])
  }
  return { carry, byBucket }
}

/** What stood before `fromSec`: the last close and tick and the holdings (the open ranges come from loadV3RangeDeltas). */
export async function loadV3CarryIn(client: ClickHouseClient, pool: V3HistoryPool, fromSec: number): Promise<Omit<V3CarryIn, 'ranges'>> {
  const price = priceSql(pool.decimals0, pool.decimals1)
  const res = await client.query({
    query: `-- v3:history:carry
            SELECT argMaxIf(${price}, (block_height, event_index), event_name IN ('Swap', 'Initialize')) AS close,
                   argMaxIf(tick, (block_height, event_index), event_name IN ('Swap', 'Initialize')) AS tick,
                   countIf(event_name IN ('Swap', 'Initialize')) AS priced,
                   toString(sum(${FLOW0})) AS flow0, toString(sum(${FLOW1})) AS flow1
            FROM price_data.uniswap_v3_events FINAL
            PREWHERE contract_address = {pool:String} AND kind = 'pool'
            WHERE block_timestamp < toDateTime({from:UInt32})
            SETTINGS max_memory_usage = 2000000000, max_threads = 4`,
    query_params: { pool: pool.address.toLowerCase(), from: Math.max(0, Math.trunc(fromSec)) },
    format: 'JSONEachRow',
  })
  const r = (await res.json<{ close: number; tick: number | string; priced: number | string; flow0: string; flow1: string }>())[0]
  if (!r) return { close: null, tick: null, balance0: 0n, balance1: 0n }
  const priced = Number(r.priced) > 0
  return { close: priced ? Number(r.close) : null, tick: priced ? Number(r.tick) : null, balance0: big(r.flow0), balance1: big(r.flow1) }
}

/** Swaps in a window and the pool's first event, to pick the grain. */
export async function loadV3WindowFacts(client: ClickHouseClient, pool: string, fromSec: number, toSec: number): Promise<{ swaps: number; firstSec: number | null; lastSec: number | null }> {
  const res = await client.query({
    query: `-- v3:history:facts
            SELECT countIf(event_name = 'Swap' AND block_timestamp >= toDateTime({from:UInt32}) AND block_timestamp < toDateTime({to:UInt32})) AS swaps,
                   toUnixTimestamp(min(block_timestamp)) AS first_sec, toUnixTimestamp(max(block_timestamp)) AS last_sec, count() AS n
            FROM price_data.uniswap_v3_events FINAL
            PREWHERE contract_address = {pool:String} AND kind = 'pool'
            SETTINGS max_memory_usage = 1000000000, max_threads = 2`,
    query_params: { pool: pool.toLowerCase(), from: Math.max(0, Math.trunc(fromSec)), to: Math.trunc(toSec) },
    format: 'JSONEachRow',
  })
  const r = (await res.json<{ swaps: number | string; first_sec: number | string; last_sec: number | string; n: number | string }>())[0]
  if (!r || Number(r.n) === 0) return { swaps: 0, firstSec: null, lastSec: null }
  return { swaps: Number(r.swaps), firstSec: Number(r.first_sec), lastSec: Number(r.last_sec) }
}

/**
 * The two tokens' closes per bucket, from the hourly (or daily) candle model — an
 * aToken side reads its reserve's candles. On the swap grain every point takes the
 * close of the hour it falls in.
 */
export async function loadV3BucketPrices(
  client: ClickHouseClient,
  pool: V3HistoryPool,
  grain: V3Grain,
  keys: { bucket: string; t: number }[],
  fromSec: number,
  toSec: number,
): Promise<{ p0: Map<string, number>; p1: Map<string, number> }> {
  const ids = [priceAssetId(pool.asset0), priceAssetId(pool.asset1)]
  const hourly = grain.kind === 'swap' || !grain.grain.daily
  const keySql = grain.kind === 'swap' ? `toString(interval_start)` : grain.grain.keySql('interval_start')
  const res = await client.query({
    query: `-- v3:history:prices
            SELECT asset_id, ${keySql} AS d, toFloat64(argMax(close, interval_start)) AS close
            FROM (
              SELECT asset_id, interval_start, argMaxMerge(close_state) AS close
              FROM price_data.${hourly ? 'ohlc_1h' : 'ohlc_1d'}
              WHERE asset_id IN {ids:Array(UInt32)}
                AND interval_start >= toDateTime({from:UInt32}) - INTERVAL 1 DAY AND interval_start < toDateTime({to:UInt32}) + INTERVAL 1 DAY
              GROUP BY asset_id, interval_start
            )
            GROUP BY asset_id, d`,
    query_params: { ids, from: Math.max(0, Math.trunc(fromSec)), to: Math.trunc(toSec) },
    format: 'JSONEachRow',
  })
  const byAsset = new Map<number, Map<string, number>>()
  for (const r of await res.json<{ asset_id: number; d: string; close: number }>()) {
    if (!(r.close > 0)) continue
    let m = byAsset.get(Number(r.asset_id)); if (!m) { m = new Map(); byAsset.set(Number(r.asset_id), m) }
    m.set(r.d, r.close)
  }
  const pick = (assetId: number): Map<string, number> => {
    const src = byAsset.get(priceAssetId(assetId)) ?? new Map<string, number>()
    if (grain.kind !== 'swap') return src
    // Swap points: the close of the hour the swap fell in (its timestamp floored).
    const out = new Map<string, number>()
    for (const k of keys) {
      const hour = new Date(Math.floor(k.t / 3600) * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
      const v = src.get(hour); if (v != null) out.set(k.bucket, v)
    }
    return out
  }
  return { p0: pick(pool.asset0), p1: pick(pool.asset1) }
}

export interface V3HistoryOptions {
  fromSec?: number
  toSec?: number
  /** Point budget the grain is chosen for (default 180). */
  points?: number
  /** Use this grain instead of choosing one (the public API's fixed buckets). */
  grain?: HistoryGrain
  /** Drop the bucket still in progress (public API: only closed buckets). */
  closedOnly?: boolean
}

export interface V3History {
  pool: string
  grain: { kind: 'ladder'; stepSec: number } | { kind: 'swap' }
  fromSec: number
  toSec: number
  points: V3HistoryPoint[]
}

/** The series for a pool over a window (default: its whole life at ≤ `points` buckets). */
export async function v3PoolHistory(client: ClickHouseClient, pool: V3HistoryPool, opts: V3HistoryOptions = {}, nowSec = Math.floor(Date.now() / 1000)): Promise<V3History> {
  const points = opts.points ?? 180
  const facts = await loadV3WindowFacts(client, pool.address, opts.fromSec ?? 0, opts.toSec ?? nowSec)
  const firstSec = facts.firstSec ?? nowSec
  // A window never opens before the pool existed: the buckets before its first event
  // would be all-null padding (a year of it, for a 1y request on a week-old pool).
  const fromSec = Math.max(opts.fromSec ?? firstSec, firstSec)
  const toSec = Math.min(opts.toSec ?? nowSec, nowSec)
  if (toSec <= fromSec) return { pool: pool.address, grain: { kind: 'ladder', stepSec: 86_400 }, fromSec, toSec, points: [] }
  const grain: V3Grain = opts.grain
    ? { kind: 'ladder', grain: opts.grain }
    : opts.fromSec != null || opts.toSec != null
      ? chooseV3Grain(fromSec, toSec, points, facts.swaps)
      : { kind: 'ladder', grain: fullRangeGrain(firstSec, toSec, points) }
  const [rows, carryIn, deltas] = await Promise.all([
    loadV3Buckets(client, pool, grain, fromSec, toSec),
    loadV3CarryIn(client, pool, fromSec),
    loadV3RangeDeltas(client, pool, grain, fromSec, toSec),
  ])
  // A mint or burn is itself a pool row, so its bucket always exists in `rows`.
  for (const [key, list] of deltas.byBucket) { const row = rows.get(key); if (row) row.ranges = list }
  const carry: V3CarryIn = { ...carryIn, ranges: deltas.carry }
  let grid: { bucket: string; t: number }[]
  if (grain.kind === 'swap') {
    grid = [...rows.keys()].map(k => ({ bucket: k, t: Math.floor(new Date(k.slice(0, 19).replace(' ', 'T') + 'Z').getTime() / 1000) }))
      .sort((a, b) => a.t - b.t || (a.bucket < b.bucket ? -1 : 1))
  } else {
    const g = grain.grain
    const end = opts.closedOnly ? Math.floor(toSec / g.stepSec) * g.stepSec - 1 : toSec
    grid = g.grid(fromSec, Math.max(fromSec, end)).map(bucket => ({ bucket, t: bucketStartSec(bucket) }))
  }
  const prices = await loadV3BucketPrices(client, pool, grain, grid, fromSec, toSec)
  const series = assembleV3Series(grid, rows, carry, prices, { d0: pool.decimals0, d1: pool.decimals1 })
  return { pool: pool.address, grain: grain.kind === 'swap' ? { kind: 'swap' } : { kind: 'ladder', stepSec: grain.grain.stepSec }, fromSec, toSec, points: series }
}

/** Unix seconds of a bucket key (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`), read as UTC. */
export function bucketStartSec(key: string): number {
  const iso = key.length === 10 ? `${key}T00:00:00Z` : `${key.replace(' ', 'T')}Z`
  return Math.floor(new Date(iso).getTime() / 1000)
}
