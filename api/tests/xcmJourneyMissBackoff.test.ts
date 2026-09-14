import { describe, expect, it } from 'vitest'
import { MISS_BACKOFF_MS, missIsDue } from '../src/services/xcmJourneyService.ts'

// A topic id the crosschain index does not have yet is retried on a widening
// schedule. The counter is stored as 1 after the FIRST unresolved look, so
// attempt N is spaced by MISS_BACKOFF_MS[N - 1] — an off-by-one here does not
// fail anything, it just stops retrying early and leaves the row unenriched
// forever, silently.
describe('the retry schedule for an unresolved journey', () => {
  const T0 = Date.parse('2026-09-14T00:00:00Z')

  it('always looks at an id it has never seen', () => {
    expect(missIsDue(undefined, T0)).toBe(true)
  })

  it('is the schedule the module documents', () => {
    expect(MISS_BACKOFF_MS).toEqual([60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000])
  })

  it('serves all five steps, each only once its wait has elapsed', () => {
    for (const [i, wait] of MISS_BACKOFF_MS.entries()) {
      const attempts = i + 1
      expect(missIsDue({ attempts, lastAttemptMs: T0 }, T0 + wait - 1), `step ${attempts} early`).toBe(false)
      expect(missIsDue({ attempts, lastAttemptMs: T0 }, T0 + wait), `step ${attempts}`).toBe(true)
    }
  })

  // Wormhole's tail runs to hours, which is what the last step is for. Giving up
  // at `attempts >= MISS_BACKOFF_MS.length` made it unreachable: the schedule
  // ended after the 2h step, ~2.6h in, and a bridged arrival landing later was
  // never looked up again.
  it('reaches the 12h step, and only then gives up', () => {
    const last = MISS_BACKOFF_MS.length
    expect(missIsDue({ attempts: last, lastAttemptMs: T0 }, T0 + 12 * 3_600_000)).toBe(true)
    expect(missIsDue({ attempts: last + 1, lastAttemptMs: T0 }, T0 + 365 * 86_400_000)).toBe(false)
  })
})
