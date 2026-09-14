import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  initIdentityService,
  loadIdentities,
  searchIdentitiesByDisplay,
  stopIdentityRefresh,
} from '../src/services/identityService.ts'

// Search must surface the account whose on-chain display IS the query. Truncating
// the scan at the limit dropped it whenever enough other names merely contained the
// query: "Validator" returned five accounts called "… Validator …" and never the one
// called "Validator".
const id = (n: number) => '0x' + n.toString(16).padStart(64, '0')

const identity = (accountId: string, display: string) => ({
  chain: 'hydration',
  priority: 0,
  account_id: accountId,
  display,
  verified: 0,
  email: '',
  web: '',
  twitter: '',
})

const clientWith = (rows: ReturnType<typeof identity>[]) => ({
  query: vi.fn(async () => ({ json: async () => rows })),
}) as never

describe('identity display search', () => {
  beforeEach(async () => {
    initIdentityService(clientWith([
      identity(id(1), 'NNP | HDX Validator'),
      identity(id(2), '🧠 Primecore Validator'),
      identity(id(3), 'PDP_Validator'),
      identity(id(4), 'ValidatorAlliance'),
      identity(id(5), 'REPE «Validator alliance»'),
      identity(id(6), 'Validator'),
      identity(id(7), 'HydraDX'),
      identity(id(8), 'Hydra'),
    ]))
    await loadIdentities()
  })

  afterEach(() => {
    stopIdentityRefresh()
    vi.restoreAllMocks()
  })

  it('ranks the exact display first even when it is scanned last', () => {
    const hits = searchIdentitiesByDisplay('Validator', 5)

    expect(hits[0].accountId).toBe(id(6))
    expect(hits).toHaveLength(5)
  })

  it('ranks a prefix match ahead of a substring match', () => {
    const hits = searchIdentitiesByDisplay('Hydra', 5).map(h => h.identity.display)

    expect(hits).toEqual(['Hydra', 'HydraDX'])
  })

  it('prefers the shortest display inside a bucket', () => {
    const hits = searchIdentitiesByDisplay('valid', 3).map(h => h.identity.display)

    // Both "Validator" and "ValidatorAlliance" are prefix matches, so they rank
    // above the substring match, shortest display first.
    expect(hits).toEqual(['Validator', 'ValidatorAlliance', 'PDP_Validator'])
  })

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(searchIdentitiesByDisplay('  vALIDATOR ', 1)[0].accountId).toBe(id(6))
  })

  it('returns nothing for an empty query', () => {
    expect(searchIdentitiesByDisplay('   ', 5)).toEqual([])
  })
})

// The search's address results come from four sources — a direct address match,
// the identity display index, the emoji-name index and the 3-letter suffix index —
// and all four are meant to share one budget (MAX_ACCOUNT_RESULTS). Identity was
// the only one called with its own smaller number, so a display many accounts
// carry surfaced a handful and left the rest of the budget unspent: 52 indexed
// accounts spell "Parity", and the dropdown offered five.
describe('identity search draws from the shared account budget', () => {
  afterEach(() => { stopIdentityRefresh() })

  it('returns as many matches as it is asked for, not a fixed five', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => identity(id(i + 1), `Somebody ${i} (Parity)`))
    initIdentityService(clientWith(rows))
    await loadIdentities()

    expect(searchIdentitiesByDisplay('parity', 5)).toHaveLength(5)
    expect(searchIdentitiesByDisplay('parity', 15)).toHaveLength(15)
    // Never more than the index holds.
    expect(searchIdentitiesByDisplay('parity', 100)).toHaveLength(30)
  })
})
