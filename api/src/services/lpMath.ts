// The pure liquidity-position arithmetic every surface that values an LP
// position shares — the explorer's account/pool pages, the account-value
// directory and the Data API. Integer/bigint throughout: the values exceed
// 2^53 and a position's redeemable legs must be exact before any USD step.

// Omnipool positions carry their entry price as FixedU128 (= num/den · 1e18);
// priceDen = OMNI_FIXED reproduces the storage rational from the event field.
export const OMNI_FIXED = 10n ** 18n

// The Omnipool hub asset (H2O, registry id 1, 12 decimals).
export const HUB_ASSET_ID = 1

export interface DecodedPosition { assetId: number; amount: bigint; shares: bigint; priceNum: bigint; priceDen: bigint }

// One Omnipool asset's pool state: asset reserve, hub (H2O) reserve, total shares.
export interface OmnipoolAssetState { reserve: bigint; hub: bigint; shares: bigint }

// Omnipool remove-liquidity (full position) → (asset out, hub/H2O out), mirroring
// the node's calculate_remove_liquidity_state_changes (withdrawalFee = 0). Verified
// bit-exact against the official indexer's per-position liquidityAmount.
export function omnipoolRemoveLiquidity(st: OmnipoolAssetState, pos: DecodedPosition): { liquidity: bigint; hub: bigint } {
  const { reserve: R, hub: Q, shares: S } = st
  if (S <= 0n || pos.priceDen === 0n) return { liquidity: 0n, hub: 0n }
  const price = pos.priceNum * OMNI_FIXED / pos.priceDen
  const pxr = (price * R) / OMNI_FIXED + 1n
  const lt = Q * OMNI_FIXED < price * R
  const gt = Q * OMNI_FIXED > price * R
  const deltaB = lt ? ((pxr - Q) * pos.shares) / (pxr + Q) + 1n : 0n
  const deltaShares = pos.shares - deltaB
  const liquidity = (R * deltaShares) / S
  const hub = gt ? ((Q * (Q - pxr)) / (Q + pxr) * deltaShares) / S : 0n
  return { liquidity, hub }
}

// XYK LP redeemable reserve legs for `shares` of a pool with raw reserves `reserveA/B` and
// `totalShares` outstanding — amountX = floor(reserveX * shares / totalShares). Shared by
// direct wallet LP balances and collection-5389 farm-deposit principal.
export function xykShareLegs(shares: bigint, reserveA: bigint, reserveB: bigint, totalShares: bigint): { amountA: bigint; amountB: bigint } {
  if (totalShares <= 0n || shares <= 0n) return { amountA: 0n, amountB: 0n }
  return { amountA: (reserveA * shares) / totalShares, amountB: (reserveB * shares) / totalShares }
}

// Which asset each XYK reserve belongs to. A snapshot row names its own
// (asset_a↔reserve_a, asset_b↔reserve_b) order, which can differ from the
// registry's PoolCreated order, so reserves pair by it whenever the row carries
// ids; the registry order is only the fallback for a row that carries none.
// Presence is the test, never a non-zero id: HDX is asset 0, and reading 0 as
// "missing" swapped an HDX pool's reserves wherever the two orders differ.
// `hasIds` is the snapshot keys' presence where the reader can see it; a sampled
// table that stores an absent id as 0 passes `snapA !== 0 || snapB !== 0` —
// a pool's two assets are distinct, so only an absent pair reads (0, 0).
export function xykReserveAssets(hasIds: boolean, snapA: number, snapB: number, registryA: number, registryB: number): [number, number] {
  return hasIds ? [snapA, snapB] : [registryA, registryB]
}

// Stableswap share redemption is pro-rata over every reserve (the proportional
// withdraw, which is peg-independent): amount_i = floor(reserve_i * shares / totalIssuance).
export function stableswapShareLegs(shares: bigint, reserves: bigint[], totalIssuance: bigint): bigint[] {
  if (totalIssuance <= 0n || shares <= 0n) return reserves.map(() => 0n)
  return reserves.map(reserve => (reserve * shares) / totalIssuance)
}

// ── Stableswap share-token price ─────────────────────────────────────────────
// The CURRENT price of a stableswap share token is what one whole share redeems
// for: its pro-rata slice of every reserve (stableswapShareLegs, the proportional
// withdraw) valued at the legs' current prices. Every current-value surface — the
// explorer's price map, /v1/accounts/balances and the Data API — puts this one
// figure in its price map under the share's own id, so a share held in a wallet,
// supplied to a money market or counted in a directory is valued by the same
// definition wherever it appears. It replaces pricing a share as one unit of a
// "main underlying", which overstates any pool whose other leg is cheaper
// (2-Pool-apyUSD = apyUSD + HOLLAR was stated at apyUSD's price, +38%).
//
// A share with ANY unpriced leg is unpriced (null) — never valued on its priced
// legs alone and never at an underlying's price — and so is a pool with no issuance.
// The on-chain peg multipliers shape only the trading curve and are not applied:
// a proportional withdraw pays reserves, not pegged amounts.
export interface StableswapSharePool { poolId: number; assetIds: number[]; reserves: bigint[]; totalIssuance: bigint }

/**
 * How old the pool snapshot a share price is derived from may be. Past it every
 * share token is unpriced — the XYK pool-state rule of /v1/accounts/balances
 * (`xykLpUsd` null past 1 h) — so a stalled snapshot writer drops share values on
 * every surface together (the explorer's and the public API's
 * stableswapSharePools, the Data API's assetsData) rather than serving reserves
 * hours out of date as current.
 */
export const SHARE_POOL_MAX_AGE_SECONDS = 3600

/**
 * One share's value in 10^-usdScale USD per WHOLE share, from integer prices
 * (10^-usdScale USD per whole leg unit). Exact up to a single final floor: the
 * legs are summed over a common denominator before dividing, so this is the
 * value `stableswapShareLegs` would redeem for, without its per-leg floors.
 */
export function stableswapSharePriceScaled(
  pool: StableswapSharePool,
  legPrices: ReadonlyArray<bigint | null | undefined>,
  legDecimals: ReadonlyArray<number | null | undefined>,
  shareDecimals: number,
): bigint | null {
  const n = pool.assetIds.length
  if (!n || pool.reserves.length !== n || legPrices.length !== n || legDecimals.length !== n) return null
  if (pool.totalIssuance <= 0n) return null
  let maxDecimals = 0
  for (let i = 0; i < n; i++) {
    const price = legPrices[i]
    const decimals = legDecimals[i]
    if (price == null || price <= 0n || decimals == null || !Number.isInteger(decimals) || decimals < 0) return null
    if (decimals > maxDecimals) maxDecimals = decimals
  }
  let numerator = 0n
  for (let i = 0; i < n; i++) {
    numerator += pool.reserves[i] * (legPrices[i] as bigint) * 10n ** BigInt(maxDecimals - (legDecimals[i] as number))
  }
  return (numerator * 10n ** BigInt(shareDecimals)) / (10n ** BigInt(maxDecimals) * pool.totalIssuance)
}

/**
 * Every pool's per-share price (null = unpriced), from one surface's own current
 * leg prices. `legPrice` is that surface's lookup for a NON-share asset (its own
 * aToken/duplicate alias rule included); a leg that is itself a share token
 * (`isShare`) is priced by this same derivation, recursively, so a share is never
 * aliased even as a leg. A share whose pool is absent from `pools` is absent from
 * the result — the caller states it unpriced.
 */
export function stableswapSharePrices(
  pools: Iterable<StableswapSharePool>,
  legPrice: (assetId: number) => bigint | null | undefined,
  decimalsOf: (assetId: number) => number | null | undefined,
  isShare: (assetId: number) => boolean = () => false,
): Map<number, bigint | null> {
  const byId = new Map<number, StableswapSharePool>()
  for (const pool of pools) byId.set(pool.poolId, pool)
  const out = new Map<number, bigint | null>()
  const inProgress = new Set<number>()
  const priceOfShare = (poolId: number): bigint | null => {
    if (out.has(poolId)) return out.get(poolId) ?? null
    const pool = byId.get(poolId)
    // A share leg whose pool is not in this state, or a cycle: unpriced.
    if (!pool || inProgress.has(poolId)) return null
    inProgress.add(poolId)
    const legPrices = pool.assetIds.map(id => (byId.has(id) || isShare(id) ? priceOfShare(id) : legPrice(id) ?? null))
    const shareDecimals = decimalsOf(poolId)
    const price = shareDecimals == null ? null : stableswapSharePriceScaled(pool, legPrices, pool.assetIds.map(decimalsOf), shareDecimals)
    inProgress.delete(poolId)
    out.set(poolId, price)
    return price
  }
  for (const poolId of byId.keys()) priceOfShare(poolId)
  return out
}

/**
 * A surface's current price map with every share token's entry REPLACED by its
 * derived per-share price: set where the pool prices, and removed where it does
 * not (an unpriced leg, no issuance, or a share whose pool the state does not
 * hold). Removed rather than kept, because what a share token's own feed or an
 * underlying's price says is not what the share redeems for. `pools` null means
 * the pool state could not be read at all: every share is then unpriced too.
 * Returns a new map; the input is not modified.
 */
export function withStableswapSharePrices(
  prices: ReadonlyMap<number, bigint>,
  pools: Iterable<StableswapSharePool> | null,
  legPrice: (assetId: number) => bigint | null | undefined,
  decimalsOf: (assetId: number) => number | null | undefined,
  isShare: (assetId: number) => boolean,
): Map<number, bigint> {
  const out = new Map(prices)
  const derived = pools ? stableswapSharePrices(pools, legPrice, decimalsOf, isShare) : new Map<number, bigint | null>()
  for (const id of [...out.keys()]) if (isShare(id) || derived.has(id)) out.delete(id)
  for (const [id, price] of derived) if (price != null) out.set(id, price)
  return out
}

// One Omnipool position economically owned at a historical bucket end: its state
// then and its asset's pool state then. `farmed`/`depositId` say how it was held
// (bare NFT or a liquidity-mining deposit) and ride through to the legs.
export interface HistoricalOwnedPosition {
  positionId: string
  assetId: number
  state: DecodedPosition
  pool: OmnipoolAssetState | undefined
  farmed?: boolean
  depositId?: string | null
}

export interface OmnipoolBucketLeg {
  positionId: string
  assetId: number
  liquidity: bigint
  hub: bigint
  shares: bigint
  farmed: boolean
  depositId: string | null
}

// Raw withdraw legs for the positions economically owned at a single historical
// bucket. Dedupes by positionId so a position is valued exactly once regardless of
// whether it is held bare or farmed (the first entry wins); a position with no pool
// state is never given a fabricated zero leg — it is counted in `unvalued` instead
// (held, but its legs cannot be stated) — and one with non-positive shares holds
// nothing. Raw integer legs — callers apply the bucket's price.
export interface OmnipoolBucket { legs: OmnipoolBucketLeg[]; unvalued: number }
export function omnipoolBucket(positions: HistoricalOwnedPosition[]): OmnipoolBucket {
  const legs: OmnipoolBucketLeg[] = []
  let unvalued = 0
  const seen = new Set<string>()
  for (const { positionId, assetId, state, pool, farmed, depositId } of positions) {
    if (seen.has(positionId)) continue
    seen.add(positionId)
    if (state.shares <= 0n) continue
    if (!pool) { unvalued++; continue }
    const { liquidity, hub } = omnipoolRemoveLiquidity(pool, state)
    legs.push({ positionId, assetId, liquidity, hub, shares: state.shares, farmed: farmed ?? false, depositId: depositId ?? null })
  }
  return { legs, unvalued }
}

/** The legs alone (omnipoolBucket without the count). */
export function omnipoolLegsForBucket(positions: HistoricalOwnedPosition[]): OmnipoolBucketLeg[] {
  return omnipoolBucket(positions).legs
}
