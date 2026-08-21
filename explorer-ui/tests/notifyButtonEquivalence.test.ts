import { describe, expect, it } from 'vitest'
import { findEquivalentRule, sameRuleParams } from '../src/notificationKinds'

// The Notify button decides whether it is already ON by looking for an equivalent
// rule among the viewer's own. The server fills `dcaStart` in from the schema's
// default, so what it STORES is never byte-identical to what the button ASKED for —
// and a comparison that misses that reads "not subscribed" forever: the button stays
// off, and clicking again creates a duplicate.
describe('a large-trade rule the server has stored', () => {
  const want = { kind: 'large-trade' as const, params: { assetId: 1000625, minUsd: 10000 } }

  it('is recognised as the rule the button asked for', () => {
    const stored = [{ ruleId: 'r1', kind: 'large-trade' as const, params: { assetId: 1000625, minUsd: 10000, dcaStart: true } }]

    expect(findEquivalentRule(stored, want)?.ruleId).toBe('r1')
  })

  it('treats an absent dcaStart and an explicit true as the same rule', () => {
    expect(sameRuleParams('large-trade', { assetId: 0, minUsd: 500 }, { assetId: 0, minUsd: 500, dcaStart: true })).toBe(true)
  })

  // The flag is a real parameter, so opting out is a DIFFERENT rule and must not
  // toggle the button for a rule that still watches DCA starts.
  it('keeps an explicit opt-out distinct', () => {
    expect(sameRuleParams('large-trade', { assetId: 0, minUsd: 500 }, { assetId: 0, minUsd: 500, dcaStart: false })).toBe(false)
  })

  it('still distinguishes a different floor or token', () => {
    expect(sameRuleParams('large-trade', { assetId: 0, minUsd: 500 }, { assetId: 0, minUsd: 600, dcaStart: true })).toBe(false)
    expect(sameRuleParams('large-trade', { assetId: 0, minUsd: 500 }, { assetId: 5, minUsd: 500, dcaStart: true })).toBe(false)
  })

  // large-transfer has no DCA to watch and its schema rejects the flag, so nothing
  // may be invented for it.
  it('does not invent the flag for large-transfer', () => {
    const stored = [{ ruleId: 't1', kind: 'large-transfer' as const, params: { assetId: 5, minUsd: 500 } }]

    expect(findEquivalentRule(stored, { kind: 'large-transfer', params: { assetId: 5, minUsd: 500 } })?.ruleId).toBe('t1')
    expect(sameRuleParams('large-transfer', { assetId: 5, minUsd: 500 }, { assetId: 5, minUsd: 500, dcaStart: true })).toBe(false)
  })
})
