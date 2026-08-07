import { describe, expect, it } from 'vitest'
import { F } from '../src/components/ui'

// A pool row's clock starts when this node first saw the transaction; the block
// row that replaces it counts from when the chain executed it, which is later
// by however long it waited. Phrased identically, the age appeared to jump
// backwards at inclusion — so a pool row states a DURATION, not a moment.
describe('waiting vs ago', () => {
  const seen = '2026-08-06 20:00:00'
  const now = Date.parse('2026-08-06T20:00:31Z')

  it('says how long, not how long ago', () => {
    expect(F.waiting(seen, now)).toBe('31s')
    expect(F.ago(seen, now)).toBe('31s ago')
  })

  it('keeps its shape past a minute and an hour', () => {
    expect(F.waiting(seen, Date.parse('2026-08-06T20:02:05Z'))).toBe('2m 5s')
    expect(F.waiting(seen, Date.parse('2026-08-06T21:30:00Z'))).toBe('1h 30m')
  })

  it('never runs negative or chokes on a bad stamp', () => {
    expect(F.waiting(seen, Date.parse('2026-08-06T19:59:00Z'))).toBe('0s')
    expect(F.waiting('not a time', now)).toBe('—')
  })
})
