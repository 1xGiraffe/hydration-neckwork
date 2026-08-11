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

// The tag directory each test wants allTags() to report. Hoisted so the mock factory
// below — which vitest applies before the module graph is built — can close over it.
const fixture = vi.hoisted(() => ({ tags: [] as { tagId: string; name: string; icon?: string; color?: string }[] }))
vi.mock('../src/services/tagService.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/tagService.ts')>(),
  allTags: () => fixture.tags.map(t => ({ tagId: t.tagId, name: t.name, color: t.color ?? '#fff', icon: t.icon ?? '', note: '', members: [] })),
}))

async function setup(tags: TagFixture[], identities: IdentityFixture[] = []) {
  fixture.tags = tags
  // Still a fresh graph per test: identity state and search's 10s query-keyed cache
  // are module-level, and these tests reuse one query across different fixtures.
  vi.resetModules()
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
    vi.resetModules()
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

describe('search: within the tag group, match quality ranks ahead of directory order', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  // Regression: allTags() returned tags in directory/insertion order, so an
  // exact "Kraken" tag inserted after "HDX Kraken LP" rendered below it —
  // q=kraken came back ["HDX Kraken LP", "Kraken", ...] instead of leading
  // with the exact name match.
  it('ranks an exact tag name first, then a prefix, then a word-start match', async () => {
    const { search } = await setup([
      { tagId: 'hdx-kraken-lp', name: 'HDX Kraken LP' },
      { tagId: 'kraken', name: 'Kraken' },
      { tagId: 'kraken-whales', name: 'Kraken Whales' },
    ])

    const tags = (await search('kraken')).filter(r => r.type === 'tag')
    expect(tags.map(r => r.value)).toEqual(['kraken', 'kraken-whales', 'hdx-kraken-lp'])
  })

  it('breaks a tie in match quality alphabetically by tag name', async () => {
    const { search } = await setup([
      { tagId: 'polkadot-treasury', name: 'Polkadot Treasury' },
      { tagId: 'moonbeam-treasury', name: 'Moonbeam Treasury' },
      { tagId: 'treasury', name: 'Treasury' },
    ])

    const tags = (await search('treasury')).filter(r => r.type === 'tag')
    expect(tags.map(r => r.value)).toEqual(['treasury', 'moonbeam-treasury', 'polkadot-treasury'])
  })
})
