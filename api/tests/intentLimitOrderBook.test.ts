import { describe, expect, it } from 'vitest'
import { assetBookEntry, compareLimitOrdersByValueDesc, limitPriceOf, type OpenLimitOrder, type PriceInfo } from '../src/services/explorerService.ts'

// The resting-limit-order model the account and asset pages read: an unfilled
// swap intent is money committed at a price, so its remaining size and that
// price are what both surfaces state.

// ---------------------------------------------------------------------------
// The asset page's book
// ---------------------------------------------------------------------------

const HDX = { assetId: 0, symbol: 'HDX', decimals: 12 }
const HOLLAR = { assetId: 222, symbol: 'HOLLAR', decimals: 18 }
const USDC = { assetId: 1003, symbol: 'aUSDC', decimals: 6 }

function order(over: Partial<OpenLimitOrder> & Pick<OpenLimitOrder, 'intentId'>): OpenLimitOrder {
  return {
    // Only the fields the arithmetic under test reads are fixtured; the owner
    // pill's shape is irrelevant here, so it is cast in rather than built.
    seq: 1, who: { accountId: '0x00' } as unknown as OpenLimitOrder['who'],
    assetIn: HDX as OpenLimitOrder['assetIn'], assetOut: HOLLAR as OpenLimitOrder['assetOut'],
    amountIn: '0', amountOut: '0', filledIn: '0', filledOut: '0',
    remainingIn: '0', remainingOut: '0', fills: 0, partial: true,
    limitPrice: null, valueUsd: null,
    placedBlock: 1, placedIndex: null, timestamp: '2026-09-11T00:00:00.000Z', deadline: null,
    ...over,
  }
}

describe('limitPriceOf', () => {
  it('prices across differing decimals', () => {
    // 3,600 HOLLAR (18dp) for 500,000 HDX (12dp) — the real open order #87.
    expect(limitPriceOf('3600000000000000000000', 18, '500000000000000000', 12)).toBeCloseTo(138.8889, 4)
  })
  it('refuses a zero or unparseable base rather than returning Infinity', () => {
    expect(limitPriceOf('0', 12, '1', 12)).toBeNull()
    expect(limitPriceOf('', 12, '1', 12)).toBeNull()
  })
})

describe('assetBookEntry', () => {
  const prices = new Map<number, PriceInfo>([
    [0, { price: 0.01, change24h: 0 }],
    [222, { price: 1, change24h: 0 }],
    [1003, { price: 1, change24h: 0 }],
  ])

  it('states a bid from the bought asset’s side', () => {
    // Sells 100 HOLLAR to buy 20,000 HDX → one HDX costs 0.005 HOLLAR.
    const bid = order({
      intentId: '1', assetIn: HOLLAR as OpenLimitOrder['assetIn'], assetOut: HDX as OpenLimitOrder['assetOut'],
      amountIn: '100000000000000000000', amountOut: '20000000000000000',
      remainingIn: '100000000000000000000', remainingOut: '20000000000000000',
    })
    const entry = assetBookEntry(bid, 0, prices)
    expect(entry.counter.assetId).toBe(222)
    expect(entry.price).toBeCloseTo(0.005, 6)
    expect(entry.priceUsd).toBeCloseTo(0.005, 6)
    expect(entry.size).toBe('20000000000000000')   // HDX, the asset being bought
    expect(entry.total).toBe('100000000000000000000')
    expect(entry.sizeUsd).toBeCloseTo(100, 6)
  })

  it('states an ask from the sold asset’s side, on the REMAINING size', () => {
    // Placed 1,000 HDX for 6 aUSDC; 400 HDX already partially filled.
    const ask = order({
      intentId: '2', assetIn: HDX as OpenLimitOrder['assetIn'], assetOut: USDC as OpenLimitOrder['assetOut'],
      amountIn: '1000000000000000', amountOut: '6000000',
      filledIn: '400000000000000', filledOut: '2400000',
      remainingIn: '600000000000000', remainingOut: '3600000',
    })
    const entry = assetBookEntry(ask, 0, prices)
    expect(entry.counter.assetId).toBe(1003)
    // Price comes from the amounts AS PLACED — partials fill at that price, so
    // the ratio is the order's identity and must not drift as it fills.
    expect(entry.price).toBeCloseTo(0.006, 9)
    expect(entry.size).toBe('600000000000000')
    expect(entry.total).toBe('3600000')
  })

  it('leaves priceUsd null when the counter asset has no feed', () => {
    const noFeed = new Map<number, PriceInfo>([[0, { price: 0.01, change24h: 0 }]])
    const ask = order({
      intentId: '3', assetIn: HDX as OpenLimitOrder['assetIn'], assetOut: USDC as OpenLimitOrder['assetOut'],
      amountIn: '1000000000000000', amountOut: '6000000', remainingIn: '1000000000000000', remainingOut: '6000000',
    })
    const entry = assetBookEntry(ask, 0, noFeed)
    expect(entry.price).toBeCloseTo(0.006, 9)
    expect(entry.priceUsd).toBeNull()
    expect(entry.sizeUsd).toBeNull()
  })
})

describe('compareLimitOrdersByValueDesc', () => {
  it('ranks by resting dollars and sinks an unpriced order below a knowable zero', () => {
    const priced = order({ intentId: 'a', valueUsd: 10 })
    const zero = order({ intentId: 'b', valueUsd: 0 })
    const unpriced = order({ intentId: 'c', valueUsd: null })
    expect([unpriced, zero, priced].sort(compareLimitOrdersByValueDesc).map(o => o.intentId)).toEqual(['a', 'b', 'c'])
  })
})
