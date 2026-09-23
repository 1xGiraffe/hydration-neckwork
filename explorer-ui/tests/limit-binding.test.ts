import { describe, expect, it } from 'vitest'
import { limitBinding, LIMIT_NOT_BINDING_ABOVE, LIMIT_BELOW_MARKET_UNDER } from '../src/utils/limitBinding'

// A DCA order's limit is a ceiling on what it pays, and the pallet enforces the
// TIGHTER of it and an oracle floor built from the order's slippage. So a ceiling
// far above market can never reject a fill — a real order asked for "at least 1 HDX"
// for 5 HOLLAR, some 670x the market price — and reading that beside a market of
// 0.0075 looks like a decoding bug when it is the owner's own term.
describe('limitBinding', () => {
  it('says nothing for a limit at or near market — there the limit IS the story', () => {
    expect(limitBinding(1)).toBeNull()
    expect(limitBinding(1.2)).toBeNull()
    expect(limitBinding(0.8)).toBeNull()
    expect(limitBinding(LIMIT_NOT_BINDING_ABOVE)).toBeNull()
    expect(limitBinding(LIMIT_BELOW_MARKET_UNDER)).toBeNull()
  })

  it('names a ceiling far above market as not binding, and says what is', () => {
    const b = limitBinding(670)
    expect(b?.kind).toBe('not-binding')
    expect(b?.label).toBe('not binding')
    expect(b?.title).toContain('670×')
    // The point of the flag: it must name the real constraint, not just the fact.
    expect(b?.title).toContain('slippage')
  })

  it('names a ceiling far below market as unreachable today', () => {
    const b = limitBinding(0.25)
    expect(b?.kind).toBe('below-market')
    expect(b?.title).toContain('0.25×')
    expect(b?.title).toContain('until the price falls')
  })

  // An unpriced pair has no market to compare against; absent must read as absent
  // rather than as "on market", which is a claim we cannot make.
  it('says nothing without a usable ratio', () => {
    for (const v of [null, undefined, 0, -1, NaN, Infinity]) expect(limitBinding(v as number)).toBeNull()
  })
})
