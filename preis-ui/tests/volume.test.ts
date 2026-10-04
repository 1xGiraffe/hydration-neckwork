import { describe, expect, it } from 'vitest'
import type { ApiCandle } from '../src/types'
import { candleVolume, formatTokenAmount, formatVolumeAxis, formatVolumeReadout } from '../src/utils/volume'

const candle = (extra: Partial<ApiCandle> = {}): ApiCandle => ({
  intervalStart: 0, open: 1, high: 1, low: 1, close: 1, volumeBuy: 600, volumeSell: 400, volumeTotal: 1000, ...extra,
})

describe('chart volume', () => {
  it('scales an asset pair\'s bars by the pair\'s base-token amount', () => {
    expect(candleVolume(candle({ pairVolumeUsd: 14_200, pairVolumeBase: 12_345, pairVolumeQuote: 3000 }), true)).toBe(12_345)
  })

  it('keeps the base asset\'s own dollar volume on a dollar pair', () => {
    expect(candleVolume(candle({ pairVolumeUsd: 120, pairVolumeBase: 25.5 }), false)).toBe(1000)
    expect(formatVolumeReadout(candle(), false, 'DOT')).toBe('$1k')
    expect(formatVolumeAxis(1000, false, 'DOT')).toBe('$1k')
  })

  it('falls back to the base asset\'s dollars when the server sends no pair volume', () => {
    expect(candleVolume(candle(), true)).toBe(1000)
    expect(formatVolumeReadout(candle(), true, 'DOT')).toBe('$1k')
  })

  it('reads out both the token amount and its dollars on an asset pair', () => {
    expect(formatVolumeReadout(candle({ pairVolumeUsd: 14_200, pairVolumeBase: 12_345 }), true, 'DOT')).toBe('12,345 DOT · $14.2k')
    expect(formatVolumeReadout(candle({ pairVolumeUsd: 0, pairVolumeBase: 0 }), true, 'DOT')).toBe('0 DOT · $0')
    expect(formatVolumeAxis(12_345, true, 'DOT')).toBe('12.3k DOT')
  })

  it('groups short token amounts and compacts long ones', () => {
    expect(formatTokenAmount(4.6612)).toBe('4.66')
    expect(formatTokenAmount(12_345.6)).toBe('12,346')
    expect(formatTokenAmount(12_345_678)).toBe('12.3M')
    expect(formatTokenAmount(0.5768)).toBe('0.577')
  })
})
