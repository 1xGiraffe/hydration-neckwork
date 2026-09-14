import { afterEach, describe, expect, it, vi } from 'vitest'
import { atokenBalanceFromUserState, readErc20Balances, updateErc20Registry } from '../../src/evm/balances.ts'
import * as evmStorage from '../../src/types/evm/storage.ts'
import type { Block } from '../../src/types/support.ts'

const POOL_ACCOUNT = `0x${'11'.repeat(32)}`
const RAY = 10n ** 27n

// One Aave V3 `_userState` word: high 128 bits are additionalData (the liquidity
// index at the holder's last mint/burn), low 128 bits the scaled balance.
const userStateWord = (scaledBalance: bigint, cachedIndex: bigint) =>
  `0x${((cachedIndex << 128n) | scaledBalance).toString(16).padStart(64, '0')}`

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
  // so it only belongs in that array after multiplying by a liquidity index; with
  // no index available there is nothing to convert it with, and returning the
  // scaled half puts two different units in one reserve array.
  it('never returns a scaled aToken balance as an underlying one', async () => {
    const accessor = evmStorage.accountStorages.v193
    const originalIs = accessor.is
    const originalGetMany = accessor.getMany
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scaled = 5_000_000_000_000_000_000n
    ;(accessor as unknown as { is: typeof originalIs }).is = () => true
    ;(accessor as unknown as { getMany: typeof originalGetMany }).getMany = async () => [
      userStateWord(scaled, 0n),
      userStateWord(scaled, RAY * 2n),
    ]
    updateErc20Registry(
      new Map([[7, `0x${'22'.repeat(20)}`], [8, `0x${'33'.repeat(20)}`]]),
      new Set([7, 8]),
    )

    try {
      const balances = await readErc20Balances({ height: 1 } as Block, [7, 8], POOL_ACCOUNT)

      // No usable index: left at 0 so the caller keeps its substrate-side reserve.
      expect(balances[0]).toBe(0n)
      expect(balances[0]).not.toBe(scaled)
      // A usable index converts to underlying units.
      expect(balances[1]).toBe(scaled * 2n)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
      ;(accessor as unknown as { is: typeof originalIs }).is = originalIs
      ;(accessor as unknown as { getMany: typeof originalGetMany }).getMany = originalGetMany
    }
  })
})

describe('atokenBalanceFromUserState', () => {
  it('converts a scaled balance with the cached index', () => {
    expect(atokenBalanceFromUserState((RAY * 3n << 128n) | 7n)).toBe(21n)
  })

  it('reports an absent cached index as unusable rather than as an index of 1', () => {
    expect(atokenBalanceFromUserState(7n)).toBeNull()
  })

  it('reads a zero scaled balance as a real zero', () => {
    expect(atokenBalanceFromUserState(0n)).toBe(0n)
    expect(atokenBalanceFromUserState(RAY << 128n)).toBe(0n)
  })
})
