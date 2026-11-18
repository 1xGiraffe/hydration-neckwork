import { describe, expect, it } from 'vitest'
import { lockName, perbillPct, spendableNowOf } from '../src/components/gov/GovUi'

describe('governance figures', () => {
  it('shows two decimals only when a share is within a point of its bar', () => {
    expect(perbillPct(162_100_000, 166_600_000)).toBe('16.21%')
    expect(perbillPct(988_000_000, 872_000_000)).toBe('98.8%')
    expect(perbillPct(264_347_841, 499_999_999)).toBe('26.4%')
    expect(perbillPct(499_999_999, 264_347_841)).toBe('50%')
    expect(perbillPct(1_000_000_000)).toBe('100%')
    expect(perbillPct(null)).toBe('—')
  })

  it('calls unlockable only what becomes spendable, and names the lock that holds the rest', () => {
    const base = { account: '0x', locked: '3', unlockableAsIs: '3', unlockableNow: '3', unlockableCollect: '3', openEnded: '0', schedule: [], nextUnlock: null, staker: null, lockObservedAt: 1, estimate: true as const }
    expect(spendableNowOf({ ...base, spendableNow: '0' })).toBe(0n)
    expect(spendableNowOf(base)).toBe(3n)
    expect(lockName('stk_stks')).toBe('HDX staking')
    expect(lockName('zzzz')).toBe('the “zzzz” lock')
  })
})
