import { describe, expect, it } from 'vitest'
import { hourlyFlowPricerFrom, flowCloseKey } from '../src/services/eventTimeCloses.ts'
import { aggregateLpRewardClaims, yieldFarmPoolAssetMap, type LpClaimHourGroup } from '../src/services/lpRewardClaims.ts'

// Claimed LP rewards: every claim summed per (pallet, pool asset, reward asset), each
// hour of claims valued at the candle closed by it. An unpriced claim is counted,
// never valued at zero; a row with no priced claim at all has no value.

const H = 1_750_000_000 - (1_750_000_000 % 3600)
const group = (over: Partial<LpClaimHourGroup>): LpClaimHourGroup => ({
  pallet: 'omnipool', yieldFarmId: 1, rewardAssetId: 0, hourSec: H, claims: 1, amount: 0n, firstAt: '2025-06-15 10:00:00', lastAt: '2025-06-15 10:00:00', ...over,
})

describe('aggregateLpRewardClaims', () => {
  const pools = new Map([['omnipool:1', 5], ['omnipool:2', 5], ['xyk:2', 7000]])
  const poolOf = (pallet: string, yf: number) => pools.get(`${pallet}:${yf}`) ?? null
  // 1e-12 USD per raw unit = $1 per whole 12-dp unit; hour H+3600 is unpriced.
  const pricer = { usd: (_a: number, amount: bigint, h: number) => (h === H ? amount : null) }

  it('sums farms of the same pool and reward, keeps unpriced claims out of the value and counted', () => {
    const r = aggregateLpRewardClaims([
      group({ yieldFarmId: 1, claims: 2, amount: 10n ** 12n }),
      group({ yieldFarmId: 2, claims: 3, amount: 2n * 10n ** 12n, hourSec: H + 3600, lastAt: '2025-06-15 11:00:00' }),
      group({ yieldFarmId: 2, claims: 1, amount: 5n, firstAt: '2025-06-01 00:00:00' }),
    ], poolOf, pricer)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({
      pallet: 'omnipool', poolAssetId: 5, rewardAssetId: 0, amount: 3n * 10n ** 12n + 5n, claims: 6,
      unpricedClaims: 3, valueUsd: 10n ** 12n + 5n, firstAt: '2025-06-01 00:00:00', lastAt: '2025-06-15 11:00:00',
    })
    expect(r.totalUsd).toBe(10n ** 12n + 5n)
    expect(r.unpricedClaims).toBe(3)
  })

  it('states no value for a row whose every claim is unpriced (undated claims included)', () => {
    const r = aggregateLpRewardClaims([
      group({ pallet: 'xyk', yieldFarmId: 2, rewardAssetId: 9, amount: 7n, hourSec: H + 3600 }),
      group({ pallet: 'xyk', yieldFarmId: 2, rewardAssetId: 9, amount: 1n, hourSec: 0 }),
    ], poolOf, pricer)
    expect(r.rows[0]).toMatchObject({ pallet: 'xyk', poolAssetId: 7000, valueUsd: null, unpricedClaims: 2, claims: 2, amount: 8n })
    expect(r.totalUsd).toBe(0n)
  })

  it('keeps a farm whose pool is unknown as its own row, and orders by value', () => {
    const r = aggregateLpRewardClaims([
      group({ yieldFarmId: 99, amount: 1n }),
      group({ yieldFarmId: 1, rewardAssetId: 3, amount: 50n }),
      group({ yieldFarmId: 1, rewardAssetId: 4, amount: 1n, hourSec: H + 3600 }),
    ], poolOf, pricer)
    expect(r.rows.map(x => [x.poolAssetId, x.rewardAssetId, x.valueUsd])).toEqual([[5, 3, 50n], [null, 0, 1n], [5, 4, null]])
  })
})

describe('hourlyFlowPricerFrom', () => {
  it('values at a close at or before the hour within the lookback, never a later or stale one', () => {
    const closes = new Map([
      [flowCloseKey(0, H), { closedAt: H, close: 2n * 10n ** 12n }],
      [flowCloseKey(0, H + 3600), { closedAt: H + 7200, close: 10n ** 12n }], // a later candle: never
      [flowCloseKey(0, H + 31 * 86_400), { closedAt: H, close: 10n ** 12n }], // older than 30 days
    ])
    const p = hourlyFlowPricerFrom(closes)
    // HDX (id 0) falls back to the registry placeholder's 12 decimals in a bare test process.
    expect(p.usd(0, 3n * 10n ** 12n, H)).toBe(6n * 10n ** 12n)
    expect(p.usd(0, 1n, H + 3600)).toBeNull()
    expect(p.usd(0, 1n, H + 31 * 86_400)).toBeNull()
    expect(p.usd(0, 1n, H + 7 * 3600)).toBeNull()
  })
})

describe('yieldFarmPoolAssetMap', () => {
  it('reads the Omnipool asset and the XYK pair share token, either pair order', () => {
    const map = yieldFarmPoolAssetMap([
      { pallet: 'omnipool_lm', yield_farm_id: 2, args_json: '{"globalFarmId":1,"yieldFarmId":2,"assetId":5}' },
      { pallet: 'xyk_lm', yield_farm_id: 2, args_json: '{"assetPair":{"assetIn":30,"assetOut":5}}' },
      { pallet: 'xyk_lm', yield_farm_id: 4, args_json: '{"assetPair":{"assetIn":1,"assetOut":2}}' },
      { pallet: 'omnipool_lm', yield_farm_id: 3, args_json: 'not json' },
    ], new Map([['5:30', 7001]]))
    expect([...map]).toEqual([['omnipool:2', 5], ['xyk:2', 7001]])
  })
})
