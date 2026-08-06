import { describe, expect, it } from 'vitest'
import { hasDriftingPegs, parseStableswapPools, pegPrice } from '../src/services/stableswapSnapshot.ts'

// Real payload shapes from raw_block_snapshots (pools 100, 103, 690 at the tip).
const HEX_POOL = {
  pool_id: 100,
  assets: '0x0a121517',
  reserves: ['48274372', '290211072669534010467', '46989660', '49804500'],
  amplification: '320',
  fee: 200,
  total_issuance: '413548267230179471837',
  initial_amplification: 320,
  final_amplification: 320,
  initial_block: 3640110,
  final_block: 3640110,
}
const ARRAY_POOL = {
  pool_id: 103,
  assets: [1002, 1000766, 1000767],
  reserves: ['373803519798', '295436420928', '370626843331'],
  amplification: '222',
  fee: 200,
  total_issuance: '1018577262547868286599058',
  initial_amplification: 222,
  final_amplification: 222,
  initial_block: 8217669,
  final_block: 8217669,
}
const PEGGED_POOL = {
  pool_id: 690,
  assets: [15, 1001],
  reserves: ['13950105915869520', '21957095198628361'],
  amplification: '222',
  fee: 690,
  total_issuance: '12056322943070684321437193',
  initial_amplification: 222,
  final_amplification: 222,
  initial_block: 10308688,
  final_block: 10308688,
  peg_multipliers: [
    ['195713684316715870490257118171772930334', '118280925221123251112015045352500455767'],
    ['1', '1'],
  ] as [string, string][],
}

describe('parseStableswapPools', () => {
  it('decodes the compact hex asset encoding (one byte per id)', () => {
    const [pool] = parseStableswapPools({ pools: [HEX_POOL] })
    expect(pool.assetIds).toEqual([10, 18, 21, 23])
    expect(pool.reserves).toEqual(HEX_POOL.reserves.map(BigInt))
    expect(pool.pegs).toBeNull()
  })

  it('decodes the int-array asset encoding used for ids above 255', () => {
    const [pool] = parseStableswapPools({ pools: [ARRAY_POOL] })
    expect(pool.assetIds).toEqual([1002, 1000766, 1000767])
    expect(pool.amplification).toBe(222)
    expect(pool.feePermill).toBe(200)
  })

  it('keeps u128-scale peg rationals exact as bigints', () => {
    const [pool] = parseStableswapPools({ pools: [PEGGED_POOL] })
    expect(pool.pegs).not.toBeNull()
    expect(pool.pegs![0].num).toBe(195713684316715870490257118171772930334n)
    expect(pool.pegs![0].den).toBe(118280925221123251112015045352500455767n)
    expect(pool.pegs![1]).toEqual({ num: 1n, den: 1n })
  })

  it('skips a malformed entry instead of guessing', () => {
    const pools = parseStableswapPools({ pools: [{ ...HEX_POOL, reserves: ['1'] }, ARRAY_POOL] })
    expect(pools.map(p => p.poolId)).toEqual([103])
  })

  it('returns empty on a missing section', () => {
    expect(parseStableswapPools(null)).toEqual([])
    expect(parseStableswapPools({})).toEqual([])
  })
})

describe('pegPrice', () => {
  it('converts u128-scale rationals without losing the ratio', () => {
    const price = pegPrice(195713684316715870490257118171772930334n, 118280925221123251112015045352500455767n)
    expect(price).toBeCloseTo(1.65465, 4)
  })

  it('handles the unit peg and a zero denominator', () => {
    expect(pegPrice(1n, 1n)).toBe(1)
    expect(pegPrice(5n, 0n)).toBe(0)
  })

  it('keeps small rationals exact', () => {
    expect(pegPrice(136723180n, 100000000n)).toBeCloseTo(1.3672318, 7)
  })
})

describe('hasDriftingPegs', () => {
  it('is false for pools without pegs and for all-unit pegs', () => {
    expect(hasDriftingPegs(null)).toBe(false)
    expect(hasDriftingPegs([{ num: 1n, den: 1n }])).toBe(false)
  })

  it('is true when any peg differs from 1/1', () => {
    expect(hasDriftingPegs([{ num: 1n, den: 1n }, { num: 3n, den: 2n }])).toBe(true)
  })
})
