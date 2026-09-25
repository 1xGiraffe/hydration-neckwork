// Aave v3 fixed-point arithmetic, ported bit-exact in BigInt: WadRayMath's ray
// operations, MathUtils' interest accrual, ReserveLogic's normalized income/debt and
// RewardsDistributor's per-holder incentive accrual. A pure leaf with no imports, shared by every
// surface that reconstructs a money-market balance or an incentive accrual from indexed
// events, so the chain's rounding is stated once.
//
// Rounding is Aave's own: rayMul and rayDiv round HALF-UP ((a·b + RAY/2) / RAY and
// (a·RAY + b/2) / b); interest and incentive terms truncate (Solidity integer division).
// Every input is a non-negative uint256 on chain; a negative argument is a caller bug and
// throws rather than rounding toward zero the wrong way.
//
// Timestamps are the EVM's block.timestamp, which is pallet_timestamp's `Now`: an EVM call
// in a block's Initialization phase (DCA and scheduled calls in on_initialize, whose logs
// carry no extrinsic index) runs before that block's Timestamp.set inherent and sees the
// PARENT block's timestamp; one in an extrinsic sees the block's own. A reserve's `tLast`
// is therefore the timestamp its last ReserveDataUpdated executed under, not always the
// timestamp of the block that emitted it — measured, taking the emitting block's for an
// Initialization-phase update misstates 9 of 72 archive balanceOf samples.

export const RAY = 10n ** 27n
export const HALF_RAY = RAY / 2n
export const SECONDS_PER_YEAR = 31_536_000n

function assertUint(name: string, value: bigint): void {
  if (value < 0n) throw new RangeError(`aaveMath: ${name} must be non-negative, got ${value}`)
}

/**
 * The CURRENT amount of a scaled balance at a reserve's settled (last emitted)
 * index: scaled · index / RAY, truncating, and 0 for a non-positive scaled
 * balance. The one current-value rule of every surface — the explorer's cards,
 * holders and directory, and the Data API's /balances and /money-market/positions.
 * It truncates where the chain's balanceOf rounds half-up (rayMul) on an index
 * compounded to the block; the history (reserveBalanceAt) states that exact figure.
 */
export function settledAmount(scaled: bigint, index: bigint): bigint {
  return scaled > 0n ? (scaled * index) / RAY : 0n
}

/** WadRayMath.rayMul: a·b / RAY, rounded half-up. */
export function rayMul(a: bigint, b: bigint): bigint {
  assertUint('a', a); assertUint('b', b)
  return (a * b + HALF_RAY) / RAY
}

/** WadRayMath.rayDiv: a·RAY / b, rounded half-up. What _mintScaled/_burnScaled apply to an amount. */
export function rayDiv(a: bigint, b: bigint): bigint {
  assertUint('a', a)
  if (b <= 0n) throw new RangeError('aaveMath: rayDiv by a non-positive divisor')
  return (a * RAY + b / 2n) / b
}

/** Seconds elapsed, clamped at zero (a timestamp at or before `from` accrues nothing). */
function elapsed(from: bigint, to: bigint): bigint {
  return to > from ? to - from : 0n
}

/**
 * MathUtils.calculateLinearInterest: RAY + rate·Δt / SECONDS_PER_YEAR — the supply side's
 * accrual factor between the reserve's last update and `t`. `rate` is the ray-scaled
 * annual liquidity rate.
 */
export function linearInterest(rate: bigint, tLast: bigint, t: bigint): bigint {
  assertUint('rate', rate)
  return RAY + (rate * elapsed(tLast, t)) / SECONDS_PER_YEAR
}

/**
 * MathUtils.calculateCompoundedInterest: the three-term binomial approximation of
 * (1 + rate/SECONDS_PER_YEAR)^Δt the debt side accrues by —
 *   RAY + rate·n/Y + n(n−1)·b²/2 + n(n−1)(n−2)·b³/6
 * with b² = rayMul(rate, rate)/Y² and b³ = rayMul(b², rate)/Y, each division truncating.
 */
export function compoundedInterest(rate: bigint, tLast: bigint, t: bigint): bigint {
  assertUint('rate', rate)
  const exp = elapsed(tLast, t)
  if (exp === 0n) return RAY
  const expMinusOne = exp - 1n
  const expMinusTwo = exp > 2n ? exp - 2n : 0n
  const basePowerTwo = rayMul(rate, rate) / (SECONDS_PER_YEAR * SECONDS_PER_YEAR)
  const basePowerThree = rayMul(basePowerTwo, rate) / SECONDS_PER_YEAR
  const secondTerm = (exp * expMinusOne * basePowerTwo) / 2n
  const thirdTerm = (exp * expMinusOne * expMinusTwo * basePowerThree) / 6n
  return RAY + (rate * exp) / SECONDS_PER_YEAR + secondTerm + thirdTerm
}

/**
 * ReserveLogic.getNormalizedIncome at time `t`: the stored liquidity index when the
 * reserve was updated at `t`, else the index compounded linearly from its last update.
 * An aToken's balanceOf is rayMul(scaledBalance, normalizedIncome).
 */
export function normalizedIncome(liquidityIndex: bigint, liquidityRate: bigint, tLast: bigint, t: bigint): bigint {
  assertUint('liquidityIndex', liquidityIndex)
  if (t === tLast) return liquidityIndex
  return rayMul(linearInterest(liquidityRate, tLast, t), liquidityIndex)
}

/**
 * ReserveLogic.getNormalizedDebt at time `t`: the stored variable-borrow index when the
 * reserve was updated at `t`, else the index compounded from its last update. A variable
 * debt token's balanceOf is rayMul(scaledBalance, normalizedDebt).
 */
export function normalizedDebt(variableBorrowIndex: bigint, variableBorrowRate: bigint, tLast: bigint, t: bigint): bigint {
  assertUint('variableBorrowIndex', variableBorrowIndex)
  if (t === tLast) return variableBorrowIndex
  return rayMul(compoundedInterest(variableBorrowRate, tLast, t), variableBorrowIndex)
}

/**
 * RewardsDistributor._getRewards: what a holder of `scaledBalance` accrues as the
 * programme's index moves from the holder's `userIndex` to `assetIndex`.
 */
export function incentivePending(scaledBalance: bigint, assetIndex: bigint, userIndex: bigint, assetUnit: bigint): bigint {
  assertUint('scaledBalance', scaledBalance)
  if (assetUnit <= 0n) throw new RangeError('aaveMath: assetUnit must be positive')
  if (assetIndex < userIndex) throw new RangeError('aaveMath: a reward index never decreases')
  return (scaledBalance * (assetIndex - userIndex)) / assetUnit
}
