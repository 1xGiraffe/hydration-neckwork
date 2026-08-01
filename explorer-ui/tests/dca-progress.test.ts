import { describe, expect, it } from 'vitest'
import { dcaProgress, dcaUnspentBudget } from '../src/utils/dca'

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
