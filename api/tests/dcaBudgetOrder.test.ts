import { describe, expect, it } from 'vitest'
import { compareDcasByBudgetUsdDesc, type ActiveDca } from '../src/services/explorerService.ts'

// Only the fields the comparator reads matter; the rest is a fixed shell.
const dca = (id: number, budgetUsd: number | null, fundingUsd: number | null = null): ActiveDca => ({
  id, direction: 'Sell',
  assetIn: { assetId: 5, iconAssetId: 5, symbol: 'DOT', name: null, decimals: 10, parachainId: null, origin: null },
  assetOut: { assetId: 0, iconAssetId: 0, symbol: 'HDX', name: null, decimals: 12, parachainId: null, origin: null },
  amountPerTrade: '1', totalAmount: budgetUsd == null ? '0' : '10', filledAmount: '0', remainingAmount: null,
  executionsDone: 0, period: 100, nextExecutionBlock: null, periodSeconds: null,
  valueUsd: null, budgetUsd, fundingBalance: null, fundingUsd,
  scheduleBlock: 1, scheduleIndex: 0,
  who: { accountId: '0x' + '11'.repeat(32), address: '1abc', emoji: '🐟', tag: null, identity: null, profile: null },
})

describe('compareDcasByBudgetUsdDesc — the asset page DCA ordering', () => {
  it('ranks budgeted and open-ended orders together by their dollar figure, descending', () => {
    const sorted = [dca(1, 100), dca(2, null, 300), dca(3, 500), dca(4, null, 40)].sort(compareDcasByBudgetUsdDesc)
    expect(sorted.map(d => d.id)).toEqual([3, 2, 1, 4])
  })
  it('sinks rows with no dollar value at all below a knowable $0', () => {
    const sorted = [dca(1, null, null), dca(2, null, 0), dca(3, 0)].sort(compareDcasByBudgetUsdDesc)
    expect(sorted.map(d => d.id)).toEqual([2, 3, 1])
  })
  it('keeps the incoming (recency) order for equal values — sort stability holds', () => {
    const sorted = [dca(9, 50), dca(7, 50), dca(8, 50)].sort(compareDcasByBudgetUsdDesc)
    expect(sorted.map(d => d.id)).toEqual([9, 7, 8])
  })
})
