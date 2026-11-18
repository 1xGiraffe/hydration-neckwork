import { describe, expect, it } from 'vitest'
import { curveCrossingX, curveDelayPerbill, mulCeilPerbill, perbillOfRational, PERBILL } from '../src/services/referendaTracks.ts'
import { PINNED_TRACKS } from '../src/services/referendaTrackTable.ts'

// The "on track" block must be the block the pallet itself schedules
// (Referenda::decision_time: since + max(delay(approval), delay(support)).mul_ceil(period)),
// with Curve::delay's own rounding. Fixtures: two live referenda read at block
// 16,763,096 (spec 458) — tally, deciding.since and the chain's alarm. The alarm
// was set when each was last serviced, against the electorate (active issuance) of
// that moment, which drifts by a few hundredths of a percent; the electorates
// below are within that drift of the value read (4,187,039,107,806,494,223,591).

function decisionTime(trackId: number, since: number, ayes: bigint, nays: bigint, support: bigint, ELECTORATE: bigint): number {
  const track = PINNED_TRACKS.find(t => t.id === trackId)!
  const approval = perbillOfRational(ayes, ayes + nays)!
  const sup = perbillOfRational(support, ELECTORATE)!
  expect(curveCrossingX(track.minApproval, approval)).not.toBeNull()
  expect(curveCrossingX(track.minSupport, sup)).not.toBeNull()
  const delay = Math.max(curveDelayPerbill(track.minApproval, approval), curveDelayPerbill(track.minSupport, sup))
  return since + mulCeilPerbill(delay, track.decisionPeriod)
}

describe('the decision time the pallet schedules', () => {
  it('matches the chain alarm of #448 (root)', () => {
    expect(decisionTime(0, 16647482, 3709858090016096636110n, 48299921118938940n, 777591484609471035470n, 4187100000000000000000n)).toBe(16793885)
  })
  it('matches the chain alarm of #450 (economic_parameters)', () => {
    expect(decisionTime(9, 16737920, 3538947369347362039032n, 44455760943933038052n, 678810915975973961943n, 4187060000000000000000n)).toBe(16767957)
  })
  it('clamps the delay to the period', () => {
    const track = PINNED_TRACKS[0]
    expect(curveDelayPerbill(track.minSupport, 0)).toBe(PERBILL)
    expect(curveDelayPerbill(track.minSupport, PERBILL)).toBe(0)
  })
})
