// The one switch every pair-candle reader goes through: PAIR_PRICE_SOURCE.
//
//   'usd-ratio' (the default) — a pair is the ratio of its two assets' USD prices,
//               per block (services/crossPair.ts), or the base asset's own USD
//               candles when the quote is a USD-pegged token. Exactly today's output.
//   'route'     — a bucket the route-priced fold covers (pair_route_ohlc, see
//               clickhouse/schema/014_pair_routes.sql) takes the price along the
//               pair's best on-chain trade route instead; every other bucket keeps
//               the 'usd-ratio' candle. Volumes always stay the usd-ratio candle's
//               (the base asset's USD volume) — a route has no volume of its own.
//
// The fold trails the chain by up to one derivations cycle. The stretch it has not
// covered yet — from its newest folded block to the indexed head, at most
// ROUTE_TAIL_MAX_BLOCKS — is folded on request by the same code (pairRouteFold's
// foldHour over the same per-block snapshots, route chosen the same way, for the
// one pair asked), so 'route' mode is route-priced up to the head, as the
// Hydration app paints its last candle from the SDK. The stretch's shared inputs
// are read once per raw head (rebuilt only when the head moves, see tailInputsAt)
// and folded per pair.
//
// Switching is an environment change and a restart of the services that read pairs
// (api, api-public); response shapes are unchanged, and in 'route' mode a candle
// additionally names its method (`priceSource`).

import type { ClickHouseClient } from '../db/client.ts'
import type { OHLCVInterval } from './ohlcvService.ts'
import { cached } from './cache.ts'
import { assetDescriptor } from './explorerAssets.ts'
// The fold is loaded on first use (the tail only): it pulls the route search and
// the stableswap math, which no 'usd-ratio' read needs.
import type { FoldHourInputs, PairRouteRow } from './pairRouteFold.ts'
const fold = () => import('./pairRouteFold.ts')

export type PairPriceSource = 'usd-ratio' | 'route'
/**
 * How one candle was priced, in 'route' mode: `route` along the pair's route;
 * `usd-ratio` the USD ratio where that IS the pair's price (the fold covered the
 * bucket and the route there was the Omnipool crossing, or a coarse bucket mixing
 * such sub-buckets with routed ones); `usd-ratio-fallback` the USD ratio served in
 * place of a route price the fold could not state — a bucket it has not covered
 * (outside its history, or not folded yet past the on-request tail) or one whose
 * route lost a hop mid-bucket. Explicit, never silent (AGENTS.md).
 */
export type CandlePriceSource = PairPriceSource | 'usd-ratio-fallback'
export const CANDLE_PRICE_SOURCES: readonly CandlePriceSource[] = ['route', 'usd-ratio', 'usd-ratio-fallback']
export const PAIR_PRICE_SOURCES: readonly PairPriceSource[] = ['usd-ratio', 'route']

/** The configured source; anything but 'route' is today's 'usd-ratio'. */
export function pairPriceSource(raw: string | undefined = process.env.PAIR_PRICE_SOURCE): PairPriceSource {
  return raw?.trim().toLowerCase() === 'route' ? 'route' : 'usd-ratio'
}

/** A request-level override where a surface offers one (explorer routes only), else the configured source. */
export function resolvePairPriceSource(override: string | undefined | null): PairPriceSource {
  return override === 'route' || override === 'usd-ratio' ? override : pairPriceSource()
}

/** Digits a route candle is served at: the cross module's CROSS_SCALE, so both methods read alike. */
export const ROUTE_SERVE_SCALE = 18
/** Digits the fold stores (pairRoutes.ROUTE_PRICE_SCALE). */
const STORED_SCALE = 30

/** One bucket of a pair's route price, oriented base/quote, as decimal text at ROUTE_SERVE_SCALE digits. */
export interface RouteCandle {
  /** The bucket's opening instant, unix seconds. */
  intervalStart: number
  open: string
  high: string
  low: string
  close: string
}

type StoredIv = '5min' | '1h' | '1d'

/** The stored interval a requested one is read from, and how its buckets group. */
const SOURCE_IV: Record<OHLCVInterval, StoredIv> = {
  '5min': '5min', '15min': '5min', '30min': '5min',
  '1h': '1h', '4h': '1h',
  '1d': '1d', '1w': '1d', '1M': '1d',
}
const SUB_SECONDS: Record<StoredIv, number> = { '5min': 300, '1h': 3_600, '1d': 86_400 }
const MONDAY = 345_600

/** The requested interval's bucket start for an instant (unix seconds), on the candle model's grid. */
export function bucketStart(interval: OHLCVInterval, t: number): number {
  switch (interval) {
    case '5min': return Math.floor(t / 300) * 300
    case '15min': return Math.floor(t / 900) * 900
    case '30min': return Math.floor(t / 1_800) * 1_800
    case '1h': return Math.floor(t / 3_600) * 3_600
    case '4h': return Math.floor(t / 14_400) * 14_400
    case '1d': return Math.floor(t / 86_400) * 86_400
    case '1w': return Math.floor((t - MONDAY) / 604_800) * 604_800 + MONDAY
    case '1M': {
      const d = new Date(t * 1000)
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
    }
  }
}

/** The end (exclusive) of the requested interval's bucket starting at `start`. */
function bucketEnd(interval: OHLCVInterval, start: number): number {
  if (interval === '1M') {
    const d = new Date(start * 1000)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000
  }
  const seconds: Record<Exclude<OHLCVInterval, '1M'>, number> = { '5min': 300, '15min': 900, '30min': 1_800, '1h': 3_600, '4h': 14_400, '1d': 86_400, '1w': 604_800 }
  return start + seconds[interval]
}

const pow10 = (n: number) => 10n ** BigInt(n)

/** Stored decimal text (30 digits) as a scaled integer. */
function parseStored(text: string): bigint {
  const [whole, frac = ''] = text.trim().split('.')
  return BigInt(`${whole || '0'}${frac.slice(0, STORED_SCALE).padEnd(STORED_SCALE, '0')}`)
}

/** A STORED-scale integer as text at ROUTE_SERVE_SCALE digits, truncated. */
function serve(v: bigint): string {
  const s = (v / pow10(STORED_SCALE - ROUTE_SERVE_SCALE)).toString().padStart(ROUTE_SERVE_SCALE + 1, '0')
  return `${s.slice(0, -ROUTE_SERVE_SCALE)}.${s.slice(-ROUTE_SERVE_SCALE)}`
}

/** 1/x at the stored scale. */
const invert = (v: bigint): bigint => (v > 0n ? pow10(2 * STORED_SCALE) / v : 0n)

export interface StoredRow {
  lo: number
  hi: number
  t: number
  open: string
  high: string
  low: string
  close: string
  complete: number
}

const TABLES: Record<StoredIv, string> = {
  '5min': 'price_data.pair_route_ohlc_5min',
  '1h': 'price_data.pair_route_ohlc_1h',
  '1d': 'price_data.pair_route_ohlc_1d',
}

/** One pair's stored rows in a window: FINAL over its primary-key prefix (one pair, one window). */
export function routeCandlesSql(iv: StoredIv): string {
  return `-- pair-route:candles
    SELECT asset_lo AS lo, asset_hi AS hi, toUnixTimestamp(interval_start) AS t,
           toString(open) AS open, toString(high) AS high, toString(low) AS low, toString(close) AS close, complete
    FROM ${TABLES[iv]} FINAL
    WHERE asset_lo = {lo:UInt32} AND asset_hi = {hi:UInt32}
      AND interval_start >= {start:DateTime} AND interval_start < {end:DateTime}
    ORDER BY t`
}

/** The fold's coverage per hour of a window: how far into each folded hour it got. */
export const ROUTE_COVERAGE_SQL = `-- pair-route:coverage
  SELECT toUnixTimestamp(hour) AS h, toUnixTimestamp(max(der_last_ts)) AS lt, toUInt8(max(der_last_block) >= max(maxb)) AS full
  FROM price_data.pair_route_hour_watermarks
  WHERE hour >= {start:DateTime} AND hour < {end:DateTime}
  GROUP BY hour
  HAVING max(der_computed) > toDateTime(0)`

/**
 * The fold's coverage per hour (unix seconds): the timestamp of the newest block
 * folded in it, and whether that is the hour's own newest block (the hour folded
 * whole). An hour absent is not folded.
 */
export type RouteCoverage = Map<number, { lt: number; full: boolean }>

// A sub-bucket ending within this of the newest folded block counts as covered.
const BLOCK_SLACK = 30

type SubStatus = 'full' | 'partial' | 'uncovered'

/** Whether the fold covered [s, s + len): every hour in it folded through its part of it. */
function coverageOf(coverage: RouteCoverage, s: number, len: number): SubStatus {
  let partial = false
  for (let h = Math.floor(s / 3_600) * 3_600; h < s + len; h += 3_600) {
    const c = coverage.get(h)
    if (c == null) return 'uncovered'
    if (c.full) continue
    // Folded only up to lt: nothing of this hour after it is covered.
    if (c.lt < Math.max(s, h)) return 'uncovered'
    if (c.lt < Math.min(s + len, h + 3_600) - BLOCK_SLACK) partial = true
  }
  return partial ? 'partial' : 'full'
}

interface Scaled { t: number; o: bigint; h: bigint; l: bigint; c: bigint }

/** Route candles by bucket start; `fallback` names the window's buckets the fold could not state (see CandlePriceSource). */
export type RouteCandles = Map<number, RouteCandle> & { fallback?: Set<number> }

/**
 * Groups stored sub-bucket rows into the requested interval's buckets. A bucket is
 * route-priced only when the fold covered it (the coverage) and the pair has a
 * COMPLETE row for every sub-bucket it covered — the whole bucket, or, for the
 * bucket the fold's coverage ends in (the one still filling), every sub-bucket up
 * to that end. A covered sub-bucket without a pair row is one whose route was a
 * single Omnipool crossing: the USD ratio prices it, so the bucket falls back.
 */
export function groupRouteRows(
  interval: OHLCVInterval, rows: readonly StoredRow[], baseIsLo: boolean, coverage: RouteCoverage,
  window?: { start: number; end: number },
): RouteCandles {
  const iv = SOURCE_IV[interval]
  const sub = SUB_SECONDS[iv]
  const pair = new Map<number, Scaled>()
  const incomplete = new Set<number>()
  for (const r of rows) {
    if (!Number(r.complete)) { incomplete.add(Number(r.t)); continue }
    let o = parseStored(r.open), h = parseStored(r.high), l = parseStored(r.low), c = parseStored(r.close)
    if (!baseIsLo) {
      // The price of hi in lo: every value inverted, and the extremes trade places.
      const [io, ih, il, ic] = [invert(o), invert(l), invert(h), invert(c)]
      o = io; h = ih; l = il; c = ic
    }
    if (o <= 0n || h <= 0n || l <= 0n || c <= 0n) continue
    pair.set(Number(r.t), { t: Number(r.t), o, h, l, c })
  }
  const out = new Map<number, RouteCandle>()
  let coverageEnd = 0
  for (const c of coverage.values()) if (c.lt > coverageEnd) coverageEnd = c.lt
  const starts = new Set<number>()
  for (const t of pair.keys()) starts.add(bucketStart(interval, t))
  for (const start of starts) {
    const end = bucketEnd(interval, start)
    const subs: Scaled[] = []
    let ok = true
    for (let t = start; t < end; t += sub) {
      const status = coverageOf(coverage, t, sub)
      if (status === 'uncovered') {
        // Past the coverage's end, inside the bucket it ends in: still filling.
        // Anywhere else an uncovered sub-bucket is a hole the fold has not filled.
        if (!(subs.length && t > coverageEnd - BLOCK_SLACK)) ok = false
        break
      }
      const p = pair.get(t)
      if (!p) { ok = false; break }
      subs.push(p)
      if (status === 'partial') {
        // The coverage ends inside this sub-bucket: nothing after it is covered.
        for (let u = t + sub; u < end; u += sub) if (coverageOf(coverage, u, sub) !== 'uncovered') ok = false
        break
      }
    }
    if (!ok || !subs.length) continue
    let h = subs[0]!.h, l = subs[0]!.l
    for (const x of subs) {
      if (x.h > h) h = x.h
      if (x.l < l) l = x.l
    }
    out.set(start, { intervalStart: start, open: serve(subs[0]!.o), high: serve(h), low: serve(l), close: serve(subs[subs.length - 1]!.c) })
  }
  const result: RouteCandles = out
  if (window) {
    // Every window bucket not route-priced: a fallback when some sub-bucket was not
    // covered by the fold (other than past the coverage's end inside the bucket it
    // ends in, which is still filling) or holds an incomplete row.
    const fallback = new Set<number>()
    for (let start = bucketStart(interval, window.start); start < window.end; start = bucketEnd(interval, start)) {
      if (out.has(start)) continue
      const end = bucketEnd(interval, start)
      for (let t = start; t < end; t += sub) {
        if (incomplete.has(t)) { fallback.add(start); break }
        if (coverageOf(coverage, t, sub) === 'uncovered') {
          if (!(t > start && t > coverageEnd - BLOCK_SLACK)) fallback.add(start)
          break
        }
      }
    }
    result.fallback = fallback
  }
  return result
}

/** The most blocks of not-yet-folded tail folded on request; a longer gap is served from its newest blocks. */
export const ROUTE_TAIL_MAX_BLOCKS = 900
// One pair's tail fold is keyed by the tail's head, so this only bounds how long a
// pair nobody asks for again stays in memory.
const TAIL_PAIR_TTL_MS = 30_000
// How long one head probe is reused. Detecting a new head costs one trivial read
// (max over the raw checkpoint, ~3 ms) per this window, shared by every request.
const HEAD_PROBE_MS = 1_000

export interface TailInputs { inputs: FoldHourInputs; from: number; head: number }

const chTime = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ')

/* ---------------- the heads the live tail and the closed-candle clamp key on ---------------- */

// The raw pipeline's checkpoint: the newest block every raw table (snapshots and
// EVM logs alike) has flushed — what the tail fold reads. A process with a head
// push (the api's SSE poller) publishes each head it is about to broadcast as a
// floor, so a refetch racing the push is never served the probe's older head.
let pushedRawHead = 0
export function publishRouteTailHead(head: number): void {
  if (head > pushedRawHead) pushedRawHead = head
}
async function rawHead(client: ClickHouseClient): Promise<number> {
  const probed = await cached('pair-route:raw-head', HEAD_PROBE_MS, async () => {
    const res = await client.query({ query: 'SELECT max(last_block) AS h FROM price_data.raw_ingestion_state', format: 'JSONEachRow' })
    return Number((await res.json<{ h: number | null }>())[0]?.h ?? 0)
  }).catch(() => 0)
  return Math.max(probed, pushedRawHead)
}

/** The price pipeline's head: its newest fully written block and that block's timestamp (unix seconds). */
export interface PriceHead { block: number; time: number }

/** Unit-test seam: the price-head read (one primary-key point read, ~3 ms). */
export const PRICE_HEAD_SQL = `SELECT block_height AS b, toUnixTimestamp(block_timestamp) AS t
  FROM price_data.blocks WHERE block_height = (SELECT max(block_height) FROM price_data.blocks) LIMIT 1`

/**
 * The newest block the price pipeline has fully written (main-live writes a
 * block's `blocks` row after its prices, candles and swaps), with its timestamp.
 * The pipeline follows the FINALIZED chain, so every block at or below it is final
 * and indexed: a bucket that ended at or before `time` holds every block it will
 * ever hold. This — never wall clock — is what makes a bucket CLOSED for every
 * candle reader that promises closed buckets: a bucket's blocks finalize ~46 s after
 * it ends, so a wall-clock clamp publishes a candle that is still missing its last
 * blocks and revises it afterwards. The route tail reads the raw pipeline, which
 * the price pipeline itself reads from, so it is at or past this head too.
 */
export function pricePipelineHead(client: ClickHouseClient): Promise<PriceHead> {
  return cached('pair-route:price-head', HEAD_PROBE_MS, async () => {
    const res = await client.query({ query: PRICE_HEAD_SQL, format: 'JSONEachRow' })
    const r = (await res.json<{ b: number | string; t: number | string }>())[0]
    return { block: Number(r?.b ?? 0), time: Number(r?.t ?? 0) }
  })
}

/**
 * The start of the newest bucket that ended at or before the head's block
 * timestamp, on a grid of `seconds` anchored at `anchor` — the last CLOSED bucket.
 */
export function lastClosedBucketStart(headTimeSec: number, seconds: number, anchor = 0): number {
  return Math.floor((headTimeSec - anchor) / seconds) * seconds + anchor - seconds
}

/* ---------------- the live tail ---------------- */

/** One tail build: the head it was keyed on and what it produced (null: no tail). */
interface TailBuild { head: number; value: TailInputs | null }
let tailBuilt: TailBuild | null = null
let tailBuilding: { head: number; promise: Promise<TailInputs | null> } | null = null

/** Test seam: forget the built tail. */
export function resetRouteTailForTests(): void {
  tailBuilt = null
  tailBuilding = null
  pushedRawHead = 0
}

/**
 * The unfolded tail's shared inputs (every priced asset, all pools) at the raw head,
 * or at `floor` when the caller needs a newer one; null when there is no tail.
 *
 * Keyed on the head, not on a timer: the build (~110 ms, ~47 MiB) runs once per
 * head that a request reaches and is reused until the head moves, so a candle is
 * route-priced up to a new block as soon as anyone asks after it lands. Single
 * flight: concurrent requests for one head share one build, and a build for a
 * newer head serves every request for an older one. A failed build serves the last
 * good tail rather than failing the candles.
 */
export async function tailInputsAt(client: ClickHouseClient, floor = 0, build: (head: number) => Promise<TailInputs | null> = h => buildTail(client, h)): Promise<TailInputs | null> {
  const head = Math.max(await rawHead(client), floor)
  if (!head) return tailBuilt?.value ?? null
  if (tailBuilt && tailBuilt.head >= head) return tailBuilt.value
  if (!tailBuilding || tailBuilding.head < head) {
    const promise = build(head).then(value => {
      if (!tailBuilt || tailBuilt.head < head) tailBuilt = { head, value }
      return value
    }).finally(() => { if (tailBuilding?.promise === promise) tailBuilding = null })
    tailBuilding = { head, promise }
  }
  try {
    return await tailBuilding.promise
  } catch (error) {
    if (tailBuilt) return tailBuilt.value
    throw error
  }
}

/** The tail's inputs folded from the fold's coverage up to `keyHead` (never past it: blocks above are not fully flushed). */
async function buildTail(client: ClickHouseClient, keyHead: number): Promise<TailInputs | null> {
  const res = await client.query({
    query: `-- pair-route:tail-bounds
      SELECT (SELECT max(der_last_block) FROM price_data.pair_route_hour_watermarks WHERE hour >= now() - INTERVAL 1 DAY) AS cov,
             (SELECT least(max(block_height), {head:UInt32}) FROM price_data.raw_block_snapshots) AS head`,
    query_params: { head: keyHead },
    format: 'JSONEachRow',
  })
  const [b] = await res.json<{ cov: number | string; head: number | string }>()
  const cov = Number(b?.cov ?? 0), head = Number(b?.head ?? 0)
  // No fold coverage within a day: the fold is down, and serving a day of tail
  // per request is not the bound this exists under.
  if (!cov || !head || head <= cov) return null
  const from = Math.max(cov + 1, head - ROUTE_TAIL_MAX_BLOCKS + 1)
  const [pricedRes, reserves, firstRes] = await Promise.all([
    client.query({
      query: `-- pair-route:tail-priced
        SELECT asset_id, toFloat64(argMaxMerge(price_state)) AS p
        FROM price_data.asset_price_latest GROUP BY asset_id
        HAVING maxMerge(block_state) >= {floor:UInt32}`,
      query_params: { floor: Math.max(0, head - 3_600) },
      format: 'JSONEachRow',
    }),
    cached('pair-route:reserve-pairs', 600_000, async () => {
      const r = await client.query({ query: (await fold()).PAIR_ROUTE_RESERVE_PAIRS_SQL, format: 'JSONEachRow' })
      return (await r.json<{ u: number; a: number }>()).map(x => `${x.u}:${x.a}`)
    }),
    client.query({
      query: `SELECT toUnixTimestamp(min(block_timestamp)) AS t FROM price_data.raw_block_snapshots WHERE block_height = {b:UInt32}`,
      query_params: { b: from },
      format: 'JSONEachRow',
    }),
  ])
  const priced = await pricedRes.json<{ asset_id: number; p: number }>()
  const t = Number((await firstRes.json<{ t: number }>())[0]?.t ?? 0)
  if (!t) return null
  const usd = new Map(priced.map(r => [Number(r.asset_id), Number(r.p)]))
  const inputs = await (await fold()).loadFoldHourInputs(client, { hour: Math.floor(t / 3_600) * 3_600, minb: from, maxb: head }, {
    priced: [...usd.keys()], usd, decimals: id => assetDescriptor(id).decimals, reservePairs: new Set(reserves),
    computedAt: chTime(Math.floor(Date.now() / 1000)), v3: true,
  })
  return { inputs, from, head }
}

/** The unfolded tail for one pair: its 5-minute rows (oriented lo/hi) and the tail's own coverage. */
export interface RouteTail { rows: PairRouteRow[]; coverage: RouteCoverage; buckets: number[] }

async function routeTail(client: ClickHouseClient, lo: number, hi: number, floor = 0): Promise<RouteTail | null> {
  const tail = await tailInputsAt(client, floor)
  if (!tail) return null
  const { foldHour } = await fold()
  return cached(`pair-route:tail:${lo}:${hi}:${tail.from}:${tail.head}`, TAIL_PAIR_TTL_MS, async () => {
    // The tail starts on the route in force where the fold stopped (the newest
    // stored hourly row's closing route), as the next stored hour will.
    const seedRes = await client.query({
      query: `-- pair-route:tail-seed
        SELECT argMax(route, (interval_start, computed_at)) AS route
        FROM ${TABLES['1h']}
        WHERE asset_lo = {lo:UInt32} AND asset_hi = {hi:UInt32}
          AND interval_start >= {h:DateTime} - INTERVAL 1 HOUR AND interval_start <= {h:DateTime} AND is_deleted = 0`,
      query_params: { lo, hi, h: chTime(tail.inputs.hour) },
      format: 'JSONEachRow',
    })
    const route = (await seedRes.json<{ route: string }>())[0]?.route
    const seed = route ? new Map([[`${lo}:${hi}`, route]]) : undefined
    const rows = foldHour({ ...tail.inputs, priced: [lo, hi], seed }).rows.filter(r => r.iv === '5min')
    const coverage: RouteCoverage = new Map()
    const buckets = new Set<number>()
    for (const b of tail.inputs.blocks) {
      const h = Math.floor(b.t / 3_600) * 3_600
      coverage.set(h, { lt: Math.max(coverage.get(h)?.lt ?? 0, b.t), full: false })
      buckets.add(Math.floor(b.t / 300) * 300)
    }
    // Every tail hour but the newest is folded whole by the tail.
    const newest = Math.max(...coverage.keys())
    for (const [h, c] of coverage) if (h < newest) c.full = true
    return { rows, coverage, buckets: [...buckets] }
  })
}

const ivStart = (iv: StoredIv, t: number) => (iv === '5min' ? t : iv === '1h' ? Math.floor(t / 3_600) * 3_600 : Math.floor(t / 86_400) * 86_400)

/**
 * Stored rows with the unfolded tail folded in at the stored interval: a tail row
 * extends the bucket it lands in (the stored row keeps its open, the tail brings
 * the close, the extremes are the wider of both) or opens it. A bucket the tail
 * covered stays complete only if every tail 5-minute bucket in it is route-priced.
 */
export function mergeTailRows(stored: readonly StoredRow[], tail: RouteTail, iv: StoredIv): StoredRow[] {
  const out = new Map<number, StoredRow>()
  for (const r of stored) out.set(Number(r.t), { ...r })
  const tailBuckets = new Map<number, number>()
  for (const b of tail.buckets) tailBuckets.set(ivStart(iv, b), (tailBuckets.get(ivStart(iv, b)) ?? 0) + 1)
  const tailPair = new Map<number, number>()
  const ordered = [...tail.rows].sort((a, b) => a.interval_start.localeCompare(b.interval_start))
  for (const r of ordered) {
    const t = ivStart(iv, Math.floor(Date.parse(`${r.interval_start.replace(' ', 'T')}Z`) / 1000))
    tailPair.set(t, (tailPair.get(t) ?? 0) + 1)
    const cur = out.get(t)
    if (!cur) {
      out.set(t, { lo: r.asset_lo, hi: r.asset_hi, t, open: r.open, high: r.high, low: r.low, close: r.close, complete: 1 })
      continue
    }
    const hiV = parseStored(r.high) > parseStored(cur.high) ? r.high : cur.high
    const loV = parseStored(r.low) < parseStored(cur.low) ? r.low : cur.low
    out.set(t, { ...cur, high: hiV, low: loV, close: r.close })
  }
  for (const [t, n] of tailBuckets) {
    if ((tailPair.get(t) ?? 0) === n) continue
    const r = out.get(t)
    if (r) r.complete = 0
  }
  return [...out.values()]
}

/** The two coverages together: an hour folded partly by the fold and partly by the tail reads the later end. */
export function mergeCoverage(a: RouteCoverage, b: RouteCoverage): RouteCoverage {
  const out = new Map(a)
  for (const [h, c] of b) {
    const cur = out.get(h)
    out.set(h, { lt: Math.max(cur?.lt ?? 0, c.lt), full: Boolean(cur?.full || c.full) })
  }
  return out
}

/**
 * The route-priced buckets of `base` quoted in `quote` within [startTime, endTime):
 * buckets whose start lies in the window, keyed by bucket start. Empty when the
 * pair has no route-priced bucket there (its route never leaves the Omnipool, or
 * the fold has not covered it).
 */
export async function queryRouteCandles(
  client: ClickHouseClient,
  options: { baseId: number; quoteId: number; startTime: Date; endTime: Date; interval: OHLCVInterval; headFloor?: number },
): Promise<RouteCandles> {
  const { baseId, quoteId, interval } = options
  if (baseId === quoteId) return new Map()
  const lo = Math.min(baseId, quoteId), hi = Math.max(baseId, quoteId)
  const startSec = Math.floor(options.startTime.getTime() / 1000)
  const endSec = Math.floor(options.endTime.getTime() / 1000)
  if (endSec <= startSec) return new Map()
  // The read spans whole requested buckets, so a bucket straddling the window start
  // is either read whole or (as below) dropped — the cross module drops it too.
  const readStart = bucketStart(interval, startSec)
  const readEnd = bucketEnd(interval, bucketStart(interval, endSec - 1))
  const iv = SOURCE_IV[interval]
  const params = { lo, hi, start: chTime(readStart), end: chTime(readEnd) }
  const settings = { max_threads: 4, max_memory_usage: '1000000000' }
  const [rowsRes, covRes] = await Promise.all([
    client.query({ query: routeCandlesSql(iv), query_params: params, clickhouse_settings: settings, format: 'JSONEachRow' }),
    // Coverage is per hour: from the hour the window starts in, or a window opening
    // mid-hour would read its first hour as unfolded.
    client.query({ query: ROUTE_COVERAGE_SQL, query_params: { ...params, start: chTime(Math.floor(readStart / 3_600) * 3_600) }, clickhouse_settings: settings, format: 'JSONEachRow' }),
  ])
  let rows = await rowsRes.json<StoredRow>()
  let coverage: RouteCoverage = new Map((await covRes.json<{ h: number; lt: number; full: number }>())
    .map(r => [Number(r.h), { lt: Number(r.lt), full: Boolean(Number(r.full)) }]))
  // The live tail, for a window reaching into the last hour.
  if (endSec > Date.now() / 1000 - 3_600) {
    // `headFloor`: a block the caller has already seen indexed (the closed-candle
    // clamp's head), which the tail must reach so its last bucket is whole.
    const tail = await routeTail(client, lo, hi, options.headFloor ?? 0)
    if (tail) {
      rows = mergeTailRows(rows, tail, iv)
      coverage = mergeCoverage(coverage, tail.coverage)
    }
  }
  const grouped = groupRouteRows(interval, rows, baseId === lo, coverage, { start: readStart, end: readEnd })
  for (const t of [...grouped.keys()]) if (t < startSec || t >= endSec) grouped.delete(t)
  return grouped
}

/** A candle tagged with the method that priced it (route mode only). */
export type Sourced<T> = T & { priceSource?: CandlePriceSource }

/**
 * Today's candles with every route-priced bucket substituted: `withRoute` builds the
 * substituted candle from the route candle and the bucket's existing candle (null
 * when only the route covers it). The result is ordered by bucket, every candle
 * tagged with its `priceSource`.
 */
export function overlayRouteCandles<T>(
  candles: readonly T[],
  route: ReadonlyMap<number, RouteCandle> & { fallback?: ReadonlySet<number> },
  startOf: (candle: T) => number,
  withRoute: (rc: RouteCandle, existing: T | null) => T,
): Array<Sourced<T>> {
  const byStart = new Map<number, T>()
  for (const c of candles) byStart.set(startOf(c), c)
  const starts = [...new Set([...byStart.keys(), ...route.keys()])].sort((a, b) => a - b)
  return starts.map(t => {
    const rc = route.get(t)
    if (rc) return { ...withRoute(rc, byStart.get(t) ?? null), priceSource: 'route' as const }
    return { ...byStart.get(t)!, priceSource: route.fallback?.has(t) ? 'usd-ratio-fallback' as const : 'usd-ratio' as const }
  })
}
