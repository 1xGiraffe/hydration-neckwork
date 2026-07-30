import { afterEach, describe, expect, it } from 'vitest'
import { readErc20Balances, updateErc20Registry } from '../../src/evm/balances.ts'
import * as evmStorage from '../../src/types/evm/storage.ts'
import type { Block } from '../../src/types/support.ts'

const POOL_ACCOUNT = `0x${'11'.repeat(32)}`

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
})
