import { describe, expect, it } from 'vitest'
import { mmReserveAddressForAsset, valueSingleUnpricedSupply, type MmReserve } from '../src/services/explorerService.ts'

describe('money-market reserve address mapping', () => {
  it('includes both precompile and deployed-token addresses for HOLLAR', () => {
    expect(mmReserveAddressForAsset(222)).toEqual(expect.arrayContaining([
      '0x00000000000000000000000000000001000000de',
      '0x531a654d1696ed52e7275a8cede955e82620f99a',
    ]))
  })

  it('keeps standard precompile reserves unchanged', () => {
    expect(mmReserveAddressForAsset(5)).toEqual([
      '0x0000000000000000000000000000000100000005',
    ])
  })
})

describe('unpriced supplied-reserve valuation', () => {
  const stHdx: MmReserve = {
    assetId: 670,
    symbol: 'stHDX',
    decimals: 12,
    supplied: '1000000000000',
    debt: '0',
    suppliedUsd: null,
    debtUsd: null,
    collateral: true,
    marketKey: 'gigahdx',
  }

  it('uses aggregate collateral when the unpriced reserve is the sole supply', () => {
    expect(valueSingleUnpricedSupply([stHdx], '4250000000')[0].suppliedUsd).toBe(42.5)
  })

  it('does not guess across a mixed supplied position', () => {
    const hollar: MmReserve = {
      ...stHdx,
      assetId: 222,
      symbol: 'HOLLAR',
      supplied: '1000000000000000000',
      suppliedUsd: 1,
      collateral: false,
    }
    expect(valueSingleUnpricedSupply([stHdx, hollar], '4250000000')[0].suppliedUsd).toBeNull()
  })
})
