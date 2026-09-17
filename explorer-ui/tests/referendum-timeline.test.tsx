import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReferendumTimeline } from '../src/components/ReferendumProgress'
import type { ReferendumTimelineEntry } from '../src/types'

// An approved referendum's call often only FILES the work — referendum 405 enacted at
// 14,672,011 by scheduling one task for 14,672,012, and every activity it was voted through to
// produce is in that later block. A timeline that stops at the enactment sends a reader to a
// block where nothing of theirs happened, which is what these rows exist to fix.

const NOW = Date.parse('2026-09-16T12:00:00Z')

const enactment: ReferendumTimelineEntry = {
  event: 'Scheduler.Dispatched', blockHeight: 14_672_011, extrinsicIndex: null,
  timestamp: '2026-09-16 11:00:00', outcome: 'ok',
}
const followOn: ReferendumTimelineEntry = {
  event: 'Scheduler.Dispatched', blockHeight: 14_672_012, extrinsicIndex: null,
  timestamp: '2026-09-16 11:00:06', outcome: 'ok', scheduled: { depth: 1, state: 'ran' },
}

const render = (timeline: ReferendumTimelineEntry[], truncated?: boolean) =>
  renderToStaticMarkup(<ReferendumTimeline timeline={timeline} truncated={truncated} now={NOW} />)

describe('the referendum timeline', () => {
  it('sends a scheduled execution to the block that ran it, not to the enactment', () => {
    const html = render([enactment, followOn])
    expect(html).toContain('/block/14672011')
    expect(html).toContain('/block/14672012')
    // Two distinct rows: the enactment and what it set off are different moments.
    expect(html.split('ref-tl-row').length - 1).toBe(2)
  })

  it('names a follow-on as scheduled rather than as a second enactment', () => {
    const html = render([enactment, followOn])
    expect(html).toContain('>Executed<')
    expect(html).toContain('>Scheduled execution<')
  })

  it('says how deep in the chain a task sits, so steps do not read as peers', () => {
    const html = render([enactment, { ...followOn, blockHeight: 14_672_100, scheduled: { depth: 3, state: 'ran' } }])
    expect(html).toContain('Scheduled execution (step 3)')
    // Depth 1 is the ordinary case and carries no step suffix.
    expect(render([enactment, followOn])).not.toContain('step 1')
  })

  it('carries a failed execution through as a failure, not as an execution', () => {
    const html = render([{ ...followOn, outcome: 'failed' }])
    expect(html).toContain('Scheduled execution failed')
    expect(html).toContain('ref-tl-dot bad')
  })

  // A task that has not run has no moment to link, so the block it is DUE in carries the link
  // instead — otherwise a pending row would be the one row a reader cannot follow.
  it('links the due block of an execution that has not run yet', () => {
    const pending: ReferendumTimelineEntry = {
      event: 'Scheduler.Scheduled', blockHeight: 14_680_000, extrinsicIndex: null,
      timestamp: '', scheduled: { depth: 1, state: 'pending' },
    }
    const html = render([enactment, pending])
    expect(html).toContain('Execution scheduled')
    expect(html).toContain('/block/14680000')
    // No relative time: there is no moment yet to be relative to.
    expect(html).not.toContain('ago</span> · #14,680,000')
  })

  it('states what is known about an execution whose block passed without it', () => {
    const html = render([{
      event: 'Scheduler.Scheduled', blockHeight: 11_052_637, extrinsicIndex: null,
      timestamp: '', scheduled: { depth: 2, state: 'dropped' },
    }])
    expect(html).toContain('Scheduled execution never ran')
    expect(html).toContain('/block/11052637')
  })

  it('says so when the chain is longer than the list', () => {
    expect(render([enactment, followOn], true)).toContain('this list is capped')
    expect(render([enactment, followOn])).not.toContain('this list is capped')
  })

  it('leaves an ordinary lifecycle timeline untouched', () => {
    const html = render([
      { event: 'Referenda.Submitted', blockHeight: 900, extrinsicIndex: 2, timestamp: '2026-09-16 10:00:00' },
      { event: 'Referenda.Confirmed', blockHeight: 950, extrinsicIndex: null, timestamp: '2026-09-16 10:30:00' },
    ])
    expect(html).toContain('>Submitted<')
    expect(html).toContain('>Confirmed<')
    expect(html).not.toContain('Scheduled execution')
    expect(html).not.toContain('ref-tl-row sub')
  })
})
