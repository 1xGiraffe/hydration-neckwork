import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapshotMoneyMarketCollateralFlags } from '../../src/raw/moneyMarket.ts'

// Aave packs a user's configuration into one word, two bits per reserve in
// reserve-list order: bit 2i is "borrowing reserve i", bit 2i+1 is "reserve i is my
// collateral". The snapshot exists because this chain does not emit an event for
// every way that bit moves, so what it writes has to be the word itself.
const POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const RESERVES = [
  '0x0000000000000000000000000000000100000005',
  '0x000000000000000000000000000000010000000f',
  '0x00000000000000000000000000000001000002b2',
]
const USER = '0x74a9accd4e9b0d530c7047e0ede0a6b1d1d8ba5c'
const word = (bits: bigint) => `0x${bits.toString(16).padStart(64, '0')}`

// Reserve list: offset, length, then one padded address per entry.
const reservesList = () => `0x${(32n).toString(16).padStart(64, '0')}${BigInt(RESERVES.length).toString(16).padStart(64, '0')}${RESERVES.map(r => r.slice(2).padStart(64, '0')).join('')}`

function rpc(configWord: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as unknown
    const one = (request: { id: string; params: [{ data: string }, string] }) =>
      ({ jsonrpc: '2.0', id: request.id, result: request.params[0].data.startsWith('0xd1946dbc') ? reservesList() : configWord })
    const result = Array.isArray(body) ? body.map(one) : one(body as { id: string; params: [{ data: string }, string] })
    return { ok: true, status: 200, statusText: 'OK', json: async () => result } as unknown as Response
  })
}

afterEach(() => { vi.restoreAllMocks() })

describe('snapshotMoneyMarketCollateralFlags', () => {
  it('reads the collateral bit of each reserve, not the borrowing bit', async () => {
    // Borrowing reserve 0 (bit 0), collateral in reserve 2 (bit 5).
    rpc(word(0b100001n))
    const { flags, failedUsers } = await snapshotMoneyMarketCollateralFlags([USER], 14_786_000, POOL)

    expect(failedUsers).toEqual([])
    expect(flags.map(f => [f.reserve_address, f.enabled])).toEqual([
      [RESERVES[0], 0], [RESERVES[1], 0], [RESERVES[2], 1],
    ])
    expect(flags.every(f => f.user_address === USER && f.pool_address === POOL && f.block_height === 14_786_000)).toBe(true)
  })

  it('writes the disabled reserves too, so a sweep can retract an earlier enable', async () => {
    rpc(word(0n))
    const { flags } = await snapshotMoneyMarketCollateralFlags([USER], 14_786_000, POOL)
    expect(flags).toHaveLength(RESERVES.length)
    expect(flags.every(f => f.enabled === 0)).toBe(true)
  })

  it('reports a user whose word could not be read instead of writing it as uncollateralised', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { id: string; params: [{ data: string }, string] }
      const reserveCall = !Array.isArray(body) && body.params[0].data.startsWith('0xd1946dbc')
      const result = reserveCall
        ? { jsonrpc: '2.0', id: body.id, result: reservesList() }
        : [{ jsonrpc: '2.0', id: (body as unknown as { id: string }[])[0].id, error: { message: 'execution reverted' } }]
      return { ok: true, status: 200, statusText: 'OK', json: async () => result } as unknown as Response
    })
    const { flags, failedUsers } = await snapshotMoneyMarketCollateralFlags([USER], 14_786_000, POOL)
    expect(flags).toEqual([])
    expect(failedUsers).toEqual([USER])
  })
})
