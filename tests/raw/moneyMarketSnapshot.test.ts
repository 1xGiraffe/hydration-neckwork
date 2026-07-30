import { describe, expect, it } from 'vitest'
import { moneyMarketSweepHasNoSuccess } from '../../src/raw/moneyMarketSnapshot.ts'

describe('money-market snapshot result validation', () => {
  it('fails only when every candidate produced an RPC warning', () => {
    expect(moneyMarketSweepHasNoSuccess(0, 3)).toBe(true)
    expect(moneyMarketSweepHasNoSuccess(0, 0)).toBe(false)
    expect(moneyMarketSweepHasNoSuccess(2, 1)).toBe(false)
  })
})
