import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { referendumVerdict, type VerdictInput } from '../src/components/gov/Verdict'
import { projectBlock, type GovClock } from '../src/governanceClock'
import { humanDate } from '../src/components/gov/GovUi'

const concluded = { blockHeight: 16_070_400, extrinsicIndex: null, timestamp: '2025-10-21 23:22:18' }
const text = (v: ReturnType<typeof referendumVerdict>) => renderToStaticMarkup(<>{v.sentence}</>).replace(/<[^>]+>/g, '')

describe('referendumVerdict', () => {
  // A Democracy referendum is decided by its vote threshold over the aye and nay votes;
  // it has no approval or support bars, so its verdict never mentions them.
  it('reads a Democracy referendum that did not pass by its tally, not by approval and support', () => {
    const input: VerdictInput = { status: 'not passed', progress: null, concludedAt: concluded, decimals: 12, tally: { ayes: '0', nays: '147249455136186080651' } }
    const v = referendumVerdict(input, undefined, Date.parse('2026-11-08T00:00:00Z'))
    expect(v.word).toBe('Rejected')
    expect(v.clause).toBe('on Tue 21 Oct 2025 · 0 aye, 147M nay votes')
    expect(text(v)).toBe('It did not pass on Tue 21 Oct 2025: 0 aye, 147M nay votes.')
    expect(`${v.clause} ${text(v)}`).not.toMatch(/approval|support/i)
    // Democracy's statuses carry no deposits.
    expect(v.deposits).toBeUndefined()
  })

  it('reads a passed Democracy referendum by its tally too', () => {
    const v = referendumVerdict({ status: 'passed', progress: null, concludedAt: concluded, decimals: 12, tally: { ayes: '5000000000000000000', nays: '0' } }, undefined, 0)
    expect(v.word).toBe('Approved')
    expect(v.clause).toBe('on Tue 21 Oct 2025 · 5M aye, 0 nay votes')
  })

  it('reads a rejected OpenGov referendum by the approval it ended on, with its deposits apart', () => {
    const v = referendumVerdict({
      status: 'rejected', progress: null, concludedAt: concluded, decimals: 12, timeline: [],
      final: { approvalPerbill: 264_000_000, approvalNeededPerbill: 500_000_000, support: null },
    }, undefined, 0)
    expect(v.clause).toBe('on Tue 21 Oct 2025 · approval 26.4% of 50% needed')
    expect(text(v)).toContain('did not reach the approval and support it needed')
    expect(renderToStaticMarkup(<>{v.deposits}</>)).toContain('Submission deposit: reclaimable')
  })

  it('says a confirming referendum in one clause, with the exact moment for its tooltip', () => {
    const clock: GovClock = { headBlock: 1000, headTs: '2026-11-08T12:00:00.000Z', msPerBlock: 6000, nominalMsPerBlock: 6000, source: 'nominal', window: null }
    const now = projectBlock(clock, clock.headBlock)
    const v = referendumVerdict({
      status: 'confirming', concludedAt: null,
      progress: { phase: 'confirming', confirmEndBlock: 1000 + 600 } as VerdictInput['progress'],
    }, clock, now)
    expect(v.word).toBe('Confirming')
    expect(v.clause).toBe('passes in 1h if both bars hold')
    expect(v.exact).toBe(humanDate(projectBlock(clock, 1600)))
  })
})
