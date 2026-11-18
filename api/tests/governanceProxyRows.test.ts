import { describe, expect, it } from 'vitest'
import { govProxyRow } from '../src/services/governanceRead.ts'
import type { AccountRef } from '../src/services/explorerService.ts'

// One rule for whether a proxy relation can vote, said once here and read by the UI:
// only an Any or a Governance proxy with no delay can; `blocked` names the reason
// another cannot, and `holder` the related account the relation belongs to.
const ref = (id: string) => ({ accountId: id, address: id }) as unknown as AccountRef

describe('govProxyRow', () => {
  it('lets only Any and Governance proxies with no delay vote', () => {
    expect(govProxyRow({ accountId: '0xa', proxyType: 'Any', delay: 0 }, '0x1', ref)).toMatchObject({ canVote: true, blocked: null, holder: '0x1' })
    expect(govProxyRow({ accountId: '0xa', proxyType: 'Governance', delay: 0 }, '0x1', ref)).toMatchObject({ canVote: true, blocked: null })
  })

  it('names why another cannot: its type first, else its delay', () => {
    expect(govProxyRow({ accountId: '0xa', proxyType: 'Any', delay: 43_200 }, '0x1', ref)).toMatchObject({ canVote: false, blocked: 'delay' })
    expect(govProxyRow({ accountId: '0xa', proxyType: 'Staking', delay: 0 }, '0x1', ref)).toMatchObject({ canVote: false, blocked: 'type' })
    expect(govProxyRow({ accountId: '0xa', proxyType: 'Staking', delay: 100 }, '0x1', ref)).toMatchObject({ canVote: false, blocked: 'type' })
  })
})
