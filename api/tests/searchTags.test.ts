import { afterEach, describe, expect, it, vi } from 'vitest'

// The complaint this file guards against: a name query that matches both a
// system tag and an on-chain identity display used to surface every fuzzy
// identity/address hit before the tag, crowding it out of view. tagService
// is mocked (like tagsRoute.test.ts) since allTags() reads a real directory
// this file doesn't otherwise need; everything else (identity search,
// referenda) goes through the real services with an empty-row client, mirroring
// searchReferenda.test.ts's init() pattern.
const id = (n: number) => '0x' + n.toString(16).padStart(64, '0')

function emptyRowClient() {
  return { query: vi.fn(async () => ({ json: async () => [] })) } as never
}

interface TagFixture { tagId: string; name: string; icon?: string; color?: string }
interface IdentityFixture { accountId: string; display: string }

async function setup(tags: TagFixture[], identities: IdentityFixture[] = []) {
  vi.resetModules()
  vi.doMock('../src/services/tagService.ts', () => ({
    allTags: () => tags.map(t => ({ tagId: t.tagId, name: t.name, color: t.color ?? '#fff', icon: t.icon ?? '', note: '', members: [] })),
  }))
  const { initExplorerService, search } = await import('../src/services/explorerService.ts')
  const { initGovernanceService } = await import('../src/services/governanceService.ts')
  const { initReferendumTitleService } = await import('../src/services/referendumTitleService.ts')
  const { initIdentityService, loadIdentities } = await import('../src/services/identityService.ts')

  initExplorerService(emptyRowClient())
  initGovernanceService(emptyRowClient())
  initReferendumTitleService(emptyRowClient())
  initIdentityService({
    query: vi.fn(async () => ({
      json: async () => identities.map(i => ({
        chain: 'hydration', priority: 0, account_id: i.accountId, display: i.display, verified: 0, email: '', web: '', twitter: '',
      })),
    })),
  } as never)
  await loadIdentities()

  return { search }
}

describe('search: tag matches rank ahead of identity matches', () => {
  afterEach(() => {
    vi.doUnmock('../src/services/tagService.ts')
    vi.restoreAllMocks()
  })

  it('returns the system tag before the identity match for the same name query', async () => {
    const { search } = await setup(
      [{ tagId: 'kraken', name: 'Kraken', icon: '🦑', color: '#7b6cf6' }],
      [{ accountId: id(1), display: 'Kraken Node Validator' }],
    )

    const results = await search('kraken')
    const tagIdx = results.findIndex(r => r.type === 'tag')
    const addrIdx = results.findIndex(r => r.type === 'address')

    expect(tagIdx).toBeGreaterThanOrEqual(0)
    expect(addrIdx).toBeGreaterThanOrEqual(0)
    expect(tagIdx).toBeLessThan(addrIdx)
    expect(results[0]).toMatchObject({ type: 'tag', value: 'kraken', label: 'Kraken' })
  })

  it('still returns nothing tag-shaped when no tag name matches, only the identity', async () => {
    const { search } = await setup(
      [{ tagId: 'treasury', name: 'Treasury' }],
      [{ accountId: id(2), display: 'Kraken Node Validator' }],
    )

    const results = await search('kraken')
    expect(results.some(r => r.type === 'tag')).toBe(false)
    expect(results.some(r => r.type === 'address')).toBe(true)
  })
})
