import { describe, expect, it } from 'vitest'
import { arbDirectionFromRaw, classifyHsmSwap, foldHsmCollateralParams, mergeHsmHoldings, parsePoolAssetIds, type RawHsmCollateralEvent } from '../src/services/hollarService.ts'

describe('parsePoolAssetIds', () => {
  it('passes through the array encoding unchanged', () => {
    expect(parsePoolAssetIds([7, 9])).toEqual([7, 9])
  })

  it('decodes the compact hex-byte-string encoding', () => {
    expect(parsePoolAssetIds('0x0102')).toEqual([1, 2])
  })

  it('decodes every asset in a multi-asset compact encoding', () => {
    expect(parsePoolAssetIds('0x010203')).toEqual([1, 2, 3])
  })
})

describe('arbDirectionFromRaw', () => {
  it('maps the HSM.ArbitrageExecuted `arbitrage` byte to a direction', () => {
    // 1 = HollarOut (pool short of HOLLAR -> HSM mints/sells HOLLAR into the pool)
    expect(arbDirectionFromRaw(1)).toBe('out')
    // 2 = HollarIn (pool oversupplied -> HSM buys HOLLAR back and burns)
    expect(arbDirectionFromRaw(2)).toBe('in')
  })
  it('returns null for an unrecognized direction byte', () => {
    expect(arbDirectionFromRaw(0)).toBeNull()
    expect(arbDirectionFromRaw(3)).toBeNull()
  })
})

describe('classifyHsmSwap', () => {
  it('classifies an HSM sell from the HOLLAR input leg', () => {
    const args = {
      fillerType: { __kind: 'HSM' },
      inputs: [{ asset: 222, amount: '2886080597856675415' }],
      outputs: [{ asset: 1003, amount: '2880304' }],
    }
    expect(classifyHsmSwap(args)).toEqual({ direction: 'sold', hollarAmountRaw: '2886080597856675415' })
  })

  it('classifies an HSM buy from the HOLLAR output leg', () => {
    const args = {
      fillerType: { __kind: 'HSM' },
      inputs: [{ asset: 1003, amount: '20005423' }],
      outputs: [{ asset: 222, amount: '20046011728594467700' }],
    }
    expect(classifyHsmSwap(args)).toEqual({ direction: 'bought', hollarAmountRaw: '20046011728594467700' })
  })

  it('ignores swaps filled by anything other than HSM', () => {
    const args = {
      fillerType: { __kind: 'Omnipool' },
      inputs: [{ asset: 222, amount: '1000000000000000000' }],
      outputs: [{ asset: 5, amount: '500000000' }],
    }
    expect(classifyHsmSwap(args)).toBeNull()
  })

  it('returns null when neither side is HOLLAR', () => {
    const args = {
      fillerType: { __kind: 'HSM' },
      inputs: [{ asset: 1003, amount: '1' }],
      outputs: [{ asset: 1002, amount: '1' }],
    }
    expect(classifyHsmSwap(args)).toBeNull()
  })
})

describe('foldHsmCollateralParams', () => {
  const events: RawHsmCollateralEvent[] = [
    { block: 10, args: { assetId: 7, poolId: 9, purchaseFee: 0, maxBuyPriceCoefficient: '995000000000000000', buyBackFee: 500, buybackRate: 1_000 } },
    { block: 20, args: { assetId: 7, buyBackFee: 100, buybackRate: 100_000 } },
    { block: 30, args: { assetId: 7, maxBuyPriceCoefficient: '998000000000000000' } },
    { block: 30, args: { assetId: 8 } },
    { block: 40, args: { assetId: 7, maxInHolding: { __kind: 'Some', value: '8000000000000' } } },
  ]

  it('folds partial updates chronologically with last-write-wins fields', () => {
    const folded = foldHsmCollateralParams(events)
    expect(folded.get(7)).toEqual({
      assetId: 7,
      poolId: 9,
      purchaseFeePermill: 0,
      maxBuyPriceCoefficientRaw: '998000000000000000',
      buyBackFeePermill: 100,
      buybackRatePerbill: 100000,
      maxInHoldingRaw: '8000000000000',
    })
  })

  it('leaves an asset untouched by an update whose args carry only assetId', () => {
    const folded = foldHsmCollateralParams([
      { block: 1, args: { assetId: 1000745, poolId: 112, purchaseFee: 0, maxBuyPriceCoefficient: '995000000000000000', buyBackFee: 100, buybackRate: 100000 } },
      { block: 2, args: { assetId: 1000745 } }, // no-op update, e.g. an unrelated field changed
    ])
    expect(folded.get(1000745)?.maxBuyPriceCoefficientRaw).toBe('995000000000000000')
    expect(folded.get(1000745)?.buyBackFeePermill).toBe(100)
  })

  it('clears maxInHolding when explicitly set to None after a prior Some', () => {
    const folded = foldHsmCollateralParams([
      { block: 1, args: { assetId: 1003, poolId: 110, purchaseFee: 0, maxBuyPriceCoefficient: '995000000000000000', buyBackFee: 100, buybackRate: 100000 } },
      { block: 2, args: { assetId: 1003, maxInHolding: { __kind: 'Some', value: '8000000000000' } } },
      { block: 3, args: { assetId: 1003, maxInHolding: { __kind: 'None' } } },
    ])
    expect(folded.get(1003)?.maxInHoldingRaw).toBeNull()
  })
})

describe('mergeHsmHoldings', () => {
  it('prefers the reconstructed aToken balance over the event fold', () => {
    // aToken balances never appear in the event-folded table (EVM-side storage,
    // interest rebasing) — the anchor+delta reconstruction is ground truth.
    const out = mergeHsmHoldings([1003, 1002], new Map([[1003, 218022224483n], [1002, 112059n]]), new Map([[1003, '0'], [1002, '999']]))
    expect(out.get(1003)).toBe('218022224483')
    expect(out.get(1002)).toBe('112059')
  })

  it('falls back to the folded balance when the reconstruction has no entry (non-aTokens, missing anchor)', () => {
    const out = mergeHsmHoldings([10, 21], new Map(), new Map([[10, '5000000']]))
    expect(out.get(10)).toBe('5000000')
    expect(out.get(21)).toBe('0')
  })
})
