// Exact Uniswap v3 swap arithmetic: a BigInt port of v3-core's TickMath,
// SqrtPriceMath, SwapMath, TickBitmap.nextInitializedTickWithinOneWord and the
// pool's swap loop (UniswapV3Pool.swap), integer for integer — every rounding
// direction, every 256-bit overflow branch that changes a result
// (getNextSqrtPriceFromAmount0RoundingUp's fallback), every revert a quote must
// respect ('SPL', 'AS', 'T', 'R', 'LS', 'LA'). Pinned by Uniswap's own published
// vectors (api/tests/uniswapV3Math.test.ts: the TickMath, SqrtPriceMath and
// SwapMath specs and all 240 cases of the pool swap snapshot) and by replaying
// every indexed Swap log of the live pools.
//
// A pure leaf: no client, no I/O. The pool's tick table is the initialised ticks
// (liquidityNet per tick, ascending) — on chain the tickBitmap + ticks mapping,
// here derived from the Mint/Burn-replayed range book (uniswapV3Ranges.ts). The
// bitmap's word structure matters for exactness, not just for gas: a step ends at
// the next initialised tick OR the edge of the 256-tick word, and every step
// rounds on its own, so the walk below stops where the contract stops.

export const MIN_TICK = -887272
export const MAX_TICK = 887272
export const MIN_SQRT_RATIO = 4295128739n
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n

const Q96 = 1n << 96n
const Q128 = 1n << 128n
const MAX_U256 = (1n << 256n) - 1n
const MAX_U160 = (1n << 160n) - 1n
const MAX_U128 = (1n << 128n) - 1n
const MAX_I256 = (1n << 255n) - 1n
const PIPS = 1_000_000n

/** A condition under which the contract reverts; `code` is its revert string where it has one. */
export class V3MathError extends Error {
  constructor(public readonly code: string) {
    super(`uniswap v3: ${code}`)
    this.name = 'V3MathError'
  }
}
const require_ = (cond: boolean, code: string): void => { if (!cond) throw new V3MathError(code) }

/* ───────────── FullMath / UnsafeMath ───────────── */

/** floor(a·b / d), reverting where FullMath would (d = 0, result ≥ 2^256). */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  require_(d > 0n, 'mulDiv: zero denominator')
  const r = (a * b) / d
  require_(r <= MAX_U256, 'mulDiv: overflow')
  return r
}

/** ceil(a·b / d), FullMath.mulDivRoundingUp. */
export function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  const r = mulDiv(a, b, d)
  if ((a * b) % d > 0n) {
    require_(r < MAX_U256, 'mulDiv: overflow')
    return r + 1n
  }
  return r
}

/** UnsafeMath.divRoundingUp: ceil(x / y) (division by zero is 0 in the EVM's `div`). */
const divRoundingUp = (x: bigint, y: bigint): bigint => (y === 0n ? 0n : x / y + (x % y > 0n ? 1n : 0n))

const toUint160 = (x: bigint): bigint => { require_(x <= MAX_U160, 'toUint160'); return x }

/* ───────────── TickMath ───────────── */

const TICK_FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
]

const sqrtRatioCache = new Map<number, bigint>()

/** sqrt(1.0001^tick) · 2^96, rounded up from Q128.128 (TickMath.getSqrtRatioAtTick). */
export function getSqrtRatioAtTick(tick: number): bigint {
  require_(Number.isInteger(tick) && Math.abs(tick) <= MAX_TICK, 'T')
  const hit = sqrtRatioCache.get(tick)
  if (hit !== undefined) return hit
  const abs = Math.abs(tick)
  let ratio = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n
  for (const [bit, factor] of TICK_FACTORS) if (abs & bit) ratio = (ratio * factor) >> 128n
  if (tick > 0) ratio = MAX_U256 / ratio
  const out = (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
  if (sqrtRatioCache.size > 100_000) sqrtRatioCache.clear()
  sqrtRatioCache.set(tick, out)
  return out
}

/** The greatest tick whose ratio is ≤ sqrtPriceX96 (TickMath.getTickAtSqrtRatio, the log-2 approximation included). */
export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  require_(sqrtPriceX96 >= MIN_SQRT_RATIO && sqrtPriceX96 < MAX_SQRT_RATIO, 'R')
  const ratio = sqrtPriceX96 << 32n
  let r = ratio
  let msb = 0n
  for (const [shift, bound] of [[7n, MAX_U128], [6n, 0xffffffffffffffffn], [5n, 0xffffffffn], [4n, 0xffffn], [3n, 0xffn], [2n, 0xfn], [1n, 0x3n]] as const) {
    const f = r > bound ? 1n << shift : 0n
    msb |= f
    r >>= f
  }
  if (r > 1n) msb |= 1n
  r = msb >= 128n ? ratio >> (msb - 127n) : ratio << (127n - msb)
  let log2 = (msb - 128n) << 64n
  for (let bit = 63n; bit >= 50n; bit--) {
    r = (r * r) >> 127n
    const f = r >> 128n
    log2 |= f << bit
    r >>= f
  }
  const logSqrt10001 = log2 * 255738958999603826347141n
  const tickLow = Number((logSqrt10001 - 3402992956809132418596140100660247210n) >> 128n)
  const tickHi = Number((logSqrt10001 + 291339464771989622907027621153398088495n) >> 128n)
  return tickLow === tickHi ? tickLow : getSqrtRatioAtTick(tickHi) <= sqrtPriceX96 ? tickHi : tickLow
}

/* ───────────── SqrtPriceMath ───────────── */

function nextSqrtPriceFromAmount0RoundingUp(sqrtPX96: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtPX96
  const numerator1 = liquidity << 96n
  const product = amount * sqrtPX96
  // The contract multiplies in 256 bits: when the product wraps (or the sum does),
  // it falls back to a coarser formula whose result differs — so must this.
  const productFits = product <= MAX_U256
  if (add) {
    if (productFits) {
      const denominator = numerator1 + product
      if (denominator <= MAX_U256) return mulDivRoundingUp(numerator1, sqrtPX96, denominator)
    }
    const d = numerator1 / sqrtPX96 + amount
    require_(d <= MAX_U256, 'add overflow')
    return divRoundingUp(numerator1, d)
  }
  require_(productFits && numerator1 > product, 'sqrtPrice: amount0 out')
  return toUint160(mulDivRoundingUp(numerator1, sqrtPX96, numerator1 - product))
}

function nextSqrtPriceFromAmount1RoundingDown(sqrtPX96: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (add) {
    const quotient = amount <= MAX_U160 ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity)
    return toUint160(sqrtPX96 + quotient)
  }
  const quotient = amount <= MAX_U160 ? divRoundingUp(amount << 96n, liquidity) : mulDivRoundingUp(amount, Q96, liquidity)
  require_(sqrtPX96 > quotient, 'sqrtPrice: amount1 out')
  return sqrtPX96 - quotient
}

/** The sqrt price after adding `amountIn` of the input token (SqrtPriceMath.getNextSqrtPriceFromInput). */
export function getNextSqrtPriceFromInput(sqrtPX96: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  require_(sqrtPX96 > 0n && liquidity > 0n, 'sqrtPrice: input')
  return zeroForOne
    ? nextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
    : nextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true)
}

/** The sqrt price after removing `amountOut` of the output token (SqrtPriceMath.getNextSqrtPriceFromOutput). */
export function getNextSqrtPriceFromOutput(sqrtPX96: bigint, liquidity: bigint, amountOut: bigint, zeroForOne: boolean): bigint {
  require_(sqrtPX96 > 0n && liquidity > 0n, 'sqrtPrice: output')
  return zeroForOne
    ? nextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
    : nextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false)
}

/** token0 between two sqrt prices for `liquidity` (SqrtPriceMath.getAmount0Delta, unsigned). */
export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA]
  const numerator1 = liquidity << 96n
  const numerator2 = sqrtB - sqrtA
  require_(sqrtA > 0n, 'amount0: zero price')
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA)
    : mulDiv(numerator1, numerator2, sqrtB) / sqrtA
}

/** token1 between two sqrt prices for `liquidity` (SqrtPriceMath.getAmount1Delta, unsigned). */
export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA]
  return roundUp ? mulDivRoundingUp(liquidity, sqrtB - sqrtA, Q96) : mulDiv(liquidity, sqrtB - sqrtA, Q96)
}

/** The signed form a mint/burn settles with: rounded up for liquidity added, down for removed. */
export function getAmount0DeltaSigned(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return liquidity < 0n ? -getAmount0Delta(sqrtA, sqrtB, -liquidity, false) : getAmount0Delta(sqrtA, sqrtB, liquidity, true)
}
export function getAmount1DeltaSigned(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return liquidity < 0n ? -getAmount1Delta(sqrtA, sqrtB, -liquidity, false) : getAmount1Delta(sqrtA, sqrtB, liquidity, true)
}

/* ───────────── SwapMath ───────────── */

export interface SwapStep { sqrtRatioNextX96: bigint; amountIn: bigint; amountOut: bigint; feeAmount: bigint }

/** One step of a swap toward `sqrtTarget` (SwapMath.computeSwapStep; `amountRemaining` > 0 exact in, < 0 exact out). */
export function computeSwapStep(sqrtCurrent: bigint, sqrtTarget: bigint, liquidity: bigint, amountRemaining: bigint, feePips: number): SwapStep {
  const fee = BigInt(feePips)
  const zeroForOne = sqrtCurrent >= sqrtTarget
  const exactIn = amountRemaining >= 0n
  let next: bigint
  let amountIn = 0n
  let amountOut = 0n
  if (exactIn) {
    const lessFee = mulDiv(amountRemaining, PIPS - fee, PIPS)
    amountIn = zeroForOne
      ? getAmount0Delta(sqrtTarget, sqrtCurrent, liquidity, true)
      : getAmount1Delta(sqrtCurrent, sqrtTarget, liquidity, true)
    next = lessFee >= amountIn ? sqrtTarget : getNextSqrtPriceFromInput(sqrtCurrent, liquidity, lessFee, zeroForOne)
  } else {
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtTarget, sqrtCurrent, liquidity, false)
      : getAmount0Delta(sqrtCurrent, sqrtTarget, liquidity, false)
    next = -amountRemaining >= amountOut ? sqrtTarget : getNextSqrtPriceFromOutput(sqrtCurrent, liquidity, -amountRemaining, zeroForOne)
  }
  const max = sqrtTarget === next
  if (zeroForOne) {
    amountIn = max && exactIn ? amountIn : getAmount0Delta(next, sqrtCurrent, liquidity, true)
    amountOut = max && !exactIn ? amountOut : getAmount1Delta(next, sqrtCurrent, liquidity, false)
  } else {
    amountIn = max && exactIn ? amountIn : getAmount1Delta(sqrtCurrent, next, liquidity, true)
    amountOut = max && !exactIn ? amountOut : getAmount0Delta(sqrtCurrent, next, liquidity, false)
  }
  if (!exactIn && amountOut > -amountRemaining) amountOut = -amountRemaining
  const feeAmount = exactIn && next !== sqrtTarget ? amountRemaining - amountIn : mulDivRoundingUp(amountIn, fee, PIPS - fee)
  return { sqrtRatioNextX96: next, amountIn, amountOut, feeAmount }
}

/* ───────────── TickBitmap ───────────── */

/** An initialised tick: the net liquidity a crossing upward adds. */
export interface V3TickNet { tick: number; liquidityNet: bigint }

/** Index of the last entry with tick ≤ t, or −1. */
function floorIndex(ticks: readonly V3TickNet[], t: number): number {
  let lo = 0, hi = ticks.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (ticks[mid]!.tick <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

/**
 * The next initialised tick at or below (lte) / above the tick, or the edge of
 * its 256-tick bitmap word when the word holds none (TickBitmap.nextInitializedTickWithinOneWord).
 * `ticks` ascending, each a multiple of `tickSpacing`.
 */
export function nextInitializedTickWithinOneWord(ticks: readonly V3TickNet[], tick: number, tickSpacing: number, lte: boolean): [number, boolean] {
  const compressed = Math.floor(tick / tickSpacing)
  if (lte) {
    const wordStart = (compressed >> 8) << 8
    const i = floorIndex(ticks, compressed * tickSpacing)
    const c = i >= 0 ? Math.floor(ticks[i]!.tick / tickSpacing) : null
    return c != null && c >= wordStart ? [c * tickSpacing, true] : [wordStart * tickSpacing, false]
  }
  const start = compressed + 1
  const wordEnd = ((start >> 8) << 8) + 255
  const i = floorIndex(ticks, start * tickSpacing - 1) + 1
  const c = i < ticks.length ? Math.floor(ticks[i]!.tick / tickSpacing) : null
  return c != null && c <= wordEnd ? [c * tickSpacing, true] : [wordEnd * tickSpacing, false]
}

/* ───────────── the swap loop ───────────── */

/** A pool's swap-relevant state: slot0, the active liquidity, its fee tier and tick spacing, and the tick table. */
export interface V3SwapPool {
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  /** Fee tier in hundredths of a bip (ppm), the pool's `fee()`. */
  fee: number
  tickSpacing: number
  /** Initialised ticks, ascending by tick. */
  ticks: readonly V3TickNet[]
  /** slot0.feeProtocol (token0's divisor in the low nibble, token1's in the high); only the fee growth reads it. */
  feeProtocol?: number
}

export interface V3SwapResult {
  /** Pool balance deltas, as the Swap log states them: positive = paid into the pool. */
  amount0: bigint
  amount1: bigint
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  /** Fee growth added to the input token's feeGrowthGlobalX128 (mod 2^256), and the protocol's share. */
  feeGrowthX128: bigint
  protocolFee: bigint
  /** Ticks crossed. */
  crossed: number
}

/**
 * UniswapV3Pool.swap: `amountSpecified` > 0 sells exactly that much of the input
 * token, < 0 buys exactly that much of the output; `sqrtPriceLimitX96` defaults to
 * the router's open limit (MIN + 1 / MAX − 1). Throws V3MathError where the pool
 * reverts.
 */
export function v3Swap(pool: V3SwapPool, zeroForOne: boolean, amountSpecified: bigint, sqrtPriceLimitX96?: bigint): V3SwapResult {
  require_(amountSpecified !== 0n, 'AS')
  const limit = sqrtPriceLimitX96 ?? (zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n)
  require_(zeroForOne
    ? limit < pool.sqrtPriceX96 && limit > MIN_SQRT_RATIO
    : limit > pool.sqrtPriceX96 && limit < MAX_SQRT_RATIO, 'SPL')
  const feeProtocol = BigInt(zeroForOne ? (pool.feeProtocol ?? 0) % 16 : (pool.feeProtocol ?? 0) >> 4)
  const exactInput = amountSpecified > 0n
  let remaining = amountSpecified
  let calculated = 0n
  let sqrtP = pool.sqrtPriceX96
  let tick = pool.tick
  let liquidity = pool.liquidity
  let feeGrowth = 0n
  let protocolFee = 0n
  let crossed = 0
  const netAt = new Map(pool.ticks.map(t => [t.tick, t.liquidityNet]))
  while (remaining !== 0n && sqrtP !== limit) {
    const start = sqrtP
    let [tickNext, initialized] = nextInitializedTickWithinOneWord(pool.ticks, tick, pool.tickSpacing, zeroForOne)
    if (tickNext < MIN_TICK) tickNext = MIN_TICK
    else if (tickNext > MAX_TICK) tickNext = MAX_TICK
    const sqrtNext = getSqrtRatioAtTick(tickNext)
    const target = (zeroForOne ? sqrtNext < limit : sqrtNext > limit) ? limit : sqrtNext
    const step = computeSwapStep(sqrtP, target, liquidity, remaining, pool.fee)
    sqrtP = step.sqrtRatioNextX96
    const paid = step.amountIn + step.feeAmount
    require_(paid <= MAX_I256 && step.amountOut <= MAX_I256, 'toInt256')
    if (exactInput) {
      remaining -= paid
      calculated -= step.amountOut
    } else {
      remaining += step.amountOut
      calculated += paid
    }
    let lpFee = step.feeAmount
    if (feeProtocol > 0n) {
      const delta = lpFee / feeProtocol
      lpFee -= delta
      protocolFee += delta
    }
    if (liquidity > 0n) feeGrowth = (feeGrowth + mulDiv(lpFee, Q128, liquidity)) & MAX_U256
    if (sqrtP === sqrtNext) {
      if (initialized) {
        const net = netAt.get(tickNext) ?? 0n
        liquidity += zeroForOne ? -net : net
        require_(liquidity >= 0n, zeroForOne ? 'LS' : 'LA')
        require_(liquidity <= MAX_U128, 'LA')
        crossed++
      }
      tick = zeroForOne ? tickNext - 1 : tickNext
    } else if (sqrtP !== start) {
      tick = getTickAtSqrtRatio(sqrtP)
    }
  }
  const [amount0, amount1] = zeroForOne === exactInput
    ? [amountSpecified - remaining, calculated]
    : [calculated, amountSpecified - remaining]
  return { amount0, amount1, sqrtPriceX96: sqrtP, tick, liquidity, feeGrowthX128: feeGrowth, protocolFee, crossed }
}

/**
 * What selling exactly `amountIn` of the input token returns (fee included), and
 * the pool state after; null where the pool would revert. A trade that the pool's
 * liquidity cannot fill in full stops at the price bound and returns what it got
 * (`filled` false), as the pool does with an open limit.
 */
export function v3QuoteExactIn(pool: V3SwapPool, zeroForOne: boolean, amountIn: bigint): { amountOut: bigint; filled: boolean; after: V3SwapResult } | null {
  if (amountIn <= 0n) return null
  try {
    const r = v3Swap(pool, zeroForOne, amountIn)
    const spent = zeroForOne ? r.amount0 : r.amount1
    return { amountOut: -(zeroForOne ? r.amount1 : r.amount0), filled: spent === amountIn, after: r }
  } catch (e) {
    if (e instanceof V3MathError) return null
    throw e
  }
}

/** The initialised-tick table of an open-range set (Mint − Burn per range): liquidityNet per boundary, ascending. */
export function tickTableFromRanges(ranges: Iterable<{ tickLower: number; tickUpper: number; net: bigint }>): V3TickNet[] {
  const net = new Map<number, bigint>()
  const gross = new Map<number, bigint>()
  for (const r of ranges) {
    if (r.net <= 0n) continue
    net.set(r.tickLower, (net.get(r.tickLower) ?? 0n) + r.net)
    net.set(r.tickUpper, (net.get(r.tickUpper) ?? 0n) - r.net)
    gross.set(r.tickLower, (gross.get(r.tickLower) ?? 0n) + r.net)
    gross.set(r.tickUpper, (gross.get(r.tickUpper) ?? 0n) + r.net)
  }
  return [...gross.entries()].filter(([, g]) => g > 0n).map(([tick]) => ({ tick, liquidityNet: net.get(tick)! })).sort((a, b) => a.tick - b.tick)
}
