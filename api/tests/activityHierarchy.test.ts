import { describe, expect, it } from 'vitest'
import { suppressSubordinateActivityRows, type ActivityRow } from '../src/services/explorerService.ts'

const account = (accountId: string) => ({ accountId } as ActivityRow['who'])
const row = (type: ActivityRow['type'], overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  type,
  blockHeight: 100,
  timestamp: '2026-07-15 00:00:00',
  eventIndex: 1,
  extrinsicIndex: 2,
  who: account('0xaaa'),
  to: null,
  asset: null,
  assetIn: null,
  assetOut: null,
  amount: null,
  amountIn: null,
  amountOut: null,
  valueUsd: null,
  ...overrides,
})

describe('suppressSubordinateActivityRows', () => {
  it.each(['trade', 'dca', 'xcm', 'liquidity', 'mm', 'staking', 'vote', 'otc'] as const)(
    'lets a %s activity own transfer legs in its extrinsic',
    type => {
      const parent = row(type)
      const transfer = row('transfer', { eventIndex: 2, who: account('0xbbb'), to: account('0xccc') })
      expect(suppressSubordinateActivityRows([transfer, parent])).toEqual([parent])
    },
  )

  it('matches hook/finalization transfer legs by block and involved account', () => {
    const dca = row('trade', { extrinsicIndex: null, eventIndex: 59, dca: true, who: account('0xowner') })
    const fee = row('transfer', { extrinsicIndex: null, eventIndex: 4, who: account('0xowner'), to: account('0xtreasury') })
    const unrelated = row('transfer', { extrinsicIndex: null, eventIndex: 5, who: account('0xother'), to: account('0xtreasury') })
    expect(suppressSubordinateActivityRows([fee, unrelated, dca])).toEqual([unrelated, dca])
  })

  it('keeps transfers from a different extrinsic or block', () => {
    const parent = row('staking')
    const otherExtrinsic = row('transfer', { extrinsicIndex: 3 })
    const otherBlock = row('transfer', { blockHeight: 101, extrinsicIndex: null })
    expect(suppressSubordinateActivityRows([parent, otherExtrinsic, otherBlock])).toEqual([parent, otherExtrinsic, otherBlock])
  })

  it('does not collapse independent semantic activities in a batch', () => {
    const vote = row('vote')
    const staking = row('staking', { eventIndex: 2 })
    expect(suppressSubordinateActivityRows([vote, staking])).toEqual([vote, staking])
  })
})
