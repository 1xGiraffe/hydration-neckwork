import { describe, it, expect } from 'vitest'
import { liveSafetyEvents } from '../src/notifications/evaluator.ts'

describe('liveSafetyEvents', () => {
  // An event family that joins the security ledger brings days-old rows with it;
  // they are history, not news, and must not reach subscribers as alerts.
  it('keeps only actions within the live horizon of the head', () => {
    const ev = (blockHeight: number) => ({ kind: 'limit', label: 'x', detail: '', blockHeight, blockTimestamp: '', extrinsicIndex: null, asset: null })
    expect(liveSafetyEvents([ev(15940800), ev(15988300)], 15988329).map(e => e.blockHeight)).toEqual([15988300])
  })
})
