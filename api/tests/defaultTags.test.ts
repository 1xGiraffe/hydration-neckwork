import { describe, it, expect } from 'vitest'
import { DEFAULT_TAGS, SYSTEM_TAG_IDS } from '../src/services/tagService.ts'
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

// One account, one tag. Two definitions naming the same pot made its label depend on
// insertion order (byAccount kept the last label_id, the grouped SQL aggregates kept
// any()), and let a system pot escape the suppression the other tag exists to apply:
// fee-staking-rewards pointed at modl'feeproc/', the fee-processor account.
describe('default tag membership is exclusive', () => {
  it('never claims one account under two tags', () => {
    const owner = new Map<string, string>()
    for (const def of DEFAULT_TAGS) {
      for (const address of def.addresses) {
        const accountId = normalizeAddress(address)?.accountId
        if (!accountId) continue
        const previous = owner.get(accountId)
        expect(previous, `${accountId} claimed by both ${previous} and ${def.tagId}`).toBeUndefined()
        owner.set(accountId, def.tagId)
      }
    }
  })

  it('leaves the fee-processor pot to the tag that suppresses it', () => {
    const feeproc = DEFAULT_TAGS.filter(d => d.addresses.some(a => normalizeAddress(a)?.accountId?.startsWith('0x6d6f646c66656570726f632f')))

    expect(feeproc.map(d => d.tagId)).toEqual(['fee-processor'])
    expect(SYSTEM_TAG_IDS.has('fee-processor')).toBe(true)
  })
})
