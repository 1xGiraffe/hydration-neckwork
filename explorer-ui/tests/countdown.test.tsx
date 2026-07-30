import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DcaNextExec } from '../src/components/AccountSections'
import { estimateBlockCountdown } from '../src/utils/blockCountdown'

describe('block-time countdowns', () => {
  const headTime = '2026-07-10 12:00:00'
  const headMs = Date.parse('2026-07-10T12:00:00Z')

  it('keeps the ETA anchored while remaining seconds decrease', () => {
    const first = estimateBlockCountdown(110, 100, headTime, headMs + 2_000)
    const later = estimateBlockCountdown(110, 100, headTime, headMs + 5_000)

    expect(first).toEqual({ etaMs: headMs + 60_000, secondsUntil: 58 })
    expect(later).toEqual({ etaMs: first!.etaMs, secondsUntil: 55 })
  })

  it('clamps overdue estimates and rejects missing anchors', () => {
    expect(estimateBlockCountdown(101, 100, headTime, headMs + 10_000)?.secondsUntil).toBe(0)
    expect(estimateBlockCountdown(110, 100, undefined, headMs)).toBeNull()
  })

  it('drives the DCA label from the same stable chain-time anchor', () => {
    const first = renderToStaticMarkup(<DcaNextExec nextBlock={110} headBlock={100} headTime={headTime} now={headMs + 2_000} />)
    const later = renderToStaticMarkup(<DcaNextExec nextBlock={110} headBlock={100} headTime={headTime} now={headMs + 5_000} />)

    expect(first).toContain('in 58s')
    expect(later).toContain('in 55s')
  })
})
