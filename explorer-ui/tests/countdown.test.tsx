import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DcaNextExec } from '../src/components/AccountSections'
import { estimateBlockCountdown } from '../src/utils/blockCountdown'
import { NOMINAL_BLOCK_SECONDS, blockSeconds } from '../src/utils/dca'

describe('block-time countdowns', () => {
  const headTime = '2026-07-10 12:00:00'
  const headMs = Date.parse('2026-07-10T12:00:00Z')

  it('keeps the ETA anchored while remaining seconds decrease', () => {
    const first = estimateBlockCountdown(110, 100, headTime, headMs + 2_000, 6)
    const later = estimateBlockCountdown(110, 100, headTime, headMs + 5_000, 6)

    expect(first).toEqual({ etaMs: headMs + 60_000, secondsUntil: 58 })
    expect(later).toEqual({ etaMs: first!.etaMs, secondsUntil: 55 })
  })

  it('clamps overdue estimates and rejects missing anchors', () => {
    expect(estimateBlockCountdown(101, 100, headTime, headMs + 10_000, 6)?.secondsUntil).toBe(0)
    expect(estimateBlockCountdown(110, 100, undefined, headMs, 6)).toBeNull()
  })

  // The pace is a required argument with no default, so a countdown cannot
  // silently keep quoting the era it was written in: 10 blocks is a minute at
  // 6s and 20 seconds at 2s, and both come from the caller's measured value.
  it('scales the estimate with the pace it is given', () => {
    expect(estimateBlockCountdown(110, 100, headTime, headMs, 2)).toEqual({ etaMs: headMs + 20_000, secondsUntil: 20 })
    expect(estimateBlockCountdown(110, 100, headTime, headMs, 12)).toEqual({ etaMs: headMs + 120_000, secondsUntil: 120 })
    // What a caller passes when the chain's measured pace is not (yet) known.
    expect(estimateBlockCountdown(110, 100, headTime, headMs, blockSeconds(undefined)))
      .toEqual({ etaMs: headMs + 10 * NOMINAL_BLOCK_SECONDS * 1000, secondsUntil: 10 * NOMINAL_BLOCK_SECONDS })
  })

  it('drives the DCA label from the same stable chain-time anchor', () => {
    const first = renderToStaticMarkup(<DcaNextExec nextBlock={110} headBlock={100} headTime={headTime} now={headMs + 2_000} />)
    const later = renderToStaticMarkup(<DcaNextExec nextBlock={110} headBlock={100} headTime={headTime} now={headMs + 5_000} />)

    expect(first).toContain('in 58s')
    expect(later).toContain('in 55s')
  })

  it('says the same distance in the chain measured pace', () => {
    const faster = renderToStaticMarkup(<DcaNextExec nextBlock={110} headBlock={100} headTime={headTime} now={headMs + 2_000} blockSec={2} />)
    expect(faster).toContain('in 18s')
  })
})
