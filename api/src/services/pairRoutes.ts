// Route-priced pair spot: the best on-chain trade route between two assets at one
// block, and the marginal price along it, computed from indexed pool state.
//
// A pure leaf (no client, no cache): the pair_route_ohlc fold (pairRouteFold.ts)
// and its tests drive it, and it reproduces — within the documented limits below —
// what the Hydration SDK's router (`@galacticcouncil/sdk-next`, `TradeRouter`)
// would pick and quote for a small trade.
//
// WHAT THE SDK DOES, and what this replicates:
//  * The routable graph is every pool's token set: the Omnipool (one pool over all
//    its assets plus the hub, H2O, which may be SOLD but never BOUGHT —
//    `validatePair` refuses the hub as assetOut), each stableswap pool (its assets
//    AND its own share token, the add/remove-liquidity hop), each money-market
//    aToken/underlying pair (1:1, no fee), each XYK pair and each Uniswap v3 pool.
//  * Paths are simple: no asset twice and no POOL twice (the SDK's `isNotVisited`
//    compares both), so the Omnipool is crossed at most once per route.
//  * XYK pools are "isolated": when both endpoints sit in a trusted (non-XYK) pool
//    the search uses trusted pools only; with one untrusted endpoint, the trusted
//    pools plus the XYK pools holding that endpoint; with neither, only the XYK
//    pools holding either endpoint (RouteSuggester.getProposals).
//  * The route is the path with the best OUTPUT for the trade's amount. Here every
//    hop is rated at a reference trade of ROUTE_REFERENCE_USD (fees and price
//    impact included) and the route maximises the product (RouteSelection): a dust
//    pool whose spot is off-market cannot win the way it would on spot alone.
//
// DOCUMENTED DEVIATIONS (each quantified in the measurement report):
//  * HSM (HOLLAR's stability module) and LBP pools are not in the graph: neither is
//    in the per-block pool snapshot this reads.
//  * Omnipool fees are dynamic and not in the snapshot; selection uses an estimate
//    per asset (FeeModel, from the pool's own recent fee legs), never the price,
//    plus the pool's slip fee on both sides (from the indexed SlipFeeSet), as the
//    SDK and the runtime charge it.
//  * Stableswap pegs are the pool's STORED multipliers at the block; the SDK
//    recomputes them from the oracle (`recalculate_peg`) at quote time.
//  * Uniswap v3 pools are every pool any factory announced (uniswap_v3_pools),
//    from its creation on and while it holds liquidity in any range; the SDK
//    routes a curated list (`V3_POOLS`, one pool today). A hop is rated by the
//    pool's exact swap (uniswapV3Math.ts: the tick walk over the Mint/Burn-
//    replayed tick table, fee taken per step), as the SDK's UniswapV3Math does.
//
// PRICE. A hop's spot is the marginal price BEFORE fees, per whole unit, as an
// exact rational (stableswap: the runtime-compatible curve from
// @galacticcouncil/math-stableswap, 18 digits); a route's spot is the product of
// its hops' rationals, rendered once at ROUTE_PRICE_SCALE digits. The fee only
// picks the route. Before fees, a route's spot read backwards is the reciprocal of
// its spot read forwards, which is why a pair is stored once.

import { calculate_liquidity_out_one_asset, calculate_out_given_in, calculate_shares, calculate_spot_price_with_fee } from '@galacticcouncil/math-stableswap'
import { parseStableswapPools, type StableswapPoolSnapshot } from './stableswapSnapshot.ts'
import { v3QuoteExactIn, type V3SwapPool, type V3TickNet } from './uniswapV3Math.ts'

/** Digits a stored route price carries (Decimal(76, 30)). */
export const ROUTE_PRICE_SCALE = 30
const SCALE = 10n ** BigInt(ROUTE_PRICE_SCALE)
/**
 * The most pool crossings a route may make: the SDK's own bound (`findPaths`
 * drops a path longer than 10 nodes, i.e. 9 crossings, money-market wraps
 * included). Executed routes do use them — 5.2 % of routed trades over 30 days
 * crossed 5 to 9 pools — and the search stays ~10 ms per bucket at this depth.
 */
export const MAX_ROUTE_HOPS = 9
/** H2O, the Omnipool's hub asset: it can be sold into the pool but never bought from it. */
export const HUB_ASSET_ID = 1
/** Omnipool tradability bits (pallet Tradability): SELL = 1, BUY = 2. */
const TRADABLE_SELL = 1
const TRADABLE_BUY = 2
/** An XYK pool's fixed exchange fee (the runtime's 3/1000, the SDK's exchangeFee). */
export const XYK_FEE = 0.003
const SS_SPOT_SCALE = 10n ** 18n

export type HopKind = 'omni' | 'ss' | 'xyk' | 'aave' | 'v3'

export interface OmniAssetState { reserve: bigint; hub: bigint; tradable: number }
export interface XykPoolState { a: number; b: number; ra: bigint; rb: bigint }
/**
 * A v3 pool at one block, as its swap reads it: slot0 (price and tick), the
 * liquidity active at the tick, the fee tier (ppm), the tick spacing and the
 * initialised tick table (liquidityNet per tick, ascending) — enough for the
 * pool's exact swap across every range it holds.
 */
export interface V3PoolState { t0: number; t1: number; sqrtP: bigint; tick: number; liquidity: bigint; feePpm: number; tickSpacing: number; ticks: readonly V3TickNet[] }

/**
 * The route rule's fingerprints, one per part of the rule. Each derived hour
 * stores the fingerprint it was folded under, and an hour whose stored value
 * differs from the rule now in force is stale (pairRouteStaleHoursSql), so
 * changing the rule re-marks exactly the hours the change can touch: bump
 * ROUTE_RULE_BASE for a change to the search, the selection or any venue every
 * hour reads, ROUTE_RULE_V3 for a change to the Uniswap v3 hop (only hours at or
 * after the first v3 pool carry it), ROUTE_RULE_OMNI_SLIP for the Omnipool's slip
 * fee (only hours at or after the first Omnipool.SlipFeeSet). 0 is the rule every
 * hour was first folded under. The stored value is compared for equality, so a
 * rollback re-marks too.
 *   base 1 — round-trip, depth-adaptive route choice (RouteSelection); the route
 *          in force re-rated per block with a switch margin (pairRouteFold).
 *   base 2 — the Omnipool crossing kept as a candidate, a route that cannot be
 *          stated gives way (or leaves its bucket incomplete), each hour seeded
 *          with the previous hour's closing route, the fee estimate deduplicated.
 *   v3 1 — the exact v3 swap (tick crossing) rates v3 hops; before it a hop was
 *          rated within the active range only.
 *   omni-slip 1 — the Omnipool's slip fee rates Omnipool hops.
 */
export const ROUTE_RULE_BASE = 2
export const ROUTE_RULE_V3 = 1
export const ROUTE_RULE_OMNI_SLIP = 1

/** Every pool the route graph is built from, at one block. */
export interface RouteState {
  omni: Map<number, OmniAssetState>
  stable: Map<number, StableswapPoolSnapshot>
  xyk: Map<string, XykPoolState>
  v3: Map<string, V3PoolState>
  /** Money-market [underlying, aToken] pairs (the snapshot's atoken_equivalences). */
  atokens: Array<[number, number]>
  /**
   * The Omnipool's maximum slip fee (Omnipool.SlipFee, a fraction; 0 while unset),
   * from the newest `Omnipool.SlipFeeSet` at or below the block.
   */
  omniMaxSlipFee: number
}

export const emptyRouteState = (): RouteState => ({ omni: new Map(), stable: new Map(), xyk: new Map(), v3: new Map(), atokens: [], omniMaxSlipFee: 0 })

/**
 * The Omnipool's slip fee on one side of a trade moving `delta` of the hub asset
 * through a pool side holding `hubReserve` at the block's start (the runtime's
 * calculate_slip_fee_amount for the first trade in a block: rate |Δ| / (Q₀ ± Δ),
 * capped at the maximum), as an amount of the hub asset. `signedDelta` < 0 for the
 * sold side (hub leaves its pool), > 0 for the bought side.
 */
export function omniSlipFee(hubReserve: number, signedDelta: number, maxSlipFee: number): number {
  if (!(maxSlipFee > 0) || !(hubReserve > 0) || signedDelta === 0) return 0
  const denom = hubReserve + signedDelta
  if (!(denom > 0)) return Math.abs(signedDelta) * maxSlipFee
  return Math.min(Math.abs(signedDelta) / denom, maxSlipFee) * Math.abs(signedDelta)
}

/** One pool crossing. `pool` is the identity the no-pool-twice rule compares. */
export interface Hop { kind: HopKind; pool: string; from: number; to: number }

/** Dynamic Omnipool fee estimates (fractions): the hub-side fee charged selling `asset`, the asset fee charged buying it. */
export interface FeeModel {
  omniSell(asset: number): number
  omniBuy(asset: number): number
}

/** The Omnipool's fee floors — the protocol fee on the sold side, the asset fee on the bought side. */
export const OMNI_SELL_FEE_FLOOR = 0.0005
export const OMNI_BUY_FEE_FLOOR = 0.0025
export const FLOOR_FEES: FeeModel = { omniSell: () => OMNI_SELL_FEE_FLOOR, omniBuy: () => OMNI_BUY_FEE_FLOOR }

export type Decimals = (assetId: number) => number

/** An exact non-negative rational. */
export interface Ratio { num: bigint; den: bigint }

const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** The pool keys whose state a hop reads — the change set that re-prices it. */
export function hopStateKeys(hop: Hop): string[] {
  switch (hop.kind) {
    case 'omni': return hop.from === HUB_ASSET_ID ? [`o:${hop.to}`] : [`o:${hop.from}`, `o:${hop.to}`]
    case 'ss': return [hop.pool]
    case 'xyk': return [hop.pool]
    case 'v3': return [hop.pool]
    case 'aave': return []
  }
}

// A pool's spot per (from, to), cached on its state object: the fold replaces the
// object exactly when the pool's snapshot value changes.
const stableSpotCache = new WeakMap<object, Map<string, Ratio | null>>()

/** Stableswap spot through the runtime-compatible package, as a ratio per whole unit. */
function stableSpot(pool: StableswapPoolSnapshot, from: number, to: number, decimals: Decimals): Ratio | null {
  let cache = stableSpotCache.get(pool)
  if (!cache) { cache = new Map(); stableSpotCache.set(pool, cache) }
  const key = `${from}>${to}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const r = computeStableSpot(pool, from, to, decimals)
  cache.set(key, r)
  return r
}

function computeStableSpot(pool: StableswapPoolSnapshot, from: number, to: number, decimals: Decimals): Ratio | null {
  const reserves = JSON.stringify(pool.assetIds.map((id, i) => ({ asset_id: id, amount: pool.reserves[i]!.toString(), decimals: decimals(id) })))
  const pegs = JSON.stringify((pool.pegs ?? pool.assetIds.map(() => ({ num: 1n, den: 1n }))).map(p => [p.num.toString(), p.den.toString()]))
  let raw: bigint
  try {
    raw = BigInt(calculate_spot_price_with_fee(String(pool.poolId), reserves, String(pool.amplification), String(from), String(to),
      pool.totalIssuance.toString(), '0', pegs))
  } catch {
    return null
  }
  if (raw <= 0n) return null
  // Between two pool assets the package answers per whole unit (decimals applied).
  // A hop into or out of the pool's own share token answers per RAW unit instead —
  // measured: share→USDT on 4-Pool returned 1.926597 at 10^6, 1.926597 USDT/share
  // at 10^18 — so the share leg's decimal difference is applied here.
  if (from === pool.poolId || to === pool.poolId) {
    const shift = decimals(from) - decimals(to)
    return shift >= 0 ? { num: raw * pow10(shift), den: SS_SPOT_SCALE } : { num: raw, den: SS_SPOT_SCALE * pow10(-shift) }
  }
  return { num: raw, den: SS_SPOT_SCALE }
}

/**
 * The hop's marginal price before fees: how many whole `to` one whole `from` buys.
 * Null when the hop cannot trade at this state.
 */
export function hopSpot(state: RouteState, hop: Hop, decimals: Decimals): Ratio | null {
  switch (hop.kind) {
    case 'aave':
      return { num: 1n, den: 1n }
    case 'omni': {
      const out = state.omni.get(hop.to)
      if (!out || out.reserve <= 0n || out.hub <= 0n) return null
      if (hop.from === HUB_ASSET_ID) {
        // B per H2O: reserve_B / hub_B, H2O carrying 12 decimals.
        return { num: out.reserve * pow10(12), den: out.hub * pow10(decimals(hop.to)) }
      }
      const inn = state.omni.get(hop.from)
      if (!inn || inn.reserve <= 0n || inn.hub <= 0n) return null
      // (hub_A / reserve_A) / (hub_B / reserve_B): the ratio of the two hub prices,
      // which is exactly what the two assets' Omnipool USD prices divide to.
      return { num: inn.hub * out.reserve * pow10(decimals(hop.from)), den: inn.reserve * out.hub * pow10(decimals(hop.to)) }
    }
    case 'ss': {
      const pool = state.stable.get(Number(hop.pool.slice(2)))
      return pool ? stableSpot(pool, hop.from, hop.to, decimals) : null
    }
    case 'xyk': {
      const p = state.xyk.get(hop.pool.slice(2))
      if (!p || p.ra <= 0n || p.rb <= 0n) return null
      const [rin, rout] = hop.from === p.a ? [p.ra, p.rb] : [p.rb, p.ra]
      return { num: rout * pow10(decimals(hop.from)), den: rin * pow10(decimals(hop.to)) }
    }
    case 'v3': {
      const p = state.v3.get(hop.pool.slice(2))
      if (!p || p.sqrtP <= 0n) return null
      // token1 per token0 in raw units = sqrtP² / 2^192.
      const sq = p.sqrtP * p.sqrtP
      const q = 1n << 192n
      return hop.from === p.t0
        ? { num: sq * pow10(decimals(p.t0)), den: q * pow10(decimals(p.t1)) }
        : { num: q * pow10(decimals(p.t1)), den: sq * pow10(decimals(p.t0)) }
    }
  }
}

/** The hop's fee as a fraction of output, for route selection only. */
export function hopFee(state: RouteState, hop: Hop, fees: FeeModel): number {
  switch (hop.kind) {
    case 'aave': return 0
    case 'omni': return (hop.from === HUB_ASSET_ID ? 0 : fees.omniSell(hop.from)) + fees.omniBuy(hop.to)
    case 'ss': return (state.stable.get(Number(hop.pool.slice(2)))?.feePermill ?? 0) / 1e6
    case 'xyk': return XYK_FEE
    case 'v3': return (state.v3.get(hop.pool.slice(2))?.feePpm ?? 0) / 1e6
  }
}

const ratioToNumber = (r: Ratio): number => {
  // Scale through a bigint quotient first so neither side has to fit a double alone.
  const q = (r.num * SCALE) / r.den
  return Number(q) / 1e30
}

/**
 * A usable hop. `cap` is the highest reference level (an index into the graph's
 * `ladder`) its own depth allows; `rt(level)` its round-trip factor there: sell the
 * level's notional across the hop and the proceeds straight back, fees and impact
 * both ways (1 = lossless; null when the hop cannot carry it). Rates are computed
 * on first use and kept.
 */
interface Edge { hop: Hop; to: number; pool: string; cap: number; rt: (level: number) => number | null }

/** The trusted (non-XYK) adjacency and the XYK edges, each with its selection rate. */
export interface RouteGraph {
  /** The reference trade sizes (USD), ascending; a route is rated at ladder[its level]. */
  ladder: readonly number[]
  /** USD per whole unit of every node the selection could price (given, or derived over the spots). */
  usd: ReadonlyMap<number, number>
  trusted: Map<number, Edge[]>
  xyk: Map<number, Edge[]>
  trustedNodes: Set<number>
  /** Stableswap asset↔asset edges tradable only directly, in eras the router could not route through the pool. */
  direct: Map<number, Edge[]>
}

/**
 * Which venues the router could route through at a block. The router gained its
 * Stableswap trade type (asset↔asset and the share-token add/remove legs) with
 * runtime 207 — the first routed Stableswap fill is block 4,542,131, 57 blocks
 * after the upgrade at 4,542,074; before it a stableswap pool traded only by a
 * direct pallet call — and its Aave trade type (aToken wraps) with runtime 305 at
 * 7,342,919 (first routed wrap 7,346,897), although aTokens existed from ~6.47 M.
 * Uniswap v3 pools exist only from runtime 443, so they need no gate.
 */
export interface RouteEra { stableswapRouting: boolean; aaveRouting: boolean }
export const ROUTER_STABLESWAP_FROM_BLOCK = 4_542_074
export const ROUTER_AAVE_FROM_BLOCK = 7_342_919
export const routeEraAt = (block: number): RouteEra => ({
  stableswapRouting: block >= ROUTER_STABLESWAP_FROM_BLOCK,
  aaveRouting: block >= ROUTER_AAVE_FROM_BLOCK,
})
export const CURRENT_ROUTE_ERA: RouteEra = { stableswapRouting: true, aaveRouting: true }

/**
 * How routes are rated for selection. A route is rated by its ROUND TRIP: a trade
 * of the reference notional sold along it and the proceeds bought back along the
 * same route in reverse — fees and price impact both ways — and the route losing
 * least wins. That is direction-neutral: a pair has one route, the same read either
 * way, whose spot read backwards is exactly the reciprocal (the stored price is the
 * spot before fees, the mid). The notional is depth-adaptive: min(`refUsd`,
 * `depthFraction` × the depth of the route's thinnest hop), never below
 * ROUTE_REFERENCE_FLOOR_USD, rounded down to ROUTE_REFERENCE_LADDER_USD — so a pair
 * whose only market is thin is rated at a trade that market can carry (and routed
 * through it) instead of not at all, while a thin hop costs its route a round trip
 * of ~2 × `depthFraction` of impact, which keeps it from beating any deep route. A
 * hop whose thinner side holds less than the floor trade, or that cannot carry
 * the floor trade both ways, is no venue (a dust pair, a drained pool). Every
 * candidate route of a pair is rated at ONE notional, the one its deepest route
 * supports (see Reach): a thin route competes at that size with the impact it
 * really has there, so it wins only where no deeper market exists. Each hop is rated alone at the route's notional (`usd`: USD per whole
 * unit of the priced assets, the rest derived over the graph's own spots) and a
 * route's factor is the product — the SDK evaluates the whole path at the caller's
 * amount; per hop at a fixed notional is the same wherever a hop conserves value,
 * and keeps the search exhaustive. Without a USD price for a hop's input, the hop
 * is rated spot × (1 − fee) both ways at every level.
 */
export interface RouteSelection {
  refUsd: number
  usd: ReadonlyMap<number, number>
  /** Overrides ROUTE_DEPTH_FRACTION. */
  depthFraction?: number
  /** The least thinner-side depth (USD) a hop needs to be a venue; default the floor trade. */
  minDepthUsd?: number
}

/** The largest reference trade route selection rates a route at. */
export const ROUTE_REFERENCE_USD = 1_000
/** The smallest: a hop that cannot carry it both ways is no venue. */
export const ROUTE_REFERENCE_FLOOR_USD = 10
/** The reference sizes a route's notional is rounded down to (USD), ascending; the top is ROUTE_REFERENCE_USD. */
export const ROUTE_REFERENCE_LADDER_USD: readonly number[] = [10, 20, 50, 100, 200, 500, 1_000]
/**
 * The notional as a fraction of the thinnest hop's depth (its thinner side, in
 * USD). Measured against 1 % / 2 % / 5 % on the SDK's own quotes (identical route
 * choice) and on executed fills (1 % marginally closest on thin pairs).
 */
export const ROUTE_DEPTH_FRACTION = 0.01

/** The largest part of a share leg's thinner side the floor trade may be. */
export const ROUTE_SHARE_LEG_MAX_FLOOR_SHARE = 0.1

const isShareLeg = (hop: Hop): boolean => {
  const id = Number(hop.pool.slice(2))
  return hop.from === id || hop.to === id
}

/** The reference ladder for a selection's cap: the standard rungs below it, and the cap itself. */
export function referenceLadder(refUsd: number): number[] {
  return [...ROUTE_REFERENCE_LADDER_USD.filter(x => x < refUsd), refUsd]
}

/**
 * A hop's depth in USD: the value of the thinner side it trades between — an
 * Omnipool asset's reserve (the hub side has no limit of its own), a stableswap
 * asset's reserve (a share leg: the pool's whole value), an XYK pool's reserve, the
 * token amounts a v3 pool's ranges hold. A side without a price does not limit.
 */
export function hopDepthUsd(state: RouteState, hop: Hop, usd: ReadonlyMap<number, number>, decimals: Decimals): number {
  const value = (asset: number, raw: number) => {
    const p = usd.get(asset)
    return p ? (raw / 10 ** decimals(asset)) * p : Infinity
  }
  switch (hop.kind) {
    case 'aave': return Infinity
    case 'omni': {
      const side = (a: number) => (a === HUB_ASSET_ID ? Infinity : value(a, Number(state.omni.get(a)?.reserve ?? 0n)))
      return Math.min(side(hop.from), side(hop.to))
    }
    case 'ss': {
      const pool = state.stable.get(Number(hop.pool.slice(2)))
      if (!pool) return 0
      const sides = pool.assetIds.map((a, i) => value(a, Number(pool.reserves[i]!)))
      const side = (a: number) => {
        const i = pool.assetIds.indexOf(a)
        return i >= 0 ? sides[i]! : sides.reduce((x, y) => x + y, 0)
      }
      return Math.min(side(hop.from), side(hop.to))
    }
    case 'xyk': {
      const p = state.xyk.get(hop.pool.slice(2))
      return p ? Math.min(value(p.a, Number(p.ra)), value(p.b, Number(p.rb))) : 0
    }
    case 'v3': {
      const p = state.v3.get(hop.pool.slice(2))
      if (!p) return 0
      const { amount0, amount1 } = v3HeldAmounts(p)
      return Math.min(value(p.t0, amount0), value(p.t1, amount1))
    }
  }
}

/** The token amounts (raw, as doubles) a v3 pool's ranges hold at its price: token1 below it, token0 above. */
function v3HeldAmounts(p: V3PoolState): { amount0: number; amount1: number } {
  const sp = Number(p.sqrtP) / 2 ** 96
  const sq = (t: number) => Math.pow(1.0001, t / 2)
  let running = 0, amount0 = 0, amount1 = 0
  for (let i = 0; i < p.ticks.length - 1; i++) {
    running += Number(p.ticks[i]!.liquidityNet)
    if (!(running > 0)) continue
    const a = sq(p.ticks[i]!.tick), b = sq(p.ticks[i + 1]!.tick)
    const lo = Math.min(Math.max(sp, a), b)
    amount0 += running * (1 / lo - 1 / b)
    amount1 += running * (lo - a)
  }
  return { amount0, amount1 }
}

const ssOutCache = new WeakMap<object, Map<string, number>>()
const v3OutCache = new WeakMap<object, Map<string, bigint>>()

/** Output per unit in, whole units, for `amountIn` whole units entering the hop; null when it cannot trade. */
function hopRateAt(state: RouteState, hop: Hop, amountIn: number, decimals: Decimals, fees: FeeModel): number | null {
  const fee = hopFee(state, hop, fees)
  const decIn = decimals(hop.from), decOut = decimals(hop.to)
  const rawIn = amountIn * 10 ** decIn
  if (!(rawIn > 0)) return null
  switch (hop.kind) {
    case 'aave': return 1
    case 'omni': {
      // The pool's sell math (hydradx-math calculate_sell_state_changes): the
      // protocol fee and the sold side's slip fee come off the hub amount leaving
      // the sold asset's pool, the bought side's slip off the hub amount entering
      // the bought one, the asset fee off the output. The slip fee is the dominant
      // size-dependent cost (8 bp of a $1,000 HOLLAR → aDOT trade), and the SDK
      // charges it, so a route rated without it overrates the Omnipool.
      const slip = state.omniMaxSlipFee
      let hubIn = rawIn
      if (hop.from !== HUB_ASSET_ID) {
        const inn = state.omni.get(hop.from)!
        const R = Number(inn.reserve), Q = Number(inn.hub)
        const delta = (Q * rawIn) / (R + rawIn)
        hubIn = delta * (1 - fees.omniSell(hop.from)) - omniSlipFee(Q, -delta, slip)
      }
      // Into the hub (the return leg of a round trip that started at H2O, which
      // the pool sells but never buys back): the sold half alone, as a rating.
      if (hop.to === HUB_ASSET_ID) return hubIn > 0 ? (hubIn / 10 ** decOut) / amountIn : null
      const out = state.omni.get(hop.to)!
      const R = Number(out.reserve), Q = Number(out.hub)
      const hubNet = hubIn - omniSlipFee(Q, hubIn, slip)
      if (!(hubNet > 0)) return null
      const rawOut = (R * hubNet) / (Q + hubNet) * (1 - fees.omniBuy(hop.to))
      return (rawOut / 10 ** decOut) / amountIn
    }
    case 'xyk': {
      const p = state.xyk.get(hop.pool.slice(2))!
      const [rin, rout] = hop.from === p.a ? [Number(p.ra), Number(p.rb)] : [Number(p.rb), Number(p.ra)]
      const x = rawIn * (1 - fee)
      return ((rout * x) / (rin + x) / 10 ** decOut) / amountIn
    }
    case 'v3': {
      // The pool's own swap of the reference amount, exact: the tick walk across
      // every initialised range, the fee taken per step. A trade larger than the
      // pool's depth spends only what it can and returns what it got, which the
      // rate (out per unit offered) charges in full, as the SDK's quote does.
      const p = state.v3.get(hop.pool.slice(2))!
      const amount = BigInt(Math.max(1, Math.floor(rawIn)))
      let cache = v3OutCache.get(p)
      if (!cache) { cache = new Map(); v3OutCache.set(p, cache) }
      const key = `${hop.from}@${amount}`
      let rawOut = cache.get(key)
      if (rawOut === undefined) {
        const pool: V3SwapPool = { sqrtPriceX96: p.sqrtP, tick: p.tick, liquidity: p.liquidity, fee: p.feePpm, tickSpacing: p.tickSpacing, ticks: p.ticks }
        const q = v3QuoteExactIn(pool, hop.from === p.t0, amount)
        rawOut = q ? q.amountOut : 0n
        cache.set(key, rawOut)
      }
      if (!(rawOut > 0n)) return null
      return (Number(rawOut) / 10 ** decOut) / (Number(amount) / 10 ** decIn)
    }
    case 'ss': {
      const pool = state.stable.get(Number(hop.pool.slice(2)))!
      const rawInText = BigInt(Math.max(1, Math.floor(rawIn))).toString()
      let cache = ssOutCache.get(pool)
      if (!cache) { cache = new Map(); ssOutCache.set(pool, cache) }
      const key = `${hop.from}>${hop.to}@${rawInText}`
      let rawOut = cache.get(key)
      if (rawOut === undefined) {
        const reserves = JSON.stringify(pool.assetIds.map((id, i) => ({ asset_id: id, amount: pool.reserves[i]!.toString(), decimals: decimals(id) })))
        const pegs = JSON.stringify((pool.pegs ?? pool.assetIds.map(() => ({ num: 1n, den: 1n }))).map(q => [q.num.toString(), q.den.toString()]))
        const amp = String(pool.amplification), feeText = String(pool.feePermill / 1e6), issuance = pool.totalIssuance.toString()
        try {
          // A share leg is the pool's own add-one-asset / remove-one-asset math,
          // so a drained pool cannot carry a route through its share token.
          rawOut = Number(hop.to === pool.poolId
            ? calculate_shares(reserves, JSON.stringify([{ asset_id: hop.from, amount: rawInText }]), amp, issuance, feeText, pegs)
            : hop.from === pool.poolId
              ? calculate_liquidity_out_one_asset(reserves, rawInText, hop.to, amp, issuance, feeText, pegs)
              : calculate_out_given_in(reserves, hop.from, hop.to, rawInText, amp, feeText, pegs))
        } catch {
          rawOut = 0
        }
        cache.set(key, rawOut)
      }
      if (!(rawOut > 0)) return null
      return (rawOut / 10 ** decOut) / (Number(rawInText) / 10 ** decIn)
    }
  }
}

/**
 * A hop's round-trip factor at a notional of `refUsd`: sold across the hop and the
 * proceeds straight back, both at the same state (fees and impact both ways);
 * null when it cannot carry it. `price` is the USD price of the hop's input; without
 * one the spot cancels and only the fees both ways remain.
 */
export function hopRoundTrip(state: RouteState, hop: Hop, refUsd: number, price: number | undefined, decimals: Decimals, fees: FeeModel): number | null {
  // A pool that left the state (a delisted asset, a destroyed pool) carries nothing.
  if (!hopSpot(state, hop, decimals)) return null
  const back: Hop = { ...hop, from: hop.to, to: hop.from }
  if (!price) {
    const v = (1 - hopFee(state, hop, fees)) * (1 - hopFee(state, back, fees))
    return v > 0 ? v : null
  }
  const amount = refUsd / price
  const f = hopRateAt(state, hop, amount, decimals, fees)
  const b = f != null && f > 0 ? hopRateAt(state, back, f * amount, decimals, fees) : null
  return f != null && b != null && f * b > 0 && Number.isFinite(f * b) ? f * b : null
}

/** A route's round-trip factor at one state (the product of its hops'); 0 when a hop cannot carry the notional. */
export function routeRoundTrip(state: RouteState, hops: readonly Hop[], refUsd: number, usd: ReadonlyMap<number, number>, decimals: Decimals, fees: FeeModel): number {
  let r = 1
  for (const h of hops) {
    const v = hopRoundTrip(state, h, refUsd, usd.get(h.from), decimals, fees)
    if (v == null) return 0
    r *= v
  }
  return r
}

export function buildRouteGraph(state: RouteState, decimals: Decimals, fees: FeeModel, selection?: RouteSelection, era: RouteEra = CURRENT_ROUTE_ERA): RouteGraph {
  const trusted = new Map<number, Edge[]>()
  const xyk = new Map<number, Edge[]>()
  const direct = new Map<number, Edge[]>()
  const trustedNodes = new Set<number>()
  const candidates: Array<{ map: Map<number, Edge[]>; hop: Hop; spot: number }> = []
  const add = (map: Map<number, Edge[]>, hop: Hop) => {
    const r = hopSpot(state, hop, decimals)
    if (!r || r.num <= 0n) return
    const spot = ratioToNumber(r)
    if (!(spot > 0) || !Number.isFinite(spot)) return
    candidates.push({ map, hop, spot })
  }
  // Omnipool: one pool, every ordered pair; the hub only as the sold side.
  const omniIds = [...state.omni.entries()].filter(([, s]) => s.reserve > 0n && s.hub > 0n).map(([id]) => id)
  if (omniIds.length) {
    trustedNodes.add(HUB_ASSET_ID)
    for (const id of omniIds) trustedNodes.add(id)
  }
  for (const a of omniIds) {
    const sa = state.omni.get(a)!
    for (const b of omniIds) {
      if (a === b) continue
      const sb = state.omni.get(b)!
      if (!(sa.tradable & TRADABLE_SELL) || !(sb.tradable & TRADABLE_BUY)) continue
      add(trusted, { kind: 'omni', pool: 'omni', from: a, to: b })
    }
  }
  for (const b of omniIds) {
    if (!(state.omni.get(b)!.tradable & TRADABLE_BUY)) continue
    add(trusted, { kind: 'omni', pool: 'omni', from: HUB_ASSET_ID, to: b })
  }
  // Stableswap: every ordered pair of the pool's assets and its share token.
  for (const pool of state.stable.values()) {
    if (pool.reserves.some(r => r <= 0n) || pool.totalIssuance <= 0n) continue
    if (!era.stableswapRouting) {
      // Before the router's Stableswap trade type: a direct swap inside the pool
      // only, no share legs, nothing to chain it with.
      for (const a of pool.assetIds) for (const b of pool.assetIds) {
        if (a !== b) add(direct, { kind: 'ss', pool: `s:${pool.poolId}`, from: a, to: b })
      }
      continue
    }
    const tokens = [...pool.assetIds, pool.poolId]
    for (const t of tokens) trustedNodes.add(t)
    for (const a of tokens) for (const b of tokens) {
      if (a !== b) add(trusted, { kind: 'ss', pool: `s:${pool.poolId}`, from: a, to: b })
    }
  }
  // Money-market wraps, both ways, one pool per pair.
  for (const [u, a] of era.aaveRouting ? state.atokens : []) {
    trustedNodes.add(u)
    trustedNodes.add(a)
    add(trusted, { kind: 'aave', pool: `a:${u}:${a}`, from: u, to: a })
    add(trusted, { kind: 'aave', pool: `a:${u}:${a}`, from: a, to: u })
  }
  for (const [addr, p] of state.v3) {
    // A pool is a venue while it holds liquidity in any range: a trade starting
    // between ranges crosses into the nearest one.
    if (!p.ticks.length) continue
    trustedNodes.add(p.t0)
    trustedNodes.add(p.t1)
    add(trusted, { kind: 'v3', pool: `v:${addr}`, from: p.t0, to: p.t1 })
    add(trusted, { kind: 'v3', pool: `v:${addr}`, from: p.t1, to: p.t0 })
  }
  for (const [acct, p] of state.xyk) {
    if (p.a === p.b) continue
    add(xyk, { kind: 'xyk', pool: `x:${acct}`, from: p.a, to: p.b })
    add(xyk, { kind: 'xyk', pool: `x:${acct}`, from: p.b, to: p.a })
  }
  // USD per whole unit for every node: the priced assets, then outward over the
  // spots (first arrival in breadth order) for the unpriced ones a route passes
  // through (aTokens, pool shares, XYK partners).
  const usd = new Map<number, number>()
  if (selection) {
    for (const [id, v] of selection.usd) if (v > 0 && Number.isFinite(v)) usd.set(id, v)
    const out = new Map<number, Array<{ to: number; spot: number }>>()
    for (const c of candidates) {
      const list = out.get(c.hop.from)
      if (list) list.push({ to: c.hop.to, spot: c.spot })
      else out.set(c.hop.from, [{ to: c.hop.to, spot: c.spot }])
    }
    const queue = [...usd.keys()]
    for (let i = 0; i < queue.length; i++) {
      const from = queue[i]!
      for (const e of out.get(from) ?? []) {
        if (usd.has(e.to)) continue
        // spot = to per from, so one `to` is worth usd(from) / spot.
        usd.set(e.to, usd.get(from)! / e.spot)
        queue.push(e.to)
      }
    }
  }
  const ladder = selection ? referenceLadder(selection.refUsd) : [1]
  const floor = Math.min(ROUTE_REFERENCE_FLOOR_USD, ladder[ladder.length - 1]!)
  const fraction = selection?.depthFraction ?? ROUTE_DEPTH_FRACTION
  const spotOf = new Map(candidates.map(c => [`${c.hop.pool}|${c.hop.from}|${c.hop.to}`, c.spot]))
  for (const { map, hop, spot } of candidates) {
    const back: Hop = { ...hop, from: hop.to, to: hop.from }
    const price = usd.get(hop.from)
    let cap = ladder.length - 1
    let rt: (level: number) => number | null
    if (selection && price) {
      // A hop whose thinner side holds less than the floor trade is no venue at
      // all (a dust pool, a drained one whose share still trades elsewhere at a
      // stale price): a few dollars of liquidity must not set a pair's price.
      const depth = hopDepthUsd(state, hop, usd, decimals)
      if (!(depth >= (selection.minDepthUsd ?? floor))) continue
      // A stableswap pool's own share leg needs the floor trade to be a small part
      // of the pool: the share is the one token that also trades elsewhere (the
      // Omnipool, a money market) at a price the pool's reserves need not back, and
      // a pool drained below that bridges the stale outside price into the pair.
      if (hop.kind === 'ss' && isShareLeg(hop) && !(depth * ROUTE_SHARE_LEG_MAX_FLOOR_SHARE >= floor)) continue
      const target = Math.max(floor, Math.min(ladder[ladder.length - 1]!, fraction * depth))
      while (cap > 0 && ladder[cap]! > target) cap--
      const memo: Array<number | null | undefined> = []
      rt = level => {
        let v = memo[level]
        if (v === undefined) memo[level] = v = hopRoundTrip(state, hop, ladder[level]!, price, decimals, fees)
        return v
      }
    } else {
      // Unsized: the spot cancels in a round trip, the fees both ways remain.
      const v = hopRoundTrip(state, hop, 0, undefined, decimals, fees)
      rt = () => v
    }
    // A hop is a venue only while the floor trade clears it in BOTH directions — the
    // round trip itself (a drained stableswap pool still takes deposits, so its
    // share could be minted at a stale price but never redeemed). An Omnipool hop's
    // way back is rated by the pool's math whatever its tradability bits say: a
    // one-way hop there is the pallet's own state (a sell-only asset being delisted,
    // the hub that is sold but never bought), which the asset's market survives.
    if (hop.kind !== 'omni' && !spotOf.has(`${back.pool}|${back.from}|${back.to}`)) continue
    if (!(spot > 0) || rt(0) == null) continue
    const list = map.get(hop.from)
    const edge: Edge = { hop, to: hop.to, pool: hop.pool, cap, rt }
    if (list) list.push(edge)
    else map.set(hop.from, [edge])
  }
  return { ladder, usd, trusted, xyk, trustedNodes, direct }
}

/**
 * A selected route: its hops, the reference level it is rated at and its
 * round-trip factor there (`rate`), and `cap`, the highest level its own hops can
 * carry (the lowest cap among them).
 */
export interface RouteChoice { hops: Hop[]; rate: number; level: number; cap: number }

/**
 * Everything a search knows about reaching one asset: `cap`, the highest level any
 * route to it can carry (the widest of the routes' thinnest hops), and per level
 * the route with the best round trip AT that level — every route rated there, a
 * thin one with the impact it really has at that size. The asset's route is
 * `best[cap]`: all candidates compete at the one notional the pair's deepest route
 * supports, so a thin pool can never win by being rated at a smaller trade.
 */
interface Ranked { hops: Hop[]; rate: number; cap: number }
interface Reach { cap: number; best: Ranked[][] }

/** How many of each asset's best routes a search keeps per level (the fold's per-block candidates). */
export const ROUTE_CANDIDATES = 3

const newReach = (levels: number): Reach => ({ cap: -1, best: Array.from({ length: levels }, () => []) })

const pick = (reach: Reach | undefined): RouteChoice | undefined => {
  const b = reach?.best[reach.cap]?.[0]
  return b && b.rate > 0 ? { hops: b.hops, rate: b.rate, level: reach!.cap, cap: b.cap } : undefined
}

/** The reach's best routes at its level, best first. */
const ranked = (reach: Reach | undefined): RouteChoice[] =>
  reach && reach.cap >= 0 ? reach.best[reach.cap]!.filter(b => b.rate > 0).map(b => ({ hops: b.hops, rate: b.rate, level: reach.cap, cap: b.cap })) : []

/** Inserts a route into one level's top list (descending, at most ROUTE_CANDIDATES). */
function insertRanked(list: Ranked[], entry: () => Ranked, rate: number): void {
  if (!(rate > 0)) return
  if (list.length >= ROUTE_CANDIDATES && rate <= list[list.length - 1]!.rate) return
  let i = list.length
  while (i > 0 && list[i - 1]!.rate < rate) i--
  list.splice(i, 0, entry())
  if (list.length > ROUTE_CANDIDATES) list.pop()
}

/** Records a route (per-level factors, min cap) into a reach, keeping the best few per level. */
function record(reach: Reach, hops: () => Hop[], byLevel: readonly number[], cap: number): void {
  if (cap > reach.cap) reach.cap = cap
  let copy: Hop[] | undefined
  for (let l = 0; l < byLevel.length; l++) {
    const r = byLevel[l]!
    insertRanked(reach.best[l]!, () => ({ hops: (copy ??= hops()), rate: r, cap }), r)
  }
}

/**
 * Best trusted-only routes from `source` to every reachable asset within
 * `maxHops` crossings: an exhaustive simple-path search (no asset twice, no pool
 * twice), the SDK's own path rule, every path rated at every level.
 */
function trustedReach(graph: RouteGraph, source: number, maxHops: number): Map<number, Reach> {
  const reach = new Map<number, Reach>()
  const visited = new Set<number>([source])
  const usedPools = new Set<string>()
  const path: Hop[] = []
  const levels = graph.ladder.length
  const walk = (node: number, byLevel: readonly number[], cap: number) => {
    if (path.length >= maxHops) return
    for (const e of graph.trusted.get(node) ?? []) {
      if (visited.has(e.to) || usedPools.has(e.pool)) continue
      const next = new Array<number>(levels)
      let any = false
      for (let l = 0; l < levels; l++) {
        next[l] = byLevel[l]! > 0 ? byLevel[l]! * (e.rt(l) ?? 0) : 0
        if (next[l]! > 0) any = true
      }
      if (!any) continue
      const nextCap = Math.min(cap, e.cap)
      path.push(e.hop)
      let r = reach.get(e.to)
      if (!r) { r = newReach(levels); reach.set(e.to, r) }
      record(r, () => [...path], next, nextCap)
      visited.add(e.to)
      usedPools.add(e.pool)
      walk(e.to, next, nextCap)
      visited.delete(e.to)
      usedPools.delete(e.pool)
      path.pop()
    }
  }
  walk(source, graph.ladder.map(() => 1), graph.ladder.length - 1)
  return reach
}

/** Best trusted-only route from `source` to every reachable asset (see Reach for how routes compete). */
export function bestTrustedFrom(graph: RouteGraph, source: number, maxHops = MAX_ROUTE_HOPS): Map<number, RouteChoice> {
  const out = new Map<number, RouteChoice>()
  for (const [to, r] of trustedReach(graph, source, maxHops)) {
    const c = pick(r)
    if (c) out.set(to, c)
  }
  return out
}

const pairKey = (lo: number, hi: number) => `${lo}:${hi}`

/**
 * A route finder over one graph: `route(from, to)` is the best route selling
 * `from` for `to` under the SDK's trusted/isolated rule, or undefined. Rated by the
 * round trip, the route found for (a, b) is the route found for (b, a) reversed.
 * The trusted searches it runs are memoised per source.
 */
export interface RouteFinder {
  (from: number, to: number): RouteChoice | undefined
  candidates(from: number, to: number): RouteChoice[]
}

export function routeFinder(graph: RouteGraph, maxHops = MAX_ROUTE_HOPS): RouteFinder {
  const levels = graph.ladder.length
  const trustedFrom = new Map<number, Map<number, Reach>>()
  const fromTrusted = (s: number) => {
    let m = trustedFrom.get(s)
    if (!m) {
      m = trustedReach(graph, s, maxHops)
      trustedFrom.set(s, m)
    }
    return m
  }
  // A composite route: XYK edges and trusted reaches in order, recorded into `into`
  // at every level (a reach contributes its best route at each level).
  const chain = (into: Reach, parts: ReadonlyArray<Edge | Reach>) => {
    const byLevel = new Array<number>(levels).fill(1)
    const hopsAt: Hop[][] = Array.from({ length: levels }, () => [])
    let cap = levels - 1
    for (const p of parts) {
      if ('rt' in p) {
        cap = Math.min(cap, p.cap)
        for (let l = 0; l < levels; l++) { byLevel[l]! *= p.rt(l) ?? 0; hopsAt[l]!.push(p.hop) }
      } else {
        cap = Math.min(cap, p.cap)
        for (let l = 0; l < levels; l++) {
          const b = p.best[l]![0]
          byLevel[l]! *= b ? b.rate : 0
          if (b) hopsAt[l]!.push(...b.hops)
        }
      }
    }
    if (cap < 0) return
    for (let l = 0; l < levels; l++) {
      if (hopsAt[l]!.length > maxHops) byLevel[l] = 0
      const hopsHere = hopsAt[l]!
      insertRanked(into.best[l]!, () => ({ hops: hopsHere, rate: byLevel[l]!, cap }), byLevel[l]!)
    }
    if (byLevel.some(r => r > 0) && cap > into.cap) into.cap = cap
  }
  const routed = (from: number, to: number): Reach | undefined => {
    const fromTrustedNode = graph.trustedNodes.has(from)
    const toTrustedNode = graph.trustedNodes.has(to)
    if (fromTrustedNode && toTrustedNode) return fromTrusted(from).get(to)
    const into = newReach(levels)
    if (!fromTrustedNode && !toTrustedNode) {
      // Only the XYK pools holding either endpoint: direct, or through one partner.
      for (const e of graph.xyk.get(from) ?? []) {
        if (e.to === to) chain(into, [e])
        for (const f of graph.xyk.get(e.to) ?? []) {
          if (f.to === to && f.pool !== e.pool) chain(into, [e, f])
        }
      }
    } else if (!fromTrustedNode) {
      // The untrusted seller's XYK pools, then trusted pools only.
      for (const e of graph.xyk.get(from) ?? []) {
        if (e.to === to) chain(into, [e])
        else if (graph.trustedNodes.has(e.to)) {
          const rest = fromTrusted(e.to).get(to)
          if (rest) chain(into, [e, rest])
        }
      }
    } else {
      // Trusted pools, then one of the untrusted buyer's XYK pools into it.
      const reach = fromTrusted(from)
      for (const e of graph.xyk.get(to) ?? []) {
        const back = (graph.xyk.get(e.to) ?? []).find(f => f.pool === e.pool && f.to === to)
        if (!back) continue
        if (e.to === from) { chain(into, [back]); continue }
        const head = reach.get(e.to)
        if (head) chain(into, [head, back])
      }
    }
    return into
  }
  const find = (from: number, to: number): RouteChoice | undefined => {
    let best = pick(routed(from, to))
    // A direct stableswap swap competes in an era the router could not chain one,
    // rated at the routed best's level (or its own cap when nothing else routes).
    for (const e of graph.direct.get(from) ?? []) {
      if (e.to !== to) continue
      const level = best ? best.level : e.cap
      const r = e.rt(level)
      if (r && (!best || r > best.rate)) best = { hops: [e.hop], rate: r, level, cap: e.cap }
    }
    return best
  }
  return Object.assign(find, {
    /** The pair's best few routes at its level, best first (the fold's per-block candidates). */
    candidates: (from: number, to: number): RouteChoice[] => {
      const list = ranked(routed(from, to))
      const best = find(from, to)
      return best && !list.some(c => c.hops === best.hops) ? [best, ...list].slice(0, ROUTE_CANDIDATES) : list
    },
  })
}

/**
 * The best route for every unordered pair of `assets` (keyed `lo:hi`, the route
 * selling lo for hi). Pairs with no route are absent.
 */
export function bestRoutes(graph: RouteGraph, assets: readonly number[], maxHops = MAX_ROUTE_HOPS): Map<string, RouteChoice> {
  const out = new Map<string, RouteChoice>()
  for (const [key, list] of routeCandidates(graph, assets, maxHops)) out.set(key, list[0]!)
  return out
}

/** The best few routes for every unordered pair of `assets` (keyed `lo:hi`, selling lo for hi), best first. */
export function routeCandidates(graph: RouteGraph, assets: readonly number[], maxHops = MAX_ROUTE_HOPS): Map<string, RouteChoice[]> {
  const out = new Map<string, RouteChoice[]>()
  const ids = [...new Set(assets)].sort((a, b) => a - b)
  const route = routeFinder(graph, maxHops)
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const list = route.candidates(ids[i]!, ids[j]!)
      if (list.length) out.set(pairKey(ids[i]!, ids[j]!), list)
    }
  }
  return out
}

/** A route that is nothing but one Omnipool crossing — priced exactly by the USD ratio already. */
export const isPureOmnipool = (hops: readonly Hop[]): boolean => hops.length === 1 && hops[0]!.kind === 'omni'

/** The route's spot before fees at ROUTE_PRICE_SCALE digits, as an integer; null if a hop cannot trade. */
export function routeSpot(state: RouteState, hops: readonly Hop[], decimals: Decimals, hopCache?: Map<string, Ratio | null>): bigint | null {
  let num = 1n
  let den = 1n
  for (const hop of hops) {
    const key = `${hop.pool}|${hop.from}|${hop.to}`
    let r = hopCache?.get(key)
    if (r === undefined) {
      r = hopSpot(state, hop, decimals)
      hopCache?.set(key, r)
    }
    if (!r) return null
    num *= r.num
    den *= r.den
  }
  if (den === 0n) return null
  const v = (num * SCALE) / den
  return v > 0n ? v : null
}

/** The hops of a route label (routeLabel's inverse); null for text that is not one. */
export function parseRouteLabel(label: string): Hop[] | null {
  const prefix: Record<string, string> = { ss: 's:', xyk: 'x:', v3: 'v:', aave: 'a:' }
  const hops: Hop[] = []
  for (const part of label.split('|')) {
    const m = part.match(/^(omni|ss|xyk|v3|aave):(?:(.*):)?(\d+)>(\d+)$/)
    if (!m) return null
    const kind = m[1] as HopKind
    if ((kind === 'omni') !== (m[2] == null)) return null
    hops.push({ kind, pool: kind === 'omni' ? 'omni' : prefix[kind] + m[2], from: Number(m[3]), to: Number(m[4]) })
  }
  return hops.length ? hops : null
}

/** A route's compact identity, e.g. `a:22:1022>ss:110>ss:143` (kind:pool, hop by hop, with direction). */
export function routeLabel(hops: readonly Hop[]): string {
  return hops.map(h => `${h.kind}:${h.kind === 'omni' ? '' : h.pool.slice(2) + ':'}${h.from}>${h.to}`).join('|')
}

/** The route's fee product complement in ppm, Π(1 − fee) — the executable discount of a small trade. */
export function routeFeePpm(state: RouteState, hops: readonly Hop[], fees: FeeModel): number {
  let keep = 1
  for (const h of hops) keep *= 1 - hopFee(state, h, fees)
  return Math.max(0, Math.min(1_000_000, Math.round((1 - keep) * 1e6)))
}

/* ───────────── parsing the snapshot's pool sections ───────────── */

/** The `o:<asset>` value written by the state extraction: `reserve,hub,tradable`. */
export function parseOmniValue(v: string): OmniAssetState | null {
  const [r, h, t] = v.split(',')
  try {
    return { reserve: BigInt(r!), hub: BigInt(h!), tradable: Number(t ?? 15) }
  } catch { return null }
}

/** The `s:<pool>` value: the snapshot's raw pool object. */
export function parseStableValue(v: string): StableswapPoolSnapshot | null {
  try {
    return parseStableswapPools({ pools: [JSON.parse(v)] })[0] ?? null
  } catch { return null }
}

/** The `x:<account>` value: `asset_a,asset_b,reserve_a,reserve_b`. */
export function parseXykValue(v: string): XykPoolState | null {
  const [a, b, ra, rb] = v.split(',')
  try {
    return { a: Number(a), b: Number(b), ra: BigInt(ra!), rb: BigInt(rb!) }
  } catch { return null }
}

/** The `a:` value: the snapshot's atoken_equivalences (pairs, or a flat id list). */
export function parseAtokenValue(v: string): Array<[number, number]> {
  let parsed: unknown
  try { parsed = JSON.parse(v) } catch { return [] }
  const flat: number[] = []
  const out: Array<[number, number]> = []
  const ids = (x: unknown): number[] => {
    if (typeof x === 'number') return [x]
    if (typeof x === 'string') {
      if (!x.startsWith('0x')) return [Number(x)]
      const h = x.slice(2)
      const r: number[] = []
      for (let i = 0; i + 1 < h.length; i += 2) r.push(parseInt(h.slice(i, i + 2), 16))
      return r
    }
    return []
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (Array.isArray(item) && item.length >= 2) out.push([Number(item[0]), Number(item[1])])
      else flat.push(...ids(item))
    }
  } else flat.push(...ids(parsed))
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!])
  return out.filter(([u, a]) => Number.isFinite(u) && Number.isFinite(a) && u !== a)
}

/** The state key of the Omnipool's maximum slip fee (value: permill, '' or 0 = unset). */
export const OMNI_SLIP_KEY = 'p:omni-slip'

/** Applies one extracted state change (key, value; '' = gone) to the state. */
export function applyStateChange(state: RouteState, key: string, value: string): void {
  const kind = key.slice(0, 2)
  const id = key.slice(2)
  if (kind === 'o:') {
    const s = value ? parseOmniValue(value) : null
    if (s) state.omni.set(Number(id), s)
    else state.omni.delete(Number(id))
  } else if (kind === 's:') {
    const s = value ? parseStableValue(value) : null
    if (s) state.stable.set(Number(id), s)
    else state.stable.delete(Number(id))
  } else if (kind === 'x:') {
    const s = value ? parseXykValue(value) : null
    if (s) state.xyk.set(id, s)
    else state.xyk.delete(id)
  } else if (kind === 'v:') {
    const s = value ? parseV3Value(value) : null
    if (s) state.v3.set(id, s)
    else state.v3.delete(id)
  } else if (key === 'a:') {
    state.atokens = value ? parseAtokenValue(value) : []
  } else if (key === OMNI_SLIP_KEY) {
    const permill = Number(value)
    state.omniMaxSlipFee = Number.isFinite(permill) && permill > 0 ? permill / 1e6 : 0
  }
}

/**
 * The `v:<pool>` value:
 * `token0_asset,token1_asset,sqrtPriceX96,tick,active_liquidity,fee_ppm,tick_spacing,ticks`,
 * `ticks` the initialised tick table as `tick:liquidityNet` joined by `;`, ascending.
 */
export function formatV3Value(p: V3PoolState): string {
  return `${p.t0},${p.t1},${p.sqrtP},${p.tick},${p.liquidity},${p.feePpm},${p.tickSpacing},${p.ticks.map(t => `${t.tick}:${t.liquidityNet}`).join(';')}`
}

export function parseV3Value(v: string): V3PoolState | null {
  const [t0, t1, sp, tick, liq, fee, spacing, table] = v.split(',')
  try {
    const ticks = (table ?? '').split(';').filter(Boolean).map(e => {
      const [t, net] = e.split(':')
      return { tick: Number(t), liquidityNet: BigInt(net!) }
    })
    const out: V3PoolState = { t0: Number(t0), t1: Number(t1), sqrtP: BigInt(sp!), tick: Number(tick), liquidity: BigInt(liq!), feePpm: Number(fee), tickSpacing: Number(spacing), ticks }
    return Number.isInteger(out.tick) && out.tickSpacing > 0 && Number.isFinite(out.feePpm) ? out : null
  } catch { return null }
}
