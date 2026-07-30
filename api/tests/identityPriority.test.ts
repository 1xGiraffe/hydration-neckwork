import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  identityForAccount,
  initIdentityService,
  loadIdentities,
  searchIdentitiesByDisplay,
  stopIdentityRefresh,
} from '../src/services/identityService.ts'

// The Identity pallet is keyed by AccountId, so one public key can hold a
// registration on Hydration and on both People chains at once. The snapshot keeps
// every row and stamps its chain's display priority; exactly one name may reach
// the explorer, and which one must not depend on the order ClickHouse returned.
const id = (n: number) => '0x' + n.toString(16).padStart(64, '0')

const row = (chain: string, priority: number, accountId: string, display: string, verified = 0) => ({
  chain, priority, account_id: accountId, display, verified, email: '', web: '', twitter: '',
})

const clientWith = (rows: ReturnType<typeof row>[]) => ({
  query: vi.fn(async () => ({ json: async () => rows })),
}) as never

const HYDRATION = row('hydration', 0, id(1), 'Hydration Name', 1)
const POLKADOT = row('polkadot-people', 1, id(1), 'Polkadot Name')
const KUSAMA = row('kusama-people', 2, id(1), 'Kusama Name')

describe('cross-chain identity priority', () => {
  afterEach(() => {
    stopIdentityRefresh()
    vi.restoreAllMocks()
  })

  it('prefers Hydration over every other source', async () => {
    initIdentityService(clientWith([KUSAMA, POLKADOT, HYDRATION]))
    await loadIdentities()

    expect(identityForAccount(id(1))).toMatchObject({ display: 'Hydration Name', verified: true })
  })

  it('resolves the same winner whatever order the rows arrive in', async () => {
    for (const rows of [[HYDRATION, POLKADOT, KUSAMA], [POLKADOT, HYDRATION, KUSAMA], [KUSAMA, HYDRATION, POLKADOT]]) {
      initIdentityService(clientWith(rows))
      await loadIdentities()

      expect(identityForAccount(id(1))?.display).toBe('Hydration Name')
    }
  })

  it('falls through to the next chain when Hydration has no name for the account', async () => {
    initIdentityService(clientWith([KUSAMA, POLKADOT]))
    await loadIdentities()

    expect(identityForAccount(id(1))?.display).toBe('Polkadot Name')
  })

  it('ranks a testnet name last', async () => {
    initIdentityService(clientWith([
      row('paseo-people', 4, id(2), 'Spoofed'),
      row('kusama-people', 2, id(2), 'Real'),
    ]))
    await loadIdentities()

    expect(identityForAccount(id(2))?.display).toBe('Real')
  })

  it('breaks a priority tie on the chain key rather than row order', async () => {
    const tied = [row('b-chain', 3, id(3), 'From B'), row('a-chain', 3, id(3), 'From A')]

    for (const rows of [tied, [...tied].reverse()]) {
      initIdentityService(clientWith(rows))
      await loadIdentities()

      expect(identityForAccount(id(3))?.display).toBe('From A')
    }
  })

  it('makes an external identity searchable like a Hydration one', async () => {
    initIdentityService(clientWith([
      row('hydration', 0, id(4), 'Local Validator'),
      row('polkadot-people', 1, id(5), 'Validator'),
    ]))
    await loadIdentities()

    // Exact match first, whichever chain it came from.
    expect(searchIdentitiesByDisplay('Validator', 5).map(hit => hit.accountId)).toEqual([id(5), id(4)])
  })

  it('searches the winning name only, not the ones it displaced', async () => {
    initIdentityService(clientWith([HYDRATION, POLKADOT, KUSAMA]))
    await loadIdentities()

    expect(searchIdentitiesByDisplay('Polkadot Name', 5)).toEqual([])
    expect(searchIdentitiesByDisplay('Hydration Name', 5)).toHaveLength(1)
  })
})
