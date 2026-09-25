import { describe, expect, it } from 'vitest'
import { externalTokenApys, latestDefillamaApy, latestKaminoApy, pctFromUpstream } from '../src/services/externalTokenApy.ts'
import { tokenRates } from '../src/services/positionYield.ts'

const PCT = 10n ** 6n

describe('external token APYs', () => {
  it('reads DeFiLlama\'s latest apyBase, falling back to apy (the Hydration UI\'s rule)', () => {
    expect(latestDefillamaApy({ data: [{ apyBase: 1, apy: 2 }, { apyBase: 3.03, apy: 3.08 }] })).toBe(3_030_000n)
    expect(latestDefillamaApy({ data: [{ apyBase: null, apy: 4.77 }] })).toBe(4_770_000n)
    expect(latestDefillamaApy({ data: [] })).toBeNull()
    expect(latestDefillamaApy(null)).toBeNull()
  })
  it('reads Kamino\'s latest apy as a fraction', () => {
    expect(latestKaminoApy([{ apy: '0.05' }, { apy: '0.064124' }])).toBe(6_412_400n)
    expect(latestKaminoApy([])).toBeNull()
    expect(latestKaminoApy({ error: 'x' })).toBeNull()
  })
  it('rejects non-numeric figures', () => {
    expect(pctFromUpstream('abc')).toBeNull()
    expect(pctFromUpstream(-1.5)).toBe(-1_500_000n)
  })
  it('holds nothing before the refresher has run', () => {
    expect(externalTokenApys().size).toBe(0)
  })
})

describe('tokenRates', () => {
  it('prefers a fresh external APY and names the source, keeping on-chain rates otherwise', () => {
    const { accrual, accrualSource } = tokenRates(new Map([[43, 4n * PCT], [55, 18n * PCT]]), new Map([[43, { apyPct: 6n * PCT, source: 'kamino' as const }], [46, { apyPct: 13n * PCT, source: 'defillama' as const }]]))
    expect(accrual.get(43)).toBe(6n * PCT)
    expect(accrualSource.get(43)).toBe('kamino')
    expect(accrual.get(55)).toBe(18n * PCT)
    expect(accrualSource.get(55)).toBe('on-chain')
    // A token with no moving peg on chain still earns its external rate.
    expect(accrual.get(46)).toBe(13n * PCT)
  })
})
