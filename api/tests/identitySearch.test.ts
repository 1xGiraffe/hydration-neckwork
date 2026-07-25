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
