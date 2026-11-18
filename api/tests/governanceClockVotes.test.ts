import { describe, expect, it } from 'vitest'
import { measuredRate } from '../src/services/governanceRead.ts'
import { pageVoters } from '../src/services/referendumVotesPage.ts'
import type { ReferendumVoter } from '../src/services/governanceService.ts'

describe('the governance projector pace', () => {
  it('is the mean block time over the window', () => {
    // 302,400 blocks over 7.56 days: 2,160 ms a block, not the nominal 2,000.
    expect(measuredRate(100, 0, 302_500, 302_400 * 2160, 2000)).toBe(2160)
  })
  it('refuses a window too short or a pace out of band, so the nominal stands', () => {
    expect(measuredRate(100, 0, 1_000, 900 * 2000, 2000)).toBeNull()
    expect(measuredRate(0, 0, 100_000, 100_000 * 5000, 2000)).toBeNull()
    expect(measuredRate(0, 0, 100_000, NaN, 2000)).toBeNull()
  })
})

const voter = (id: string, side: ReferendumVoter['side'], weighted: string, block: number, display?: string): ReferendumVoter => ({
  account: { accountId: id, address: `addr${id}`, emoji: '', tag: null, identity: display ? { display, verified: false, email: '', web: '', twitter: '' } : null, profile: null } as unknown as ReferendumVoter['account'],
  kind: side === 'Split' ? 'Split' : 'Standard', side, conviction: null, convictionIndex: null,
  balance: weighted, ayeBalance: '0', nayBalance: '0', abstainBalance: '0',
  weightedAye: side === 'Aye' || side === 'Split' ? weighted : '0', weightedNay: side === 'Nay' || side === 'Split' ? weighted : '0', weighted,
  valueUsd: null, blockHeight: block, eventIndex: 0, extrinsicIndex: null, timestamp: '', removed: false,
})

describe('a page of voters', () => {
  const all = [
    voter('0xa', 'Aye', '300000000000000000000000', 10, 'Alice'),
    voter('0xb', 'Nay', '900000000000000000000000', 20),
    voter('0xc', 'Split', '5', 30),
    voter('0xd', 'Aye', '7', 40),
  ]
  it('orders by power (128-bit exact) or by time, with exact totals', () => {
    const power = pageVoters(all, { sort: 'power', side: 'all', q: '', offset: 0, limit: 2 })
    expect(power.rows.map(r => r.account!.accountId)).toEqual(['0xb', '0xa'])
    expect([power.total, power.totalAll]).toEqual([4, 4])
    expect(pageVoters(all, { sort: 'time', side: 'all', q: '', offset: 2, limit: 2 }).rows.map(r => r.account!.accountId)).toEqual(['0xb', '0xa'])
  })
  it('filters abstain to the votes with an abstain part', () => {
    const abstainer = { ...voter('0xe', 'SplitAbstain', '9', 50), kind: 'SplitAbstain' as const, abstainBalance: '9' }
    expect(pageVoters([...all, abstainer], { sort: 'power', side: 'abstain', q: '', offset: 0, limit: 10 }).rows.map(r => r.account!.accountId)).toEqual(['0xe'])
  })
  it('counts a Split vote on both sides, and searches by name or by a normalized address', () => {
    expect(pageVoters(all, { sort: 'power', side: 'aye', q: '', offset: 0, limit: 10 }).rows.map(r => r.account!.accountId)).toEqual(['0xa', '0xd', '0xc'])
    expect(pageVoters(all, { sort: 'power', side: 'nay', q: '', offset: 0, limit: 10 }).total).toBe(2)
    expect(pageVoters(all, { sort: 'power', side: 'all', q: 'alic', offset: 0, limit: 10 }).rows.map(r => r.account!.accountId)).toEqual(['0xa'])
    expect(pageVoters(all, { sort: 'power', side: 'all', q: 'whatever-spelling', accountId: '0xD', offset: 0, limit: 10 }).total).toBe(1)
  })
})
