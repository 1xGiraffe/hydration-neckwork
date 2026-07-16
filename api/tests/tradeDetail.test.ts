import { describe, it, expect } from 'vitest'
import { swapEventAmounts, parseTradeLimit, parseRouteHops, limitMarginPct } from '../src/services/explorerService.ts'

// Trade-detail parsing: swap-event amount extraction (XYK uses amount/salePrice/
// buyPrice instead of amountIn/amountOut), slippage-limit extraction per call
// shape, router route hops, and the executed-vs-limit margin.

describe('swapEventAmounts', () => {
  it('reads amountIn/amountOut for Omnipool/Stableswap/Router events', () => {
    const a = swapEventAmounts('Omnipool.SellExecuted', { assetIn: 222, assetOut: 5, amountIn: '10', amountOut: '20' })
    expect(a).toEqual({ assetIn: 222, assetOut: 5, amountIn: '10', amountOut: '20' })
  })
  it('maps XYK sell amount/salePrice onto in/out', () => {
    const a = swapEventAmounts('XYK.SellExecuted', { assetIn: 5, assetOut: 30, amount: '111', salePrice: '999' })
    expect(a).toEqual({ assetIn: 5, assetOut: 30, amountIn: '111', amountOut: '999' })
  })
  it('maps XYK buy amount/buyPrice onto out/in', () => {
    const a = swapEventAmounts('XYK.BuyExecuted', { assetIn: 5, assetOut: 16, amount: '222', buyPrice: '444' })
    expect(a).toEqual({ assetIn: 5, assetOut: 16, amountIn: '444', amountOut: '222' })
  })
})

describe('parseTradeLimit', () => {
  it('Router.sell → min received of assetOut', () => {
    expect(parseTradeLimit('Router.sell', { assetIn: 10, assetOut: 5, minAmountOut: '99' }))
      .toEqual({ kind: 'minReceived', amount: '99', assetId: 5 })
  })
  it('Router.buy → max paid of assetIn', () => {
    expect(parseTradeLimit('Router.buy', { assetIn: 10, assetOut: 5, maxAmountIn: '77' }))
      .toEqual({ kind: 'maxPaid', amount: '77', assetId: 10 })
  })
  it('Omnipool/Stableswap sell & buy limits', () => {
    expect(parseTradeLimit('Omnipool.sell', { assetIn: 9, assetOut: 5, minBuyAmount: '3' })).toEqual({ kind: 'minReceived', amount: '3', assetId: 5 })
    expect(parseTradeLimit('Omnipool.buy', { assetIn: 0, assetOut: 5, maxSellAmount: '4' })).toEqual({ kind: 'maxPaid', amount: '4', assetId: 0 })
    expect(parseTradeLimit('Stableswap.sell', { assetIn: 222, assetOut: 10, minBuyAmount: '5' })).toEqual({ kind: 'minReceived', amount: '5', assetId: 10 })
    expect(parseTradeLimit('Stableswap.buy', { assetIn: 10, assetOut: 22, maxSellAmount: '6' })).toEqual({ kind: 'maxPaid', amount: '6', assetId: 10 })
  })
  it('XYK maxLimit is min-received on sell, max-paid on buy', () => {
    expect(parseTradeLimit('XYK.sell', { assetIn: 1, assetOut: 2, maxLimit: '9' })).toEqual({ kind: 'minReceived', amount: '9', assetId: 2 })
    expect(parseTradeLimit('XYK.buy', { assetIn: 1, assetOut: 2, maxLimit: '8' })).toEqual({ kind: 'maxPaid', amount: '8', assetId: 1 })
  })
  it('returns null for non-swap calls (batch, proxy, transfers)', () => {
    expect(parseTradeLimit('Utility.batch_all', { calls: [] })).toBeNull()
    expect(parseTradeLimit('Balances.transfer', {})).toBeNull()
  })
})

describe('parseRouteHops', () => {
  it('parses the router route with pool kinds and stableswap pool ids', () => {
    const hops = parseRouteHops({
      route: [
        { pool: { __kind: 'Aave' }, assetIn: 10, assetOut: 1002 },
        { pool: { __kind: 'Stableswap', value: 111 }, assetIn: 1002, assetOut: 222 },
        { pool: { __kind: 'Omnipool' }, assetIn: 222, assetOut: 1000796 },
      ],
    })
    expect(hops).toEqual([
      { pool: 'Aave', poolId: null, assetIn: 10, assetOut: 1002 },
      { pool: 'Stableswap', poolId: 111, assetIn: 1002, assetOut: 222 },
      { pool: 'Omnipool', poolId: null, assetIn: 222, assetOut: 1000796 },
    ])
  })
  it('returns [] when there is no route', () => {
    expect(parseRouteHops({ assetIn: 9 })).toEqual([])
  })
})

describe('limitMarginPct', () => {
  it('headroom above a min-received floor', () => {
    expect(limitMarginPct('minReceived', '100', '103')).toBeCloseTo(3)
  })
  it('headroom under a max-paid ceiling', () => {
    expect(limitMarginPct('maxPaid', '100', '97')).toBeCloseTo(3)
  })
  it('null for zero/absent limits', () => {
    expect(limitMarginPct('minReceived', '0', '103')).toBeNull()
    expect(limitMarginPct('minReceived', '', '103')).toBeNull()
  })
})
