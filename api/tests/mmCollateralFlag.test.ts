import { describe, it, expect } from 'vitest'
import { mmReserveRow, mmReserveAddressForAsset } from '../src/services/explorerService.ts'
import type { MmReserveToken } from '../src/services/explorerService.ts'

// A supplied reserve is NOT automatically collateral: Aave keeps a per-user
// usage-as-collateral bit, and a reserve the user turned off — or one that carries
// no LTV and so was never auto-enabled — is lent out while backing nothing. The
// badge must follow that bit, never a positive aToken balance.
const RAY = 10n ** 27n
const POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const RESERVE = mmReserveAddressForAsset(15)[0]   // vDOT's money-market reserve
const ATOKEN = '0x00000000000000000000000000000000000a1005'
const VDEBT = '0x00000000000000000000000000000000000d1005'
const KEY = `${POOL}:${RESERVE}`

const token: MmReserveToken = { asset: RESERVE, aToken: ATOKEN, vDebt: VDEBT, poolProxy: POOL, marketKey: 'core' }
const indices = new Map([[KEY, { liq: RAY, vbi: RAY }]])
const supplied = new Map([[ATOKEN, 20_000_000_000n]])
const noPrices = new Map()

describe('mmReserveRow collateral flag', () => {
  it('marks a supplied reserve as collateral only when the holder enabled it', () => {
    const row = mmReserveRow(token, supplied, indices, noPrices, new Map([[KEY, true]]))
    expect(row?.supplied).toBe('20000000000')
    expect(row?.collateral).toBe(true)
  })

  it('leaves a supplied reserve the holder disabled off the collateral badge', () => {
    expect(mmReserveRow(token, supplied, indices, noPrices, new Map([[KEY, false]]))?.collateral).toBe(false)
  })

  it('treats a reserve with no flag row as never collateralised', () => {
    expect(mmReserveRow(token, supplied, indices, noPrices, new Map())?.collateral).toBe(false)
  })

  it('never marks a debt-only reserve as collateral, even with the flag set', () => {
    const borrowed = new Map([[VDEBT, 5_000_000_000n]])
    const row = mmReserveRow(token, borrowed, indices, noPrices, new Map([[KEY, true]]))
    expect(row?.debt).toBe('5000000000')
    expect(row?.collateral).toBe(false)
  })
})
