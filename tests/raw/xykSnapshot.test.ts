import { afterEach, describe, expect, it } from 'vitest'
import { updateErc20Registry } from '../../src/evm/balances.ts'
import { readXYKState, reserveTransferAccounts } from '../../src/raw/snapshot.ts'
import * as evmStorage from '../../src/types/evm/storage.ts'
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

describe('reserveTransferAccounts', () => {
  it('names both accounts of a Tokens, Currencies or Balances transfer', () => {
    // An aToken / Erc20 leg is reported as Currencies.Transferred alone.
    expect(reserveTransferAccounts({ name: 'Currencies.Transferred', args: { currencyId: 69, from: '0x03', to: TOKEN_POOL, amount: 1n } })).toEqual(['0x03', TOKEN_POOL])
    expect(reserveTransferAccounts({ name: 'Balances.Transfer', args: { from: '0x01', to: HDX_POOL, amount: 1n } })).toEqual(['0x01', HDX_POOL])
    expect(reserveTransferAccounts({ name: 'Tokens.Transfer', args: { currencyId: 5, from: TOKEN_POOL, to: '0x02', amount: 1n } })).toEqual([TOKEN_POOL, '0x02'])
  })

  it('ignores every other event and malformed args', () => {
    expect(reserveTransferAccounts({ name: 'Balances.Deposit', args: { who: HDX_POOL, amount: 1n } })).toBeNull()
    expect(reserveTransferAccounts({ name: 'Balances.Transfer', args: { from: '0x01' } })).toBeNull()
    expect(reserveTransferAccounts({ name: 'Balances.Transfer' })).toBeNull()
    expect(reserveTransferAccounts({ name: 'Currencies.Transferred', args: { to: TOKEN_POOL } })).toBeNull()
    expect(reserveTransferAccounts({ args: { from: '0x01', to: TOKEN_POOL } })).toBeNull()
  })
})
