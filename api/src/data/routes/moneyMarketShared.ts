import { z } from 'zod'
import { zAssetId, zIsoTimestamp } from '../schemas/common.ts'

// One money-market entity, one wire shape (AGENTS "One wire shape per entity"):
// the chain's getUserAccountData figures as /money-market publishes them per pool,
// as /money-market/positions carries them per market, and as /money-market/history
// carries them per market and bucket; a market reference; a reserve leg. The
// routes extend these rather than restating them.

/** getUserAccountData's six figures, as the chain reported them. */
export const zMmAccountDataFields = {
  totalCollateralBase: z.string(),
  totalDebtBase: z.string(),
  availableBorrowsBase: z.string(),
  liquidationThreshold: z.string(),
  ltv: z.string(),
  healthFactor: z.string().describe('1e18-scaled; the max-uint sentinel means "no debt".'),
}

/** /money-market's per-pool position (its original shape, unchanged). */
export const zMmPosition = z.object({
  poolAddress: z.string(),
  marketKey: z.string().nullable().describe("'core' (primary), 'gigahdx', 'bil', … Markets are ISOLATED: never combine health factors or totals across pools."),
  ...zMmAccountDataFields,
  blockHeight: z.number().int(),
  timestamp: zIsoTimestamp,
})

export const zMmObservation = z.object({
  observedAtBlock: z.number().int().describe('The block the chain\'s getUserAccountData was read at — an event-driven read after the account\'s own money-market event, or the periodic re-read every borrower gets (typically every ~9–10k blocks). It is the figure AS OBSERVED there, never recomputed for a later block.'),
  timestamp: zIsoTimestamp.nullable().describe('That block\'s time.'),
  ...zMmAccountDataFields,
}).describe('The chain\'s own aggregate for this account in this market (base-currency units as the pool reports them, 1e8 = 1 USD on these markets; ltv and liquidationThreshold in basis points). Per market: health factors are never blended across markets.')

export const zMmMarketRef = z.object({
  marketKey: z.string().describe("The isolated market: 'core' (primary), 'gigahdx', 'bil', … — per market, not a closed list."),
  poolAddress: z.string().describe('The market\'s Pool proxy contract.'),
  stakingBacked: z.boolean().describe('true for a market whose collateral a staking pallet backs with HDX that stays locked in the owner\'s wallet (GIGAHDX): its supplied side restates that HDX, so the Explorer leaves it out of account value. A client summing value filters on this.'),
})

export const zMmReserveIdentity = z.object({
  assetId: zAssetId.describe('The reserve\'s underlying registry asset; `supplied` and `borrowed` are in its raw units.'),
  reserveAddress: z.string().describe('The reserve\'s asset address in the pool (the ERC-20 precompile of assetId, or a deployed token such as HOLLAR).'),
  aTokenAssetId: zAssetId.nullable().describe('The registry asset a supply of this reserve is held as (aDOT for DOT), when the registry lists one.'),
})

/** One unclaimed lending-incentive amount at a bucket end (history), per reward asset, under its market. */
export const zMmRewardPoint = z.object({
  assetId: zAssetId.describe('The reward asset; `amount` is in its raw units.'),
  amount: z.string().describe('What claimAllRewards would have paid at the bucket end, SETTLED: the RewardsController\'s stored accrual (the chain\'s value at B0 plus every indexed Accrued less every RewardsClaimed) plus each incentivized aToken\'s pending accrual up to the programme\'s last on-chain index update at or before `blockHeight`, summed over the account\'s holders.'),
  valueUsd: z.string().nullable().describe('At the reward asset\'s closed candle, 2 decimals; null when unpriced (counted in the account point\'s `rewardsIncomplete`).'),
  settledAtBlock: z.number().int().nullable().describe('The newest programme index update the pending part is settled at; null when nothing is pending (the whole amount is the stored accrual).'),
})

/** One claimable lending-incentive amount now (current positions), per reward asset, under its market. */
export const zMmRewardCurrent = z.object({
  assetId: zAssetId.describe('The reward asset; `amount` is in its raw units.'),
  amount: z.string().describe('The chain\'s own RewardsController.getAllUserRewards at `rewardsAsOfBlock` over this market\'s incentivized aTokens: what one claimAllRewards would pay then (stored accrual plus every incentivized aToken\'s pending accrual to that block), less any RewardsClaimed indexed since (floored at zero).'),
  valueUsd: z.string().nullable().describe('At the current price, 2 decimals; null when unpriced (then in no total).'),
  reconciled: z.boolean().describe('Whether the indexed log arithmetic (the chain\'s accrual at B0 plus every Accrued less every RewardsClaimed, plus scaled balance × index difference per aToken) reproduces `amount` to the unit. false means an indexed log or balance gap for this account: the amount is still the chain\'s, but /money-market/history cannot state this reward and counts it in `rewardsIncomplete`.'),
  belowExistentialDeposit: z.boolean().describe('0 < amount < the reward asset\'s existential deposit: a claimAllRewards including it reverts until the account holds that deposit of the asset or the amount grows past it. It is owed, not forfeited, and still counted.'),
  legs: z.array(z.object({
    aTokenAddress: z.string().describe('The incentivized aToken contract.'),
    aTokenAssetId: zAssetId.nullable().describe('Its registry asset, when the registry lists one.'),
    pending: z.string().describe('The log arithmetic\'s pending accrual on this aToken (scaled balance × (programme index at `rewardsAsOfBlock` − the account\'s index) / 10^decimals), raw units of the reward. Informative: `amount` is the chain\'s total, and the stored accrual part is per reward, not per aToken.'),
  })).describe('The incentivized aTokens the account holds, with the arithmetic\'s pending part of each.'),
})
