import { describe, expect, it } from 'vitest'
import { dcaAmountLeft, dcaLeftUsd, dcaProgress, dcaUnspentBudget } from '../src/utils/dca'

// A DCA schedule is bounded either by a budget or by the wallet behind it, and the
// two read completely differently. These pin the cases that have actually misled a
// reader on the schedule page.

describe('dcaProgress', () => {
  it('is the share of the budget spent when there is one', () => {
    expect(dcaProgress('1000', '250')).toEqual({ pct: 25, projected: false })
    expect(dcaProgress('1000', '1000')).toEqual({ pct: 100, projected: false })
  })

  // An open-ended order has no denominator on the chain, so what remains in the
  // wallet supplies one. A funding balance that reads 0 for an owner who still
  // holds thousands — every aToken and ERC-20-backed asset did, before the funding
  // balance learned to look EVM-side — collapses that denominator onto what has
  // already been spent and reports a running order as finished.
  it('projects an open-ended order against the balance still funding it', () => {
    expect(dcaProgress('0', '22', '17536')).toEqual({ pct: 0.1, projected: true })
    // The failure this guards: same order, balance misread as nothing.
    expect(dcaProgress('0', '22', '0')).toEqual({ pct: 100, projected: true })
  })

  // Unknowable and finished are different answers, and 100% reads as finished.
  it('has no percentage at all with no budget and no balance to project against', () => {
    expect(dcaProgress('0', '22', null)).toEqual({ pct: null, projected: true })
  })
})

describe('dcaUnspentBudget', () => {
  // Schedule #34200: a Buy order whose budget covered only two worst-case trades,
  // so the pallet closed it with a third of the budget untouched — "completed"
  // beside a 66% ring, which is exactly the pair a reader cannot reconcile.
  it('names what a completed order never got to spend', () => {
    expect(dcaUnspentBudget('6504492042342880045395', '4336365585831843606504'))
      .toBe('2168126456511036438891')
  })

  it('is null when there is nothing to explain', () => {
    expect(dcaUnspentBudget('1000', '1000')).toBeNull()   // spent the lot
    expect(dcaUnspentBudget('1000', '1200')).toBeNull()   // never negative
    expect(dcaUnspentBudget('0', '500')).toBeNull()       // open-ended: no budget to fall short of
    expect(dcaUnspentBudget('bad', '1')).toBeNull()
  })
})

// What a RUNNING budgeted order still has to spend — the figure the DCA tables and
// the schedule page show beside the budget. Same arithmetic as dcaUnspentBudget,
// different question: this one is live, that one is the remainder a finished order
// had released back to it.
describe('dcaAmountLeft', () => {
  it('is the unfilled part of the budget, in exact integer arithmetic', () => {
    // 18-decimal amounts, well past what a float divide holds.
    expect(dcaAmountLeft('6504492042342880045395', '4336365585831843606504'))
      .toBe('2168126456511036438891')
    expect(dcaAmountLeft('1000', '250')).toBe('750')
  })

  it('shows nothing rather than "0 left" once the budget is spent', () => {
    expect(dcaAmountLeft('1000', '1000')).toBeNull()
    expect(dcaAmountLeft('1000', '1200')).toBeNull()   // never negative
  })

  it('is null for an open-ended order, which is funded by a balance, not a budget', () => {
    expect(dcaAmountLeft('0', '500')).toBeNull()
  })

  it('is null on unparseable input rather than guessing', () => {
    expect(dcaAmountLeft('bad', '1')).toBeNull()
    expect(dcaAmountLeft('1000', '')).toBeNull()
  })
})

// The dollar form is what the surfaces show. It has to follow dcaAmountLeft
// exactly — the two are rendered from one guard — and it has to hold its share
// through amounts a float divide would round away.
describe('dcaLeftUsd', () => {
  it('is the budget value scaled by the unspent share', () => {
    expect(dcaLeftUsd('1000', '250', 400)).toBeCloseTo(300)
    expect(dcaLeftUsd('10', '5', 1000)).toBeCloseTo(500)
  })

  it('holds the share on 18-decimal amounts, taken on the integers', () => {
    // Two thirds of a 6,000-token budget left, the budget worth $300.
    expect(dcaLeftUsd('6000000000000000000000', '2000000000000000000000', 300)).toBeCloseTo(200)
    // A ratio with no exact decimal form still lands well inside a cent.
    expect(dcaLeftUsd('3', '1', 300)).toBeCloseTo(200)
    // A real schedule's amounts: 33.3328% of the budget still to spend.
    expect(dcaLeftUsd('6504492042342880045395', '4336365585831843606504', 300)).toBeCloseTo(99.9983, 4)
  })

  it('is null exactly where dcaAmountLeft is', () => {
    expect(dcaLeftUsd('1000', '1000', 400)).toBeNull()   // budget spent
    expect(dcaLeftUsd('1000', '1200', 400)).toBeNull()   // never negative
    expect(dcaLeftUsd('0', '500', 400)).toBeNull()       // open-ended
    expect(dcaLeftUsd('bad', '1', 400)).toBeNull()
  })

  it('is null without a price, so a caller states the remainder in the asset', () => {
    expect(dcaLeftUsd('1000', '250', null)).toBeNull()
    expect(dcaLeftUsd('1000', '250', undefined)).toBeNull()
    expect(dcaLeftUsd('1000', '250', NaN)).toBeNull()
  })
})
