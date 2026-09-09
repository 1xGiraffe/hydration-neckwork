import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { blockExtrinsicTupleList } from '../src/services/explorerService.ts'
import {
  classifyV3Events, ethPrefixedAccountId, feeTierLabel, resolveV3TokenAsset, sqrtPriceX96ToPrice, tickToPrice, v3PoolForHop,
  type V3ClassifyContext, type V3EventRow, type V3Pool,
} from '../src/services/uniswapV3Service.ts'

// Everything here is pinned against the first deployment (aDOT/HOLLAR 0.3%, pool
// 0x5c6208a3…, created 2026-09-08 in block 14359646): the numbers are the chain's.

const POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
const MANAGER = '0xd5029e471ee3f6f51fefb63fed0482a74bb310b3'
const VAULT = '0xa206d0959813f17c17c87147271c49065438648a'
const ADOT_CONTRACT = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const HOLLAR_CONTRACT = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const USER = '0x6e896769ddecd994f63e5772218a820918e0ff6f'
const ROUTER = '0x5a79de848626994c4099640ef5c48fd65dae4159'

describe('price math', () => {
  // Initialize(sqrtPriceX96 = 0x28cb9010a808d91a8d95db235065, tick = 185084) in
  // block 14359650. aDOT has 10 decimals, HOLLAR 18: the raw token1-per-token0
  // ratio is ~1.088e8 and the human price ~1.088 HOLLAR per aDOT.
  it('turns the pool sqrt price into a human token1-per-token0 price', () => {
    const price = sqrtPriceX96ToPrice(BigInt('0x28cb9010a808d91a8d95db235065'), 10, 18)
    expect(price).toBeCloseTo(1.088, 2)
    expect(tickToPrice(185084, 10, 18)).toBeCloseTo(price, 3)
  })
  it('agrees with the tick math in both directions', () => {
    // 1.0001^tick × 10^(dec0 − dec1); a negative tick is a price below one.
    expect(tickToPrice(0, 6, 6)).toBe(1)
    expect(tickToPrice(-6932, 18, 18)).toBeCloseTo(0.5, 3)
  })
  it('labels a fee tier the way the product does', () => {
    expect(feeTierLabel(3000)).toBe('0.3%')
    expect(feeTierLabel(500)).toBe('0.05%')
    expect(feeTierLabel(100)).toBe('0.01%')
    expect(feeTierLabel(10000)).toBe('1%')
  })
})

describe('resolveV3TokenAsset', () => {
  const aTokenReserve = new Map([[ADOT_CONTRACT, '0x0000000000000000000000000000000100000005']])
  const contractAsset = (addr: string) => (addr === HOLLAR_CONTRACT ? 222 : null)
  it('reads the id out of an asset precompile address', () => {
    expect(resolveV3TokenAsset('0x00000000000000000000000000000001000000de', aTokenReserve, contractAsset)).toBe(222)
  })
  it('maps an aToken contract to the aToken asset, not its reserve', () => {
    // The pool holds aDOT (1001), which is valued through DOT but IS a different asset.
    expect(resolveV3TokenAsset(ADOT_CONTRACT, aTokenReserve, contractAsset)).toBe(1001)
  })
  it('falls back to the deployed-contract map, and answers null for a stranger', () => {
    expect(resolveV3TokenAsset(HOLLAR_CONTRACT, aTokenReserve, contractAsset)).toBe(222)
    expect(resolveV3TokenAsset('0x1111111111111111111111111111111111111111', aTokenReserve, contractAsset)).toBeNull()
  })
  it('is case-insensitive about the address', () => {
    expect(resolveV3TokenAsset(ADOT_CONTRACT.toUpperCase().replace('0X', '0x'), aTokenReserve, contractAsset)).toBe(1001)
  })
})

describe('ethPrefixedAccountId', () => {
  it('wraps an H160 the way the chain truncates it', () => {
    expect(ethPrefixedAccountId(USER)).toBe('0x455448006e896769ddecd994f63e5772218a820918e0ff6f0000000000000000')
    expect(ethPrefixedAccountId('')).toBeNull()
  })
})

function row(over: Partial<V3EventRow>): V3EventRow {
  return {
    block_height: 14395782, event_index: 0, extrinsic_index: 3, ts: '2026-09-09 04:55:00',
    contract_address: POOL, kind: 'pool', event_name: 'Swap', actor: '', counterparty: '', owner: '',
    token_id: '0', tick_lower: 0, tick_upper: 0, tick: 0, liquidity: '0', amount0: '0', amount1: '0',
    sqrt_price_x96: '0', aux0: '0', aux1: '0', ...over,
  }
}

const ctx: V3ClassifyContext = {
  pools: new Map([[POOL, { address: POOL, token0: ADOT_CONTRACT, token1: HOLLAR_CONTRACT, asset0: 1001, asset1: 222, fee: 3000 }]]),
  managers: new Set([MANAGER]),
  vaults: new Map([[VAULT, POOL]]),
  ownerOfToken: new Map([[`${MANAGER}:1`, USER]]),
}

describe('classifyV3Events', () => {
  // Swap in block 14395782-4: the router paid 0.0462 HOLLAR into the pool and took
  // 0.0422 aDOT out (amount0 negative), for the trader who signed the extrinsic.
  it('reads a swap as in-leg positive, out-leg negative, and leaves the trader to the extrinsic', () => {
    const swap = row({ event_index: 34, extrinsic_index: 4, actor: ROUTER, counterparty: USER, amount0: '-421811245', amount1: '46181299507238469', sqrt_price_x96: '3220000000000000000000000000000', tick: 185060, liquidity: '5546587393127453' })
    const out = classifyV3Events([swap], ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'swap', pool: POOL, assetIn: 222, assetOut: 1001, amountIn: '46181299507238469', amountOut: '421811245',
      whoAccountId: ethPrefixedAccountId(USER), eventIndex: 34, extrinsicIndex: 4,
    })
  })

  // Position #1 opened in 14395782-3: the manager's IncreaseLiquidity is the act,
  // the pool's Mint (owner = manager) is its plumbing and carries the tick range.
  it('folds a manager mint into one Add owned by the position NFT holder', () => {
    const mint = row({ event_index: 22, event_name: 'Mint', actor: MANAGER, owner: MANAGER, tick_lower: 184980, tick_upper: 185100, liquidity: '5546587393127453', amount0: '421811246', amount1: '299999999999999996' })
    const inc = row({ event_index: 24, contract_address: MANAGER, kind: 'manager', event_name: 'IncreaseLiquidity', token_id: '1', liquidity: '5546587393127453', amount0: '421811246', amount1: '299999999999999996' })
    const nft = row({ event_index: 23, contract_address: MANAGER, kind: 'manager', event_name: 'Transfer', actor: '0x0000000000000000000000000000000000000000', counterparty: USER, token_id: '1' })
    const out = classifyV3Events([mint, nft, inc], ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'liquidity', action: 'Add', pool: POOL, asset0: 1001, asset1: 222, amount0: '421811246', amount1: '299999999999999996',
      tokenId: '1', tickLower: 184980, tickUpper: 185100, whoAccountId: ethPrefixedAccountId(USER), eventIndex: 24,
    })
  })

  // Closing it (14395783-2 … 14395788): DecreaseLiquidity books the principal, the
  // Collect that follows pays principal + fees. The row for the collect is the
  // FEE part alone, and only when there is one.
  it('books a decrease as Remove and the excess of the collect as fees', () => {
    const dec = row({ block_height: 14395783, event_index: 10, extrinsic_index: 2, contract_address: MANAGER, kind: 'manager', event_name: 'DecreaseLiquidity', token_id: '1', liquidity: '5546587393127453', amount0: '1000', amount1: '2000' })
    const burn = row({ block_height: 14395783, event_index: 9, extrinsic_index: 2, event_name: 'Burn', actor: MANAGER, owner: MANAGER, liquidity: '5546587393127453', amount0: '1000', amount1: '2000' })
    const poolCollect = row({ block_height: 14395783, event_index: 11, extrinsic_index: 2, event_name: 'Collect', actor: MANAGER, owner: MANAGER, counterparty: USER, amount0: '1010', amount1: '2000' })
    const collect = row({ block_height: 14395783, event_index: 12, extrinsic_index: 2, contract_address: MANAGER, kind: 'manager', event_name: 'Collect', token_id: '1', counterparty: USER, amount0: '1010', amount1: '2000' })
    const out = classifyV3Events([burn, dec, poolCollect, collect], ctx)
    expect(out.map(a => [a.action, a.amount0, a.amount1])).toEqual([
      ['Remove', '1000', '2000'],
      ['CollectFees', '10', '0'],
    ])
    expect(out[1]).toMatchObject({ whoAccountId: ethPrefixedAccountId(USER), tokenId: '1', eventIndex: 12 })
  })

  it('drops a collect that paid nothing beyond the principal', () => {
    const dec = row({ contract_address: MANAGER, kind: 'manager', event_name: 'DecreaseLiquidity', token_id: '1', amount0: '5', amount1: '7', event_index: 1 })
    const collect = row({ contract_address: MANAGER, kind: 'manager', event_name: 'Collect', token_id: '1', counterparty: USER, amount0: '5', amount1: '7', event_index: 2 })
    expect(classifyV3Events([dec, collect], ctx).map(a => a.action)).toEqual(['Remove'])
  })

  // Vault deposit 14397240-3: 1 aDOT + 1.1767 HOLLAR for 0x20a9… shares, to the
  // depositor. The vault's own Mint into the pool is plumbing; so is every
  // ZeroBurn/SetFee/share transfer.
  it('reads a vault deposit as an Add for the beneficiary and hides the vault plumbing', () => {
    const dep = row({ block_height: 14397240, event_index: 40, contract_address: VAULT, kind: 'vault', event_name: 'Deposit', actor: USER, counterparty: USER, liquidity: '2353209325101471743', amount0: '10000000000', amount1: '1176707870000000000' })
    const share = row({ block_height: 14397240, event_index: 39, contract_address: VAULT, kind: 'vault', event_name: 'Transfer', actor: '0x0000000000000000000000000000000000000000', counterparty: USER, liquidity: '2353209325101471743' })
    const mint = row({ block_height: 14397240, event_index: 30, event_name: 'Mint', actor: VAULT, owner: VAULT, amount0: '9', amount1: '9' })
    const zero = row({ block_height: 14397240, event_index: 31, contract_address: VAULT, kind: 'vault', event_name: 'ZeroBurn', aux0: '255' })
    const out = classifyV3Events([mint, zero, share, dep], ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'liquidity', action: 'Add', pool: POOL, vault: VAULT, shares: '2353209325101471743',
      amount0: '10000000000', amount1: '1176707870000000000', whoAccountId: ethPrefixedAccountId(USER),
    })
  })

  it('reads a withdrawal as Remove and a rebalance as its own act, both against the vault', () => {
    const wd = row({ contract_address: VAULT, kind: 'vault', event_name: 'Withdraw', actor: USER, counterparty: USER, liquidity: '5', amount0: '1', amount1: '2', event_index: 3 })
    const reb = row({ contract_address: VAULT, kind: 'vault', event_name: 'Rebalance', tick: 185843, amount0: '100', amount1: '200', aux0: '3', aux1: '4', liquidity: '999', event_index: 4 })
    const burn = row({ event_name: 'Burn', owner: VAULT, actor: VAULT, liquidity: '0', event_index: 1 })
    const collect = row({ event_name: 'Collect', owner: VAULT, actor: VAULT, counterparty: VAULT, amount0: '1', amount1: '1', event_index: 2 })
    const out = classifyV3Events([burn, collect, wd, reb], ctx)
    expect(out.map(a => a.action)).toEqual(['Remove', 'Rebalance'])
    expect(out[1]).toMatchObject({ vault: VAULT, pool: POOL, whoAccountId: null, amount0: '100', amount1: '200', tick: 185843 })
  })

  // A contract nobody announced minting straight into the pool: the act is real
  // and stays, with the extrinsic left to name who did it. A zero-liquidity burn
  // is the fee-poke Uniswap requires before collecting and is never an act.
  it('keeps a direct pool mint as an Add with no owner and drops zero-burn pokes', () => {
    const other = '0x9999999999999999999999999999999999999999'
    const mint = row({ event_name: 'Mint', actor: other, owner: other, amount0: '3', amount1: '4', tick_lower: 1, tick_upper: 2, event_index: 1 })
    const poke = row({ event_name: 'Burn', actor: other, owner: other, liquidity: '0', event_index: 2 })
    const collect = row({ event_name: 'Collect', actor: other, owner: other, counterparty: other, amount0: '6', amount1: '0', event_index: 3 })
    const out = classifyV3Events([mint, poke, collect], ctx)
    expect(out.map(a => [a.action, a.whoAccountId])).toEqual([['Add', null], ['CollectFees', ethPrefixedAccountId(other)]])
    expect(out[0]).toMatchObject({ tickLower: 1, tickUpper: 2 })
  })

  it('keeps event order and never invents a row for an unknown pool', () => {
    const strangerPool = row({ contract_address: '0x1234567890123456789012345678901234567890', event_name: 'Swap', amount0: '1', amount1: '-1' })
    expect(classifyV3Events([strangerPool], ctx)).toHaveLength(0)
  })
})

// The registry loader answers EMPTY without a client, silently: the pool vanished
// from /liquidity and the aDOT page on first deploy because nothing had wired it.
// Every process that serves pools calls initPoolService, so that is where the v3
// service must be wired too.
describe('wiring', () => {
  it('is initialised by initPoolService, the one entry point every pool surface shares', () => {
    const poolService = readFileSync(new URL('../src/services/poolService.ts', import.meta.url), 'utf8')
    const init = poolService.slice(poolService.indexOf('export function initPoolService'), poolService.indexOf('\n}\n', poolService.indexOf('export function initPoolService')))
    expect(init).toContain('initUniswapV3Service(c)')
  })
})

describe('blockExtrinsicTupleList', () => {
  // The routed-hop exclusion interpolated `block:extrinsic` keys verbatim, which
  // ClickHouse rejects; the list must be numeric tuples.
  it('renders block:extrinsic keys as numeric tuples', () => {
    expect(blockExtrinsicTupleList(['14395782:4', '14397741:2'])).toBe('(14395782,4),(14397741,2)')
    expect(blockExtrinsicTupleList([])).toBe('')
  })
})

// A Router route names a v3 hop as (assetIn, assetOut, fee); the factory allows one
// pool per (token0, token1, fee), so that triple IS the pool when the registry has it.
describe('v3PoolForHop', () => {
  const pool = (address: string, asset0: number, asset1: number, fee: number): V3Pool => ({
    address, token0: '', token1: '', asset0, asset1, fee, factory: '', tickSpacing: 60, createdBlock: 1, createdAt: '', createdExtrinsic: null, vault: null,
  })
  const registry = { pools: new Map([[POOL, pool(POOL, 1001, 222, 3000)], ['0xb', pool('0xb', 1001, 222, 500)]]) }
  it('finds the pool for the pair at the fee tier, in either direction', () => {
    expect(v3PoolForHop(registry, 1001, 222, 3000)?.address).toBe(POOL)
    expect(v3PoolForHop(registry, 222, 1001, 3000)?.address).toBe(POOL)
    expect(v3PoolForHop(registry, 222, 1001, 500)?.address).toBe('0xb')
  })
  it('answers null for another tier, another pair, or a degenerate same-asset hop', () => {
    expect(v3PoolForHop(registry, 1001, 222, 10000)).toBeNull()
    expect(v3PoolForHop(registry, 1001, 5, 3000)).toBeNull()
    expect(v3PoolForHop(registry, 222, 222, 3000)).toBeNull()
  })
})
