import { describe, it, expect } from 'vitest'
import { DEFAULT_TAGS, SYSTEM_TAG_IDS } from '../src/services/tagService.ts'
import { normalizeAddress } from '../src/services/addressIdentity.ts'
import { BIL_TAG_IDS } from '../src/services/explorerService.ts'

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
    expect(byId.get('polkadot-treasury')?.addresses).toHaveLength(6)
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

// BIL's parties each carry their own label: the vault (Hydration's side, the uBIL token),
// the Decentral lending pool its positions are in, that pool's position NFT, and the
// Decentral borrower. One tag for all four labelled the vault "Decentral".
describe('BIL and Decentral tags', () => {
  const byId = new Map(DEFAULT_TAGS.map(t => [t.tagId, t]))
  const members = (id: string) => byId.get(id)?.addresses.map(a => a.toLowerCase())

  it('labels the vault, the pool, the position NFT and the borrower each on its own', () => {
    expect(members('bil-vault')).toEqual(['0x6a21891db0940491603f3cca0a9f4dba4c6e810c'])
    expect(members('decentral-pool')).toEqual(['0x207a626c07b73e76134177d1f44b0f32e94adb5a'])
    expect(members('decentral-position-nft')).toEqual(['0xc91808c129c9766b13d22c9f0cd53db459c0bc48'])
    expect(members('bil-originator')).toEqual(['0x2333aa052610012c27e4fc176bc27095651dcbc6'])
    expect(byId.get('bil-vault')?.name).toBe('BIL Vault')
    expect(byId.get('bil-originator')?.name).toBe('Decentral Borrower')
  })

  // 0x15304c8f…a578df0 is the first 20 bytes of the BIL/HOLLAR stableswap pool's own
  // account (pool 10055): the BIL aToken files the pool's balance under it (its BIL
  // equals the pool's BIL reserve to the wei). It is the pool, not an issuer wallet.
  it('names only the deposit zap as the issuer, not the BIL/HOLLAR pool', () => {
    expect(members('bil-issuer')).toEqual(['0x646fd203bbcf19b35d79f58413bb07450fdbb1db'])
  })

  it('colours Hydration\'s side in the BIL market green and Decentral\'s side apart', () => {
    expect(byId.get('bil-vault')?.color).toBe(byId.get('bil-issuer')?.color)
    for (const id of ['decentral-pool', 'decentral-position-nft', 'bil-originator']) expect(byId.get(id)?.color).not.toBe(byId.get('bil-vault')?.color)
  })

  it('says where the borrowed HOLLAR goes, and what the Treasury pilot returned on the pool', () => {
    expect(byId.get('bil-originator')?.note).toMatch(/USDT/)
    const pool = byId.get('decentral-pool')?.note ?? ''
    expect(pool).toMatch(/200,000/)
    expect(pool).toMatch(/207,337\.97/)
  })

  // 0x6a21891db is the uBIL token contract, not a payment forwarder.
  it('describes the vault as the uBIL token', () => {
    expect(byId.get('bil-vault')?.note).toMatch(/uBIL/)
    expect(byId.get('bil-vault')?.note).not.toMatch(/forwarder/i)
  })

  it('treats every BIL and Decentral contract as an ERC-20 venue', () => {
    const tagged = DEFAULT_TAGS.filter(t => /^(bil|decentral)-/.test(t.tagId)).map(t => t.tagId)
    expect([...BIL_TAG_IDS].sort()).toEqual(tagged.sort())
  })
})
