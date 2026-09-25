// The liquidity-mining reward arithmetic of the node's warehouse pallet
// (`pallets/liquidity-mining`, instances OmnipoolWarehouseLM and XYKWarehouseLM,
// math in `math/src/liquidity_mining`), restated in bigint so an entry's
// claimable reward is computed to the unit the runtime would pay.
//
// FixedU128 is a u128 `inner` with 18 decimals (`FIXED_ONE` = 1.0). The rounding
// is the runtime's, and every step here floors where it floors:
//  - `checked_mul_int` (a fixed times an integer) floors;
//  - `checked_div` between two fixeds floors;
//  - `checked_mul` between two fixeds is used only in the loyalty numerator,
//    whose right operand is an integral scale coefficient, so its rounding
//    mode never shows (the product is exact).
// Any intermediate outside u128 is an error, as the pallet's checked ops are —
// a result the runtime would refuse is not a number to publish.
//
// A LEAF — no service imports, so the explorer, the refresher and the Data API
// can all take it.

export const FIXED_ONE = 10n ** 18n
const U128_MAX = (1n << 128n) - 1n

export class LmMathError extends Error {}

const u128 = (value: bigint, what: string): bigint => {
  if (value < 0n || value > U128_MAX) throw new LmMathError(`${what} outside u128`)
  return value
}

/** `FixedU128::checked_mul_int` — floor(fixed · n). */
export function fixedMulInt(fixed: bigint, n: bigint): bigint {
  return u128((fixed * n) / FIXED_ONE, 'checked_mul_int')
}

/** `FixedU128::checked_div` — floor(a / b). */
export function fixedDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new LmMathError('division by zero')
  return u128((a * FIXED_ONE) / b, 'checked_div')
}

/** `FixedU128::from(n)` — an integer as a fixed. */
export const fixedFromInt = (n: bigint | number): bigint => u128(BigInt(n) * FIXED_ONE, 'from')

export interface LoyaltyCurve {
  /** FixedU128 inner. */
  initialRewardPercentage: bigint
  scaleCoef: number
}

/**
 * `calculate_loyalty_multiplier`: (t + initial · scale) / (t + scale), t the
 * periods the entry has been rewarded for. No curve means no loyalty discount
 * (1.0). The pallet refuses a multiplier above 1 as inconsistent state.
 */
export function loyaltyMultiplier(periods: bigint | number, curve: LoyaltyCurve | null): bigint {
  if (!curve) return FIXED_ONE
  const t = fixedFromInt(periods)
  const scale = fixedFromInt(curve.scaleCoef)
  // initial · scale: the scale is integral, so this product is exact.
  const num = u128((curve.initialRewardPercentage * scale) / FIXED_ONE + t, 'loyalty numerator')
  const den = u128(t + scale, 'loyalty denominator')
  const m = fixedDiv(num, den)
  if (m > FIXED_ONE) throw new LmMathError('loyalty multiplier above 1')
  return m
}

/** `calculate_reward`: (rps_now − rps_start) · shares. */
export function rewardBetween(rpsStart: bigint, rpsNow: bigint, shares: bigint): bigint {
  if (rpsNow < rpsStart) throw new LmMathError('rps went backwards')
  return fixedMulInt(rpsNow - rpsStart, shares)
}

/**
 * `calculate_user_reward` → `(user_rewards, unclaimable_rewards)`: the gross
 * reward since entry at loyalty 1 (`max`), the loyalty share of it the entry
 * has earned, less what it has already claimed.
 */
export function userReward(
  entryRpvs: bigint, valuedShares: bigint, claimed: bigint, rpvsNow: bigint, loyalty: bigint,
): { userRewards: bigint; unclaimable: bigint; gross: bigint } {
  const gross = rewardBetween(entryRpvs, rpvsNow, valuedShares)
  if (gross === 0n) return { userRewards: 0n, unclaimable: 0n, gross }
  const earned = fixedMulInt(loyalty, gross)
  const unclaimable = gross - earned
  if (earned < claimed) throw new LmMathError('claimed more than earned')
  return { userRewards: earned - claimed, unclaimable, gross }
}

// ───────────────────────── farm state and an entry's reward ─────────────────────────

export type FarmState = 'active' | 'stopped' | 'terminated'

export interface GlobalFarmData {
  id: number
  updatedAt: number
  totalSharesZ: bigint
  accumulatedRpz: bigint
  rewardCurrency: number
  pendingRewards: bigint
  accumulatedPaidRewards: bigint
  /** Perquintill parts (1e18 = 100%), which is also its FixedU128 inner. */
  yieldPerPeriod: bigint
  blocksPerPeriod: number
  incentivizedAsset: number
  maxRewardPerPeriod: bigint
  priceAdjustment: bigint
  state: FarmState
}

export interface YieldFarmData {
  id: number
  updatedAt: number
  totalShares: bigint
  totalValuedShares: bigint
  accumulatedRpvs: bigint
  accumulatedRpz: bigint
  loyaltyCurve: LoyaltyCurve | null
  multiplier: bigint
  state: FarmState
  entriesCount: bigint
  leftToDistribute: bigint
  totalStopped: number
}

export interface FarmEntry {
  globalFarmId: number
  yieldFarmId: number
  valuedShares: bigint
  accumulatedRpvs: bigint
  accumulatedClaimedRewards: bigint
  enteredAt: number
  updatedAt: number
  stoppedAtCreation: number
}

/** `get_period_number`: the relay block number the runtime sees, floored by the farm's period length. */
export function periodOf(relayBlock: number, blocksPerPeriod: number): number {
  if (!Number.isInteger(blocksPerPeriod) || blocksPerPeriod <= 0) throw new LmMathError('invalid blocks per period')
  return Math.floor(relayBlock / blocksPerPeriod)
}

/**
 * The periods an entry has been rewarded for, as `claim_rewards` counts them:
 * yf.updated_at − entered_at, less the periods the yield farm spent STOPPED
 * since the entry was created (total_stopped − stopped_at_creation). The pallet
 * treats a negative result as inconsistent state.
 */
export function entryPeriods(entry: FarmEntry, yf: Pick<YieldFarmData, 'updatedAt' | 'totalStopped'>): number {
  const stoppedSince = yf.totalStopped - entry.stoppedAtCreation
  const periods = yf.updatedAt - entry.enteredAt - stoppedSince
  if (stoppedSince < 0 || yf.updatedAt < entry.enteredAt || periods < 0) throw new LmMathError('invalid entry period')
  return periods
}

export interface EntryReward {
  /** Periods counted toward loyalty. */
  periods: number
  /** FixedU128 inner of the loyalty multiplier. */
  loyalty: bigint
  /** What one `claim_rewards` would pay now: loyalty · gross − already claimed. */
  claimable: bigint
  /** The ceiling at full loyalty: gross − already claimed. */
  maxReward: bigint
  /**
   * gross − loyalty · gross: what leaving the farm now forfeits (withdraw_shares
   * claims `claimable` first and returns this to the global farm). A claim does
   * NOT forfeit it — a later claim pays loyalty(later) · gross(later) − claimed,
   * so claiming early loses nothing.
   */
  forfeitIfWithdrawnNow: bigint
}

/**
 * The entry's reward against a yield farm state (the stored one, or one synced
 * to the head by the runtime). A TERMINATED yield farm pays
 * nothing: `claim_rewards` refuses it (LiquidityMiningCanceled) and
 * `withdraw_shares` skips the claim.
 */
export function entryReward(entry: FarmEntry, yf: YieldFarmData, rpvsNow: bigint = yf.accumulatedRpvs): EntryReward {
  if (yf.state === 'terminated') return { periods: 0, loyalty: 0n, claimable: 0n, maxReward: 0n, forfeitIfWithdrawnNow: 0n }
  const periods = entryPeriods(entry, yf)
  const loyalty = loyaltyMultiplier(periods, yf.loyaltyCurve)
  const { userRewards, unclaimable, gross } = userReward(entry.accumulatedRpvs, entry.valuedShares, entry.accumulatedClaimedRewards, rpvsNow, loyalty)
  return { periods, loyalty, claimable: userRewards, maxReward: gross - entry.accumulatedClaimedRewards, forfeitIfWithdrawnNow: unclaimable }
}
