// Raw on-chain amount → USD, in one place.
//
// Five services carried a byte-identical copy of these four lines
// (explorerService's `usdValue`, plus securityService, poolService,
// hollarService and wormholeNttService), which is how one of them ends up
// rounding, guarding or aliasing differently from the surface it links to.
//
// Deliberately a LEAF: it takes the price map structurally rather than importing
// explorerService's `PriceInfo`, so the public and data trees can reach it
// without dragging the explorer in.

/** The one field a valuation reads; explorerService's `PriceInfo` satisfies it. */
export interface AssetPrice { price: number }

/**
 * Value `raw` (an amount in the asset's smallest unit) at `price`.
 *
 * Null when there is no price, or when the amount does not survive the
 * conversion to a JS number — an unpriceable amount must read as UNKNOWN, never
 * as $0.
 *
 * HAZARD, inherited from the call sites this replaces: `Number('')` is 0, not
 * NaN, so an EMPTY amount values as $0 rather than as unknown. A caller whose
 * source can carry a blank amount (Omnipool's null-extrinsic liquidity rows, for
 * one) has to reject it before getting here.
 */
export function usdAtPrice(price: number | null | undefined, raw: bigint | string | null | undefined, decimals: number): number | null {
  if (price == null || raw == null) return null
  const amount = Number(raw) / 10 ** decimals
  return Number.isFinite(amount) ? amount * price : null
}

/** `usdAtPrice` against a price map, keyed by asset id. */
export function usdOfRaw(
  prices: ReadonlyMap<number, AssetPrice>,
  assetId: number,
  raw: bigint | string | null | undefined,
  decimals: number,
): number | null {
  return usdAtPrice(prices.get(assetId)?.price, raw, decimals)
}
