import { describe, expect, it } from 'vitest'
import { parseUrlPair } from '../src/utils/pairs'

describe('parseUrlPair', () => {
  it('parses canonical asset pair slugs', () => {
    expect(parseUrlPair('0-10')).toEqual({ baseId: 0, quoteId: 10 })
    expect(parseUrlPair('1000625-222')).toEqual({ baseId: 1_000_625, quoteId: 222 })
  })

  it.each(['1x-10', '1-10x', '-1-10', '01-10', '1-1', '1-2-3', ''])('rejects malformed slug %j', slug => {
    expect(parseUrlPair(slug)).toBeNull()
  })

  it('rejects integers outside JavaScript’s safe range', () => {
    expect(parseUrlPair('9007199254740992-10')).toBeNull()
  })
})
