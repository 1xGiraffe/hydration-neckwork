import { describe, it, expect } from 'vitest'
import { foldVoters, packItems } from '../src/components/voteBubbleLayout'
import { avgConvictionLabel } from '../src/utils/voteRows'
import type { ReferendumVoter, AccountRef } from '../src/types'
import type { ResolvedTag } from '../src/userTags'

const account = (id: string): AccountRef => ({ accountId: id, address: id, emoji: '', tag: null, identity: null, profile: null } as unknown as AccountRef)

function voter(over: Partial<ReferendumVoter> & { blockHeight: number }): ReferendumVoter {
  return {
    account: account('0x' + 'aa'.repeat(32)), kind: 'standard', side: 'Aye',
    conviction: 'Locked1x', convictionIndex: 1,
    balance: '1000', ayeBalance: '1000', nayBalance: '0', abstainBalance: '0',
    weightedAye: '1000', weightedNay: '0', weighted: '1000', valueUsd: 1,
    eventIndex: 1, extrinsicIndex: 1, timestamp: '2026-07-01 00:00:00', removed: false,
    ...over,
  } as ReferendumVoter
}

const TAG: ResolvedTag = { kind: 'user', id: 'tag-1', name: 'Whales', color: '#22c55e', icon: '🐳', listId: 'lib1' }
const inTag = (ids: string[]) => (a: AccountRef): ResolvedTag | null => (ids.includes(a.accountId) ? TAG : null)

describe('foldVoters', () => {
  const A = '0x' + '11'.repeat(32), B = '0x' + '22'.repeat(32), C = '0x' + '33'.repeat(32)

  it('folds two tagged voters into one group with exact integer sums', () => {
    const items = foldVoters([
      voter({ blockHeight: 1, account: account(A), weighted: '6000', weightedAye: '6000', balance: '1000' }),
      voter({ blockHeight: 2, account: account(B), weighted: '500', weightedAye: '500', balance: '5000' }),
      voter({ blockHeight: 3, account: account(C), weighted: '700', weightedAye: '700', balance: '700' }),
    ], inTag([A, B]))
    expect(items).toHaveLength(2)
    const tag = items.find(i => i.kind === 'tag')
    expect(tag && tag.kind === 'tag' ? tag.group : null).toMatchObject({
      voters: 2, weighted: '6500', balance: '6000', weightedAye: '6500', weightedNay: '0',
    })
    const solo = items.find(i => i.kind === 'voter')
    expect(solo && solo.kind === 'voter' ? solo.voter.account?.accountId : null).toBe(C)
  })

  it('keeps a single tagged voter individual — nothing to merge', () => {
    const items = foldVoters([voter({ blockHeight: 1, account: account(A) })], inTag([A]))
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('voter')
  })

  it('drops removed and zero-weight voters before folding', () => {
    const items = foldVoters([
      voter({ blockHeight: 1, account: account(A), removed: true }),
      voter({ blockHeight: 2, account: account(B), weighted: '0', weightedAye: '0' }),
    ], inTag([A, B]))
    expect(items).toHaveLength(0)
  })

  it('a null resolver keeps every voter individual (the anonymous packVoters contract)', () => {
    const items = foldVoters([
      voter({ blockHeight: 1, account: account(A) }),
      voter({ blockHeight: 2, account: account(B) }),
    ], () => null)
    expect(items.every(i => i.kind === 'voter')).toBe(true)
  })

  it('a group backing both sides packs as split', () => {
    const bubbles = packItems(foldVoters([
      voter({ blockHeight: 1, account: account(A), side: 'Aye', weighted: '1000', weightedAye: '1000', weightedNay: '0' }),
      voter({ blockHeight: 2, account: account(B), side: 'Nay', weighted: '2000', weightedAye: '0', weightedNay: '2000' }),
    ], inTag([A, B])))
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].side).toBe('split')
    expect(bubbles[0].weight).toBe(3000)
  })
})

describe('avgConvictionLabel', () => {
  it('recovers the capital-weighted mean in tenths with integer maths', () => {
    // 1000 at 6x + 5000 at 0.1x → (6000+500)/6000 = 1.083… → 1.1x
    expect(avgConvictionLabel('6500', '6000')).toBe('1.1x avg')
    expect(avgConvictionLabel('6000', '1000')).toBe('6.0x avg')
    expect(avgConvictionLabel('100', '1000')).toBe('0.1x avg')
  })
  it('reports nothing when there is no capital to weigh', () => {
    expect(avgConvictionLabel(null, null)).toBeNull()
    expect(avgConvictionLabel('10', '0')).toBeNull()
  })
})
