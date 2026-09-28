import { afterEach, describe, expect, it } from 'vitest'
import { updateErc20Registry } from '../../src/evm/balances.ts'
import {
  eventAccounts,
  eventCurrencyId,
  getStableswapPoolAccount,
  poolPalletEventFamily,
  readStableswapState,
  readXYKState,
  refreshAccruingPoolFields,
  stableswapAmplificationAt,
} from '../../src/raw/snapshot.ts'
import type { SnapshotStableswapPoolState } from '../../src/raw/types.ts'
import * as evmStorage from '../../src/types/evm/storage.ts'
import * as stableswapStorage from '../../src/types/stableswap/storage.ts'
import * as systemStorage from '../../src/types/system/storage.ts'
import * as tokensStorage from '../../src/types/tokens/storage.ts'
import type { Block } from '../../src/types/support.ts'

const HDX_POOL = `0x${'aa'.repeat(32)}`
const TOKEN_POOL = `0x${'bb'.repeat(32)}`
const ERC20_POOL = `0x${'cc'.repeat(32)}`
const HOLLAR = 222
const block = { height: 15_013_200 } as Block

type Patchable = Record<string, unknown>
const restores: Array<() => void> = []
function patch(target: object, fields: Patchable): void {
  const t = target as Patchable
  const saved = Object.fromEntries(Object.keys(fields).map(k => [k, t[k]]))
  Object.assign(t, fields)
  restores.push(() => Object.assign(t, saved))
}

const tokenBalances = new Map<string, bigint>()
const nativeBalances = new Map<string, bigint>()
const tokenKeysRead: Array<[string, number]> = []

function installStorage(): void {
  patch(tokensStorage.accounts.v108, {
    is: () => true,
    getMany: async (_b: Block, keys: Array<[string, number]>) => {
      tokenKeysRead.push(...keys)
      return keys.map(([account, asset]) => {
        const free = tokenBalances.get(`${account}:${asset}`)
        return free == null ? undefined : { free, reserved: 0n, frozen: 0n }
      })
    },
  })
  patch(systemStorage.account.v205, {
    is: () => true,
    getMany: async (_b: Block, accounts: string[]) => accounts.map((account) => {
      const free = nativeBalances.get(account)
      return free == null ? undefined : { nonce: 0, consumers: 0, providers: 1, sufficients: 0, data: { free, reserved: 0n, frozen: 0n, flags: 0n } }
    }),
  })
}

afterEach(() => {
  while (restores.length) restores.pop()!()
  tokenBalances.clear()
  nativeBalances.clear()
  tokenKeysRead.length = 0
  updateErc20Registry(new Map(), new Set())
})

describe('readXYKState', () => {
  it('reads the HDX side from System.Account, never from Tokens.Accounts', async () => {
    installStorage()
    nativeBalances.set(HDX_POOL, 196_114_599_820_530_258n)
    tokenBalances.set(`${HDX_POOL}:1000286`, 203_305_074_956_348_449n)
    tokenBalances.set(`${TOKEN_POOL}:5`, 7n)
    tokenBalances.set(`${TOKEN_POOL}:10`, 11n)

    const pools = await readXYKState(block, [
      { poolAccount: HDX_POOL, assetA: 0, assetB: 1000286 },
      { poolAccount: TOKEN_POOL, assetA: 5, assetB: 10 },
    ])

    expect(pools).toEqual([
      { pool_account: HDX_POOL, asset_a: 0, asset_b: 1000286, reserve_a: '196114599820530258', reserve_b: '203305074956348449' },
      { pool_account: TOKEN_POOL, asset_a: 5, asset_b: 10, reserve_a: '7', reserve_b: '11' },
    ])
    expect(tokenKeysRead.some(([, asset]) => asset === 0)).toBe(false)
  })

  it('keeps sides aligned when HDX is asset B', async () => {
    installStorage()
    nativeBalances.set(HDX_POOL, 287_036_626_259_638n)
    tokenBalances.set(`${HDX_POOL}:1000019`, 7_993_101_464_579_321n)

    const [pool] = await readXYKState(block, [{ poolAccount: HDX_POOL, assetA: 1000019, assetB: 0 }])

    expect(pool.reserve_a).toBe('7993101464579321')
    expect(pool.reserve_b).toBe('287036626259638')
  })

  it('reads an HDX pool account with no System.Account entry as 0', async () => {
    installStorage()
    tokenBalances.set(`${HDX_POOL}:1000038`, 41_754_066n)

    const [pool] = await readXYKState(block, [{ poolAccount: HDX_POOL, assetA: 1000038, assetB: 0 }])

    expect(pool.reserve_b).toBe('0')
    expect(pool.reserve_a).toBe('41754066')
  })

  it('reads an Erc20 side from the pool account EVM balance', async () => {
    installStorage()
    nativeBalances.set(ERC20_POOL, 111_047_710_256_923n)
    updateErc20Registry(new Map([[HOLLAR, '0x531a654d1696ed52e7275a8cede955e82620f99a']]), new Set())
    const evmReads: string[][] = []
    patch(evmStorage.accountStorages.v193, {
      is: () => true,
      getMany: async (_b: Block, keys: Array<[string, string]>) => {
        evmReads.push(keys.map(([contract]) => contract))
        return keys.map(() => `0x${(864_626_893_617_646_414n).toString(16).padStart(64, '0')}`)
      },
    })

    const [pool] = await readXYKState(block, [{ poolAccount: ERC20_POOL, assetA: 0, assetB: HOLLAR }])

    expect(pool.reserve_a).toBe('111047710256923')
    expect(pool.reserve_b).toBe('864626893617646414')
    expect(evmReads).toEqual([['0x531a654d1696ed52e7275a8cede955e82620f99a']])
  })

  it('reads no EVM storage for a pool without an Erc20 asset', async () => {
    installStorage()
    patch(evmStorage.accountStorages.v193, {
      is: () => true,
      getMany: async () => { throw new Error('unexpected EVM read') },
    })
    tokenBalances.set(`${TOKEN_POOL}:5`, 7n)

    const [pool] = await readXYKState(block, [{ poolAccount: TOKEN_POOL, assetA: 5, assetB: 10 }])

    expect(pool).toMatchObject({ reserve_a: '7', reserve_b: '0' })
  })
})

describe('eventAccounts', () => {
  it('names every account in the arguments, not only a transfer\'s two', () => {
    // An aToken / Erc20 leg is reported as Currencies.Transferred alone.
    expect(eventAccounts({ args: { currencyId: 69, from: `0x${'03'.repeat(32)}`, to: TOKEN_POOL, amount: 1n } }))
      .toEqual(new Set([`0x${'03'.repeat(32)}`, TOKEN_POOL]))
    // Deposits and withdrawals move a pool account's free balance with no transfer beside them.
    expect(eventAccounts({ args: { who: HDX_POOL, amount: 1n } })).toEqual(new Set([HDX_POOL]))
    expect(eventAccounts({ args: { currencyId: 5, who: TOKEN_POOL, amount: 1n } })).toEqual(new Set([TOKEN_POOL]))
    // Nested structures (a filler, a route) are searched too.
    expect(eventAccounts({ args: { filler: { account: ERC20_POOL }, route: [{ pool: HDX_POOL }] } })).toEqual(new Set([ERC20_POOL, HDX_POOL]))
  })

  it('names nothing for events without account arguments', () => {
    expect(eventAccounts({ args: { amount: 1n, assetId: 5 } })).toEqual(new Set())
    expect(eventAccounts({ args: { evmAddress: '0x531a654d1696ed52e7275a8cede955e82620f99a' } })).toEqual(new Set())
    expect(eventAccounts({})).toEqual(new Set())
  })
})

describe('eventCurrencyId', () => {
  it('reads the currency a Tokens or Currencies event moves', () => {
    // A stableswap share minted to a holder changes the pool's total_issuance.
    expect(eventCurrencyId({ name: 'Tokens.Deposited', args: { currencyId: 102, who: '0x01', amount: 1n } })).toBe(102)
    expect(eventCurrencyId({ name: 'Currencies.Withdrawn', args: { currencyId: 690, who: '0x01', amount: 1n } })).toBe(690)
  })

  it('ignores other pallets and malformed ids', () => {
    expect(eventCurrencyId({ name: 'Omnipool.SellExecuted', args: { currencyId: 5 } })).toBeNull()
    expect(eventCurrencyId({ name: 'Tokens.Deposited', args: { currencyId: '5' } })).toBeNull()
    expect(eventCurrencyId({ name: 'Tokens.Deposited' })).toBeNull()
  })
})

describe('stableswapAmplificationAt', () => {
  const ramp = { initialAmplification: 100, finalAmplification: 300, initialBlock: 1_000, finalBlock: 3_000 }

  it('steps the ramp linearly every block and holds its ends', () => {
    expect(stableswapAmplificationAt(ramp, 999)).toBe(100n)
    expect(stableswapAmplificationAt(ramp, 1_000)).toBe(100n)
    expect(stableswapAmplificationAt(ramp, 2_000)).toBe(200n)
    expect(stableswapAmplificationAt(ramp, 2_001)).toBe(200n)
    expect(stableswapAmplificationAt(ramp, 2_010)).toBe(201n)
    expect(stableswapAmplificationAt(ramp, 3_000)).toBe(300n)
    expect(stableswapAmplificationAt(ramp, 9_000)).toBe(300n)
  })
})

describe('refreshAccruingPoolFields', () => {
  const ATOKEN = 1001
  const ATOKEN_CONTRACT = `0x${'44'.repeat(20)}`
  const PLAIN = 5
  const OMNIPOOL = `0x${'dd'.repeat(32)}`
  const ssPool = (overrides: Partial<SnapshotStableswapPoolState> = {}): SnapshotStableswapPoolState => ({
    pool_id: 690, assets: [PLAIN, ATOKEN], reserves: ['10', '20'], amplification: '100', fee: 200,
    initial_amplification: 100, final_amplification: 100, initial_block: 0, final_block: 0, ...overrides,
  })

  function installEvm(value: bigint): Array<Array<[string, string]>> {
    const reads: Array<Array<[string, string]>> = []
    patch(evmStorage.accountStorages.v193, {
      is: () => true,
      getMany: async (_b: Block, keys: Array<[string, string]>) => {
        reads.push(keys)
        return keys.map(() => `0x${value.toString(16).padStart(64, '0')}`)
      },
    })
    return reads
  }

  it('re-reads every reused Erc20 leg in one batched storage read', async () => {
    updateErc20Registry(new Map([[HOLLAR, '0x531a654d1696ed52e7275a8cede955e82620f99a'], [ATOKEN, ATOKEN_CONTRACT]]), new Set())
    const reads = installEvm(777n)

    const next = await refreshAccruingPoolFields(block, {
      omnipool_account: OMNIPOOL,
      omnipool_assets: [
        { asset_id: 0, hub_reserve: '1', reserve: '2', shares: '3', protocol_shares: '0', cap: '1', tradable: 15 },
        { asset_id: ATOKEN, hub_reserve: '1', reserve: '5', shares: '5', protocol_shares: '0', cap: '1', tradable: 15 },
      ],
      xyk_pools: [
        { pool_account: ERC20_POOL, asset_a: 0, asset_b: HOLLAR, reserve_a: '9', reserve_b: '8' },
        { pool_account: TOKEN_POOL, asset_a: 5, asset_b: 10, reserve_a: '7', reserve_b: '11' },
      ],
      stableswap_pools: [ssPool()],
    }, { omnipool: true, xyk: true, stableswap: true })

    expect(reads).toHaveLength(1)
    expect(reads[0].map(([contract]) => contract)).toEqual([ATOKEN_CONTRACT, '0x531a654d1696ed52e7275a8cede955e82620f99a', ATOKEN_CONTRACT])
    expect(next.omnipool_assets.map(asset => asset.reserve)).toEqual(['2', '777'])
    expect(next.xyk_pools.map(pool => [pool.reserve_a, pool.reserve_b])).toEqual([['9', '777'], ['7', '11']])
    expect(next.stableswap_pools[0].reserves).toEqual(['10', '777'])
  })

  it('leaves refreshed families alone and keeps a leg that reads zero', async () => {
    updateErc20Registry(new Map([[ATOKEN, ATOKEN_CONTRACT]]), new Set())
    const reads = installEvm(0n)
    const state = {
      omnipool_account: OMNIPOOL,
      omnipool_assets: [{ asset_id: ATOKEN, hub_reserve: '1', reserve: '5', shares: '5', protocol_shares: '0', cap: '1', tradable: 15 }],
      xyk_pools: [],
      stableswap_pools: [ssPool()],
    }

    const next = await refreshAccruingPoolFields(block, state, { omnipool: false, xyk: true, stableswap: true })

    expect(reads[0].map(([, key]) => key)).toHaveLength(1)
    expect(next.omnipool_assets).toBe(state.omnipool_assets)
    expect(next.stableswap_pools).toBe(state.stableswap_pools)
  })

  it('steps a reused stableswap ramp to the block height with no storage read', async () => {
    patch(evmStorage.accountStorages.v193, { is: () => true, getMany: async () => { throw new Error('unexpected EVM read') } })
    const pool = ssPool({ assets: [PLAIN, 10], initial_amplification: 100, final_amplification: 300, initial_block: 15_000_000, final_block: 15_026_400, amplification: '100' })

    const next = await refreshAccruingPoolFields(block, { omnipool_account: OMNIPOOL, omnipool_assets: [], xyk_pools: [], stableswap_pools: [pool] },
      { omnipool: true, xyk: true, stableswap: true })

    // block 15,013,200 is halfway through the ramp.
    expect(next.stableswap_pools[0].amplification).toBe('200')
    expect(getStableswapPoolAccount(690)).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('poolPalletEventFamily', () => {
  it('refreshes the family on every event of its pallet, not only trades', () => {
    // Block 6,012,000: an AssetWeightCapUpdated with no Omnipool trade or transfer in the block.
    expect(poolPalletEventFamily({ name: 'Omnipool.AssetWeightCapUpdated' })).toBe('omnipool')
    expect(poolPalletEventFamily({ name: 'Omnipool.TradableStateUpdated' })).toBe('omnipool')
    expect(poolPalletEventFamily({ name: 'Omnipool.PositionDestroyed' })).toBe('omnipool')
    expect(poolPalletEventFamily({ name: 'Stableswap.PoolPegSourceUpdated' })).toBe('stableswap')
    expect(poolPalletEventFamily({ name: 'XYK.LiquidityRemoved' })).toBe('xyk')
  })

  it('ignores other pallets and malformed names', () => {
    expect(poolPalletEventFamily({ name: 'OmnipoolLiquidityMining.RewardClaimed' })).toBeNull()
    expect(poolPalletEventFamily({ name: 'XYKLiquidityMining.DepositDestroyed' })).toBeNull()
    expect(poolPalletEventFamily({ name: 'Broadcast.Swapped3' })).toBeNull()
    expect(poolPalletEventFamily({ name: 'Omnipool' })).toBeNull()
    expect(poolPalletEventFamily({})).toBeNull()
  })
})

describe('readStableswapState', () => {
  function installStableswap(info: Record<number, unknown>): void {
    installStorage()
    patch(tokensStorage.totalIssuance.v108, { is: () => true, getMany: async (_b: Block, ids: number[]) => ids.map(() => 1_000n) })
    patch(stableswapStorage.pools.v183, { is: () => true, getMany: async (_b: Block, ids: number[]) => ids.map(id => info[id]) })
    for (const version of [stableswapStorage.poolPegs.v305, stableswapStorage.poolPegs.v323, stableswapStorage.poolPegs.v378]) {
      patch(version, { is: () => false })
    }
  }

  it('publishes the pool parameters Stableswap.Pools stores, not the cached copy', async () => {
    // Pool 146 at grid height 12,561,600: the cache published the new pool with
    // initial_block/final_block 0; storage holds its creation block.
    // Pool 100 at 6,990,000: the cache held a fee of 400; storage holds 200.
    installStableswap({
      146: { assets: [46, 222], initialAmplification: 100, finalAmplification: 100, initialBlock: 12_561_497, finalBlock: 12_561_497, fee: 400 },
      100: { assets: [10, 21], initialAmplification: 320, finalAmplification: 320, initialBlock: 3_640_110, finalBlock: 3_640_110, fee: 200 },
    })

    const [pool100, pool146] = await readStableswapState({ height: 12_561_600 } as Block, [
      { poolId: 146, assets: [46, 222], initialAmplification: 100, finalAmplification: 100, initialBlock: 0, finalBlock: 0, fee: 400 },
      { poolId: 100, assets: [10, 21], initialAmplification: 320, finalAmplification: 320, initialBlock: 3_640_110, finalBlock: 3_640_110, fee: 400 },
    ])

    expect(pool146).toMatchObject({ pool_id: 146, initial_block: 12_561_497, final_block: 12_561_497, fee: 400, amplification: '100' })
    expect(pool100).toMatchObject({ pool_id: 100, fee: 200, amplification: '320' })
  })

  it('computes the amplification from the stored ramp', async () => {
    // Pool 690 at 8,650,000: the stored ramp 100 -> 1000 over 8,628,000-8,700,000,
    // while the cache still held the previous 22 -> 100 ramp.
    installStableswap({ 690: { assets: [5, 1001], initialAmplification: 100, finalAmplification: 1000, initialBlock: 8_628_000, finalBlock: 8_700_000, fee: 200 } })

    const [pool] = await readStableswapState({ height: 8_650_000 } as Block, [
      { poolId: 690, assets: [5, 1001], initialAmplification: 22, finalAmplification: 100, initialBlock: 7_422_222, finalBlock: 7_441_722, fee: 200 },
    ])

    expect(pool).toMatchObject({ initial_amplification: 100, final_amplification: 1000, amplification: '375' })
  })

  it('keeps the cached parameters of a pool storage does not hold', async () => {
    installStableswap({})

    const [pool] = await readStableswapState({ height: 100 } as Block, [
      { poolId: 7, assets: [5, 10], initialAmplification: 50, finalAmplification: 50, initialBlock: 1, finalBlock: 1, fee: 100 },
    ])

    expect(pool).toMatchObject({ pool_id: 7, fee: 100, amplification: '50' })
  })
})
