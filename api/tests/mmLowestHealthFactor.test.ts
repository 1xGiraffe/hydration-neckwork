import { describe, expect, it } from 'vitest'
import { selectMoneyMarketBuckets, withLowestHealthFactor, type MmObservation, type MoneyMarketHistory } from '../src/services/moneyMarketHistory.ts'

const obs = (block: number, hf: string): MmObservation => ({
  block, totalCollateralBase: '1', totalDebtBase: '1', availableBorrowsBase: '0', liquidationThreshold: '8000', ltv: '7000', healthFactor: hf,
})

describe('withLowestHealthFactor', () => {
  it('takes the minimum of the in-bucket observations and the value carried in', () => {
    const a = obs(10, '1500000000000000000'), b = obs(25, '1300000000000000000')
    // bucket 0: a is last; bucket 1: quiet (a carried); bucket 2: b last, but a dip to 1.05 inside it
    const out = withLowestHealthFactor([a, a, b], new Map([[0, { hf: '1500000000000000000', block: 10 }], [2, { hf: '1050000000000000000', block: 22 }]]))
    expect(out.map(o => o?.lowestHealthFactor)).toEqual(['1500000000000000000', '1500000000000000000', '1050000000000000000'])
    expect(out[2]?.lowestAtBlock).toBe(22)
    expect(out[2]?.healthFactor).toBe('1300000000000000000')
  })
  it('lets a higher in-bucket value not mask a lower one carried in, and compares bucket 0 with the pre-window carry', () => {
    const before = obs(5, '1100000000000000000'), a = obs(10, '1400000000000000000')
    const out = withLowestHealthFactor([a], new Map([[0, { hf: '1400000000000000000', block: 10 }]]), before)
    expect(out[0]?.lowestHealthFactor).toBe('1100000000000000000')
    expect(out[0]?.lowestAtBlock).toBe(5)
  })
})

describe('selectMoneyMarketBuckets', () => {
  it('folds the lowest health factor of dropped buckets into the published one', () => {
    const point = (b: number, low: string) => ({
      b, suppliedUsd: 0n, borrowedUsd: 0n, netUsd: 0n, unpriced: 0, eModeCategoryId: null, unclaimedRewards: [],
      interestEarnedUsd: 0n, interestPaidUsd: 0n, interestUnpriced: 0,
      observation: { ...obs(b, '2000000000000000000'), lowestHealthFactor: low, lowestAtBlock: b },
    })
    const history = {
      reserveHistoryFrom: null, points: [],
      markets: [{ marketKey: 'core', poolAddress: '0x', stakingBacked: false, reserves: [], points: [point(0, '1900000000000000000'), point(1, '1020000000000000000'), point(2, '1800000000000000000'), point(3, '1700000000000000000')] }],
    } as unknown as MoneyMarketHistory
    const kept = selectMoneyMarketBuckets(history, [0, 2, 3]).markets[0].points
    expect(kept.map(p => [p.b, p.observation?.lowestHealthFactor, p.observation?.lowestAtBlock])).toEqual([
      [0, '1900000000000000000', 0], [2, '1020000000000000000', 1], [3, '1700000000000000000', 3],
    ])
  })
})
