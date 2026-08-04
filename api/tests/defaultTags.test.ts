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

// The BIL primary sale routes its HOLLAR proceeds through three addresses that
// belong to the originator, not to the issuance operator: a forwarder contract,
// the funding vault it sweeps into, and the wallet that converts the proceeds to
// USDT and withdraws them over XCM. Untagged, the last of those reads as an
// anonymous whale selling half a million HOLLAR for no visible reason.
describe('BIL originator tag', () => {
  const byId = new Map(DEFAULT_TAGS.map(t => [t.tagId, t]))

  it('claims the operator wallet, the funding vault and the uBIL issuance contract', () => {
    const tag = byId.get('bil-originator')
    expect(tag?.addresses.map(a => a.toLowerCase())).toEqual([
      '0x2333aa052610012c27e4fc176bc27095651dcbc6',
      '0x207a626c07b73e76134177d1f44b0f32e94adb5a',
      '0x6a21891db0940491603f3cca0a9f4dba4c6e810c',
    ])
  })

  it('stays distinct from the issuance operator tag', () => {
    expect(byId.get('bil-issuer')?.addresses).not.toContain('0x2333aa052610012c27e4fc176bc27095651dcbc6')
    expect(byId.get('bil-originator')?.tagId).not.toBe(byId.get('bil-issuer')?.tagId)
  })

  it('shares the BIL market colour so both sides of the sale read as one market', () => {
    expect(byId.get('bil-originator')?.color).toBe(byId.get('bil-issuer')?.color)
  })

  it('says in its note where the proceeds go and what the Treasury pilot returned', () => {
    const note = byId.get('bil-originator')?.note ?? ''
    expect(note).toMatch(/HOLLAR/)
    expect(note).toMatch(/USDT/)
    expect(note).toMatch(/200,000/)
    expect(note).toMatch(/207,337\.97/)
  })

  // 0x6a21891db is the uBIL token contract, not a payment forwarder: it was given
  // its roles on 2026-07-24 and has minted uBIL from the zero address 25 times
  // (694,503.35 uBIL), handing each mint to the BIL aToken. It moves the buyer's
  // HOLLAR on to the vault as part of that sale, which is what made it look like a
  // forwarder. Naming it wrongly in the note misdescribes the one address a reader
  // is most likely to arrive at from the uBIL side of the flow.
  it('describes the uBIL issuance contract for what it is', () => {
    const note = byId.get('bil-originator')?.note ?? ''
    expect(note).toMatch(/uBIL/)
    expect(note).not.toMatch(/forwarder/i)
  })
})
