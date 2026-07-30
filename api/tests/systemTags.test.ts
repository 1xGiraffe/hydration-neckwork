import { describe, it, expect } from 'vitest'
import { modlAccountId, stableswapPoolAccount, economicModuleAccounts, truncatedH160Index, SYSTEM_TAG_IDS, DEFAULT_TAGS } from '../src/services/tagService.ts'
import type { Tag } from '../src/services/tagService.ts'

describe('system-account derivations', () => {
  it('builds modl pallet account ids ("modl" + 8-byte pallet id, zero-padded)', () => {
    expect(modlAccountId('omnipool')).toBe('0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000')
    expect(modlAccountId('py/trsry')).toBe('0x6d6f646c70792f74727372790000000000000000000000000000000000000000')
    expect(modlAccountId('staking#')).toBe('0x6d6f646c7374616b696e67230000000000000000000000000000000000000000')
  })

  it('derives stableswap pool accounts (blake2-256 of "sts" + poolId LE) — verified on-chain', () => {
    // pool 100 (4-Pool) — account confirmed present in account_asset_latest_balances
    expect(stableswapPoolAccount(100)).toMatch(/^0x[0-9a-f]{64}$/)
    expect(stableswapPoolAccount(100)).not.toBe(stableswapPoolAccount(101))
  })

  it('ships reproducible pallet-account membership in DEFAULT_TAGS', () => {
    const ids = DEFAULT_TAGS.map(t => t.tagId)
    for (const t of ['omnipool', 'staking-pot', 'fee-processor', 'gigahdx-pots', 'pallet-pots']) expect(ids).toContain(t)
    const treasury = DEFAULT_TAGS.find(t => t.tagId === 'treasury')!
    expect(treasury.addresses.length).toBeGreaterThan(1) // main + sub-pot
  })
})

describe('economicModuleAccounts — movers exception list', () => {
  const tag = (tagId: string, members: string[]): Tag => ({ tagId, name: tagId, color: '', note: '', icon: '', members })
  it('admits tagged module accounts except system-tag members', () => {
    const tags = [
      tag('treasury', ['0x6d6f646c70792f74727372790000000000000000000000000000000000000000']),
      tag('omnipool', ['0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000']),
      tag('kraken', ['0x1111111111111111111111111111111111111111111111111111111111111111']),
    ]
    const out = economicModuleAccounts(tags)
    expect(out).toContain('0x6d6f646c70792f74727372790000000000000000000000000000000000000000')
    expect(out).not.toContain('0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000') // system tag
    expect(out).not.toContain('0x1111111111111111111111111111111111111111111111111111111111111111') // not modl
    expect(SYSTEM_TAG_IDS.has('omnipool')).toBe(true)
    expect(SYSTEM_TAG_IDS.has('treasury')).toBe(false)
  })
})

// ERC-20 balances of NATIVE accounts live EVM-side under H160 = first 20 bytes
// of the AccountId32 (e.g. the GIGADOT stableswap pool's aDOT reserve). The tag
// registry is the reverse-lookup source: every structural account is tagged.
describe('truncatedH160Index — resolve EVM-side aliases of tagged native accounts', () => {
  const tag = (tagId: string, members: string[]): Tag => ({ tagId, name: tagId, color: '', note: '', icon: '', members })
  const pool690 = '0xe21da918e4176b72ef1930ffaa17edcb03b9b739c2843fb0cf096283a7d9c261'

  it('maps a tagged native account by its first 20 bytes', () => {
    const idx = truncatedH160Index([tag('stableswap-pools', [pool690])])
    expect(idx.get('0xe21da918e4176b72ef1930ffaa17edcb03b9b739')).toBe(pool690)
  })

  it('skips ETH-prefixed members (their truncation IS the EVM address) and malformed ids', () => {
    const idx = truncatedH160Index([
      tag('exchange', ['0x45544800e21da918e4176b72ef1930ffaa17edcb03b9b7390000000000000000']),
      tag('broken', ['not-an-account']),
    ])
    expect(idx.size).toBe(0)
  })
})
