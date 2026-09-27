import { afterEach, describe, expect, it, vi } from 'vitest'
import { atokenBalanceFromUserState, normalizedIncomeFromReserveWords, readErc20Balances, updateErc20Registry } from '../../src/evm/balances.ts'
import * as evmStorage from '../../src/types/evm/storage.ts'
import type { Block } from '../../src/types/support.ts'

const POOL_ACCOUNT = `0x${'11'.repeat(32)}`
const RAY = 10n ** 27n

// One Aave V3 `_userState` word: high 128 bits are additionalData (the liquidity
// index at the holder's last mint/burn), low 128 bits the scaled balance.
const userStateWord = (scaledBalance: bigint, cachedIndex: bigint) =>
  `0x${((cachedIndex << 128n) | scaledBalance).toString(16).padStart(64, '0')}`

const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`
const block = (timestamp?: number) => ({ height: 1, timestamp } as unknown as Block)

// Core USDC reserve at block 15,103,648, read from the Pool's `_reserves` storage
// and checked against getReserveNormalizedIncome.
const CORE_POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const USDC_UNDERLYING = '0x0000000000000000000000000000000100000016'
const AUSDC = '0x2ec4884088d84e5c2970a034732e5209b0acfa93'
const USDC_INDEX = 1_065_804_414_733_237_908_463_573_395n
const USDC_RATE = 21_495_115_669_901_615_875_230_050n
const USDC_LAST_UPDATE = 1_790_529_192n

afterEach(() => {
  updateErc20Registry(new Map(), new Set())
})

describe('readErc20Balances', () => {
  it('keeps results aligned when an asset id appears more than once', async () => {
    const accessor = evmStorage.accountStorages.v193
    const originalIs = accessor.is
    const originalGetMany = accessor.getMany
    ;(accessor as unknown as { is: typeof originalIs }).is = () => true
    ;(accessor as unknown as { getMany: typeof originalGetMany }).getMany = async () => [
      `0x${'0'.repeat(63)}1`,
      `0x${'0'.repeat(63)}2`,
    ]
    updateErc20Registry(new Map([[7, `0x${'22'.repeat(20)}`]]), new Set())

    try {
      const balances = await readErc20Balances(
        { height: 1 } as Block,
        [7, 7],
        POOL_ACCOUNT,
      )

      expect(balances).toEqual([1n, 2n])
    } finally {
      ;(accessor as unknown as { is: typeof originalIs }).is = originalIs
      ;(accessor as unknown as { getMany: typeof originalGetMany }).getMany = originalGetMany
    }
  })

  // The result array is in underlying units. An aToken's stored balance is SCALED,
  // so it only belongs in that array after multiplying by the reserve's normalized
  // income at the block; with no reserve to accrue there is nothing to convert it with.
  it('never returns a scaled aToken balance as an underlying one', async () => {
    const accessor = evmStorage.accountStorages.v193
    const originalIs = accessor.is
    const originalGetMany = accessor.getMany
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scaled = 5_000_000_000_000_000_000n
    ;(accessor as unknown as { is: typeof originalIs }).is = () => true
    ;(accessor as unknown as { getMany: typeof originalGetMany }).getMany = async () => [
      userStateWord(scaled, RAY * 2n),
    ]
    updateErc20Registry(new Map([[7, `0x${'22'.repeat(20)}`]]), new Set([7]))

    try {
      const balances = await readErc20Balances(block(), [7], POOL_ACCOUNT)

      // No reserve known: left at 0 so the caller keeps its substrate-side reserve,
      // and the holder's cached index is never used as a fallback.
      expect(balances).toEqual([0n])
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
      ;(accessor as unknown as { is: typeof originalIs }).is = originalIs
      ;(accessor as unknown as { getMany: typeof originalGetMany }).getMany = originalGetMany
    }
  })

  // Pool 110's aUSDC leg at block 15,103,648: the chain's balanceOf is 840,697,276,606.
  // Scaled × the holder's cached `_userState` index understated it; the reserve's
  // normalized income accrued to the block's timestamp states it to the unit.
  it('accrues the reserve liquidity index to the block like balanceOf', async () => {
    const accessor = evmStorage.accountStorages.v193
    const originalIs = accessor.is
    const originalGetMany = accessor.getMany
    const reads: Array<[string, string]> = []
    const staleIndex = 1_065_800_000_000_000_000_000_000_000n
    ;(accessor as unknown as { is: typeof originalIs }).is = () => true
    ;(accessor as unknown as { getMany: typeof originalGetMany }).getMany = async (_b: Block, keys: Array<[string, string]>) => {
      reads.push(...keys)
      return [
        userStateWord(788_791_092_848n, staleIndex),
        word((USDC_RATE << 128n) | USDC_INDEX),
        word(USDC_LAST_UPDATE << 128n),
        word(BigInt(AUSDC)),
      ]
    }
    updateErc20Registry(
      new Map([[1003, AUSDC]]),
      new Set([1003]),
      new Map([[AUSDC, { poolProxy: CORE_POOL, assetAddress: USDC_UNDERLYING }]]),
    )

    try {
      const balances = await readErc20Balances(block(1_790_529_624_000), [1003], POOL_ACCOUNT)

      expect(balances).toEqual([840_697_276_606n])
      // The reserve words come from the Pool proxy, in the same batch.
      expect(reads.slice(1).every(([contract]) => contract === CORE_POOL)).toBe(true)
      expect(reads).toHaveLength(4)
    } finally {
      ;(accessor as unknown as { is: typeof originalIs }).is = originalIs
      ;(accessor as unknown as { getMany: typeof originalGetMany }).getMany = originalGetMany
    }
  })

  it('refuses a reserve whose aTokenAddress is a different contract', async () => {
    const accessor = evmStorage.accountStorages.v193
    const originalIs = accessor.is
    const originalGetMany = accessor.getMany
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(accessor as unknown as { is: typeof originalIs }).is = () => true
    ;(accessor as unknown as { getMany: typeof originalGetMany }).getMany = async () => [
      userStateWord(788_791_092_848n, RAY),
      word((USDC_RATE << 128n) | USDC_INDEX),
      word(USDC_LAST_UPDATE << 128n),
      word(0x1234n),
    ]
    updateErc20Registry(
      new Map([[1003, AUSDC]]),
      new Set([1003]),
      new Map([[AUSDC, { poolProxy: CORE_POOL, assetAddress: USDC_UNDERLYING }]]),
    )

    try {
      expect(await readErc20Balances(block(1_790_529_624_000), [1003], POOL_ACCOUNT)).toEqual([0n])
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
      ;(accessor as unknown as { is: typeof originalIs }).is = originalIs
      ;(accessor as unknown as { getMany: typeof originalGetMany }).getMany = originalGetMany
    }
  })
})

describe('normalizedIncomeFromReserveWords', () => {
  it('matches getReserveNormalizedIncome for the core USDC reserve at block 15,103,648', () => {
    expect(normalizedIncomeFromReserveWords((USDC_RATE << 128n) | USDC_INDEX, USDC_LAST_UPDATE << 128n, 1_790_529_624n))
      .toBe(1_065_804_728_563_226_623_295_666_567n)
  })

  it('is the stored index when the reserve was updated at that second', () => {
    expect(normalizedIncomeFromReserveWords((USDC_RATE << 128n) | USDC_INDEX, USDC_LAST_UPDATE << 128n, USDC_LAST_UPDATE))
      .toBe(USDC_INDEX)
  })

  it('reports an uninitialized reserve as unusable', () => {
    expect(normalizedIncomeFromReserveWords(0n, 0n, 1n)).toBeNull()
  })
})

describe('atokenBalanceFromUserState', () => {
  it('converts the scaled half with the given income, ignoring the cached index', () => {
    expect(atokenBalanceFromUserState((RAY * 3n << 128n) | 7n, RAY * 2n)).toBe(14n)
    expect(atokenBalanceFromUserState(7n, RAY * 2n)).toBe(14n)
  })

  it('rounds half-up like rayMul', () => {
    expect(atokenBalanceFromUserState(1n, RAY / 2n)).toBe(1n)
    expect(atokenBalanceFromUserState(1n, RAY / 2n - 1n)).toBe(0n)
  })

  it('reads a zero scaled balance as a real zero', () => {
    expect(atokenBalanceFromUserState(0n, RAY)).toBe(0n)
    expect(atokenBalanceFromUserState(RAY << 128n, RAY)).toBe(0n)
  })
})
