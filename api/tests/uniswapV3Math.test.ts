import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  computeSwapStep,
  getAmount0Delta,
  getAmount0DeltaSigned,
  getAmount1Delta,
  getAmount1DeltaSigned,
  getNextSqrtPriceFromInput,
  getNextSqrtPriceFromOutput,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  nextInitializedTickWithinOneWord,
  tickTableFromRanges,
  v3Swap,
  V3MathError,
} from '../src/services/uniswapV3Math.ts'

// The exact Uniswap v3 port (services/uniswapV3Math.ts) against Uniswap's own
// published vectors: v3-core's TickMath / SqrtPriceMath / SwapMath specs and their
// snapshots, and every case of the pool swap snapshot (UniswapV3Pool.swaps.spec.ts),
// transcribed into tests/fixtures/uniswapV3PoolSwaps.json.

const E18 = 10n ** 18n
const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n
  let x = n, y = (x + 1n) / 2n
  while (y < x) { x = y; y = (x + n / x) / 2n }
  return x
}
/**
 * v3-core's encodePriceSqrt(reserve1, reserve0): bignumber.js at 40 decimal places,
 * half-up — the quotient and its root each rounded to 40 places — then floor(x · 2^96).
 * The rounding is part of the vector: 1 / 2^127 keeps two significant digits.
 */
const D40 = 10n ** 40n
const encodePriceSqrt = (r1: bigint | number, r0: bigint | number) => {
  const n = BigInt(r1) * D40, d = BigInt(r0)
  const x = ((2n * n + d) / (2n * d)) * D40
  let s = isqrt(x)
  if ((2n * s + 1n) ** 2n <= 4n * x) s++
  return (s << 96n) / D40
}

describe('TickMath', () => {
  it('matches the spec at the bounds', () => {
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(4295128739n)
    expect(getSqrtRatioAtTick(MIN_TICK + 1)).toBe(4295343490n)
    expect(getSqrtRatioAtTick(MAX_TICK - 1)).toBe(1461373636630004318706518188784493106690254656249n)
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(1461446703485210103287273052203988822378723970342n)
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO)
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO)
    expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow(V3MathError)
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(V3MathError)
  })

  it('matches the getSqrtRatioAtTick snapshot', () => {
    const snap: Record<number, string> = {
      [-50]: '79030349367926598376800521322', [-100]: '78833030112140176575862854579', [-250]: '78244023372248365697264290337',
      [-500]: '77272108795590369356373805297', [-1000]: '75364347830767020784054125655', [-2500]: '69919044979842180277688105136',
      [-3000]: '68192822843687888778582228483', [-4000]: '64867181785621769311890333195', [-5000]: '61703726247759831737814779831',
      [-50000]: '6504256538020985011912221507', [-150000]: '43836292794701720435367485', [-250000]: '295440463448801648376846',
      [-500000]: '1101692437043807371', [-738203]: '7409801140451',
      50: '79426470787362580746886972461', 100: '79625275426524748796330556128', 250: '80224679980005306637834519095',
      500: '81233731461783161732293370115', 1000: '83290069058676223003182343270', 2500: '89776708723587163891445672585',
      3000: '92049301871182272007977902845', 4000: '96768528593268422080558758223', 5000: '101729702841318637793976746270',
      50000: '965075977353221155028623082916', 150000: '143194173941309278083010301478497', 250000: '21246587762933397357449903968194344',
      500000: '5697689776495288729098254600827762987878', 738203: '847134979253254120489401328389043031315994541',
    }
    for (const [tick, ratio] of Object.entries(snap)) expect(getSqrtRatioAtTick(Number(tick)).toString(), `tick ${tick}`).toBe(ratio)
  })

  it('matches the getTickAtSqrtRatio snapshot and brackets the ratio', () => {
    const snap: Array<[bigint, number]> = [
      [MIN_SQRT_RATIO, -887272], [79228162514264337593543n, -276325], [79228162514264337593543950n, -138163],
      [9903520314283042199192993792n, -41591], [28011385487393069959365969113n, -20796], [56022770974786139918731938227n, -6932],
      [79228162514264337593543950336n, 0], [112045541949572279837463876454n, 6931], [224091083899144559674927752909n, 20795],
      [633825300114114700748351602688n, 41590], [79228162514264337593543950336000n, 138162],
      [79228162514264337593543950336000000n, 276324], [MAX_SQRT_RATIO - 1n, 887271],
      [4295343490n, MIN_TICK + 1], [1461373636630004318706518188784493106690254656249n, MAX_TICK - 1],
    ]
    for (const [ratio, tick] of snap) {
      expect(getTickAtSqrtRatio(ratio), `ratio ${ratio}`).toBe(tick)
      expect(getSqrtRatioAtTick(tick) <= ratio).toBe(true)
      if (tick < MAX_TICK) expect(getSqrtRatioAtTick(tick + 1) > ratio).toBe(true)
    }
    expect(() => getTickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).toThrow(V3MathError)
    expect(() => getTickAtSqrtRatio(MAX_SQRT_RATIO)).toThrow(V3MathError)
  })

  it('inverts getSqrtRatioAtTick at and just below every sampled tick', () => {
    for (let t = MIN_TICK; t <= MAX_TICK; t += 9973) {
      const r = getSqrtRatioAtTick(t)
      expect(getTickAtSqrtRatio(r)).toBe(t)
      if (t > MIN_TICK) expect(getTickAtSqrtRatio(r - 1n)).toBe(t - 1)
    }
  })
})

describe('SqrtPriceMath', () => {
  const one = encodePriceSqrt(1, 1)
  it('getNextSqrtPriceFromInput', () => {
    expect(() => getNextSqrtPriceFromInput(0n, 0n, E18 / 10n, false)).toThrow(V3MathError)
    expect(() => getNextSqrtPriceFromInput(1n, 0n, E18 / 10n, true)).toThrow(V3MathError)
    expect(() => getNextSqrtPriceFromInput((1n << 160n) - 1n, 1024n, 1024n, false)).toThrow(V3MathError)
    expect(getNextSqrtPriceFromInput(1n, 1n, 1n << 255n, true)).toBe(1n)
    expect(getNextSqrtPriceFromInput(one, E18 / 10n, 0n, true)).toBe(one)
    expect(getNextSqrtPriceFromInput(one, E18 / 10n, 0n, false)).toBe(one)
    const maxU128 = (1n << 128n) - 1n, sqrtP = (1n << 160n) - 1n
    expect(getNextSqrtPriceFromInput(sqrtP, maxU128, (1n << 256n) - 1n - (maxU128 << 96n) / sqrtP, true)).toBe(1n)
    expect(getNextSqrtPriceFromInput(one, E18, E18 / 10n, false)).toBe(87150978765690771352898345369n)
    expect(getNextSqrtPriceFromInput(one, E18, E18 / 10n, true)).toBe(72025602285694852357767227579n)
    expect(getNextSqrtPriceFromInput(one, 10n * E18, 1n << 100n, true)).toBe(624999999995069620n)
    expect(getNextSqrtPriceFromInput(one, 1n, ((1n << 256n) - 1n) / 2n, true)).toBe(1n)
  })

  it('getNextSqrtPriceFromOutput', () => {
    const p = 20282409603651670423947251286016n
    expect(() => getNextSqrtPriceFromOutput(0n, 0n, E18 / 10n, false)).toThrow(V3MathError)
    expect(() => getNextSqrtPriceFromOutput(1n, 0n, E18 / 10n, true)).toThrow(V3MathError)
    expect(() => getNextSqrtPriceFromOutput(p, 1024n, 4n, false)).toThrow(V3MathError)
    expect(() => getNextSqrtPriceFromOutput(p, 1024n, 5n, false)).toThrow(V3MathError)
    expect(() => getNextSqrtPriceFromOutput(p, 1024n, 262145n, true)).toThrow(V3MathError)
    expect(() => getNextSqrtPriceFromOutput(p, 1024n, 262144n, true)).toThrow(V3MathError)
    expect(getNextSqrtPriceFromOutput(p, 1024n, 262143n, true)).toBe(77371252455336267181195264n)
    expect(getNextSqrtPriceFromOutput(one, E18 / 10n, 0n, true)).toBe(one)
    expect(getNextSqrtPriceFromOutput(one, E18, E18 / 10n, false)).toBe(88031291682515930659493278152n)
    expect(getNextSqrtPriceFromOutput(one, E18, E18 / 10n, true)).toBe(71305346262837903834189555302n)
    expect(() => getNextSqrtPriceFromOutput(one, 1n, (1n << 256n) - 1n, true)).toThrow(V3MathError)
    expect(() => getNextSqrtPriceFromOutput(one, 1n, (1n << 256n) - 1n, false)).toThrow(V3MathError)
  })

  it('getAmount0Delta / getAmount1Delta', () => {
    expect(getAmount0Delta(one, encodePriceSqrt(2, 1), 0n, true)).toBe(0n)
    expect(getAmount0Delta(one, one, 0n, true)).toBe(0n)
    expect(getAmount0Delta(one, encodePriceSqrt(121, 100), E18, true)).toBe(90909090909090910n)
    expect(getAmount0Delta(one, encodePriceSqrt(121, 100), E18, false)).toBe(90909090909090909n)
    const up = getAmount0Delta(encodePriceSqrt(1n << 90n, 1), encodePriceSqrt(1n << 96n, 1), E18, true)
    expect(up).toBe(getAmount0Delta(encodePriceSqrt(1n << 90n, 1), encodePriceSqrt(1n << 96n, 1), E18, false) + 1n)
    expect(getAmount1Delta(one, encodePriceSqrt(2, 1), 0n, true)).toBe(0n)
    expect(getAmount1Delta(one, encodePriceSqrt(121, 100), E18, true)).toBe(100000000000000000n)
    expect(getAmount1Delta(one, encodePriceSqrt(121, 100), E18, false)).toBe(99999999999999999n)
  })

  it('takes the overflow branch where sqrtP · amount wraps 256 bits', () => {
    const sqrtP = 1025574284609383690408304870162715216695788925244n
    const liquidity = 50015962439936049619261659728067971248n
    const sqrtQ = getNextSqrtPriceFromInput(sqrtP, liquidity, 406n, true)
    expect(sqrtQ).toBe(1025574284609383582644711336373707553698163132913n)
    expect(getAmount0Delta(sqrtQ, sqrtP, liquidity, true)).toBe(406n)
  })
})

describe('SwapMath.computeSwapStep', () => {
  const one = encodePriceSqrt(1, 1)
  it('caps an exact input at the price target (one for zero)', () => {
    const s = computeSwapStep(one, encodePriceSqrt(101, 100), 2n * E18, E18, 600)
    expect([s.amountIn, s.feeAmount, s.amountOut]).toEqual([9975124224178055n, 5988667735148n, 9925619580021728n])
    expect(s.sqrtRatioNextX96).toBe(encodePriceSqrt(101, 100))
  })
  it('caps an exact output at the price target (one for zero)', () => {
    const s = computeSwapStep(one, encodePriceSqrt(101, 100), 2n * E18, -E18, 600)
    expect([s.amountIn, s.feeAmount, s.amountOut]).toEqual([9975124224178055n, 5988667735148n, 9925619580021728n])
    expect(s.sqrtRatioNextX96).toBe(encodePriceSqrt(101, 100))
  })
  it('spends an exact input fully', () => {
    const s = computeSwapStep(one, encodePriceSqrt(1000, 100), 2n * E18, E18, 600)
    expect([s.amountIn, s.feeAmount, s.amountOut]).toEqual([999400000000000000n, 600000000000000n, 666399946655997866n])
    expect(s.sqrtRatioNextX96).toBe(getNextSqrtPriceFromInput(one, 2n * E18, E18 - s.feeAmount, false))
  })
  it('receives an exact output fully', () => {
    const s = computeSwapStep(one, encodePriceSqrt(10000, 100), 2n * E18, -E18, 600)
    expect([s.amountIn, s.feeAmount, s.amountOut]).toEqual([2000000000000000000n, 1200720432259356n, E18])
    expect(s.sqrtRatioNextX96).toBe(getNextSqrtPriceFromOutput(one, 2n * E18, E18, false))
  })
  it('caps the amount out at the desired amount', () => {
    const s = computeSwapStep(417332158212080721273783715441582n, 1452870262520218020823638996n, 159344665391607089467575320103n, -1n, 1)
    expect([s.amountIn, s.feeAmount, s.amountOut, s.sqrtRatioNextX96]).toEqual([1n, 1n, 1n, 417332158212080721273783715441581n])
  })
  it('uses a partial input at a target price of 1', () => {
    const s = computeSwapStep(2n, 1n, 1n, 3915081100057732413702495386755767n, 1)
    expect([s.amountIn, s.feeAmount, s.amountOut, s.sqrtRatioNextX96]).toEqual([39614081257132168796771975168n, 39614120871253040049813n, 0n, 1n])
  })
  it('takes the entire input as fee', () => {
    const s = computeSwapStep(2413n, 79887613182836312n, 1985041575832132834610021537970n, 10n, 1872)
    expect([s.amountIn, s.feeAmount, s.amountOut, s.sqrtRatioNextX96]).toEqual([0n, 10n, 0n, 2413n])
  })
  it('handles intermediate insufficient liquidity (exact output, both directions)', () => {
    const p = 20282409603651670423947251286016n
    const a = computeSwapStep(p, (p * 11n) / 10n, 1024n, -4n, 3000)
    expect([a.amountOut, a.sqrtRatioNextX96, a.amountIn, a.feeAmount]).toEqual([0n, (p * 11n) / 10n, 26215n, 79n])
    const b = computeSwapStep(p, (p * 9n) / 10n, 1024n, -263000n, 3000)
    expect([b.amountOut, b.sqrtRatioNextX96, b.amountIn, b.feeAmount]).toEqual([26214n, (p * 9n) / 10n, 1n, 1n])
  })
})

describe('TickBitmap.nextInitializedTickWithinOneWord', () => {
  // v3-core's TickBitmap spec: ticks -200, -55, -4, 70, 78, 84, 139, 240, 535 at spacing 1.
  const ticks = [-200, -55, -4, 70, 78, 84, 139, 240, 535].map(tick => ({ tick, liquidityNet: 1n }))
  const next = (tick: number, lte: boolean) => nextInitializedTickWithinOneWord(ticks, tick, 1, lte)
  it('searches upward (lte = false)', () => {
    expect(next(78, false)).toEqual([84, true])
    expect(next(-55, false)).toEqual([-4, true])
    expect(next(77, false)).toEqual([78, true])
    expect(next(-56, false)).toEqual([-55, true])
    expect(next(255, false)).toEqual([511, false])
    expect(next(-257, false)).toEqual([-200, true])
    expect(next(508, false)).toEqual([511, false])
    expect(next(383, false)).toEqual([511, false])
    // With 340 flipped on, the search from 328 finds it in the next word.
    expect(nextInitializedTickWithinOneWord([...ticks, { tick: 340, liquidityNet: 1n }].sort((a, b) => a.tick - b.tick), 328, 1, false)).toEqual([340, true])
  })
  it('searches downward (lte = true)', () => {
    expect(next(78, true)).toEqual([78, true])
    expect(next(79, true)).toEqual([78, true])
    expect(next(258, true)).toEqual([256, false])
    expect(next(256, true)).toEqual([256, false])
    expect(next(72, true)).toEqual([70, true])
    expect(next(-257, true)).toEqual([-512, false])
    expect(next(1023, true)).toEqual([768, false])
    expect(next(900, true)).toEqual([768, false])
    // With 329 flipped on, it is the boundary found from 456.
    expect(nextInitializedTickWithinOneWord([...ticks, { tick: 329, liquidityNet: 1n }].sort((a, b) => a.tick - b.tick), 456, 1, true)).toEqual([329, true])
  })
})

interface FixtureCase {
  name: string; fee: number; tickSpacing: number; sqrtPriceX96: string
  positions: Array<{ tickLower: number; tickUpper: number; liquidity: string }>
  zeroForOne: boolean; amountSpecified: string; sqrtPriceLimitX96: string | null
  expect: {
    error?: string; amount0Before: string; amount1Before: string; tickBefore: number
    amount0Delta?: string; amount1Delta?: string; tickAfter?: number
    feeGrowthGlobal0X128Delta?: string; feeGrowthGlobal1X128Delta?: string
  }
}
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/uniswapV3PoolSwaps.json', import.meta.url), 'utf8')) as { cases: FixtureCase[] }

describe('UniswapV3Pool.swap: the published swap snapshot', () => {
  it('carries every case of the snapshot', () => {
    expect(FIXTURE.cases.length).toBe(240)
  })

  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      const sqrtP = BigInt(c.sqrtPriceX96)
      const tick = getTickAtSqrtRatio(sqrtP)
      // The pool as the spec's fixture minted it: amounts per position (rounded up,
      // the pool's mint rule) and the liquidity straddling the starting tick.
      let amount0 = 0n, amount1 = 0n, liquidity = 0n
      for (const p of c.positions) {
        const L = BigInt(p.liquidity)
        const lo = getSqrtRatioAtTick(p.tickLower), hi = getSqrtRatioAtTick(p.tickUpper)
        if (tick < p.tickLower) amount0 += getAmount0DeltaSigned(lo, hi, L)
        else if (tick < p.tickUpper) {
          amount0 += getAmount0DeltaSigned(sqrtP, hi, L)
          amount1 += getAmount1DeltaSigned(lo, sqrtP, L)
          liquidity += L
        } else amount1 += getAmount1DeltaSigned(lo, hi, L)
      }
      expect(tick).toBe(c.expect.tickBefore)
      expect(amount0.toString()).toBe(c.expect.amount0Before)
      expect(amount1.toString()).toBe(c.expect.amount1Before)
      const pool = {
        sqrtPriceX96: sqrtP, tick, liquidity, fee: c.fee, tickSpacing: c.tickSpacing,
        ticks: tickTableFromRanges(c.positions.map(p => ({ tickLower: p.tickLower, tickUpper: p.tickUpper, net: BigInt(p.liquidity) }))),
      }
      const run = () => v3Swap(pool, c.zeroForOne, BigInt(c.amountSpecified), c.sqrtPriceLimitX96 == null ? undefined : BigInt(c.sqrtPriceLimitX96))
      if (c.expect.error) {
        expect(run).toThrow(new V3MathError(c.expect.error))
        return
      }
      const r = run()
      expect(r.amount0.toString()).toBe(c.expect.amount0Delta)
      expect(r.amount1.toString()).toBe(c.expect.amount1Delta)
      expect(r.tick).toBe(c.expect.tickAfter)
      expect(r.feeGrowthX128.toString()).toBe(c.zeroForOne ? c.expect.feeGrowthGlobal0X128Delta : c.expect.feeGrowthGlobal1X128Delta)
      expect(c.zeroForOne ? c.expect.feeGrowthGlobal1X128Delta : c.expect.feeGrowthGlobal0X128Delta).toBe('0')
    })
  }
})
