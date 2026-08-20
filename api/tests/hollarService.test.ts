import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { arbDirectionFromRaw, classifyHsmSwap, foldHsmCollateralParams, mergeHsmHoldings, parsePoolAssetIds, type RawHsmCollateralEvent } from '../src/services/hollarService.ts'

const hollarService = readFileSync(new URL('../src/services/hollarService.ts', import.meta.url), 'utf8')
const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

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
    { block: 10, name: 'HSM.CollateralAdded', args: { assetId: 7, poolId: 9, purchaseFee: 0, maxBuyPriceCoefficient: '995000000000000000', buyBackFee: 500, buybackRate: 1_000 } },
    { block: 20, name: 'HSM.CollateralUpdated', args: { assetId: 7, buyBackFee: 100, buybackRate: 100_000 } },
    { block: 30, name: 'HSM.CollateralUpdated', args: { assetId: 7, maxBuyPriceCoefficient: '998000000000000000' } },
    { block: 30, name: 'HSM.CollateralAdded', args: { assetId: 8 } },
    { block: 40, name: 'HSM.CollateralUpdated', args: { assetId: 7, maxInHolding: { __kind: 'Some', value: '8000000000000' } } },
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
      { block: 1, name: 'HSM.CollateralAdded', args: { assetId: 1000745, poolId: 112, purchaseFee: 0, maxBuyPriceCoefficient: '995000000000000000', buyBackFee: 100, buybackRate: 100000 } },
      { block: 2, name: 'HSM.CollateralUpdated', args: { assetId: 1000745 } }, // no-op update, e.g. an unrelated field changed
    ])
    expect(folded.get(1000745)?.maxBuyPriceCoefficientRaw).toBe('995000000000000000')
    expect(folded.get(1000745)?.buyBackFeePermill).toBe(100)
  })

  it('clears maxInHolding when explicitly set to None after a prior Some', () => {
    const folded = foldHsmCollateralParams([
      { block: 1, name: 'HSM.CollateralAdded', args: { assetId: 1003, poolId: 110, purchaseFee: 0, maxBuyPriceCoefficient: '995000000000000000', buyBackFee: 100, buybackRate: 100000 } },
      { block: 2, name: 'HSM.CollateralUpdated', args: { assetId: 1003, maxInHolding: { __kind: 'Some', value: '8000000000000' } } },
      { block: 3, name: 'HSM.CollateralUpdated', args: { assetId: 1003, maxInHolding: { __kind: 'None' } } },
    ])
    expect(folded.get(1003)?.maxInHoldingRaw).toBeNull()
  })
})

// A delisted collateral is not a collateral with different parameters — it is
// gone, and the HSM will neither buy nor sell it. sUSDe (1000625) and sUSDS
// (1000745) were capped to zero on 2026-07-21 and removed outright on
// 2026-07-26, yet every reader still listed them, because the fold has no
// removal case AND the MV never stored the event that carries one.
describe('foldHsmCollateralParams — delisting', () => {
  it('drops a collateral that HSM.CollateralRemoved retired', () => {
    const folded = foldHsmCollateralParams([
      { block: 1, name: 'HSM.CollateralAdded', args: { assetId: 1000625, poolId: 113, purchaseFee: 0, maxBuyPriceCoefficient: '995000000000000000', buyBackFee: 100, buybackRate: 100000 } },
      { block: 2, name: 'HSM.CollateralUpdated', args: { assetId: 1000625, maxInHolding: { __kind: 'Some', value: '0' } } },
      { block: 3, name: 'HSM.CollateralRemoved', args: { assetId: 1000625 } },
    ])
    expect(folded.has(1000625)).toBe(false)
  })

  // CollateralRemoved carries only `assetId` — byte-identical to the no-op
  // CollateralUpdated above. The event name is the ONLY discriminator, so a
  // fold that takes bare args can never distinguish the two.
  it('keeps a collateral whose update happens to carry only assetId', () => {
    const folded = foldHsmCollateralParams([
      { block: 1, name: 'HSM.CollateralAdded', args: { assetId: 1002, poolId: 111, purchaseFee: 0, maxBuyPriceCoefficient: '995000000000000000', buyBackFee: 100, buybackRate: 100000 } },
      { block: 2, name: 'HSM.CollateralUpdated', args: { assetId: 1002 } },
    ])
    expect(folded.has(1002)).toBe(true)
  })

  it('does not let a re-added collateral inherit its pre-removal parameters', () => {
    const folded = foldHsmCollateralParams([
      { block: 1, name: 'HSM.CollateralAdded', args: { assetId: 1000745, poolId: 112, purchaseFee: 5000, maxBuyPriceCoefficient: '995000000000000000', buyBackFee: 500, buybackRate: 1000 } },
      { block: 2, name: 'HSM.CollateralRemoved', args: { assetId: 1000745 } },
      { block: 3, name: 'HSM.CollateralAdded', args: { assetId: 1000745 } },
    ])
    expect(folded.get(1000745)?.purchaseFeePermill).toBe(0)
    expect(folded.get(1000745)?.buyBackFeePermill).toBe(0)
    expect(folded.get(1000745)?.poolId).toBeNull()
  })

  it('ignores a removal for a collateral that was never added', () => {
    const folded = foldHsmCollateralParams([
      { block: 1, name: 'HSM.CollateralRemoved', args: { assetId: 4242 } },
    ])
    expect(folded.size).toBe(0)
  })
})

// The fold and the model that feeds it have to agree on the event set. A fold
// that handles an event the MV never indexes is silently dead code — which is
// exactly how the delisting went unnoticed.
describe('hsm_activity — the model behind the HSM collateral set', () => {
  it('indexes CollateralRemoved, or no reader can ever observe a delisting', () => {
    const mv = views.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS price_data\.hsm_activity_mv ([^;]+);/)?.[0]
    expect(mv).toBeTruthy()
    for (const name of ['HSM.CollateralAdded', 'HSM.CollateralUpdated', 'HSM.CollateralRemoved']) {
      expect(mv).toContain(`'${name}'`)
    }
  })

  it('is read back with the same event set the fold folds', () => {
    const loader = hollarService.match(/FROM price_data\.hsm_activity FINAL\s+WHERE event_name IN \(([^)]+)\)/)?.[1]
    expect(loader).toBeTruthy()
    for (const name of ['HSM.CollateralAdded', 'HSM.CollateralUpdated', 'HSM.CollateralRemoved']) {
      expect(loader).toContain(`'${name}'`)
    }
  })

  // The fold discriminates on the event name, so the loader must select it.
  it('selects the event name the fold discriminates on', () => {
    expect(hollarService).toMatch(/SELECT block_height AS block, event_name AS name, args_json/)
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
