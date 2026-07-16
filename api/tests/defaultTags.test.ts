import { describe, it, expect } from 'vitest'
import { DEFAULT_TAGS } from '../src/services/tagService.ts'
import { normalizeAddress } from '../src/services/addressIdentity.ts'

// Every address in the code-defined tag set must resolve to an AccountId32 —
// seedDefaultTags() skips (with a warning) anything that doesn't, so a typo here
// would silently drop a member on the next fresh-DB seed.
describe('DEFAULT_TAGS', () => {
  it('resolves every configured address to an account id', () => {
    for (const tag of DEFAULT_TAGS) {
      for (const address of tag.addresses) {
        const n = normalizeAddress(address)
        expect(n?.accountId, `${tag.tagId}: ${address}`).toMatch(/^0x[0-9a-f]{64}$/)
      }
    }
  })

  it('has unique tag ids and no duplicate members within a tag', () => {
    const ids = DEFAULT_TAGS.map(t => t.tagId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tag of DEFAULT_TAGS) {
      const members = tag.addresses.map(a => normalizeAddress(a)?.accountId)
      expect(new Set(members).size, tag.tagId).toBe(members.length)
    }
  })

  it('contains the default structural and entity tags', () => {
    const byId = new Map(DEFAULT_TAGS.map(t => [t.tagId, t]))
    expect(byId.get('kraken')?.addresses).toContain('12xtAYsRUrmbniiWQqJtECiBQrMn8AypQcXhnQAc6RB6XkLW')
    expect(byId.get('kraken')?.addresses).toContain('15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ')
    expect(byId.get('polkadot-treasury')?.addresses).toHaveLength(5)
    expect(byId.get('polkadot-fellowship')?.addresses).toHaveLength(1)
    expect(byId.get('moonbeam-treasury')?.addresses).toHaveLength(1)
  })
})
