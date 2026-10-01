import { describe, expect, it } from 'vitest'
import { chartOrientation, chartTimeframe, feeAdjustedLimit, fillPoints, measuredFee, placementRead, priceRange } from '../src/utils/intentChart'
import type { ActivityRow, AssetRef } from '../src/types'

const a = (assetId: number, symbol: string, decimals = 12): AssetRef => ({ assetId, iconAssetId: assetId, symbol, name: null, decimals, parachainId: null })
const HDX = a(0, 'HDX'), DOT = a(5, 'DOT', 10), USDT = a(10, 'USDT', 6), HOLLAR = a(222, 'HOLLAR', 18), AUSDC = a(1003, 'aUSDC', 6)

describe('chartOrientation', () => {
  it('quotes in the money-like leg, whichever side the order sells', () => {
    // Selling DOT for USDT: USDT per DOT, fills at or above the line.
    expect(chartOrientation({ assetIn: DOT, assetOut: USDT, limitPriceOutPerIn: '1.3', limitPriceInPerOut: '0.769' }))
      .toMatchObject({ base: DOT, quote: USDT, limit: 1.3, fillsWhen: 'above', sellsBase: true })
    // Selling HOLLAR for HDX (buying HDX): HOLLAR per HDX, fills at or below the line.
    expect(chartOrientation({ assetIn: HOLLAR, assetOut: HDX, limitPriceOutPerIn: '140', limitPriceInPerOut: '0.00714' }))
      .toMatchObject({ base: HDX, quote: HOLLAR, limit: 0.00714, fillsWhen: 'below', sellsBase: false })
  })

  it('treats an aToken over a stable as the stable', () => {
    expect(chartOrientation({ assetIn: HDX, assetOut: AUSDC, limitPriceOutPerIn: '0.008', limitPriceInPerOut: '125' }).quote).toBe(AUSDC)
  })

  it('reads two non-money legs so the price is above 1', () => {
    expect(chartOrientation({ assetIn: HDX, assetOut: DOT, limitPriceOutPerIn: '0.0061', limitPriceInPerOut: '163' }))
      .toMatchObject({ base: DOT, quote: HDX, limit: 163, fillsWhen: 'below' })
    expect(chartOrientation({ assetIn: DOT, assetOut: HDX, limitPriceOutPerIn: '163', limitPriceInPerOut: '0.0061' }))
      .toMatchObject({ base: DOT, quote: HDX, limit: 163, fillsWhen: 'above' })
  })
})

describe('chartTimeframe', () => {
  it('zooms in the closer the limit sits to market, the same either way round', () => {
    expect(chartTimeframe(1.005).interval).toBe('15min')
    expect(chartTimeframe(1 / 1.005).interval).toBe('15min')
    expect(chartTimeframe(1.03).interval).toBe('1h')
    expect(chartTimeframe(0.9).interval).toBe('4h')
    expect(chartTimeframe(1.4).interval).toBe('1d')
    expect(chartTimeframe(700).interval).toBe('1w')
    expect(chartTimeframe(null).interval).toBe('1h')
  })
})

describe('fillPoints', () => {
  it('prices each fill in the chart\'s orientation', () => {
    const fill = { timestamp: '2026-09-29 12:00:00', amountIn: '2000000000000000000000', amountOut: '280000000000000', assetIn: HOLLAR, assetOut: HDX } as unknown as ActivityRow
    const o = chartOrientation({ assetIn: HOLLAR, assetOut: HDX, limitPriceOutPerIn: '140', limitPriceInPerOut: '0.00714' })
    const [p] = fillPoints([fill], o)
    expect(p.price).toBeCloseTo(2000 / 280, 9)
    expect(p.t).toBe(Date.parse('2026-09-29T12:00:00Z') / 1000)
  })
})

describe('priceRange', () => {
  it('takes in a limit near the candles, and reports one far off market outside the plot', () => {
    const near = priceRange([1.0, 1.02], [1.05, 1.06], 1.1)
    expect(near.limitOffscale).toBeNull()
    expect(near.hi).toBeGreaterThan(1.1)
    const far = priceRange([0.0074], [0.0078], 5)
    expect(far.limitOffscale).toBe('above')
    expect(far.hi).toBeLessThan(0.01)
  })
})

describe('placementRead', () => {
  const o = chartOrientation({ assetIn: HOLLAR, assetOut: a(22, 'USDC', 6), limitPriceOutPerIn: '0.98819', limitPriceInPerOut: '1.0119' })
  const candles = [{ t: 1000, o: 0.998, c: 0.998 }, { t: 1900, o: 0.9979, c: 0.998 }]

  it('reads a minimum received the market already met at placement', () => {
    const r = placementRead(o, candles, 900, 1950, 1956)
    expect(r.marketable).toBe(true)
    expect(r.distancePct).toBeCloseTo((0.98819 / 0.9979 - 1) * 100, 6)
  })

  it('reads a limit above the market as resting', () => {
    const resting = chartOrientation({ assetIn: HOLLAR, assetOut: a(22, 'USDC', 6), limitPriceOutPerIn: '1.01', limitPriceInPerOut: '0.99' })
    expect(placementRead(resting, candles, 900, 1950, null).marketable).toBe(false)
  })

  it('falls back to a fill within a minute of placement when the chart does not cover it', () => {
    expect(placementRead(o, candles, 900, 100, 130)).toEqual({ marketable: true, distancePct: null })
    expect(placementRead(o, candles, 900, 100, 900)).toEqual({ marketable: false, distancePct: null })
  })
})

describe('the fee-adjusted line', () => {
  // Intent 33034537680267242151258095616424: buy PRIME with USDT paying at most
  // 1.06120 USDT per PRIME; every fill executed at 1.06116 against a candle at 1.06061.
  const PRIME = a(43, 'PRIME', 6)
  const o = chartOrientation({ assetIn: USDT, assetOut: PRIME, limitPriceOutPerIn: '0.942329', limitPriceInPerOut: '1.06120049367' })
  const candles = [{ t: 900, c: 1.060607488512 }, { t: 1800, c: 1.0606 }]
  const fills = [{ t: 1000, price: 1.06116, href: null }, { t: 1100, price: 1.06116, href: null }, { t: 1900, price: 1.06115, href: null }]

  it('measures the fee its fills paid over the candles', () => {
    expect(o).toMatchObject({ base: PRIME, fillsWhen: 'below' })
    expect(measuredFee(o, fills, candles, 900)).toBeCloseTo(1.06116 / 1.060607488512 - 1, 9)
  })

  it('moves the line to where the market must be for the order to fill', () => {
    const fee = measuredFee(o, fills, candles, 900)!
    expect(feeAdjustedLimit(o, fee)).toBeCloseTo(1.06120049367 / (1 + fee), 9)
    // A seller receives less: the line moves UP by the fee.
    const sell = chartOrientation({ assetIn: DOT, assetOut: USDT, limitPriceOutPerIn: '1.3', limitPriceInPerOut: '0.769' })
    expect(feeAdjustedLimit(sell, 0.01)).toBeCloseTo(1.3 / 0.99, 9)
    expect(feeAdjustedLimit(sell, null)).toBe(1.3)
  })

  it('measures nothing without a fill inside the candles, or when the gap is not a fee', () => {
    expect(measuredFee(o, [], candles, 900)).toBeNull()
    expect(measuredFee(o, [{ t: 99_999, price: 1.1, href: null }], candles, 900)).toBeNull()
    // Fills BELOW the market on a buy are not a fee, and a 20 % "fee" is not one either.
    expect(measuredFee(o, [{ t: 1000, price: 1.05, href: null }], candles, 900)).toBeNull()
    expect(measuredFee(o, [{ t: 1000, price: 1.3, href: null }], candles, 900)).toBeNull()
  })
})
