import { describe, expect, it } from 'vitest'
import { lockUntilLabel } from '../src/services/securityService.ts'

// "locked until block 14,871,261" is the chain's answer and an unreadable one:
// nobody knows whether that height is tomorrow or in March. The height stays —
// it is what the chain recorded — but behind the time it means.
describe('lockUntilLabel', () => {
  const HEAD = { height: 14_871_000, timestamp: '2026-09-21 08:00:00' }
  const PACE = 2_000

  it('states a height the chain has reached as fact, from its real timestamp', () => {
    const actual = new Map([[13_126_783, '2026-08-14 09:31:12']])
    expect(lockUntilLabel(13_126_783, actual, HEAD, PACE))
      .toBe('2026-08-14 09:31 UTC (block 13,126,783)')
  })

  // A past height is never projected backwards: the chain ran ~12s until Q3 2025,
  // ~6s until runtime 440 and ~2s since, so walking back from the head at today's
  // pace would cross those eras and state a confident wrong time.
  it('says only the height when a past block has no timestamp to hand', () => {
    expect(lockUntilLabel(13_126_783, new Map(), HEAD, PACE)).toBe('block 13,126,783')
  })

  it('projects a height the chain has not reached, and marks it an estimate', () => {
    // 1,800 blocks at 2s is an hour past the head.
    expect(lockUntilLabel(HEAD.height + 1_800, new Map(), HEAD, PACE))
      .toBe('~2026-09-21 09:00 UTC (block 14,872,800)')
  })

  it('falls back to the bare height when there is nothing to project from', () => {
    expect(lockUntilLabel(14_872_800, new Map(), null, PACE)).toBe('block 14,872,800')
    expect(lockUntilLabel(14_872_800, new Map(), HEAD, 0)).toBe('block 14,872,800')
    expect(lockUntilLabel(14_872_800, new Map(), { ...HEAD, timestamp: 'not a time' }, PACE))
      .toBe('block 14,872,800')
  })

  it('keeps the height readable, with the separators every page uses', () => {
    expect(lockUntilLabel(14_872_800, new Map(), null, PACE)).toContain('14,872,800')
  })
})
