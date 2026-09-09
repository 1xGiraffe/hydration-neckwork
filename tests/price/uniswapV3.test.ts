import { describe, expect, it } from 'vitest'
import {
  UNISWAP_V3_TOPICS,
  UniswapV3PoolTracker,
  applyPoolEvent,
  decodeUniswapV3Log,
  emptyPoolState,
  evmLogOf,
  invertErc20Contracts,
  resolveEvmTokenAssetId,
  routedUniswapV3Extrinsics,
  tickInRange,
  uniswapV3SwapTrade,
  virtualReserves,
} from '../../src/price/uniswapV3.ts'

const Q96 = 2n ** 96n

// The aDOT/HOLLAR 0.3% pool (runtime 443, 2026-09-08): the first concentrated-
// liquidity pool on Hydration, and its first Mint and Swap as they arrived in
// `EVM.Log` args (price_data.raw_events, block 14395782, extrinsics 3 and 4;
// PoolCreated at block 14359646).
const POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
const ADOT_CONTRACT = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const HOLLAR_CONTRACT = '0x531a654d1696ed52e7275a8cede955e82620f99a'

const POOL_CREATED_ARGS = JSON.parse('{"log":{"address":"0x776c4fd6a6170165a91ba45dec40a14bcc8ec354","topics":["0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118","0x00000000000000000000000002639ec01313c8775fae74f2dad1118c8a8a86da","0x000000000000000000000000531a654d1696ed52e7275a8cede955e82620f99a","0x0000000000000000000000000000000000000000000000000000000000000bb8"],"data":"0x000000000000000000000000000000000000000000000000000000000000003c0000000000000000000000005c6208a3c316a801f8996750aa7b6f45fc988548"}}')
const MINT_ARGS = JSON.parse('{"log":{"address":"0x5c6208a3c316a801f8996750aa7b6f45fc988548","topics":["0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde","0x000000000000000000000000d5029e471ee3f6f51fefb63fed0482a74bb310b3","0x000000000000000000000000000000000000000000000000000000000002d294","0x000000000000000000000000000000000000000000000000000000000002d30c"],"data":"0x000000000000000000000000d5029e471ee3f6f51fefb63fed0482a74bb310b30000000000000000000000000000000000000000000000000013a9f0cf2dfc1d000000000000000000000000000000000000000000000000000000001924542e0000000000000000000000000000000000000000000000000429d069189dfffc"}}')
const SWAP_ARGS = JSON.parse('{"log":{"address":"0x5c6208a3c316a801f8996750aa7b6f45fc988548","topics":["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67","0x0000000000000000000000005a79de848626994c4099640ef5c48fd65dae4159","0x0000000000000000000000006e896769ddecd994f63e5772218a820918e0ff6f"],"data":"0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffe6dbabd300000000000000000000000000000000000000000000000000a411a5b06516450000000000000000000000000000000000002a5f9ddcd191e225a5b8b880afcb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002d5f3"}}')
// Initialize(sqrtPriceX96, tick) at block 14359650, from the same pool.
const INITIALIZE_ARGS = {
  log: {
    address: POOL,
    topics: [UNISWAP_V3_TOPICS.initialize],
    data: `0x${(827424287114210652059963100450917n).toString(16).padStart(64, '0')}${(185084n).toString(16).padStart(64, '0')}`,
  },
}

export const REAL_LOGS = { POOL_CREATED_ARGS, MINT_ARGS, SWAP_ARGS, INITIALIZE_ARGS }

const tokens = new Map([[1001, ADOT_CONTRACT], [222, HOLLAR_CONTRACT]])

describe('virtual reserves', () => {
  it('flattens √P and L into the tangent constant-product reserves', () => {
    // P = 1: both sides equal L. P = 4 (√P = 2): token0 side halves, token1 side doubles.
    expect(virtualReserves(Q96, 1000n)).toEqual({ reserve0: 1000n, reserve1: 1000n })
    expect(virtualReserves(2n * Q96, 1000n)).toEqual({ reserve0: 500n, reserve1: 2000n })
  })

  it('offers no reserves for an uninitialised pool or one with nothing in range', () => {
    expect(virtualReserves(0n, 1000n)).toBeNull()
    expect(virtualReserves(Q96, 0n)).toBeNull()
  })

  it('reproduces the pool price: reserve1/reserve0 is (√P/2^96)² in raw units', () => {
    const sqrtPriceX96 = 862203316974439708502410565924684n
    const liquidity = 2118967809806757n
    const reserves = virtualReserves(sqrtPriceX96, liquidity)!
    expect(reserves).toEqual({ reserve0: 194712688634n, reserve1: 23059743103956470264n })
    // aDOT (10 decimals) priced in HOLLAR (18 decimals) ≈ 1.184 HOLLAR
    const priceScaled = (reserves.reserve1 * 10n ** 10n * 1_000_000n) / (reserves.reserve0 * 10n ** 18n)
    expect(priceScaled).toBe(1_184_295n)
  })
})

describe('in-range liquidity', () => {
  it('a position is active on [tickLower, tickUpper): the lower bound counts, the upper does not', () => {
    expect(tickInRange(100, 100, 200)).toBe(true)
    expect(tickInRange(199, 100, 200)).toBe(true)
    expect(tickInRange(200, 100, 200)).toBe(false)
    expect(tickInRange(99, 100, 200)).toBe(false)
  })

  it('Mint and Burn move liquidity only while their range holds the current tick', () => {
    const state = emptyPoolState()
    expect(applyPoolEvent(state, { kind: 'initialize', pool: POOL, sqrtPriceX96: Q96, tick: 150 })).toBe(true)
    expect(applyPoolEvent(state, { kind: 'mint', pool: POOL, owner: '', tickLower: 100, tickUpper: 200, amount: 500n, amount0: 0n, amount1: 0n })).toBe(true)
    expect(applyPoolEvent(state, { kind: 'mint', pool: POOL, owner: '', tickLower: 200, tickUpper: 300, amount: 900n, amount0: 0n, amount1: 0n })).toBe(false)
    expect(state.liquidity).toBe(500n)
    expect(applyPoolEvent(state, { kind: 'burn', pool: POOL, owner: '', tickLower: 100, tickUpper: 200, amount: 200n, amount0: 0n, amount1: 0n })).toBe(true)
    expect(state.liquidity).toBe(300n)
    // a burn(0) poke is not a change
    expect(applyPoolEvent(state, { kind: 'burn', pool: POOL, owner: '', tickLower: 100, tickUpper: 200, amount: 0n, amount0: 0n, amount1: 0n })).toBe(false)
    // never below zero
    applyPoolEvent(state, { kind: 'burn', pool: POOL, owner: '', tickLower: 100, tickUpper: 200, amount: 10_000n, amount0: 0n, amount1: 0n })
    expect(state.liquidity).toBe(0n)
  })

  it('a Swap is authoritative for price, tick and in-range liquidity', () => {
    const state = emptyPoolState()
    applyPoolEvent(state, { kind: 'initialize', pool: POOL, sqrtPriceX96: Q96, tick: 0 })
    applyPoolEvent(state, { kind: 'mint', pool: POOL, owner: '', tickLower: -100, tickUpper: 100, amount: 777n, amount0: 0n, amount1: 0n })
    applyPoolEvent(state, { kind: 'swap', pool: POOL, sender: '', recipient: '', amount0: 1n, amount1: -1n, sqrtPriceX96: 2n * Q96, liquidity: 42n, tick: 13_863 })
    expect(state).toEqual({ sqrtPriceX96: 2n * Q96, tick: 13_863, liquidity: 42n })
  })
})

describe('EVM.Log decoding', () => {
  it('reads PoolCreated: indexed tokens and fee from the topics, tick spacing and pool from the data', () => {
    const decoded = decodeUniswapV3Log(evmLogOf(POOL_CREATED_ARGS)!)
    expect(decoded).toEqual({
      kind: 'poolCreated',
      factory: '0x776c4fd6a6170165a91ba45dec40a14bcc8ec354',
      pool: { address: POOL, token0: ADOT_CONTRACT, token1: HOLLAR_CONTRACT, fee: 3000, tickSpacing: 60 },
    })
  })

  it('reads Mint: owner and ticks from the topics, then sender, liquidity and amounts from the data', () => {
    expect(decodeUniswapV3Log(evmLogOf(MINT_ARGS)!)).toEqual({
      kind: 'mint',
      pool: POOL,
      owner: '0xd5029e471ee3f6f51fefb63fed0482a74bb310b3',
      tickLower: 184980,
      tickUpper: 185100,
      amount: 5534876290645021n,
      amount0: 421811246n,
      amount1: 299999999999999996n,
    })
  })

  it('reads Swap with two’s-complement amounts, √P, post-swap liquidity and tick', () => {
    expect(decodeUniswapV3Log(evmLogOf(SWAP_ARGS)!)).toEqual({
      kind: 'swap',
      pool: POOL,
      sender: '0x5a79de848626994c4099640ef5c48fd65dae4159',
      recipient: '0x6e896769ddecd994f63e5772218a820918e0ff6f',
      amount0: -421811245n,
      amount1: 46181299507238469n,
      sqrtPriceX96: 859436734892113204694862687940555n,
      liquidity: 0n,
      tick: 185843,
    })
  })

  it('reads Initialize and negative int24 ticks', () => {
    expect(decodeUniswapV3Log(evmLogOf(INITIALIZE_ARGS)!)).toEqual({
      kind: 'initialize', pool: POOL, sqrtPriceX96: 827424287114210652059963100450917n, tick: 185084,
    })
    const negativeTick = (2n ** 256n - 887220n).toString(16).padStart(64, '0')
    const decoded = decodeUniswapV3Log({ address: POOL, topics: [UNISWAP_V3_TOPICS.initialize], data: `0x${Q96.toString(16).padStart(64, '0')}${negativeTick}` })
    expect(decoded).toMatchObject({ kind: 'initialize', tick: -887220 })
  })

  it('ignores logs that are not pool-family events and args that are not logs', () => {
    const transfer = { log: { address: POOL, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: '0x' + '0'.repeat(64) } }
    expect(decodeUniswapV3Log(evmLogOf(transfer)!)).toBeNull()
    expect(evmLogOf({ who: '0xabc' })).toBeNull()
    expect(evmLogOf(null)).toBeNull()
  })
})

describe('token resolution', () => {
  it('maps a deployed ERC-20 through the registry and a precompile through its address', () => {
    const byContract = invertErc20Contracts(tokens)
    expect(resolveEvmTokenAssetId(ADOT_CONTRACT, byContract)).toBe(1001)
    expect(resolveEvmTokenAssetId(HOLLAR_CONTRACT.toUpperCase().replace('0X', '0x'), byContract)).toBe(222)
    expect(resolveEvmTokenAssetId('0x0000000000000000000000000000000100000005', byContract)).toBe(5)
    expect(resolveEvmTokenAssetId('0x1111111111111111111111111111111111111111', byContract)).toBeNull()
  })
})

describe('swap trades', () => {
  const pools = new Map([[POOL, { token0AssetId: 1001, token1AssetId: 222 }]])

  it('books the positive amount as the trader’s input and the negative one as the output, to the recipient', () => {
    const swap = decodeUniswapV3Log(evmLogOf(SWAP_ARGS)!)
    expect(swap?.kind).toBe('swap')
    expect(uniswapV3SwapTrade(swap as Extract<typeof swap, { kind: 'swap' }>, pools)).toEqual({
      account: '0x455448006e896769ddecd994f63e5772218a820918e0ff6f0000000000000000',
      filler: 'UniswapV3',
      inputs: [{ assetId: 222, amount: 46181299507238469n }],
      outputs: [{ assetId: 1001, amount: 421811245n }],
    })
  })

  it('ignores an unknown pool', () => {
    const swap = decodeUniswapV3Log(evmLogOf(SWAP_ARGS)!) as Extract<ReturnType<typeof decodeUniswapV3Log>, { kind: 'swap' }>
    expect(uniswapV3SwapTrade(swap, new Map())).toBeNull()
  })

  it('names the extrinsics whose Broadcast fill came from the UniswapV3 venue', () => {
    expect(routedUniswapV3Extrinsics([
      { filler: 'UniswapV3', extrinsicIndex: 4 },
      { filler: 'Omnipool', extrinsicIndex: 5 },
      { filler: 'UniswapV3', extrinsicIndex: null },
    ])).toEqual(new Set([4]))
  })
})

describe('UniswapV3PoolTracker', () => {
  const event = (args: unknown) => ({ name: 'EVM.Log', args })

  it('learns a pool from PoolCreated, resolves its tokens and exposes it as an edge once liquidity is in range', () => {
    const tracker = new UniswapV3PoolTracker()
    tracker.setErc20Contracts(tokens)

    expect(tracker.processEvents([event(POOL_CREATED_ARGS), { name: 'Tokens.Transfer', args: {} }])).toEqual({ swaps: 0, changed: false })
    expect(tracker.size).toBe(1)
    expect(tracker.poolIndex()).toEqual(new Map([[POOL, { token0AssetId: 1001, token1AssetId: 222 }]]))
    expect(tracker.edges()).toEqual([])

    expect(tracker.processEvents([event(INITIALIZE_ARGS)])).toEqual({ swaps: 0, changed: true })
    expect(tracker.edges()).toEqual([]) // priced, but nothing in range

    expect(tracker.processEvents([event(MINT_ARGS)])).toEqual({ swaps: 0, changed: true })
    expect(tracker.edges()).toEqual([{
      poolAddress: POOL,
      assetA: 1001,
      assetB: 222,
      reserveA: 529979703376n,
      reserveB: 57803827877842929730n,
    }])

    // The first swap pushed the price out of the only position's range: the
    // pool reports zero in-range liquidity and stops being an edge.
    expect(tracker.processEvents([event(SWAP_ARGS)])).toEqual({ swaps: 1, changed: true })
    expect(tracker.edges()).toEqual([])
  })

  it('does not count events on a pool it does not know and skips a pool whose token the registry cannot name', () => {
    const tracker = new UniswapV3PoolTracker()
    expect(tracker.processEvents([event(SWAP_ARGS), event(MINT_ARGS)])).toEqual({ swaps: 0, changed: false })

    tracker.processEvents([event(POOL_CREATED_ARGS), event(INITIALIZE_ARGS), event(MINT_ARGS)])
    // no ERC-20 map: aDOT and HOLLAR are deployed contracts, not precompiles
    expect(tracker.poolIndex().size).toBe(0)
    expect(tracker.edges()).toEqual([])
    tracker.setErc20Contracts(tokens)
    expect(tracker.edges()).toHaveLength(1)
  })

  it('accepts a pool seeded from storage and normalises its addresses', () => {
    const tracker = new UniswapV3PoolTracker()
    expect(tracker.addPool({ address: POOL.toUpperCase().replace('0X', '0x'), token0: ADOT_CONTRACT, token1: HOLLAR_CONTRACT, fee: 3000, tickSpacing: 60 })).toBe(true)
    expect(tracker.addPool({ address: POOL, token0: ADOT_CONTRACT, token1: HOLLAR_CONTRACT, fee: 3000, tickSpacing: 60 })).toBe(false)
    tracker.setErc20Contracts(tokens)
    expect([...tracker.poolIndex().keys()]).toEqual([POOL])
  })
})
