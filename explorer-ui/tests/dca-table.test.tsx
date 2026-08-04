import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActiveDcaTable, dcaAggregates } from '../src/components/AccountSections'
import type { ActiveDca, AccountRef } from '../src/types'

const owner: AccountRef = {
  accountId: '0x' + 'ab'.repeat(32), address: '14gxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH1ebc',
  emoji: '🦢', tag: null, identity: null, profile: null,
}

const dca = (overrides: Partial<ActiveDca> = {}): ActiveDca => ({
  id: 34253,
  assetIn: { assetId: 4444, symbol: 'HEURC', name: null, decimals: 18, parachainId: null },
  assetOut: { assetId: 0, symbol: 'HDX', name: null, decimals: 12, parachainId: null },
  direction: 'Sell', amountPerTrade: '2272727272727272727', totalAmount: '100000000000000000000',
  filledAmount: '20454545454545454543', remainingAmount: '79545454545454545457',
  executionsDone: 9, period: 109, nextExecutionBlock: null, periodSeconds: 663,
  valueUsd: 2.28, budgetUsd: 100.4, fundingBalance: null,
  scheduleBlock: 13400000, scheduleIndex: 2, who: owner,
  ...overrides,
})

describe('ActiveDcaTable — account vs asset-page modes', () => {
  it('keeps the account-page shape: default title, no Owner column', () => {
    const html = renderToStaticMarkup(<ActiveDcaTable dcas={[dca()]} headBlock={13444900} now={Date.now()} />)
    expect(html).toContain('Active DCA orders')
    expect(html).not.toContain('>Owner<')
  })
  it('renders nothing for an empty list without emptyText (account page)', () => {
    expect(renderToStaticMarkup(<ActiveDcaTable dcas={[]} headBlock={0} now={Date.now()} />)).toBe('')
  })
  it('names the section and the owner of each row in asset-page mode', () => {
    const html = renderToStaticMarkup(
      <ActiveDcaTable dcas={[dca()]} headBlock={13444900} now={Date.now()} showOwner
        title={<>Buys · 1</>} emptyText="No ongoing DCA orders buying HDX" />,
    )
    expect(html).toContain('Buys · 1')
    expect(html).toContain('>Owner<')
    expect(html).toContain('14gx')                      // the owner pill's address text
    expect(html).toContain('data-dca-schedule="34253"') // row still targets its schedule
  })
  it('keeps an empty section visible with its emptyText in asset-page mode', () => {
    const html = renderToStaticMarkup(
      <ActiveDcaTable dcas={[]} headBlock={0} now={Date.now()} showOwner
        title={<>Sells · 0</>} emptyText="No ongoing DCA orders selling HDX" />,
    )
    expect(html).toContain('Sells · 0')
    expect(html).toContain('No ongoing DCA orders selling HDX')
  })
})

// The Budget cell states two things and their order carries the meaning: what the
// order started with, then what is still ahead of it. Both are money — the sold
// asset's amount answers "how much of the token", which is not the question a
// reader of a budget asks.
describe('ActiveDcaTable — the Budget cell', () => {
  const render = (d: ActiveDca) =>
    renderToStaticMarkup(<ActiveDcaTable dcas={[d]} headBlock={13444900} now={Date.now()} />)

  it('states the budget value and the remainder beside it, on one line', () => {
    // A $100 budget with 79.5% of it unspent.
    const html = render(dca())
    expect(html).toContain('$100 · ')
    expect(html).toContain('$79.86 left')
    expect(html.indexOf('$100')).toBeLessThan(html.indexOf('$79.86'))
    expect(html).not.toContain('HEURC left')
  })

  it('states an open-ended order’s funding balance as its remainder, once', () => {
    const html = render(dca({ totalAmount: '0', remainingAmount: null, budgetUsd: null, fundingBalance: '7000000000000000000', fundingUsd: 42.5 }))
    expect(html).toContain('open-ended')
    expect(html).toContain('$42.50')
    expect(html).not.toContain('HEURC left')
    expect(html.match(/\$42\.50/g)).toHaveLength(1)   // not the balance and its value twice
  })

  it('says nothing about a remainder once the budget is spent', () => {
    const html = render(dca({ filledAmount: '100000000000000000000', remainingAmount: '0' }))
    expect(html).not.toContain(' left</span>')   // inline styles carry a CSS `left`
  })

  it('falls back to the sold asset when it has no price feed', () => {
    const html = render(dca({ valueUsd: null, budgetUsd: null }))
    expect(html).toContain('79.5 HEURC left')
  })
})

describe('dcaAggregates — the section totals row', () => {
  // One budgeted order half spent, one open-ended, one unpriced: $100 per trade
  // every 12h + $10 per trade every 6h → $260/day across 6 trades/day. Amounts
  // leave each order plenty of trades, so the runway cap stays out of the way.
  const budgeted = dca({ valueUsd: 100, budgetUsd: 1000, amountPerTrade: '1', totalAmount: '10', filledAmount: '5', remainingAmount: '5', periodSeconds: 43200, executionsDone: 5, nextExecutionBlock: 900 })
  const openEnded = dca({ valueUsd: 10, budgetUsd: null, amountPerTrade: '1', totalAmount: '0', filledAmount: '2', fundingBalance: '7', fundingUsd: 300, periodSeconds: 21600, executionsDone: 2, nextExecutionBlock: 500 })
  const unpriced = dca({ valueUsd: null, budgetUsd: null, amountPerTrade: '1', totalAmount: '10', filledAmount: '0', remainingAmount: '10', periodSeconds: 21600, executionsDone: 1, nextExecutionBlock: null })

  it('folds budgeted and open-ended orders into one rate, budget, and remainder', () => {
    const agg = dcaAggregates([budgeted, openEnded], undefined)
    expect(agg.perDayUsd).toBeCloseTo(100 * 2 + 10 * 4)
    expect(agg.tradesPerDay).toBeCloseTo(6)
    expect(agg.budgetUsd).toBe(1300)          // 1000 budget + 300 funding
    expect(agg.leftUsd).toBeCloseTo(800)      // 1000 × 5/10 remaining + all 300 funding
    expect(agg.trades).toBe(7)
    expect(agg.nextBlock).toBe(500)           // the soonest plan wins
  })
  it('keeps unpriced orders in the counts and timing but out of the money', () => {
    const agg = dcaAggregates([budgeted, unpriced], undefined)
    expect(agg.pricedOrders).toBe(1)
    expect(agg.budgetUsd).toBe(1000)
    expect(agg.perDayUsd).toBeCloseTo(200)
    expect(agg.tradesPerDay).toBeCloseTo(6)   // still fires 4×/day + 2×/day
    expect(agg.trades).toBe(6)
  })
  it('caps a fast order about to exhaust its budget at the trades it can still fund', () => {
    // Fires every 30s ($2,880/day instantaneous) with 2 trades left → $2/day.
    const whale = dca({ valueUsd: 1, budgetUsd: 100, amountPerTrade: '1', totalAmount: '10', filledAmount: '8', remainingAmount: '2', periodSeconds: 30, executionsDone: 8 })
    const agg = dcaAggregates([whale], undefined)
    expect(agg.perDayUsd).toBeCloseTo(2)
    expect(agg.tradesPerDay).toBeCloseTo(2)
  })
  it('renders the aggregate as the first row only when asked and only for 2+ orders', () => {
    const two = renderToStaticMarkup(<ActiveDcaTable dcas={[budgeted, openEnded]} headBlock={100} now={Date.now()} showOwner totals title={<>Buys</>} />)
    expect(two).toContain('All 2 orders combined')
    expect(two).toContain('/day')
    const one = renderToStaticMarkup(<ActiveDcaTable dcas={[budgeted]} headBlock={100} now={Date.now()} showOwner totals title={<>Buys</>} />)
    expect(one).not.toContain('orders combined')
    const account = renderToStaticMarkup(<ActiveDcaTable dcas={[budgeted, openEnded]} headBlock={100} now={Date.now()} />)
    expect(account).not.toContain('orders combined')
  })
})
