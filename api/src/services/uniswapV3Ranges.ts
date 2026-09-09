// The range book of a concentrated-liquidity (Uniswap v3) pool: where its liquidity
// sits, from the pool's own Mint and Burn logs.
//
// A v3 pool has no single reserve. Liquidity is minted over tick ranges, and the
// number the pool's `liquidity()` returns — what a swap actually trades against — is
// the sum of the open ranges straddling the current tick. This module replays those
// logs: every Mint adds its liquidity over [tickLower, tickUpper), every Burn removes
// it, and the book is then read at a tick (`activeLiquidity`), as the initialised-tick
// table a v3 chart draws (`rangesToTicks`), or as the liquidity standing between
// consecutive ticks (`liquiditySegments`).
//
// Reading `liquidity` off the Swap logs instead is wrong between swaps: it is only
// right at the instant of that swap, so a vault that mints into range afterwards
// reads as an empty pool until the next trade — and, on the live aDOT/HOLLAR pool,
// a swap that crossed out of the only range reported 0 while the range still stood.
//
// This is an import LEAF (the client type and nothing else), so the explorer, the
// public API and the Data API all state active liquidity the same way.

import type { ClickHouseClient } from '../db/client.ts'

const Q96 = 2 ** 96

/** Rows that changed something: a burn(0) poke and a collect that paid nothing are skipped. */
export const V3_MEANINGFUL_SQL = `NOT (event_name IN ('Burn', 'Collect') AND amount0 = 0 AND amount1 = 0 AND liquidity = 0)`

export const big = (s: string | number | null | undefined): bigint => { try { return BigInt(String(s ?? '0') || '0') } catch { return 0n } }

/** token1 per token0 in whole tokens from the pool's sqrt price. */
export function v3Price(sqrtPriceX96: bigint | string, decimals0: number, decimals1: number): number {
  const r = Number(BigInt(sqrtPriceX96)) / Q96
  return r * r * 10 ** (decimals0 - decimals1)
}

/** One Mint (+) or Burn (−) of liquidity over a tick range. */
export interface V3RangeDelta { tickLower: number; tickUpper: number; delta: bigint }
/** The pool's open ranges: key `lower:upper` → net liquidity standing in it. */
export type V3RangeBook = Map<string, { tickLower: number; tickUpper: number; net: bigint }>

/** Apply mints and burns to the range book (a range burnt to nothing is dropped). */
export function applyRangeDeltas(book: V3RangeBook, deltas: V3RangeDelta[]): V3RangeBook {
  for (const d of deltas) {
    const key = `${d.tickLower}:${d.tickUpper}`
    const cur = book.get(key)
    const net = (cur?.net ?? 0n) + d.delta
    if (net > 0n) book.set(key, { tickLower: d.tickLower, tickUpper: d.tickUpper, net })
    else book.delete(key)
  }
  return book
}

/** Liquidity a swap trades against at `tick`: the open ranges with lower ≤ tick < upper. Null before the pool has a tick. */
export function activeLiquidity(book: V3RangeBook, tick: number | null): bigint | null {
  if (tick == null) return null
  let sum = 0n
  for (const r of book.values()) if (r.tickLower <= tick && tick < r.tickUpper) sum += r.net
  return sum
}

export interface V3Tick { tick: number; liquidityNet: bigint; liquidityGross: bigint }

/** The initialised ticks the open ranges imply, ascending — the shape a Uniswap v3 tick table (and the UI's distribution chart) reads. */
export function rangesToTicks(book: V3RangeBook): V3Tick[] {
  const ticks = new Map<number, V3Tick>()
  const at = (tick: number) => { let t = ticks.get(tick); if (!t) { t = { tick, liquidityNet: 0n, liquidityGross: 0n }; ticks.set(tick, t) } return t }
  for (const r of book.values()) {
    const lo = at(r.tickLower), hi = at(r.tickUpper)
    lo.liquidityNet += r.net; lo.liquidityGross += r.net
    hi.liquidityNet -= r.net; hi.liquidityGross += r.net
  }
  return [...ticks.values()].filter(t => t.liquidityGross > 0n).sort((a, b) => a.tick - b.tick)
}

/** Liquidity standing between each pair of consecutive initialised ticks (empty stretches skipped). */
export function liquiditySegments(ticks: V3Tick[]): { tickLower: number; tickUpper: number; liquidity: bigint }[] {
  const out: { tickLower: number; tickUpper: number; liquidity: bigint }[] = []
  let running = 0n
  for (let i = 0; i < ticks.length - 1; i++) {
    running += ticks[i].liquidityNet
    if (running > 0n) out.push({ tickLower: ticks[i].tick, tickUpper: ticks[i + 1].tick, liquidity: running })
  }
  return out
}

/** token1 per token0 in whole tokens at a tick. */
export function priceAtTick(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1)
}

/**
 * The tokens `liquidity` over [tickLower, tickUpper) holds when the pool is at `tick`
 * (its sqrt price when known): all token0 above the price, all token1 below, both in
 * the straddling range. Raw units, floored — Float64 arithmetic, so exact to ~16 digits.
 */
export function amountsInRange(liquidity: bigint, tickLower: number, tickUpper: number, tick: number, sqrtPriceX96?: bigint | string | null): { amount0: bigint; amount1: bigint } {
  const L = Number(liquidity)
  const sa = 1.0001 ** (tickLower / 2), sb = 1.0001 ** (tickUpper / 2)
  const sp = sqrtPriceX96 != null ? Number(BigInt(sqrtPriceX96)) / Q96 : 1.0001 ** (tick / 2)
  const floor = (x: number) => (x > 0 ? BigInt(Math.floor(x)) : 0n)
  if (tick < tickLower) return { amount0: floor(L * (1 / sa - 1 / sb)), amount1: 0n }
  if (tick >= tickUpper) return { amount0: 0n, amount1: floor(L * (sb - sa)) }
  return { amount0: floor(L * (1 / sp - 1 / sb)), amount1: floor(L * (sp - sa)) }
}

/** What one pool's ranges need to be read and priced. */
export interface V3RangePool { address: string; decimals0: number; decimals1: number }

export interface V3PoolLiquidity {
  pool: string
  /** The pool's last meaningful event. */
  blockHeight: number | null
  /** The tick and sqrt price after the last Swap/Initialize; null before the pool is initialised. */
  tick: number | null
  sqrtPriceX96: string | null
  price: number | null
  /** Active liquidity at `tick`. */
  liquidity: string | null
  ticks: { tick: number; price: number; liquidityNet: string; liquidityGross: string }[]
  /** Liquidity standing between consecutive initialised ticks, with the tokens it holds at the current price. */
  segments: { tickLower: number; tickUpper: number; priceLower: number; priceUpper: number; liquidity: string; amount0: string; amount1: string }[]
  /** The open positions grouped by owner and range, deepest first. */
  ranges: { owner: string; tickLower: number; tickUpper: number; priceLower: number; priceUpper: number; liquidity: string; amount0: string; amount1: string; positions: number; inRange: boolean }[]
}

/**
 * The pool's liquidity distribution now: its open ranges (mints net of burns, per
 * owner) as a tick table and as segments, valued at the current tick. One bounded
 * read over the pool's Mint/Burn rows plus the last price-bearing event.
 */
export async function v3PoolLiquidity(client: ClickHouseClient, pool: V3RangePool): Promise<V3PoolLiquidity> {
  // `await client.query()` then `.json()` — the client's result is not a promise chain.
  const readRanges = async () => {
    const res = await client.query({
      query: `-- v3:liquidity:ranges
              SELECT owner, tick_lower, tick_upper,
                     -- net_raw stays Int256 for the HAVING: comparing the stringified
                     -- sum against 0 is a type error, not a filter.
                     sumIf(toInt256(liquidity), event_name = 'Mint') - sumIf(toInt256(liquidity), event_name = 'Burn') AS net_raw,
                     toString(net_raw) AS net,
                     countIf(event_name = 'Mint') AS mints
              FROM price_data.uniswap_v3_events FINAL
              PREWHERE contract_address = {pool:String} AND kind = 'pool'
              WHERE event_name IN ('Mint', 'Burn') AND liquidity > 0
              GROUP BY owner, tick_lower, tick_upper
              HAVING net_raw > 0
              SETTINGS max_memory_usage = 1000000000, max_threads = 2`,
      query_params: { pool: pool.address.toLowerCase() }, format: 'JSONEachRow',
    })
    return res.json<{ owner: string; tick_lower: number | string; tick_upper: number | string; net: string; mints: number | string }>()
  }
  const readState = async () => {
    const res = await client.query({
      query: `-- v3:liquidity:state
              SELECT argMaxIf(tick, (block_height, event_index), event_name IN ('Swap', 'Initialize')) AS tick,
                     toString(argMaxIf(sqrt_price_x96, (block_height, event_index), event_name IN ('Swap', 'Initialize'))) AS sqrt,
                     countIf(event_name IN ('Swap', 'Initialize')) AS priced, maxIf(block_height, ${V3_MEANINGFUL_SQL}) AS last_block, count() AS n
              FROM price_data.uniswap_v3_events FINAL
              PREWHERE contract_address = {pool:String} AND kind = 'pool'
              SETTINGS max_memory_usage = 1000000000, max_threads = 2`,
      query_params: { pool: pool.address.toLowerCase() }, format: 'JSONEachRow',
    })
    return (await res.json<{ tick: number | string; sqrt: string; priced: number | string; last_block: number | string; n: number | string }>())[0]
  }
  const [rangeRows, state] = await Promise.all([readRanges(), readState()])
  const priced = !!state && Number(state.priced) > 0
  const tick = priced ? Number(state.tick) : null
  const sqrt = priced ? String(state.sqrt) : null
  const d0 = pool.decimals0, d1 = pool.decimals1
  const price = (t: number) => priceAtTick(t, d0, d1)
  const book: V3RangeBook = new Map()
  const ranges = rangeRows.map(r => {
    const tickLower = Number(r.tick_lower), tickUpper = Number(r.tick_upper), net = big(r.net)
    applyRangeDeltas(book, [{ tickLower, tickUpper, delta: net }])
    const amounts = tick != null ? amountsInRange(net, tickLower, tickUpper, tick, sqrt) : { amount0: 0n, amount1: 0n }
    return {
      owner: r.owner, tickLower, tickUpper, priceLower: price(tickLower), priceUpper: price(tickUpper), liquidity: net.toString(),
      amount0: amounts.amount0.toString(), amount1: amounts.amount1.toString(), positions: Number(r.mints),
      inRange: tick != null && tickLower <= tick && tick < tickUpper,
    }
  }).sort((a, b) => (BigInt(b.liquidity) > BigInt(a.liquidity) ? 1 : BigInt(b.liquidity) < BigInt(a.liquidity) ? -1 : a.tickLower - b.tickLower))
  const ticks = rangesToTicks(book)
  const segments = liquiditySegments(ticks).map(s => {
    const amounts = tick != null ? amountsInRange(s.liquidity, s.tickLower, s.tickUpper, tick, sqrt) : { amount0: 0n, amount1: 0n }
    return { tickLower: s.tickLower, tickUpper: s.tickUpper, priceLower: price(s.tickLower), priceUpper: price(s.tickUpper), liquidity: s.liquidity.toString(), amount0: amounts.amount0.toString(), amount1: amounts.amount1.toString() }
  })
  return {
    pool: pool.address,
    blockHeight: state && Number(state.n) > 0 ? Number(state.last_block) : null,
    tick, sqrtPriceX96: sqrt, price: sqrt != null ? v3Price(sqrt, d0, d1) : null,
    liquidity: activeLiquidity(book, tick)?.toString() ?? null,
    ticks: ticks.map(t => ({ tick: t.tick, price: price(t.tick), liquidityNet: t.liquidityNet.toString(), liquidityGross: t.liquidityGross.toString() })),
    segments, ranges,
  }
}

/** Active liquidity at a known tick: the open ranges straddling it. */
export async function v3ActiveLiquidityAtTick(client: ClickHouseClient, pool: string, tick: number): Promise<string> {
  const res = await client.query({
    query: `-- v3:liquidity:at-tick
            SELECT toString(greatest(sumIf(toInt256(liquidity), event_name = 'Mint') - sumIf(toInt256(liquidity), event_name = 'Burn'), toInt256(0))) AS l
            FROM price_data.uniswap_v3_events FINAL
            WHERE kind = 'pool' AND contract_address = {pool:String} AND event_name IN ('Mint', 'Burn')
              AND tick_lower <= {tick:Int32} AND tick_upper > {tick:Int32}`,
    query_params: { pool: pool.toLowerCase(), tick: Math.trunc(tick) },
    format: 'JSONEachRow',
  })
  return (await res.json<{ l: string }>())[0]?.l ?? '0'
}

/**
 * Active liquidity for every pool at once, keyed by pool address: the open ranges
 * straddling each pool's current tick. One read for the whole registry — the Data
 * API's snapshot answers every pool in one request.
 */
export async function v3ActiveLiquidityByPool(client: ClickHouseClient): Promise<Map<string, string>> {
  const res = await client.query({
    query: `-- data:pools:uniswapv3-active-liquidity
            WITH last_state AS (
              SELECT contract_address,
                     argMaxIf(tick, (block_height, event_index), event_name IN ('Swap', 'Initialize')) AS tick,
                     countIf(event_name IN ('Swap', 'Initialize')) AS priced
              FROM price_data.uniswap_v3_events FINAL
              WHERE kind = 'pool'
              GROUP BY contract_address
            )
            SELECT e.contract_address AS pool,
                   toString(greatest(sumIf(toInt256(e.liquidity), e.event_name = 'Mint') - sumIf(toInt256(e.liquidity), e.event_name = 'Burn'), toInt256(0))) AS liquidity
            FROM price_data.uniswap_v3_events AS e FINAL
            INNER JOIN last_state AS s ON s.contract_address = e.contract_address
            WHERE e.kind = 'pool' AND e.event_name IN ('Mint', 'Burn') AND e.liquidity > 0
              AND s.priced > 0 AND e.tick_lower <= s.tick AND e.tick_upper > s.tick
            GROUP BY pool
            SETTINGS max_memory_usage = 2000000000, max_threads = 4`,
    format: 'JSONEachRow',
  })
  const out = new Map<string, string>()
  for (const row of await res.json<{ pool: string; liquidity: string }>()) out.set(String(row.pool).toLowerCase(), String(row.liquidity))
  return out
}
