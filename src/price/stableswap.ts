import { calculate_spot_price_with_fee } from '@galacticcouncil/math-stableswap'
import type { StableswapPool, AssetDecimals } from './types.ts'

const SPOT_PRICE_SCALE = 10n ** 12n
const PACKAGE_SPOT_SCALE = 10n ** 18n

function jsonBigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

function serializePoolReserves(pool: StableswapPool, decimals: AssetDecimals): string {
  const reserves = pool.assets.map((assetId, index) => ({
    asset_id: assetId,
    amount: pool.reserves[index],
    decimals: decimals.get(assetId) ?? 12,
  }))

  return JSON.stringify(reserves, jsonBigintReplacer)
}

function serializePoolPegs(pool: StableswapPool): string {
  const pegs = (pool.pegMultipliers ?? pool.assets.map(() => [1n, 1n] as [bigint, bigint]))
    .map(([num, den]) => [num.toString(), den.toString()])
  return JSON.stringify(pegs)
}

/**
 * Calculate spot price of assetIn in terms of assetOut
 *
 * Delegates the runtime-compatible curve and peg math to the official package.
 *
 * @param pool - Stableswap pool
 * @param assetInIndex - Index of input asset in pool.assets
 * @param assetOutIndex - Index of output asset in pool.assets
 * @param decimals - Decimal counts for all assets
 * @returns Spot price scaled to 10^12 precision (price per whole unit)
 */
export function calculateSpotPrice(
  pool: StableswapPool,
  assetInIndex: number,
  assetOutIndex: number,
  decimals: AssetDecimals
): bigint {
  const assetInId = pool.assets[assetInIndex]
  const assetOutId = pool.assets[assetOutIndex]

  try {
    const rawSpot = BigInt(calculate_spot_price_with_fee(
      pool.poolId.toString(),
      serializePoolReserves(pool, decimals),
      pool.amplification.toString(),
      assetInId.toString(),
      assetOutId.toString(),
      (pool.totalIssuance ?? 1n).toString(),
      '0',
      serializePoolPegs(pool),
    ))

    if (rawSpot <= 0n) {
      return 0n
    }

    return rawSpot / (PACKAGE_SPOT_SCALE / SPOT_PRICE_SCALE)
  } catch {
    return 0n
  }
}
