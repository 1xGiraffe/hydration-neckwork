// The pair_route_ohlc fold's inputs and its per-hour computation: the per-block
// pool state of an hour read from raw_block_snapshots (only what changed), the
// Uniswap v3 pools' prices, the Omnipool fee estimates and the hour's priced asset
// set, and the 5-minute / hourly candle rows computed from them with the route
// search in pairRoutes.ts. The publication (stale hours, day partitions, staging
// twin) is the `pair_route_ohlc` job in derivations/jobs.ts.
//
// Why raw_block_snapshots and not the pool state-history tables: those sample
// every 600th block (20 minutes at today's 2 s blocks, 2 hours at the old 12 s),
// which cannot state a 5-minute candle. The snapshot is the one per-block record of
// pool state, and the omnipool/stableswap/xyk sections are ~8 KB of its ~275 KB, so
// the read extracts those sections in ClickHouse and ships only the keys whose
// value CHANGED from the previous block (lagInFrame over each pool key), plus every
// key at the range's first block as the baseline. Measured: one hour (1,800 blocks)
// extracts in ~0.1 s and ships a few thousand rows.

import type { ClickHouseClient } from '../db/client.ts'
import { V3_TOKEN_ASSETS_CTE, v3TokenAssetSql } from './revenueStreams.ts'
import { activeLiquidity, applyRangeDeltas, big, type V3RangeBook } from './uniswapV3Ranges.ts'
import { tickTableFromRanges } from './uniswapV3Math.ts'
import {
  applyStateChange,
  formatV3Value,
  hopRoundTrip,
  parseRouteLabel,
  routeCandidates,
  buildRouteGraph,
  emptyRouteState,
  FLOOR_FEES,
  hopStateKeys,
  isPureOmnipool,
  OMNI_SLIP_KEY,
  parseAtokenValue,
  routeFeePpm,
  routeLabel,
  hopSpot,
  ROUTE_PRICE_SCALE,
  ROUTE_REFERENCE_USD,
  routeEraAt,
  type Decimals,
  type FeeModel,
  type Hop,
  type Ratio,
  type RouteState,
  OMNI_BUY_FEE_FLOOR,
  OMNI_SELL_FEE_FLOOR,
} from './pairRoutes.ts'

/** The stored intervals' tables (clickhouse/schema/014_pair_routes.sql). */
export const PAIR_ROUTE_TABLES = {
  '5min': 'price_data.pair_route_ohlc_5min',
  '1h': 'price_data.pair_route_ohlc_1h',
  '1d': 'price_data.pair_route_ohlc_1d',
} as const
export const PAIR_ROUTE_WATERMARKS_TABLE = 'price_data.pair_route_hour_watermarks'
const BUCKET_SECONDS = 300

/**
 * The hour's pool state as change rows: (key, block, value, last block the key was
 * present in the range). Keys: `o:<asset>` an Omnipool asset (`reserve,hub,tradable`),
 * `s:<pool>` a stableswap pool (its raw snapshot object), `x:<account>` an XYK pool
 * holding a priced asset (`a,b,reserve_a,reserve_b`), `a:` / `l:` the snapshot's
 * atoken and lp equivalence lists. Only rows whose value differs from the key's
 * previous block in the range are returned; the first block carries every key.
 */
export function pairRouteStateChangesSql(): string {
  // Every JSONExtract call parses its document from the start, and the payload's
  // first ~78 % is the asset registry (`assets.items`), which nothing here reads.
  // The snapshot writes its sections in one fixed order (schema_version, block,
  // assets{items, atoken_equivalences, lp_equivalences}, omnipool, xyk, stableswap),
  // so the pool sections are parsed from the payload's tail and the equivalence
  // lists from the slice between them and the pools: 2.74 → 0.99 CPU-s for an hour
  // of 2 s blocks, measured. A payload in any other shape is parsed whole.
  return `-- pair-route:state
    SELECT k, b, v, lastb FROM (
      SELECT k, b, v,
             lagInFrame(v, 1, '') OVER (PARTITION BY k ORDER BY b ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS pv,
             max(b) OVER (PARTITION BY k) AS lastb
      FROM (
        SELECT b, kv.1 AS k, kv.2 AS v
        FROM (
          SELECT block_height AS b,
                 position(payload_json, ',"omnipool":') AS pos_pools,
                 position(payload_json, '"atoken_equivalences":') AS pos_eq,
                 if(pos_pools > 0, concat('{', substring(payload_json, pos_pools + 1)), payload_json) AS pools_json,
                 if(pos_eq > 0 AND pos_pools > pos_eq, concat('{', substring(payload_json, pos_eq, pos_pools - pos_eq)),
                    JSONExtractRaw(payload_json, 'assets')) AS eq_json
          -- Not deduplicated by ingest: a replayed block repeats identical values, which
          -- the change filter drops (its lag is itself); grouping the 275 KB payloads to
          -- deduplicate would hold the whole range in memory.
          FROM price_data.raw_block_snapshots
          WHERE block_height BETWEEN {b0:UInt32} AND {b1:UInt32}
        )
        ARRAY JOIN arrayConcat(
          arrayMap(a -> ('o:' || toString(JSONExtractUInt(a, 'asset_id')),
                         concat(JSONExtractString(a, 'reserve'), ',', JSONExtractString(a, 'hub_reserve'), ',', toString(JSONExtractUInt(a, 'tradable')))),
                   JSONExtractArrayRaw(pools_json, 'omnipool', 'assets')),
          arrayMap(p -> ('s:' || toString(JSONExtractUInt(p, 'pool_id')), p),
                   JSONExtractArrayRaw(pools_json, 'stableswap', 'pools')),
          arrayMap(p -> ('x:' || JSONExtractString(p, 'pool_account'),
                         concat(toString(JSONExtractInt(p, 'asset_a')), ',', toString(JSONExtractInt(p, 'asset_b')), ',',
                                JSONExtractString(p, 'reserve_a'), ',', JSONExtractString(p, 'reserve_b'))),
                   arrayFilter(p -> has({ids:Array(Int64)}, JSONExtractInt(p, 'asset_a')) OR has({ids:Array(Int64)}, JSONExtractInt(p, 'asset_b')),
                               JSONExtractArrayRaw(pools_json, 'xyk', 'pools'))),
          [('a:', JSONExtractRaw(eq_json, 'atoken_equivalences')),
           ('l:', JSONExtractRaw(eq_json, 'lp_equivalences'))]
        ) AS kv
      )
    )
    WHERE v != pv
    ORDER BY b, k`
}

/** The hour's snapshot blocks and their timestamps. */
export function pairRouteBlocksSql(): string {
  return `-- pair-route:blocks
    SELECT block_height AS b, toUnixTimestamp(min(block_timestamp)) AS t
    FROM price_data.raw_block_snapshots
    WHERE block_height BETWEEN {b0:UInt32} AND {b1:UInt32}
    GROUP BY block_height
    ORDER BY block_height`
}

/**
 * Every Uniswap v3 pool's price-bearing and liquidity-bearing logs up to the
 * range's last block (Initialize, Swap, Mint, Burn), oldest first, one row per
 * log (replayed ingests collapsed), with the pool's tokens as registry assets, its
 * fee tier and tick spacing. Pools are whatever any factory announced
 * (uniswap_v3_pools, discovered by topic — no pool or factory is named anywhere
 * in this fold), each read from its own PoolCreated block on, so a new pool is a
 * route candidate from its creation, once initialised and holding liquidity.
 * v3RouteChanges turns them into state changes.
 */
export function pairRouteV3EventsSql(): string {
  return `-- pair-route:v3
    WITH ${V3_TOKEN_ASSETS_CTE},
    pools AS (
      SELECT lower(pool_address) AS pool, any(lower(token0)) AS token0, any(lower(token1)) AS token1, any(fee) AS fee,
             any(tick_spacing) AS spacing, min(block_height) AS created
      FROM price_data.uniswap_v3_pools GROUP BY pool
    )
    SELECT e.pool AS pool, e.b AS b, e.ei AS ei, e.name AS name, toString(e.sp) AS sp, e.tick AS tick,
           e.tl AS tl, e.tu AS tu, toString(e.liq) AS liq,
           ${v3TokenAssetSql('t0.asset_id', 'p.token0')} AS t0, ${v3TokenAssetSql('t1.asset_id', 'p.token1')} AS t1, p.fee AS fee,
           p.spacing AS spacing
    FROM (
      SELECT lower(contract_address) AS pool, block_height AS b, event_index AS ei,
             argMax(event_name, ingested_at) AS name, argMax(sqrt_price_x96, ingested_at) AS sp, argMax(tick, ingested_at) AS tick,
             argMax(tick_lower, ingested_at) AS tl, argMax(tick_upper, ingested_at) AS tu, argMax(liquidity, ingested_at) AS liq
      FROM price_data.uniswap_v3_events
      WHERE kind = 'pool' AND event_name IN ('Initialize', 'Swap', 'Mint', 'Burn') AND block_height <= {b1:UInt32}
        AND lower(contract_address) IN (SELECT pool FROM pools)
      GROUP BY pool, b, ei
    ) AS e
    INNER JOIN pools AS p ON p.pool = e.pool
    LEFT JOIN token_assets AS t0 ON t0.addr = p.token0
    LEFT JOIN token_assets AS t1 ON t1.addr = p.token1
    WHERE e.b >= p.created
    ORDER BY e.b, e.ei`
}

export interface V3EventRow {
  pool: string; b: number; ei: number; name: string; sp: string; tick: number
  tl: number; tu: number; liq: string; t0: number; t1: number; fee: number; spacing: number
}

/**
 * The v3 pools' state as change rows on `v:<pool>` keys (pairRoutes.formatV3Value:
 * slot0, active liquidity, fee, tick spacing and the initialised tick table): the
 * pool's range book replayed from its Mint/Burn logs (services/uniswapV3Ranges.ts),
 * slot0 from its latest Swap/Initialize, the active liquidity the book's at that
 * tick — never the Swap log's own liquidity field, which is wrong across range
 * exits. Replaying every indexed Swap from this state reproduces each logged
 * amount, price, tick and liquidity exactly. The state at the range's first block
 * is the baseline; every log inside the range is a change at its block.
 */
export function v3RouteChanges(rows: readonly V3EventRow[], b0: number): StateChange[] {
  const pools = new Map<string, { book: V3RangeBook; sp: bigint; tick: number | null; meta: V3EventRow }>()
  const out = new Map<string, StateChange>()
  const value = (p: { book: V3RangeBook; sp: bigint; tick: number | null; meta: V3EventRow }) => formatV3Value({
    t0: Number(p.meta.t0), t1: Number(p.meta.t1), sqrtP: p.sp, tick: p.tick ?? 0, liquidity: activeLiquidity(p.book, p.tick) ?? 0n,
    feePpm: Number(p.meta.fee), tickSpacing: Number(p.meta.spacing), ticks: tickTableFromRanges(p.book.values()),
  })
  // One change per pool per block: the state after the block's last log, rendered
  // once per (pool, block) — every log before the range collapses onto its first block.
  let block = -1
  const dirty = new Set<string>()
  const flush = () => {
    for (const pool of dirty) {
      const p = pools.get(pool)!
      if (p.sp > 0n) out.set(`${pool}@${block}`, { k: `v:${pool}`, b: block, v: value(p), lastb: 0 })
    }
    dirty.clear()
  }
  for (const r of rows) {
    const b = Math.max(Number(r.b), b0)
    if (b !== block) { flush(); block = b }
    let p = pools.get(r.pool)
    if (!p) { p = { book: new Map(), sp: 0n, tick: null, meta: r }; pools.set(r.pool, p) }
    if (r.name === 'Mint' || r.name === 'Burn') {
      const liq = big(r.liq)
      if (liq > 0n) applyRangeDeltas(p.book, [{ tickLower: Number(r.tl), tickUpper: Number(r.tu), delta: r.name === 'Mint' ? liq : -liq }])
    } else {
      p.sp = big(r.sp)
      p.tick = Number(r.tick)
    }
    dirty.add(r.pool)
  }
  flush()
  return [...out.values()].sort((x, y) => x.b - y.b)
}

/**
 * Every Omnipool.SlipFeeSet up to the range's last block (its maximum slip fee in
 * permill; an unset fee reads 0), oldest first — few rows, found through
 * raw_events' event_name set index.
 */
export function pairRouteSlipFeeSql(): string {
  return `-- pair-route:slip-fee
    SELECT block_height AS b, event_index AS ei, toUInt32(JSONExtractUInt(argMax(args_json, ingested_at), 'slipFee', 'maxSlipFee')) AS permill
    FROM price_data.raw_events
    WHERE event_name = 'Omnipool.SlipFeeSet' AND block_height <= {b1:UInt32}
    GROUP BY block_height, event_index
    ORDER BY block_height, event_index`
}

/** The slip fee as state changes: its value at the range's first block, then each change inside the range. */
export function slipFeeChanges(rows: ReadonlyArray<{ b: number; permill: number }>, b0: number): StateChange[] {
  const out = new Map<number, StateChange>()
  for (const r of rows) {
    const b = Math.max(Number(r.b), b0)
    out.set(b, { k: OMNI_SLIP_KEY, b, v: String(Number(r.permill) || 0), lastb: 0 })
  }
  return [...out.values()]
}

/**
 * Omnipool fee estimates per asset over a window: the median fee rate of the
 * asset's sell halves (A → H2O; the protocol fee, charged in H2O) and buy halves
 * (H2O → B; the asset fee, charged in B), from the pool's own fee legs.
 */
export function pairRouteFeesSql(): string {
  return `-- pair-route:fees
    SELECT if(aout = 1, 'sell', 'buy') AS side, toUInt32(if(aout = 1, ain, aout)) AS asset,
           quantileExact(0.5)(fee_amt / (out_amt + fee_amt)) AS rate, count() AS n
    FROM (
      SELECT pool_key, block_height, event_index,
             anyIf(asset_id, leg_kind = 'in') AS ain, anyIf(asset_id, leg_kind = 'out') AS aout,
             toFloat64(anyIf(toUInt256OrZero(amount), leg_kind = 'out')) AS out_amt,
             toFloat64(sumIf(toUInt256OrZero(amount), leg_kind = 'fee')) AS fee_amt
      FROM (
        -- One row per leg: a replayed raw range re-inserts its legs, and a fee leg
        -- summed twice would double the estimate.
        SELECT pool_key, block_height, event_index, leg_kind, leg_index,
               argMax(asset_id, ingested_at) AS asset_id, argMax(amount, ingested_at) AS amount
        FROM price_data.pool_swap_legs
        WHERE venue = 'omnipool' AND block_timestamp >= {from:DateTime} AND block_timestamp < {to:DateTime}
        GROUP BY pool_key, block_height, event_index, leg_kind, leg_index
      )
      GROUP BY pool_key, block_height, event_index
    )
    WHERE (aout = 1 OR ain = 1) AND out_amt + fee_amt > 0
    GROUP BY side, asset`
}

/**
 * The assets priced in each hour of a list (ohlc_1h) — the pair set's members — and
 * each one's USD open for the hour, the notional route selection sizes its
 * reference trade with (a float: it only sizes a trade, it prices nothing).
 */
export function pairRoutePricedSql(): string {
  return `-- pair-route:priced
    SELECT toString(interval_start) AS hour, groupArray(asset_id) AS ids, groupArray(toFloat64(open)) AS opens
    FROM (
      SELECT asset_id, interval_start, argMinMerge(open_state) AS open
      FROM price_data.ohlc_1h WHERE interval_start IN {hours:Array(DateTime)}
      GROUP BY asset_id, interval_start
    )
    GROUP BY hour`
}

/**
 * The money market's reserve pairs (underlying, aToken) from atoken_reserve_map:
 * which `lp_equivalences` entries of a snapshot are 1:1 wraps (an aToken over a
 * pool share, HUSDC over 2-Pool-HUSDC) rather than a price alias.
 */
export const PAIR_ROUTE_RESERVE_PAIRS_SQL = `-- pair-route:reserves
  WITH ${V3_TOKEN_ASSETS_CTE}
  SELECT toUInt32(reinterpretAsUInt32(reverse(unhex(substring(m.asset_address, 35, 8))))) AS u, toUInt32(t.asset_id) AS a
  FROM (SELECT DISTINCT lower(asset_address) AS asset_address, lower(atoken) AS atoken FROM price_data.atoken_reserve_map FINAL) AS m
  INNER JOIN token_assets AS t ON t.addr = m.atoken
  WHERE startsWith(m.asset_address, '0x00000000000000000000000000000001')`

export interface StateChange { k: string; b: number; v: string; lastb: number }
export interface FoldBlock { b: number; t: number }

/** One stored row, prices as decimal text at ROUTE_PRICE_SCALE digits. */
export interface PairRouteRow {
  iv: '5min' | '1h' | '1d'
  asset_lo: number
  asset_hi: number
  interval_start: string
  open: string
  high: string
  low: string
  close: string
  route: string
  routes: number
  fee_ppm: number
  buckets: number
  complete: number
  first_block: number
  last_block: number
  computed_at: string
}

/** A scaled integer at ROUTE_PRICE_SCALE digits as decimal text. */
export function scaledToText(v: bigint): string {
  const s = v.toString().padStart(ROUTE_PRICE_SCALE + 1, '0')
  return `${s.slice(0, -ROUTE_PRICE_SCALE)}.${s.slice(-ROUTE_PRICE_SCALE)}`
}

const chTime = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ')

/** A fee model from the estimate rows; floors where an asset has none. */
export function feeModelFrom(rows: ReadonlyArray<{ side: string; asset: number; rate: number }>): FeeModel {
  const sell = new Map<number, number>()
  const buy = new Map<number, number>()
  for (const r of rows) (r.side === 'sell' ? sell : buy).set(Number(r.asset), Number(r.rate))
  return {
    omniSell: a => Math.max(OMNI_SELL_FEE_FLOOR, sell.get(a) ?? FLOOR_FEES.omniSell(a)),
    omniBuy: a => Math.max(OMNI_BUY_FEE_FLOOR, buy.get(a) ?? FLOOR_FEES.omniBuy(a)),
  }
}

/** One candidate route of a pair within a bucket: its hops, their integer ids and its label. */
interface Cand { hops: Hop[]; ids: number[]; label: string }

interface Agg {
  lo: number; hi: number
  /** The pair's candidate routes this bucket, the route in force (`cur`), the notional they are rated at, and every route in force at some block. */
  cands: Cand[]; cur: number; ref: number; used: Set<string>
  /** A non-Omnipool route was in force at some evaluated block (else the bucket is the USD ratio). */
  routeUsed: boolean
  /** Some block had no candidate that could be stated: the bucket's close may be stale. */
  broken: boolean
  // The hop ratios at the bucket's first, highest and lowest evaluated block (the
  // close is read from the state at the bucket's last block when it is
  // finalised). The comparison runs in double precision; the stored values are the
  // exact products of the ratios kept here, rendered once at finalisation.
  openR: Ratio[] | null; highR: Ratio[]; lowR: Ratio[]; lastR: Ratio[]
  highF: number; lowF: number; first: number; last: number
}

export interface FoldHourInputs {
  /** The hour's start, unix seconds. */
  hour: number
  blocks: readonly FoldBlock[]
  /** State + v3 change rows, any order. */
  changes: readonly StateChange[]
  priced: readonly number[]
  /** USD per whole unit of the priced assets, for sizing the selection's reference trade. */
  usd: ReadonlyMap<number, number>
  fees: FeeModel
  decimals: Decimals
  /** `u:a` keys of the money market's reserve pairs (for the lp_equivalences filter). */
  reservePairs: ReadonlySet<string>
  computedAt: string
  /** Overrides ROUTE_SWITCH_MARGIN (a fraction of the round-trip factor). */
  switchMargin?: number
  /** Per `lo:hi`, the route in force at the previous hour's close (its stored 1h row's `route`), to start the hour on. */
  seed?: ReadonlyMap<string, string>
}

/**
 * How much better (as a fraction of the round-trip factor) a candidate route must
 * rate than the route in force before the price switches to it. Without a margin
 * two routes rated alike flip back and forth with every trade, and each flip is a
 * jump of the two routes' price difference.
 */
export const ROUTE_SWITCH_MARGIN = 0.0003

export interface FoldHourResult {
  rows: PairRouteRow[]
  /** 5-minute buckets of the hour that have blocks. */
  bucketsWithBlocks: number
  /** The newest block folded and its timestamp (0 when the range had none). */
  lastBlock: number
  lastTs: number
  /** Pairs routed per bucket, summed over the hour (diagnostic). */
  pairsSearched: number
}

const SCALE = 10n ** BigInt(ROUTE_PRICE_SCALE)

/** The exact product of hop ratios at ROUTE_PRICE_SCALE digits. */
export function ratioProduct(ratios: readonly Ratio[]): bigint {
  let num = 1n, den = 1n
  for (const r of ratios) { num *= r.num; den *= r.den }
  return den > 0n ? (num * SCALE) / den : 0n
}

const ratioFloat = (r: Ratio): number => Number(r.num) / Number(r.den)

/**
 * The hour's 5-minute and hourly rows. At each 5-minute bucket's first block every
 * pair gets its best few candidate routes (pairRoutes.routeCandidates); at every
 * block where one of their pools changed they are re-rated and the route in force
 * gives way only to a candidate better by the switch margin, and the route in
 * force's spot is re-evaluated. The route in force carries from bucket to bucket
 * within the hour.
 */
export function foldHour(inp: FoldHourInputs): FoldHourResult {
  const state: RouteState = emptyRouteState()
  let atokenEq: Array<[number, number]> = []
  let lpEq: Array<[number, number]> = []
  const refreshWraps = () => {
    const seen = new Set<string>()
    const out: Array<[number, number]> = []
    for (const [u, a] of [...atokenEq, ...lpEq.filter(([u, a]) => inp.reservePairs.has(`${u}:${a}`))]) {
      const key = `${u}:${a}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push([u, a])
    }
    state.atokens = out
  }
  const byBlock = new Map<number, StateChange[]>()
  const removals = new Map<number, string[]>()
  const lastBlock = inp.blocks.length ? inp.blocks[inp.blocks.length - 1]!.b : 0
  for (const c of inp.changes) {
    const list = byBlock.get(Number(c.b))
    if (list) list.push(c)
    else byBlock.set(Number(c.b), [c])
  }
  // A key absent after its last block in the range was removed (a delisted asset,
  // a destroyed pool). Its removal lands on the next snapshot block.
  const blockIndex = new Map(inp.blocks.map((b, i) => [b.b, i]))
  for (const c of inp.changes) {
    const lb = Number(c.lastb)
    if (!lb || lb >= lastBlock || c.k.startsWith('v:')) continue
    const next = inp.blocks[(blockIndex.get(lb) ?? -2) + 1]
    if (!next) continue
    const list = removals.get(next.b) ?? []
    if (!list.includes(c.k)) list.push(c.k)
    removals.set(next.b, list)
  }

  const rows: PairRouteRow[] = []
  let current: Agg[] = []
  let byKey = new Map<string, number[]>()
  let bucket = -1
  let bucketsWithBlocks = 0
  let pairsSearched = 0
  const hourRows = new Map<string, PairRouteRow[]>()

  // Hop ratios by integer hop id, cached until a state key the hop reads changes —
  // the inner loop below runs once per (changed block, affected pair), ~650k times
  // in a busy hour, so it touches arrays only.
  const hopIds = new Map<string, number>()
  const hops: Hop[] = []
  const hopR: Array<Ratio | null> = []
  const hopF: number[] = []
  const hopOk: boolean[] = []
  const hopsByState = new Map<string, number[]>()
  const hopId = (h: Hop): number => {
    const key = `${h.pool}|${h.from}|${h.to}`
    let id = hopIds.get(key)
    if (id === undefined) {
      id = hops.push(h) - 1
      hopIds.set(key, id)
      hopR.push(null); hopF.push(0); hopOk.push(false)
      for (const sk of hopStateKeys(h)) {
        const list = hopsByState.get(sk)
        if (list) list.push(id)
        else hopsByState.set(sk, [id])
      }
    }
    return id
  }
  const hopValue = (id: number): Ratio | null => {
    if (!hopOk[id]) {
      const r = hopSpot(state, hops[id]!, inp.decimals)
      hopR[id] = r
      hopF[id] = r ? ratioFloat(r) : 0
      hopOk[id] = true
    }
    return hopR[id]!
  }
  const invalidate = (stateKey: string) => {
    for (const id of hopsByState.get(stateKey) ?? []) { hopOk[id] = false; hopRT[id]?.clear() }
  }

  // Round-trip factor per hop and notional, cached like the ratios.
  const hopRT: Array<Map<number, number>> = []
  const roundTrip = (id: number, ref: number): number => {
    let m = hopRT[id]
    if (!m) hopRT[id] = m = new Map()
    let v = m.get(ref)
    if (v === undefined) {
      v = hopRoundTrip(state, hops[id]!, ref, rateUsd.get(hops[id]!.from), inp.decimals, inp.fees) ?? 0
      m.set(ref, v)
    }
    return v
  }
  const rate = (c: Cand, ref: number): number => {
    let r = 1
    for (const id of c.ids) { r *= roundTrip(id, ref); if (!(r > 0)) return 0 }
    return r
  }
  const margin = inp.switchMargin ?? ROUTE_SWITCH_MARGIN
  let rateUsd: ReadonlyMap<number, number> = inp.usd
  // The route in force per pair at the previous bucket's close, so the next bucket
  // starts on it (and the next candle opens at the previous close) unless a
  // candidate beats it by the margin.
  const inForce = new Map<string, Cand>()
  const hourUsed = new Map<string, Set<string>>()

  const pure = (c: Cand) => isPureOmnipool(c.hops)
  const finalize = () => {
    for (const a of current) {
      const route = a.cands[a.cur]!
      const key = `${a.lo}:${a.hi}`
      inForce.set(key, route)
      // A bucket the Omnipool crossing priced throughout is the USD ratio: no row.
      if (a.openR == null || !a.routeUsed) continue
      // The close is the last block the route in force could be stated at. A block
      // where no candidate could be (every route lost a hop) leaves the bucket
      // incomplete: its close would be a stale one, so readers fall back.
      const close = ratioProduct(a.lastR)
      const row: PairRouteRow = {
        iv: '5min', asset_lo: a.lo, asset_hi: a.hi, interval_start: chTime(bucket),
        open: scaledToText(ratioProduct(a.openR)), high: scaledToText(ratioProduct(a.highR)),
        low: scaledToText(ratioProduct(a.lowR)), close: scaledToText(close),
        route: route.label, routes: a.used.size, fee_ppm: routeFeePpm(state, route.hops, inp.fees), buckets: 1, complete: a.broken ? 0 : 1,
        first_block: a.first, last_block: a.last, computed_at: inp.computedAt,
      }
      rows.push(row)
      const list = hourRows.get(key)
      if (list) list.push(row)
      else hourRows.set(key, [row])
      let used = hourUsed.get(key)
      if (!used) hourUsed.set(key, used = new Set())
      for (const l of a.used) used.add(l)
    }
    current = []
    byKey = new Map()
  }

  /** States the route in force at `block` into the bucket's OHLC; false when one of its hops cannot be stated. */
  const evaluate = (agg: Agg, block: number): boolean => {
    const ids = agg.cands[agg.cur]!.ids
    const n = ids.length
    const r: Ratio[] = new Array(n)
    let f = 1
    for (let i = 0; i < n; i++) {
      const v = hopValue(ids[i]!)
      if (!v) return false
      r[i] = v
      f *= hopF[ids[i]!]!
    }
    if (!(f > 0)) return false
    if (agg.openR == null) {
      agg.openR = r; agg.highR = r; agg.lowR = r; agg.highF = f; agg.lowF = f; agg.first = block
    } else {
      if (f > agg.highF) { agg.highF = f; agg.highR = r }
      if (f < agg.lowF) { agg.lowF = f; agg.lowR = r }
    }
    agg.lastR = r
    agg.last = block
    if (!pure(agg.cands[agg.cur]!)) agg.routeUsed = true
    return true
  }

  const moveTo = (agg: Agg, i: number) => {
    agg.cur = i
    agg.used.add(agg.cands[i]!.label)
  }

  // Re-rates a pair's candidates at the current state and moves to the best one when
  // it beats the route in force by the margin. A switch is priced at its block on
  // both routes, so the candle carries the move and the next candle opens where this
  // one closed. A route in force that can no longer be stated (a hop lost its pool)
  // gives way to the best candidate that can; with none, the bucket is incomplete.
  // The Omnipool crossing competes like any candidate: while it is in force the
  // pair is priced by it — the very ratio the USD-ratio candle states.
  const reroute = (agg: Agg, block: number) => {
    const rates = agg.cands.map(c => rate(c, agg.ref))
    const cur = rates[agg.cur]!
    let best = agg.cur
    for (let i = 0; i < rates.length; i++) if (rates[i]! > rates[best]!) best = i
    if (best !== agg.cur && (!(cur > 0) || rates[best]! > cur * (1 + margin))) {
      evaluate(agg, block)
      moveTo(agg, best)
    }
    if (evaluate(agg, block)) return
    const order = rates.map((r, i) => [r, i] as const).filter(([r, i]) => r > 0 && i !== agg.cur).sort((x, y) => y[0] - x[0])
    for (const [, i] of order) {
      const was = agg.cur
      moveTo(agg, i)
      if (evaluate(agg, block)) return
      agg.cur = was
    }
    agg.broken = true
  }

  for (const blk of inp.blocks) {
    const changed = new Set<string>()
    const b5 = Math.floor(blk.t / BUCKET_SECONDS) * BUCKET_SECONDS
    // The bucket closes before the next one's first block is applied.
    if (b5 !== bucket && bucket >= 0) finalize()
    const set = (k: string, v: string) => {
      if (k === 'a:') { atokenEq = v ? parseAtokenValue(v) : []; changed.add('a:') }
      else if (k === 'l:') { lpEq = v ? parseAtokenValue(v) : []; changed.add('a:') }
      else { applyStateChange(state, k, v); changed.add(k); invalidate(k) }
    }
    for (const k of removals.get(blk.b) ?? []) set(k, '')
    for (const c of byBlock.get(blk.b) ?? []) set(c.k, c.v)
    if (changed.has('a:')) refreshWraps()
    if (b5 !== bucket) {
      bucket = b5
      bucketsWithBlocks++
      const graph = buildRouteGraph(state, inp.decimals, inp.fees, { refUsd: ROUTE_REFERENCE_USD, usd: inp.usd }, routeEraAt(blk.b))
      rateUsd = graph.usd
      for (const m of hopRT) m?.clear()
      const routes = routeCandidates(graph, inp.priced)
      pairsSearched += routes.size
      const seen = new Set<string>()
      for (const [key, list] of routes) {
        seen.add(key)
        const [lo, hi] = key.split(':').map(Number) as [number, number]
        const cands: Cand[] = list.map(c => ({ hops: c.hops, ids: c.hops.map(hopId), label: routeLabel(c.hops) }))
        const ref = graph.ladder[list[0]!.level]!
        // Start on the route in force at the previous close — the previous bucket's,
        // or for the hour's first bucket the previous hour's stored closing route —
        // and let the candidates challenge it as on any block.
        let prev = inForce.get(key)
        if (!prev && bucketsWithBlocks === 1) {
          const label = inp.seed?.get(key)
          const hopsOf = label ? parseRouteLabel(label) : null
          if (hopsOf) prev = { hops: hopsOf, ids: hopsOf.map(hopId), label: label! }
        }
        let cur = 0
        if (prev) {
          let i = cands.findIndex(c => c.label === prev!.label)
          if (i < 0) i = cands.push(prev) - 1
          if (rate(cands[i]!, ref) > 0) cur = i
        }
        const agg: Agg = {
          lo, hi, cands, cur, ref, used: new Set([cands[cur]!.label]), routeUsed: false, broken: false,
          openR: null, highR: [], lowR: [], lastR: [], highF: 0, lowF: 0, first: 0, last: 0,
        }
        // A pair whose candidates are all the Omnipool crossing has nothing to switch to.
        if (cands.every(pure)) { inForce.set(key, cands[0]!); continue }
        const idx = current.push(agg) - 1
        for (const c of cands) for (const h of c.hops) for (const sk of hopStateKeys(h)) {
          const keys = byKey.get(sk)
          if (keys) { if (keys[keys.length - 1] !== idx) keys.push(idx) }
          else byKey.set(sk, [idx])
        }
        reroute(agg, blk.b)
      }
      for (const key of [...inForce.keys()]) if (!seen.has(key)) inForce.delete(key)
      continue
    }
    if (!changed.size) continue
    const touched = new Set<number>()
    for (const k of changed) for (const i of byKey.get(k) ?? []) touched.add(i)
    for (const i of touched) reroute(current[i]!, blk.b)
    // A pool appearing or vanishing mid-bucket adds no candidate; the next bucket does.
  }
  if (bucket >= 0) finalize()

  for (const [key, list] of hourRows) {
    const [lo, hi] = key.split(':').map(Number) as [number, number]
    const first = list[0]!, last = list[list.length - 1]!
    let high = first.high, low = first.low
    let hiV = BigInt(first.high.replace('.', '')), loV = BigInt(first.low.replace('.', ''))
    for (const r of list) {
      const h = BigInt(r.high.replace('.', '')), l = BigInt(r.low.replace('.', ''))
      if (h > hiV) { hiV = h; high = r.high }
      if (l < loV) { loV = l; low = r.low }
    }
    rows.push({
      iv: '1h', asset_lo: lo, asset_hi: hi, interval_start: chTime(inp.hour),
      open: first.open, high, low, close: last.close,
      // The route in force at the hour's close (the next hour's seed), which may be
      // the Omnipool crossing when the last bucket was the USD ratio.
      route: inForce.get(key)?.label ?? last.route, routes: hourUsed.get(key)?.size ?? 1, fee_ppm: last.fee_ppm,
      buckets: list.length, complete: list.length === bucketsWithBlocks && list.every(r => r.complete === 1) ? 1 : 0,
      first_block: first.first_block, last_block: last.last_block, computed_at: inp.computedAt,
    })
  }
  const last = inp.blocks[inp.blocks.length - 1]
  return { rows, bucketsWithBlocks, pairsSearched, lastBlock: last?.b ?? 0, lastTs: last?.t ?? 0 }
}

/** Everything one hour's fold reads, from ClickHouse. */
export async function loadFoldHourInputs(
  client: ClickHouseClient,
  hour: { hour: number; minb: number; maxb: number },
  shared: { priced: readonly number[]; usd: ReadonlyMap<number, number>; decimals: Decimals; reservePairs: ReadonlySet<string>; computedAt: string; v3: boolean },
): Promise<FoldHourInputs> {
  const ids = shared.priced.map(Number)
  const params = { b0: hour.minb, b1: hour.maxb, ids }
  const [blocksRes, stateRes, v3Res, feeRes, slipRes] = await Promise.all([
    client.query({ query: pairRouteBlocksSql(), query_params: params, format: 'JSONEachRow' }),
    client.query({ query: pairRouteStateChangesSql(), query_params: params, format: 'JSONEachRow' }),
    shared.v3 ? client.query({ query: pairRouteV3EventsSql(), query_params: { b1: hour.maxb }, format: 'JSONEachRow' }) : null,
    client.query({
      query: pairRouteFeesSql(),
      query_params: { from: chTime(hour.hour - 24 * 3600), to: chTime(hour.hour) },
      format: 'JSONEachRow',
    }),
    client.query({ query: pairRouteSlipFeeSql(), query_params: { b1: hour.maxb }, format: 'JSONEachRow' }),
  ])
  const blocks = (await blocksRes.json<{ b: number; t: number }>()).map(r => ({ b: Number(r.b), t: Number(r.t) }))
  const changes = await stateRes.json<StateChange>()
  if (v3Res) changes.push(...v3RouteChanges(await v3Res.json<V3EventRow>(), hour.minb))
  changes.push(...slipFeeChanges(await slipRes.json<{ b: number; permill: number }>(), hour.minb))
  const fees = feeModelFrom(await feeRes.json<{ side: string; asset: number; rate: number }>())
  return { hour: hour.hour, blocks, changes, priced: ids, usd: shared.usd, fees, decimals: shared.decimals, reservePairs: shared.reservePairs, computedAt: shared.computedAt }
}

/**
 * The newest version of each key a stored table holds in [from, to): the
 * replacement resolved by argMax over computed_at, deletions dropped — FINAL's
 * answer, but readable through the table's time-first projection (`p_time`,
 * 014_pair_routes.sql). FINAL over a time-only predicate cannot use the
 * pair-first sort key and read the whole partition per hour published (8 M rows,
 * 127 MiB per call, measured). `columns` are extra argMax-resolved columns.
 */
export function pairRouteLatestSql(table: string, columns: readonly string[] = []): string {
  const extra = columns.map(c => `, argMax(${c}, computed_at) AS v_${c}`).join('')
  return `SELECT asset_lo, asset_hi, interval_start AS t_start${extra}
    FROM ${table}
    WHERE interval_start >= {from:DateTime} AND interval_start < {to:DateTime}
    GROUP BY asset_lo, asset_hi, interval_start
    HAVING argMax(is_deleted, computed_at) = 0`
}

/**
 * A day's 1d rows from its hourly rows (the newest version of each, the hours just
 * published included). A day is complete for a pair when it has a complete hourly
 * row for each of the day's `dayHours` source hours. Aliases are prefixed: an
 * alias naming a column the statement reads again would resolve that later
 * reference to the aggregate.
 */
export function pairRouteDailyRowsSql(): string {
  const cols = ['open', 'high', 'low', 'close', 'route', 'fee_ppm', 'buckets', 'complete', 'first_block', 'last_block']
  return `-- pair-route:daily
    SELECT asset_lo, asset_hi, toString(toStartOfDay(min(t_start))) AS d_start,
           toString(argMin(v_open, t_start)) AS d_open, toString(max(v_high)) AS d_high, toString(min(v_low)) AS d_low,
           toString(argMax(v_close, t_start)) AS d_close,
           argMax(v_route, t_start) AS d_route, toUInt16(uniqExact(v_route)) AS d_routes, argMax(v_fee_ppm, t_start) AS d_fee,
           toUInt16(sum(v_buckets)) AS d_buckets, toUInt8(countIf(v_complete = 1) = {hours:UInt32}) AS d_complete,
           min(v_first_block) AS d_first, max(v_last_block) AS d_last
    FROM (${pairRouteLatestSql(PAIR_ROUTE_TABLES['1h'], cols)})
    GROUP BY asset_lo, asset_hi`
}
