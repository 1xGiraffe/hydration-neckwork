import { describe, expect, it } from 'vitest'
import { HEAD_SILENCE_LIMIT_MS, headStreamFresh, parseHeadEvent } from '../src/live'

// A pushed head only counts when it advances: reconnects replay the current
// head, which must not re-trigger the chart's candle poll. preis follows the
// MAIN (price indexer) watermark — the raw head advances before candles for
// that block can exist.
describe('parseHeadEvent', () => {
  it('follows the main watermark, not the raw head', () => {
    expect(parseHeadEvent('{"head":13488202,"main":13488200}', 13488199)).toBe(13488200)
    // raw advanced but main did not — no refetch, the candles are not there yet
    expect(parseHeadEvent('{"head":13488205,"main":13488200}', 13488200)).toBeNull()
  })

  it('falls back to head when main is absent', () => {
    expect(parseHeadEvent('{"head":13488200}', 13488199)).toBe(13488200)
  })

  it('ignores replayed or regressed heads', () => {
    expect(parseHeadEvent('{"head":13488201,"main":13488200}', 13488200)).toBeNull()
    expect(parseHeadEvent('{"head":13488199}', 13488200)).toBeNull()
  })

  it('ignores malformed frames', () => {
    expect(parseHeadEvent('not json', 0)).toBeNull()
    expect(parseHeadEvent('{"head":"soon"}', 0)).toBeNull()
    expect(parseHeadEvent('{}', 0)).toBeNull()
  })
})

// EventSource fires `error` when the socket DROPS, never when it stays open and
// stops delivering — a suspended laptop or an idle proxy holding the connection
// leaves it open and silent. This flag is the only thing deciding whether the
// chart's fallback poll and the indexer chip's refetch run at all, so an open
// socket alone must not count as healthy: silence has to hand the surfaces back
// to their timers.
describe('headStreamFresh', () => {
  const now = 1_760_000_000_000

  it('is healthy only while frames keep arriving', () => {
    expect(headStreamFresh(true, now - 1_000, now)).toBe(true)
    expect(headStreamFresh(true, now - (HEAD_SILENCE_LIMIT_MS - 1), now)).toBe(true)
  })

  it('goes unhealthy once the open socket falls silent', () => {
    expect(headStreamFresh(true, now - HEAD_SILENCE_LIMIT_MS, now)).toBe(false)
    expect(headStreamFresh(true, now - 3_600_000, now)).toBe(false)
  })

  it('is never healthy before the first frame, or with the socket down', () => {
    expect(headStreamFresh(true, 0, now)).toBe(false)
    expect(headStreamFresh(false, now, now)).toBe(false)
  })

  // A stalled stream must not sit just under the window forever: the limit is
  // several nominal blocks, not minutes.
  it('gives up within a minute of the last frame', () => {
    expect(HEAD_SILENCE_LIMIT_MS).toBeLessThanOrEqual(60_000)
    expect(HEAD_SILENCE_LIMIT_MS).toBeGreaterThanOrEqual(12_000)
  })
})
