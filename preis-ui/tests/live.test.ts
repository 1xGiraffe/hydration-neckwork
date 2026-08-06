import { describe, expect, it } from 'vitest'
import { parseHeadEvent } from '../src/live'

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
