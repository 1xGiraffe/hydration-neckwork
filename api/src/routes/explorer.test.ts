import { describe, expect, it } from 'vitest'
import { unusableFilterParam } from './explorer.ts'

// A filter the server cannot honour must be refused, never dropped. Dropping one
// answers a wider question under the caller's own parameters: an unrecognized
// `type` used to fall back to `all`, so `?type=staking` (the row-type word rather
// than the wire word `stake`) returned the UNFILTERED total and every family's
// rows, indistinguishable from a genuine answer.
describe('unusableFilterParam', () => {
  it('accepts an absent or cleared filter as unfiltered', () => {
    expect(unusableFilterParam({})).toBeNull()
    expect(unusableFilterParam({ type: '', min: '', from: '', to: '', unit: '' })).toBeNull()
  })

  it('accepts every activity type the wire vocabulary defines', () => {
    for (const type of ['all', 'transfer', 'trade', 'dca', 'liquidity', 'mm', 'xcm', 'stake', 'vote', 'otc']) {
      expect(unusableFilterParam({ type })).toBeNull()
    }
  })

  it('refuses the row-type word rather than widening to the whole feed', () => {
    expect(unusableFilterParam({ type: 'staking' })?.key).toBe('type')
    expect(unusableFilterParam({ type: 'nonsense' })?.key).toBe('type')
  })

  it('refuses a min that is not a number, and honours one that is', () => {
    expect(unusableFilterParam({ min: '10' })).toBeNull()
    expect(unusableFilterParam({ min: '0' })).toBeNull()
    // A negative floor selects every row, which is what the reader resolves it to.
    expect(unusableFilterParam({ min: '-5' })).toBeNull()
    expect(unusableFilterParam({ min: 'abc' })?.key).toBe('min')
  })

  it('refuses a unit outside the two the value filter understands', () => {
    expect(unusableFilterParam({ unit: 'usd' })).toBeNull()
    expect(unusableFilterParam({ unit: 'token' })).toBeNull()
    expect(unusableFilterParam({ unit: 'eur' })?.key).toBe('unit')
  })

  it('refuses a date that is not a real calendar day', () => {
    expect(unusableFilterParam({ from: '2025-02-28', to: '2025-03-01' })).toBeNull()
    expect(unusableFilterParam({ from: '2025-02-30' })?.key).toBe('from')
    expect(unusableFilterParam({ to: '28-02-2025' })?.key).toBe('to')
    expect(unusableFilterParam({ to: '2025-13-01' })?.key).toBe('to')
  })

  it('reports the first unusable filter with what it expected', () => {
    expect(unusableFilterParam({ type: 'staking', min: 'abc' })).toEqual({
      key: 'type',
      expected: 'all, transfer, trade, dca, liquidity, mm, xcm, stake, vote, otc',
    })
  })

  it('refuses a repeated parameter rather than reading one arbitrary copy', () => {
    // Fastify parses `?type=trade&type=vote` into an array; neither copy may be
    // silently preferred over the other.
    expect(unusableFilterParam({ type: ['trade', 'vote'] })?.key).toBe('type')
  })
})
