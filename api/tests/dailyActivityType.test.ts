import { describe, it, expect } from 'vitest'
import { dailyActivityFilters } from '../src/routes/explorer.ts'

describe('daily activity type', () => {
  it('translates the wire word stake to the row type the histogram branches on', () => {
    expect(dailyActivityFilters({ type: 'stake', action: 'GIGAHDX Yield' })).toEqual({ type: 'staking', action: 'GIGAHDX Yield' })
  })
  it('leaves every other type, and an absent one, as sent', () => {
    expect(dailyActivityFilters({ type: 'vote' })).toEqual({ type: 'vote' })
    expect(dailyActivityFilters<{ type?: string; token?: string }>({ token: 'HDX' })).toEqual({ token: 'HDX' })
  })
})
