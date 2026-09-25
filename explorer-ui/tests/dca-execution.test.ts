import { describe, expect, it } from 'vitest'
import { canonicalDcaExecutionPath } from '../src/utils/dca'

// /dca/<block>-e<index> is addressed by the execution event (DCA.TradeExecuted /
// TradeFailed). A link keyed on a swap leg's index — what feed rows carried before
// the identity was unified — resolves to the execution that follows the leg, and
// the page then moves to that execution's own URL so one fill has one address.
describe('canonicalDcaExecutionPath', () => {
  it('stays put on a link that already names the execution event', () => {
    expect(canonicalDcaExecutionPath(15027912, 35, { blockHeight: 15027912, eventIndex: 35 })).toBeNull()
  })

  it('moves a leg-index link to the execution event it resolved to', () => {
    expect(canonicalDcaExecutionPath(15027912, 34, { blockHeight: 15027912, eventIndex: 35 })).toBe('/dca/15027912-e35')
  })

  it('decides nothing before the execution has loaded', () => {
    expect(canonicalDcaExecutionPath(15027912, 34, undefined)).toBeNull()
  })
})
