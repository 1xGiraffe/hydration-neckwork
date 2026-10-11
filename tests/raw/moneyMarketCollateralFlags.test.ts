import { describe, expect, it } from 'vitest'
import { snapshotMoneyMarketCollateralFlags, type EthCall } from '../../src/raw/moneyMarket.ts'

// Aave packs a user's configuration into one word, two bits per reserve in
// reserve-list order: bit 2i is "borrowing reserve i", bit 2i+1 is "reserve i is my
// collateral". The read exists because this chain does not emit an event for every
// way that bit moves, so what it writes has to be the word itself.
const POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const RESERVES = [
  '0x0000000000000000000000000000000100000005',
  '0x000000000000000000000000000000010000000f',
  '0x00000000000000000000000000000001000002b2',
]
const USER = '0x74a9accd4e9b0d530c7047e0ede0a6b1d1d8ba5c'
const OTHER = '0x0000000000000000000000000000000000000abc'
const word = (bits: bigint) => `0x${bits.toString(16).padStart(64, '0')}`
const RESERVES_LIST = '0xd1946dbc'
const USER_CONFIG = '0x4417a583'

// Reserve list: offset, length, then one padded address per entry.
const reservesList = (reserves = RESERVES) => `0x${(32n).toString(16).padStart(64, '0')}${BigInt(reserves.length).toString(16).padStart(64, '0')}${reserves.map(r => r.slice(2).padStart(64, '0')).join('')}`

// A fake EthCallBatch: the reserve list, and each user's word (null = that call failed).
function chain(words: Record<string, string | null>, opts: { reserves?: string | null; userBatchThrows?: boolean } = {}) {
  const calls: Array<{ block: number; data: string[] }> = []
  const call = async (batch: EthCall[], block: number) => {
    calls.push({ block, data: batch.map(c => c.data) })
    if (opts.userBatchThrows && batch[0]?.data.startsWith(USER_CONFIG)) throw new Error('timeout')
    return batch.map(c => {
      if (c.to !== POOL) return null
      if (c.data === RESERVES_LIST) return opts.reserves === undefined ? reservesList() : opts.reserves
      const user = `0x${c.data.slice(USER_CONFIG.length + 24)}`
      return words[user] ?? null
    })
  }
  return { call, calls }
}

describe('snapshotMoneyMarketCollateralFlags', () => {
  it('reads the collateral bit of each reserve, not the borrowing bit, at the asked block', async () => {
    // Borrowing reserve 0 (bit 0), collateral in reserve 2 (bit 5).
    const c = chain({ [USER]: word(0b100001n) })
    const { flags, failedUsers } = await snapshotMoneyMarketCollateralFlags([USER], 14_786_000, POOL, c.call)

    expect(failedUsers).toEqual([])
    expect(flags.map(f => [f.reserve_address, f.enabled])).toEqual([
      [RESERVES[0], 0], [RESERVES[1], 0], [RESERVES[2], 1],
    ])
    expect(flags.every(f => f.user_address === USER && f.pool_address === POOL && f.block_height === 14_786_000)).toBe(true)
    expect(c.calls.every(call => call.block === 14_786_000)).toBe(true)
  })

  it('writes the disabled reserves too, so a read can retract an earlier enable', async () => {
    const { flags } = await snapshotMoneyMarketCollateralFlags([USER], 14_786_000, POOL, chain({ [USER]: word(0n) }).call)
    expect(flags).toHaveLength(RESERVES.length)
    expect(flags.every(f => f.enabled === 0)).toBe(true)
  })

  it('reports a user whose word could not be read instead of writing it as uncollateralised', async () => {
    const { flags, failedUsers } = await snapshotMoneyMarketCollateralFlags([USER, OTHER], 14_786_000, POOL, chain({ [USER]: null, [OTHER]: word(0b10n) }).call)
    expect(failedUsers).toEqual([USER])
    expect(flags.map(f => [f.user_address, f.reserve_address, f.enabled])).toEqual([
      [OTHER, RESERVES[0], 1], [OTHER, RESERVES[1], 0], [OTHER, RESERVES[2], 0],
    ])
  })

  it('fails a batch whose transport failed, user by user, and the whole read when the reserve list is unreadable', async () => {
    const down = await snapshotMoneyMarketCollateralFlags([USER], 14_786_000, POOL, chain({ [USER]: word(2n) }, { userBatchThrows: true }).call)
    expect(down).toEqual({ flags: [], failedUsers: [USER] })
    await expect(snapshotMoneyMarketCollateralFlags([USER], 14_786_000, POOL, chain({ [USER]: word(2n) }, { reserves: null }).call))
      .rejects.toThrow('returned no reserve list at block 14786000')
  })

  it('reads nothing for no users', async () => {
    const c = chain({})
    expect(await snapshotMoneyMarketCollateralFlags([], 1, POOL, c.call)).toEqual({ flags: [], failedUsers: [] })
    expect(c.calls).toEqual([])
  })
})
