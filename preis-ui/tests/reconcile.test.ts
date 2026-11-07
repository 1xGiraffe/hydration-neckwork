import { describe, expect, it } from 'vitest'
import { reconcileCandleVolume } from '../src/utils/reconcile'
import type { OmniwatchVolumeDetails } from '../src/types'

const details = (over: Partial<OmniwatchVolumeDetails>): OmniwatchVolumeDetails => ({
  accounts: [], accountCount: 1, tradeCount: 1,
  volumeBuy: 0, volumeSell: 0, volumeTotal: 100, netVolume: 0,
  nativeVolumeBuy: '0', nativeVolumeSell: '0', nativeVolumeTotal: '1000', nativeNetVolume: '0',
  candleVolumeTotal: 100, candleNativeVolumeTotal: '1000',
  limit: 200, offset: 0, hasMore: false, nextOffset: null,
  ...over,
})

describe('reconcileCandleVolume', () => {
  it('names pool volume no account is booked for', () => {
    expect(reconcileCandleVolume(details({ candleVolumeTotal: 300, candleNativeVolumeTotal: '3000' })))
      .toEqual({ kind: 'unattributed', usd: 200, native: '2000' })
  })

  it('names account volume beyond the pool volume as ICE-matched', () => {
    expect(reconcileCandleVolume(details({ candleVolumeTotal: 40, candleNativeVolumeTotal: '400' })))
      .toEqual({ kind: 'matched', usd: 60, native: '600' })
  })

  it('says nothing below $1 or 1% of the larger side', () => {
    expect(reconcileCandleVolume(details({ candleVolumeTotal: 100.9 }))).toBeNull()
    expect(reconcileCandleVolume(details({ volumeTotal: 1_000_000, candleVolumeTotal: 1_005_000 }))).toBeNull()
    expect(reconcileCandleVolume(details({ volumeTotal: 1_000_000, candleVolumeTotal: 1_020_000 }))?.kind).toBe('unattributed')
  })

  it('judges an unpriced asset on its native amounts, exactly', () => {
    const unpriced = { volumeTotal: 0, candleVolumeTotal: 0 }
    expect(reconcileCandleVolume(details({ ...unpriced, nativeVolumeTotal: '123456789012345678901234567890', candleNativeVolumeTotal: '123456789012345678901234567890' }))).toBeNull()
    expect(reconcileCandleVolume(details({ ...unpriced, nativeVolumeTotal: '0', candleNativeVolumeTotal: '5' })))
      .toEqual({ kind: 'unattributed', usd: 0, native: '5' })
  })

  it('says nothing to an api without the candle figures', () => {
    expect(reconcileCandleVolume(details({ candleVolumeTotal: undefined, candleNativeVolumeTotal: undefined }))).toBeNull()
  })
})
