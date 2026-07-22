import { describe, expect, it } from 'vitest'
import { originTitle } from '../src/components/ActivityRows'
import type { AccountIdentity, AccountRef, ExtrinsicOrigin } from '../src/types'

function account(address: string, identity?: string): AccountRef {
  const id: AccountIdentity | undefined = identity ? { display: identity, verified: false, email: '', web: '', twitter: '' } : undefined
  return { accountId: address, address, emoji: '🦊', tag: null, identity: id }
}

describe('originTitle', () => {
  it('describes a proxy execution in one line', () => {
    const origin: ExtrinsicOrigin = { kind: 'proxy' }
    expect(originTitle(origin)).toBe('Executed on behalf of this account by a proxy')
  })

  it('lists the operation state then one line per timeline entry — 4 lines for a 3-entry timeline', () => {
    const origin: ExtrinsicOrigin = {
      kind: 'multisig',
      state: 'executed',
      timeline: [
        { account: account('addr-initiator-000000001'), action: 'initiated', timestamp: '2026-07-20 10:00:00' },
        { account: account('addr-approver-0000000002'), action: 'approved', timestamp: '2026-07-20 10:05:00' },
        { account: account('addr-executor-0000000003'), action: 'executed', timestamp: '2026-07-20 10:10:00' },
      ],
    }
    const lines = originTitle(origin).split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('Multisig operation · executed')
  })

  it('prefers the identity display name over the address when set', () => {
    const origin: ExtrinsicOrigin = {
      kind: 'multisig',
      timeline: [{ account: account('addr-initiator-000000001', 'Treasury Signer'), action: 'initiated', timestamp: '2026-07-20 10:00:00' }],
    }
    expect(originTitle(origin)).toBe('Multisig operation · executed\ninitiated by Treasury Signer · 2026-07-20 10:00:00')
  })

  it('falls back to a shortened address (first 6 + … + last 4) with no identity', () => {
    const origin: ExtrinsicOrigin = {
      kind: 'multisig',
      state: 'pending',
      timeline: [{ account: account('addr-initiator-000000001'), action: 'initiated', timestamp: '2026-07-20 10:00:00' }],
    }
    expect(originTitle(origin)).toBe('Multisig operation · pending\ninitiated by addr-i…0001 · 2026-07-20 10:00:00')
  })
})
