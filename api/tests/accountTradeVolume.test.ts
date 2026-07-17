import { describe, expect, it } from 'vitest'
import { accountVolumeSource, isAccountTradeVolumeReady, setAccountTradeVolumeReady } from '../src/services/accountTradeVolume.ts'

// Model-readiness gate: per-account trading volume must fall back to the legacy
// per-leg sum until the de-duped net-trade model's backfill covers every active
// partition, then switch — so the number is never silently partial mid-backfill.
describe('account trade volume source gate', () => {
  it('reads the legacy per-leg table until the net-trade model is covered', () => {
    expect(isAccountTradeVolumeReady()).toBe(false)
    expect(accountVolumeSource()).toEqual({ table: 'price_data.trade_volume_by_account', col: 'usd_volume_buy' })
  })

  it('switches to the de-duped net-trade table once ready', () => {
    setAccountTradeVolumeReady()
    expect(isAccountTradeVolumeReady()).toBe(true)
    expect(accountVolumeSource()).toEqual({ table: 'price_data.account_trade_volume', col: 'volume_usd' })
  })
})
