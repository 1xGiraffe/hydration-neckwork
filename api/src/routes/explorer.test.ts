import { describe, expect, it } from 'vitest'
import { unusableFilterParam } from './explorer.ts'
import { liqActionFor, liquidityActionEventNames, isAmountlessLiquidityEvent, liquidityRowAmount } from '../services/explorerService.ts'
import type { PriceInfo } from '../services/explorerService.ts'

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

// XYK.PoolDestroyed always rides alongside XYK.LiquidityRemoved (728 of 728
// extrinsic groups chain-wide), so it is a lifecycle marker carrying no value.
// XYK.PoolCreated never rides alongside XYK.LiquidityAdded (0 of 956), so it is
// the only record of the seed liquidity and must keep its amount.
describe('liquidity pool lifecycle classification', () => {
  it('labels pool destruction distinctly rather than falling through to Add', () => {
    expect(liqActionFor('XYK.PoolDestroyed')).toBe('Destroy')
    expect(liqActionFor('XYK.PoolCreated')).toBe('Create')
    expect(liqActionFor('XYK.LiquidityRemoved')).toBe('Remove')
    expect(liqActionFor('XYK.LiquidityAdded')).toBe('Add')
    expect(liqActionFor('OmnipoolLiquidityMining.RewardClaimed')).toBe('Claim')
  })

  it('keeps the derived action inverse consistent with the label', () => {
    expect(liquidityActionEventNames('Destroy')).toEqual(['XYK.PoolDestroyed'])
    expect(liquidityActionEventNames('Remove')).not.toContain('XYK.PoolDestroyed')
    expect(liquidityActionEventNames()).toContain('XYK.PoolDestroyed')
  })

  it('marks pool destruction amountless so the paired removal is not double-counted', () => {
    expect(isAmountlessLiquidityEvent('XYK.PoolDestroyed')).toBe(true)
    // Every other empty-amount event MUST still be fillable from its transfer leg.
    expect(isAmountlessLiquidityEvent('XYK.PoolCreated')).toBe(false)
    expect(isAmountlessLiquidityEvent('XYK.LiquidityAdded')).toBe(false)
    expect(isAmountlessLiquidityEvent('XYK.LiquidityRemoved')).toBe(false)
    expect(isAmountlessLiquidityEvent('Omnipool.LiquidityRemoved')).toBe(false)
  })

  // The read model hands an amountless event exactly '' (see
  // LIQUIDITY_AMOUNT_ARG['XYK.PoolDestroyed']), and Number('') is 0 — so without an
  // explicit guard at the row's construction, a Destroy row would price at exactly
  // $0.00 the moment its asset has a live price, rather than carrying no value at
  // all. The price MUST be present for this to be a real test: with none loaded,
  // usdValue already returns null on its own and this would pass vacuously.
  it('keeps a Destroy row valueless on the wire even when its asset has a live price', () => {
    const prices = new Map<number, PriceInfo>([[5, { price: 2.5, change24h: 0 }]])
    expect(liquidityRowAmount('XYK.PoolDestroyed', prices, 5, '', 12)).toEqual({ amount: null, valueUsd: null })
    // Sanity: the same helper must still price a REAL amount for a non-amountless
    // event under the same price map, so the guard isn't just returning null
    // unconditionally.
    expect(liquidityRowAmount('XYK.LiquidityAdded', prices, 5, String(4 * 10 ** 12), 12)).toEqual({ amount: String(4 * 10 ** 12), valueUsd: 10 })
  })
})
