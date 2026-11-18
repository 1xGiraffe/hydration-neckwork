import { describe, expect, it } from 'vitest'
import { clockAsStats, clockEta, projectBlock, type GovClock } from '../src/governanceClock'
import { estimateBlockCountdown } from '../src/utils/blockCountdown'

// The pages' countdowns sit on the api's governance projector: the same anchor and
// the same measured pace give the same moment the api dates a deadline with.
const clock: GovClock = { headBlock: 1_000, headTs: '2026-11-08T00:00:00.000Z', msPerBlock: 2161.3, nominalMsPerBlock: 2000, source: 'measured', window: { fromBlock: 0, toBlock: 1_000 } }

describe('the governance clock', () => {
  it('projects a block as the api does: a 15-minute-snapped basis + block × measured pace', () => {
    const basis = Math.round((Date.parse('2026-11-08T00:00:00.000Z') - 1_000 * 2161.3) / 900_000) * 900_000
    expect(projectBlock(clock, 1_100)).toBe(basis + 1_100 * 2161.3)
    expect(clockEta(clock, 1_000, 0)).toBeNull()
  })
  it('holds still when the head moves on at the measured pace', () => {
    const later = { ...clock, headBlock: 1_028, headTs: new Date(Date.parse(clock.headTs) + 28 * 2161.3 + 3_000).toISOString() }
    expect(projectBlock(later, 200_000)).toBe(projectBlock(clock, 200_000))
  })
  it('hands the shared progress card the same line', () => {
    const s = clockAsStats(clock)
    const viaCard = estimateBlockCountdown(1_100, s.headBlock, s.headTime, 0, s.avgBlockSec)
    expect(viaCard?.etaMs).toBeCloseTo(projectBlock(clock, 1_100), 3)
  })
})
