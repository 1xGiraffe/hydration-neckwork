import { describe, expect, it } from 'vitest'
import { mergeBreakdownCatchup, mergeDashboardCatchup, mergeFlowCatchup } from '../src/utils/userRevenueMerge'
import { breakdownWindowNote } from '../src/components/userRevenueLabels'
import type { UserRevenueBreakdown, UserRevenueDashboard, UserRevenueFlowResponse } from '../src/types'

const row = (stream: string, label: string, earned: number) => ({ stream, label, sign: 'both' as const, revisable: true, toggle: false, coverage: '', earned, paid: 0, net: earned, unpriced: 1 })

describe('the catch-up stream reads as token accrual in the UI (one rule)', () => {
  it('folds the dashboard breakdown and history', () => {
    const d = {
      breakdown: [row('token_accrual', 'Yield-bearing token accrual', 10), row('token_accrual_catchup', 'Yield-bearing token accrual, dated back', 5), row('farm_rewards', 'Farms', 2)],
      history: { series: [
        { stream: 'token_accrual', points: [{ t: 1, usd: 4, earned: 4, paid: 0 }] },
        { stream: 'token_accrual_catchup', points: [{ t: 1, usd: 1, earned: 1, paid: 0 }, { t: 2, usd: 3, earned: 3, paid: 0 }] },
      ] },
    } as unknown as UserRevenueDashboard
    const m = mergeDashboardCatchup(d)
    expect(m.breakdown.map(b => [b.stream, b.net, b.unpriced])).toEqual([['token_accrual', 15, 2], ['farm_rewards', 2, 1]])
    expect(m.history.series).toEqual([{ stream: 'token_accrual', points: [{ t: 1, usd: 5, earned: 5, paid: 0 }, { t: 2, usd: 3, earned: 3, paid: 0 }] }])
  })
  it('folds an account tab and the river\'s drips', () => {
    const b = {
      streams: [{ ...row('token_accrual_catchup', 'dated back', 5), items: [], otherCount: 0, otherNet: 0 }],
      points: [{ t: 1, earned: 5, paid: 0, net: 5, streams: [{ stream: 'token_accrual_catchup', net: 5 }] }],
    } as unknown as UserRevenueBreakdown
    const m = mergeBreakdownCatchup(b)
    expect(m.streams.map(s => [s.stream, s.label, s.net])).toEqual([['token_accrual', 'Yield-bearing token accrual', 5]])
    expect(m.points[0].streams).toEqual([{ stream: 'token_accrual', net: 5 }])
    const f = { drips: [
      { key: 'token_accrual:43', stream: 'token_accrual', label: 'Yield-bearing token accrual · PRIME', assetId: 43, usdPerBlock: 1 },
      { key: 'token_accrual_catchup:43', stream: 'token_accrual_catchup', label: 'Yield-bearing token accrual, dated back · PRIME', assetId: 43, usdPerBlock: 2 },
    ] } as unknown as UserRevenueFlowResponse
    expect(mergeFlowCatchup(f).drips).toEqual([{ key: 'token_accrual:43', stream: 'token_accrual', label: 'Yield-bearing token accrual · PRIME', assetId: 43, usdPerBlock: 3 }])
  })
})

describe('the breakdowns\' window note', () => {
  it('states the UTC-day window and the account cut, compactly', () => {
    expect(breakdownWindowNote('2026-09-05', '2026-10-04T18:00:00.000Z', true)).toBe('breakdowns: UTC days from 5 Sep through 18:00')
    expect(breakdownWindowNote('2025-10-05', '2026-10-04T18:00:00.000Z', false)).toBe('breakdowns: UTC days from 5 Oct 2025 through 18:00 · some months not published yet')
    expect(breakdownWindowNote(null, null)).toBeNull()
  })
})
