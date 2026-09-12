import { describe, expect, it } from 'vitest'
import { intentOrderStatus } from '../src/services/explorerService.ts'
import { computeIntentStatus, intentIsResting, type IntentKind } from '../src/public/services/intentOrders.ts'
import { foldIntentStatus } from '../src/data/services/intentData.ts'

// A resting ICE intent is a POSITION — the owner's asset_in sits under a named
// reserve until a solver fills it — so three surfaces publish its state: the
// explorer's intent page, the public API's owner listing, and the Data API's
// order fold. They are deliberately separate implementations (the public and data
// trees are import-leaves), which is exactly why the rule has to be pinned in one
// place: an order that reads "open" on one may never read "filled" on another.

const CANCELLED = 'Intent.IntentCanceled'
const EXPIRED = 'Intent.IntentExpired'
const RESOLVED = 'Intent.IntentResolved'
// The partial-resolution event is spelled `IntentResovedPartially` on chain (sic).
const PARTIAL = 'Intent.IntentResovedPartially'
const DCA_TRADE = 'Intent.DcaTradeExecuted'
const DCA_DONE = 'Intent.DcaCompleted'
const SUBMITTED = 'Intent.IntentSubmitted'

// The public surface's wire words differ by a hyphen/underscore from the
// explorer's; everything else must match name for name.
const PUBLIC_TO_EXPLORER: Record<string, string> = { partially_filled: 'partially-filled' }

function publicStatus(kind: IntentKind, events: string[]): string {
  const status = computeIntentStatus({
    kind,
    hasCancelled: events.includes(CANCELLED),
    hasExpired: events.includes(EXPIRED),
    hasResolved: events.includes(RESOLVED),
    hasPartial: events.includes(PARTIAL),
    hasDcaCompleted: events.includes(DCA_DONE),
  })
  return PUBLIC_TO_EXPLORER[status] ?? status
}
function dataStatus(kind: IntentKind, events: string[]): string {
  const status = foldIntentStatus(kind, events)
  return PUBLIC_TO_EXPLORER[status] ?? status
}

describe('intent status is one rule across three surfaces', () => {
  const cases: { kind: IntentKind; events: string[]; expected: string }[] = [
    { kind: 'swap', events: [SUBMITTED], expected: 'open' },
    { kind: 'swap', events: [SUBMITTED, RESOLVED], expected: 'filled' },
    { kind: 'swap', events: [SUBMITTED, PARTIAL], expected: 'partially-filled' },
    { kind: 'swap', events: [SUBMITTED, PARTIAL, PARTIAL, RESOLVED], expected: 'filled' },
    // The live case that motivated the rule: id …96250533888086 took eight
    // partial resolutions and was then pulled. A partial never ends an order.
    { kind: 'swap', events: [SUBMITTED, PARTIAL, PARTIAL, CANCELLED], expected: 'cancelled' },
    { kind: 'swap', events: [SUBMITTED, EXPIRED], expected: 'expired' },
    { kind: 'dca', events: [SUBMITTED], expected: 'open' },
    { kind: 'dca', events: [SUBMITTED, DCA_TRADE, DCA_TRADE], expected: 'open' },
    { kind: 'dca', events: [SUBMITTED, DCA_TRADE, DCA_DONE], expected: 'completed' },
    { kind: 'dca', events: [SUBMITTED, DCA_TRADE, CANCELLED], expected: 'cancelled' },
  ]
  for (const { kind, events, expected } of cases) {
    it(`${kind} after ${events.slice(1).join('+') || 'submission'} is ${expected}`, () => {
      expect(intentOrderStatus(kind, events)).toBe(expected)
      expect(publicStatus(kind, events)).toBe(expected)
      expect(dataStatus(kind, events)).toBe(expected)
    })
  }

  it('a DCA intent never resolves and a swap intent never completes', () => {
    // The two kinds emit disjoint fill vocabularies; crossing them must not
    // silently change a state (a swap seeing DcaCompleted stays open).
    expect(intentOrderStatus('swap', [SUBMITTED, DCA_DONE])).toBe('open')
    expect(intentOrderStatus('dca', [SUBMITTED, RESOLVED])).toBe('open')
  })

  it('only open and partially filled still hold the owner’s funds', () => {
    expect(intentIsResting('open')).toBe(true)
    expect(intentIsResting('partially_filled')).toBe(true)
    for (const done of ['filled', 'cancelled', 'expired', 'completed'] as const) {
      expect(intentIsResting(done)).toBe(false)
    }
  })
})
