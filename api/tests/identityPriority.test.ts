import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hasVerifiedIdentity,
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

const row = (chain: string, priority: number, accountId: string, display: string, verified = 0, email = '') => ({
  chain, priority, account_id: accountId, display, verified, email, web: '', twitter: '',
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

  it('never shows a testnet name, even where it is the only one', async () => {
    initIdentityService(clientWith([
      row('paseo-people', 4, id(2), 'Spoofed'),
      row('kusama-people', 2, id(2), 'Real'),
      row('westend-people', 3, id(6), 'Free name', 1),
      row('rococo', 1, id(7), 'Old testnet'),
    ]))
    await loadIdentities()

    expect(identityForAccount(id(2))?.display).toBe('Real')
    expect(identityForAccount(id(6))).toBeNull()
    expect(identityForAccount(id(7))).toBeNull()
    expect(searchIdentitiesByDisplay('Free name', 5)).toEqual([])
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

describe('verified identity (the forum\'s standing)', () => {
  afterEach(() => {
    stopIdentityRefresh()
    vi.restoreAllMocks()
  })

  it('counts an own registration a registrar judged, on Hydration or a Polkadot/Kusama People chain', async () => {
    initIdentityService(clientWith([
      row('hydration', 0, id(10), 'Judged here', 1),
      row('polkadot-people', 1, id(11), 'Judged on Polkadot', 1, 'a@example.org'),
      // An unverified name wins the display; a verified one on another chain still counts.
      row('hydration', 0, id(12), 'Unjudged here'),
      row('kusama-people', 2, id(12), 'Judged on Kusama', 1),
    ]))
    await loadIdentities()

    for (const n of [10, 11, 12]) expect(hasVerifiedIdentity(id(n))).toBe(true)
    expect(identityForAccount(id(12))?.display).toBe('Unjudged here')
  })

  it('does not count an unjudged name, a testnet, another chain, a username or a sub-identity', async () => {
    initIdentityService(clientWith([
      row('hydration', 0, id(20), 'Unjudged'),
      row('westend-people', 3, id(21), 'Testnet judged', 1, 'a@example.org'),
      row('paseo-people', 4, id(22), 'Testnet judged', 1),
      row('some-parachain', 5, id(23), 'Elsewhere judged', 1),
      row('polkadot-people', 1, id(24), 'alice.dot'),
      // A sub inherits its parent's judgement: "Parent/Sub", no contacts of its own.
      row('polkadot-people', 1, id(25), 'Parent/Sub', 1),
    ]))
    await loadIdentities()

    for (const n of [20, 21, 22, 23, 24, 25]) expect(hasVerifiedIdentity(id(n)), String(n)).toBe(false)
    expect(hasVerifiedIdentity('')).toBe(false)
  })
})
