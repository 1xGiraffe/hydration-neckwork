import { z } from 'zod'
import { LP_VENUES, type LpVenue } from '../../services/lpHistory.ts'
import { zAssetId } from '../schemas/common.ts'

// One liquidity position, the same identity on /liquidity/positions (its current
// legs) and /liquidity/history (its legs per bucket). A client joins the two on
// (venue, positionId, poolKey, shareAssetId), adding `farmed` only where it
// splits one pool into two positions (XYK direct vs farm principal). For an
// Omnipool position `farmed` is not identity: history keeps one series per
// position NFT across bare↔farmed moves and states `farmed` as at its LAST held
// bucket, while /liquidity/positions states it now, so the two can differ for the
// same position.

export const zLpVenue = z.enum(LP_VENUES as [LpVenue, ...LpVenue[]])

export const zLpLeg = z.object({
  assetId: zAssetId,
  amount: z.string().describe('Raw integer units of assetId the position redeems to at the pool state the surface states it at (the snapshot block for current positions, the bucket end for history).'),
  valueUsd: z.string().nullable().describe('At the current price for current positions, at the bucket\'s closed candle for history; null when the asset has no usable price.'),
})

export const zLpPositionIdentity = z.object({
  venue: zLpVenue.describe("'uniswapv3' is a concentrated-liquidity position NFT held through a NonfungiblePositionManager; 'gamma' a Gamma Strategies vault share balance in such a pool."),
  farmed: z.boolean().describe('Held through a liquidity-mining deposit (Omnipool: collection-2584 deposit NFT; XYK: farm principal) rather than directly.'),
  positionId: z.string().nullable().describe('The Omnipool position NFT id, or a Uniswap v3 position\'s NFT token id; null for fungible pool shares.'),
  poolKey: z.string().describe("The venue's own pool key, as on the fill feeds: 'omnipool', a stableswap pool id, an XYK pool account, a Uniswap v3 pool contract (uniswapv3), a vault contract (gamma)."),
  shareAssetId: zAssetId.nullable().describe('The LP share token (a stableswap pool\'s share asset is its pool id; an XYK pool\'s its LP asset); null for an Omnipool or Uniswap v3 position and for a vault share the registry has not listed.'),
})

/**
 * One farm entry's reward (a liquidity-mining deposit in one yield farm), the same
 * identity on /liquidity/positions (claimable now) and /liquidity/history (settled
 * at a bucket end). Each route extends it with its own amount semantics.
 */
export const zLpRewardIdentity = z.object({
  depositId: z.string().describe('The liquidity-mining deposit (its deposit NFT id in collection 2584 for Omnipool, 5389 for XYK).'),
  globalFarmId: z.number().int(),
  yieldFarmId: z.number().int(),
  assetId: zAssetId.describe('The reward asset.'),
})
