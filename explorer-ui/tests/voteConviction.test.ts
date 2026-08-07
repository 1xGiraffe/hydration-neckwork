import { describe, expect, it } from 'vitest'
import { convictionLabel } from '../src/utils/voteRows'

// The chain names conviction with a runtime enum — `Locked6x`, and `None` for
// the no-lock case. Neither reads as a multiplier, and `None` reads as missing
// data sitting next to votes that show one, which is how a conviction that was
// always rendered came to be reported as "not shown". Conviction is defined in
// tenths on-chain, so the no-lock vote really does carry 0.1x of its capital.
describe('convictionLabel', () => {
  it('says how hard somebody voted, in multipliers', () => {
    expect(convictionLabel('Locked6x')).toBe('6x')
    expect(convictionLabel('Locked1x')).toBe('1x')
  })

  it('gives the no-lock vote its real weight rather than the word None', () => {
    expect(convictionLabel('None')).toBe('0.1x')
  })

  it('passes an unrecognised conviction through instead of hiding it', () => {
    // A conviction the runtime grows later is still a fact about the vote.
    expect(convictionLabel('Locked9x')).toBe('Locked9x')
    expect(convictionLabel('1.2x avg')).toBe('1.2x avg')
  })

  it('has nothing to say when the vote carries no conviction', () => {
    // A collective vote has neither balance nor conviction.
    expect(convictionLabel(null)).toBeNull()
    expect(convictionLabel(undefined)).toBeNull()
    expect(convictionLabel('')).toBeNull()
  })
})
