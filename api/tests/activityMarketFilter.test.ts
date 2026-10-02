import { describe, expect, it } from 'vitest'
import { activityRowMatchesFilters, mmMarketPoolSql, mmMarkets } from '../src/services/explorerService.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'
import { unusableFilterParam, valueFilters } from '../src/routes/explorer.ts'

// The money-market feeds' `market` filter: one isolated market by its key, pushed
// into the mm source reads as the pool predicate a row's mmMarketKey is derived
// from, and re-checked on the built rows — so a page, its exact count and its
// located ranks all select the same rows.
const pools = Object.fromEntries(mmMarkets().map(m => [m.key, m.poolProxy]))

describe('the market query param', () => {
  it('accepts a configured market key on the money-market feed', () => {
    for (const key of ['core', 'gigahdx', 'bil']) {
      expect(unusableFilterParam({ type: 'mm', market: key })).toBeNull()
      expect(valueFilters({ type: 'mm', market: key }).market).toBe(key)
    }
    // Cleared = unfiltered, as for every other filter.
    expect(unusableFilterParam({ type: 'mm', market: '' })).toBeNull()
    expect(valueFilters({ type: 'mm', market: '' }).market).toBeUndefined()
  })

  it('refuses an unknown key rather than widening to every market', () => {
    const bad = unusableFilterParam({ type: 'mm', market: 'nonsense' })
    expect(bad?.key).toBe('market')
    expect(bad?.expected).toContain('core')
    expect(unusableFilterParam({ type: 'mm', market: 'CORE' })?.key).toBe('market')
  })

  it('refuses a market on any feed other than the money-market one', () => {
    expect(unusableFilterParam({ market: 'core' })?.key).toBe('market')
    expect(unusableFilterParam({ type: 'all', market: 'core' })?.key).toBe('market')
    expect(unusableFilterParam({ type: 'trade', market: 'gigahdx' })?.key).toBe('market')
  })
})

describe('mmMarketPoolSql', () => {
  it('is the pool predicate the row market is derived from', () => {
    expect(mmMarketPoolSql(undefined)).toBe('')
    expect(mmMarketPoolSql('core')).toBe(`AND lower(ifNull(pool_address, '')) = '${pools.core}'`)
    expect(mmMarketPoolSql('bil', 'm.pool_address')).toBe(`AND lower(m.pool_address) = '${pools.bil}'`)
  })

  it('selects nothing for a key no deployment configured', () => {
    expect(mmMarketPoolSql('nonsense')).toBe('AND 0')
  })
})

describe('the market row filter', () => {
  const row = (over: Partial<ActivityRow>): ActivityRow =>
    ({ type: 'mm', blockHeight: 1, timestamp: '2026-10-01 00:00:00', extrinsicIndex: 0, who: null, to: null,
       asset: null, assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null, ...over } as ActivityRow)

  it('keeps only the rows of the requested market', () => {
    const core = row({ mmAction: 'Borrow', mmMarketKey: 'core', mmMarket: 'Money Market' })
    const giga = row({ mmAction: 'Borrow', mmMarketKey: 'gigahdx', mmMarket: 'GIGAHDX' })
    expect(activityRowMatchesFilters(core, { market: 'core' })).toBe(true)
    expect(activityRowMatchesFilters(giga, { market: 'core' })).toBe(false)
    expect(activityRowMatchesFilters(giga, { market: 'gigahdx' })).toBe(true)
    expect(activityRowMatchesFilters(giga, {})).toBe(true)
  })

  it('drops a reward claim, which names no market', () => {
    const claim = row({ mmAction: 'ClaimRewards' })
    expect(activityRowMatchesFilters(claim, {})).toBe(true)
    expect(activityRowMatchesFilters(claim, { market: 'core' })).toBe(false)
  })
})
