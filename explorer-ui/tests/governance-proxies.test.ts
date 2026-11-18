import { describe, expect, it } from 'vitest'
import { delayText, proxiesToOffer, proxyBlock, proxyBlockReason, splitByVote } from '../src/governanceProxies'

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const ME = id(1)
const row = (account: number, proxyType: string, delay: number, extra: { holder?: string; blocked?: 'delay' | 'type' | null } = {}) => ({
  account: { accountId: id(account) }, proxyType, delay, canVote: (proxyType === 'Any' || proxyType === 'Governance') && delay === 0, ...extra,
})

describe('proxy voting rules', () => {
  it('says why a relation cannot vote, from the api when it says so and by the same rule when it does not', () => {
    expect(proxyBlock(row(2, 'Any', 0))).toBeNull()
    expect(proxyBlock(row(2, 'Any', 43_200))).toBe('delay')
    expect(proxyBlock(row(2, 'Staking', 0))).toBe('type')
    expect(proxyBlock({ ...row(2, 'Any', 43_200), blocked: 'delay' })).toBe('delay')
  })

  it('states a delay at the measured pace, not at six-second blocks', () => {
    expect(delayText(43_200, 2_160)).toBe('about 26 hours')
    expect(delayText(1_000, 2_160)).toBe('about 36 minutes')
    expect(delayText(200_000, 2_160)).toBe('about 5 days')
    expect(delayText(43_200, null)).toBe('43,200 blocks')
    expect(proxyBlockReason(row(2, 'Any', 43_200), 2_160)).toContain('about 26 hours')
    expect(proxyBlockReason(row(2, 'Any', 0), 2_160)).toBeNull()
  })

  it('splits each direction so a "can vote" group never holds one that cannot', () => {
    const { voting, other } = splitByVote([row(2, 'Any', 0), row(3, 'Any', 43_200), row(4, 'Governance', 0), row(5, 'Staking', 0)])
    expect(voting.map(r => r.account.accountId)).toEqual([id(2), id(4)])
    expect(other.map(r => r.account.accountId)).toEqual([id(3), id(5)])
  })

  it('offers one relation per account: the one that can vote, Any over Governance, delayed ones last', () => {
    const offered = proxiesToOffer([
      row(3, 'Any', 43_200),
      row(2, 'Governance', 0),
      row(2, 'Any', 0),
      row(3, 'Governance', 0),
      row(4, 'Any', 100),
      row(5, 'Staking', 0),
    ], ME)
    // In the order each account first appears, the ones that can vote first.
    expect(offered.map(r => [r.account.accountId, r.proxyType, r.delay])).toEqual([
      [id(3), 'Governance', 0],
      [id(2), 'Any', 0],
      [id(4), 'Any', 100],
    ])
  })

  it('never offers a relation that belongs to another account (an EVM twin the api merged in)', () => {
    const offered = proxiesToOffer([row(2, 'Any', 0, { holder: id(9) }), row(3, 'Any', 0, { holder: ME.toUpperCase().replace('0X', '0x') }), row(4, 'Any', 0)], ME)
    expect(offered.map(r => r.account.accountId)).toEqual([id(3), id(4)])
  })
})
