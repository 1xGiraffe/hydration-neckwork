import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { datedWindowIsClosed } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// The dated feed caches (activity, events, extrinsics) key on `liveFeedTag`, which
// drops the block head and returns the constant 'tw' for any time-windowed read, on
// the assumption that a dated window is historical and therefore stable. A window
// whose upper bound reaches TODAY is not: blocks keep landing inside it. Under a
// constant tag the page then freezes for the cache's whole TTL (30s), and a reader
// that only moves forward — the notification evaluator's per-kind cursor — steps
// past every row that arrived meanwhile and never looks again.
//
// Measured live 2026-08-20: the large-trade lane went 17h and 22 qualifying trades
// without a single match while its cursor tracked the head, because day-bounding its
// fetch flipped it onto the 'tw' tag. Driving the same window with a cold cache
// matched every one of them.
describe('a dated feed window that reaches today', () => {
  const TODAY = '2026-08-20'

  it('is not closed, so it cannot be cached under the head-less tag', () => {
    expect(datedWindowIsClosed(TODAY, TODAY)).toBe(false)
  })

  it('is not closed when only its lower bound is dated', () => {
    expect(datedWindowIsClosed(undefined, TODAY)).toBe(false)
  })

  it('is not closed when its upper bound runs past today', () => {
    expect(datedWindowIsClosed('2026-09-01', TODAY)).toBe(false)
  })

  it('is closed once its upper bound names a day that has ended', () => {
    expect(datedWindowIsClosed('2026-08-19', TODAY)).toBe(true)
  })

  it('is not closed when the upper bound is not a date at all', () => {
    expect(datedWindowIsClosed('not-a-date', TODAY)).toBe(false)
  })
})

// Both tag helpers collapse a time-windowed read onto the same head-less tag, so the
// staleness is not specific to the activity feed: the events and extrinsics feeds
// share `liveFeedTag`, and thirteen more dated feeds (transfers, trades, liquidity,
// the XCM/NTT lanes, money-market, staking, OTC, votes) share `liveHeadTag`. Fixing
// one and leaving the rest would just move the bug.
describe('every dated feed cache', () => {
  it('tells its tag helper which window it is caching, so today-touching reads stay head-keyed', () => {
    const dated = [...explorerService.matchAll(/live(?:Feed|Head)Tag\(Boolean\(tw\)[^)]*\)/g)].map(m => m[0])

    expect(dated.length).toBe(16)
    for (const call of dated) {
      expect(call).toMatch(/datedWindowIsClosed\(/)
    }
  })

  // The scoped account/tag feeds carry the same asymmetry in their own idiom: the
  // live read is keyed on the account's activity watermark and a dated one collapsed
  // that to the constant 0 on the same "a dated view is history" assumption.
  it('keys a today-touching account window on the activity watermark, not the constant 0', () => {
    expect(explorerService).not.toMatch(/const mark = window \? 0 :/)
    expect(explorerService).toMatch(/const mark = window && datedWindowIsClosed\(to\) \? 0 :/)
  })
})
