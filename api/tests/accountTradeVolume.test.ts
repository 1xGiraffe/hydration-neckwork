import { describe, expect, it } from 'vitest'
import { accountVolumeSource } from '../src/services/accountTradeVolume.ts'

// Per-account trading volume always reads the de-duped net-trade model (the
// legacy per-leg readiness gate was removed once its backfill completed).
describe('accountVolumeSource', () => {
  it('returns the net-trade model table and column', () => {
    expect(accountVolumeSource()).toEqual({ table: 'price_data.account_trade_volume', col: 'volume_usd' })
  })
})
