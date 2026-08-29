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

// Stableswap share redemption is pro-rata over every reserve (the proportional
// withdraw, which is peg-independent): amount_i = floor(reserve_i * shares / totalIssuance).
export function stableswapShareLegs(shares: bigint, reserves: bigint[], totalIssuance: bigint): bigint[] {
  if (totalIssuance <= 0n || shares <= 0n) return reserves.map(() => 0n)
  return reserves.map(reserve => (reserve * shares) / totalIssuance)
}
