import { describe, expect, it } from 'vitest'
import { assetDescriptor } from '../src/services/explorerAssets.ts'
import { farmAprByAsset, farmAprPercScaled, renderPerc, xykFarmAprPercScaled, type LiveFarm } from '../src/services/farmApr.ts'
import {
  WEIGHT_UNIT, assemblePoolYield, tokenAccrualAprs, farmPartsByReward, feeAprPctScaled, incentiveAprPctScaled, legWeights, pctFromPerc,
  pctNumber, rayAprToApyPctScaled, underlyingParts, v3LpFee, type YieldContext,
} from '../src/services/positionYield.ts'

const RAY = 10n ** 27n
const USD = 10n ** 12n
const PCT = 10n ** 6n

const FARM: LiveFarm = {
  globalFarmId: 133, yieldFarmId: 139, assetId: 222, rewardAssetId: 222,
  multiplier: 10n ** 18n, yieldPerPeriod: 41856925419n, maxRewardPerPeriod: 47945205479452054n,
  blocksPerPeriod: 1, plannedYieldingPeriods: 2628000,
  startedAt: new Date('2026-04-27T09:10:36Z'), endsAt: new Date('2026-10-26T09:10:36Z'),
}

describe('reserve APY (per-second compounding in RAY)', () => {
  it('turns the HOLLAR strategy rate ln(1.045) into exactly 4.5 %', () => {
    // The live core-market HOLLAR variableBorrowRate: the facilitator strategy states
    // the APR as ln(1 + APY), so compounding must land on the round APY.
    expect(pctNumber(rayAprToApyPctScaled(44016888917752794000000000n))).toBeCloseTo(4.5, 5)
  })

  it('matches the closed form (1 + r/Y)^Y − 1 on an ordinary rate', () => {
    const rate = 30806894391835939458877706n // 3.0807 % APR (live DOT borrow)
    const r = Number(rate) / 1e27
    const expected = (Math.expm1(Math.log1p(r / 31_536_000) * 31_536_000)) * 100
    expect(pctNumber(rayAprToApyPctScaled(rate))).toBeCloseTo(expected, 5)
  })

  it('is zero for a zero rate and never below the APR', () => {
    expect(rayAprToApyPctScaled(0n)).toBe(0n)
    const apr = 5n * RAY / 100n
    expect(rayAprToApyPctScaled(apr)).toBeGreaterThan(5n * PCT)
  })
})

describe('incentive APR', () => {
  it('annualises emission over the priced total', () => {
    // 1 token/s (18 dec) at $1 over 31 536 000 tokens (6 dec) at $1 = 100 %.
    const apr = incentiveAprPctScaled(10n ** 18n, 18, USD, 31_536_000n * 10n ** 6n, 6, USD)
    expect(apr).toBe(100n * PCT)
  })

  it('is null without a price or without anything to spread over', () => {
    expect(incentiveAprPctScaled(1n, 18, null, 1n, 6, USD)).toBeNull()
    expect(incentiveAprPctScaled(1n, 18, USD, 1n, 6, null)).toBeNull()
    expect(incentiveAprPctScaled(1n, 18, USD, 0n, 6, USD)).toBeNull()
  })
})

describe('per-farm split', () => {
  it('sums back to the public per-asset figure, and a missing term nulls the sum', () => {
    const second = { ...FARM, globalFarmId: 200, yieldFarmId: 201, rewardAssetId: 5 }
    const a = farmAprPercScaled(FARM, 0n, USD)!
    const b = farmAprPercScaled(second, 1_000_000n * USD, USD)!
    const byAsset = farmAprByAsset([{ farm: FARM, aprScaled: a }, { farm: second, aprScaled: b }])
    expect(byAsset.get('222')).toEqual({ farmAprPerc: renderPerc(a + b), rewardAssetIds: ['222', '5'] })
    expect(farmAprByAsset([{ farm: FARM, aprScaled: a }, { farm: second, aprScaled: null }]).get('222')?.farmAprPerc).toBeNull()
  })

  it('folds farm components per reward asset with null propagation', () => {
    expect(farmPartsByReward([{ rewardAssetId: 1, apr: 2n }, { rewardAssetId: 1, apr: 3n }, { rewardAssetId: 2, apr: null }]))
      .toEqual([{ kind: 'farm', apr: 5n, assetId: 1 }, { kind: 'farm', apr: null, assetId: 2 }])
  })
})

describe('XYK farm APR', () => {
  it('halves the uncapped branch only', () => {
    // Uncapped (nothing staked): the Omnipool rate 22.0146 % halves to 11.0073 %.
    expect(renderPerc(xykFarmAprPercScaled(FARM, 0n, USD)!)).toBe('11.0073')
    // Capped: the budget over the FULL position value is already per unit of value.
    const capped = { ...FARM, maxRewardPerPeriod: 10n ** 16n }
    // $0.01·10^(18−dec)·… sized so the budget binds at ~5.26 % whatever decimals the registry resolves.
    const stake = 10n ** BigInt(24 - assetDescriptor(222).decimals) * USD
    const rate = farmAprPercScaled(capped, stake, USD)!
    expect(rate).toBeGreaterThan(0n)
    expect(rate).toBeLessThan(farmAprPercScaled(capped, 0n, USD)! / 2n)
    expect(xykFarmAprPercScaled(capped, stake, USD)).toBe(rate)
    expect(xykFarmAprPercScaled(FARM, null, USD)).toBeNull()
  })
})

describe('composition', () => {
  it('orders fees, mm, farms and nulls the total on any null component', () => {
    const y = assemblePoolYield([
      { kind: 'farm', apr: 1n * PCT, assetId: 0 },
      { kind: 'mm-supply', apr: 2n * PCT, assetId: 5, weight: WEIGHT_UNIT / 2n },
      { kind: 'omnipool-fee', apr: pctFromPerc('1.2345') },
    ])
    expect(y.components.map(c => c.kind)).toEqual(['omnipool-fee', 'mm-supply', 'farm'])
    expect(y.totalAprPct).toBe(4.2345)
    expect(y.components[1].weightPct).toBe(50)
    expect(assemblePoolYield([{ kind: 'xyk-fee', apr: 1n }, { kind: 'farm', apr: null, assetId: 0 }]).totalAprPct).toBeNull()
  })

  it('weights an aToken leg by its USD share and nulls it when a leg is unpriced', () => {
    const reserve = {
      market: 'core', underlyingId: 5, aToken: '0xa', vDebt: '0xd', aTokenAssetId: 1001, supplied: 1n, debt: 0n,
      supplyApy: 4n * PCT, borrowApy: 0n, supplyIncentives: [], borrowIncentives: [],
    }
    const ctx = (price: (id: number) => bigint | null, accrual = new Map<number, bigint>()): YieldContext => ({
      aTokenReserve: new Map([[1001, reserve]]),
      pools: new Map([[690, { poolId: 690, assetIds: [15, 1001], reserves: [3n * 10n ** 10n, 1n * 10n ** 10n], totalIssuance: 1n }]]),
      poolFee: new Map([[690, 1n * PCT]]),
      price,
      decimals: () => 10,
      accrual,
    })
    const parts = underlyingParts(690, WEIGHT_UNIT, ctx(() => USD))
    expect(parts.map(p => [p.kind, p.apr])).toEqual([['stablepool-fee', 1n * PCT], ['mm-supply', 1n * PCT]])
    const unpriced = underlyingParts(690, WEIGHT_UNIT, ctx(id => (id === 15 ? null : USD)))
    expect(unpriced.find(p => p.kind === 'mm-supply')?.apr).toBeNull()
    // A yield-bearing leg (vDOT, 3/4 of the pool) adds its own rate at its weight.
    const withAccrual = underlyingParts(690, WEIGHT_UNIT, ctx(() => USD, new Map([[15, 8n * PCT]])))
    expect(withAccrual.find(p => p.kind === 'token-yield')).toMatchObject({ apr: 6n * PCT, assetId: 15 })
  })

  it('annualises a peg multiplier\'s growth as the token\'s own APR, and skips static pegs', () => {
    const DAY = 86_400
    const rows = [{
      asset_ids: [15, 1001],
      // vDOT's rate 1.5 → 1.5075 over 30 days (+0.5%), aDOT pegged 1:1 throughout.
      n0: ['15000', '1'], d0: ['10000', '1'], n1: ['15075', '1'], d1: ['10000', '1'],
      t0: 0, t1: 30 * DAY,
    }]
    const out = tokenAccrualAprs(rows)
    expect([...out.keys()]).toEqual([15])
    // 0.5% × 365/30 = 6.083333%
    expect(out.get(15)).toBe(6_083_333n)
    expect(tokenAccrualAprs([{ ...rows[0], t1: 0 }]).size).toBe(0)
  })

  it('reads a share with no current pool state as unknown, never as its fee alone', () => {
    const ctx: YieldContext = { aTokenReserve: new Map(), pools: new Map(), poolFee: new Map([[690, 1n * PCT]]), price: () => USD, decimals: () => 10, accrual: new Map() }
    const parts = underlyingParts(690, WEIGHT_UNIT, ctx)
    expect(parts.find(p => p.kind === 'stablepool-fee')?.apr).toBe(1n * PCT)
    expect(assemblePoolYield(parts).totalAprPct).toBeNull()
  })

  it('states leg weights only for a fully priced, non-empty pool', () => {
    expect(legWeights([1n, 3n])).toEqual([WEIGHT_UNIT / 4n, WEIGHT_UNIT * 3n / 4n])
    expect(legWeights([1n, null])).toBeNull()
    expect(legWeights([0n, 0n])).toBeNull()
  })
})

describe('venue fee APRs', () => {
  it('annualises a window fee and is null without TVL', () => {
    expect(feeAprPctScaled(30n * USD, 365n * USD, 30)).toBe(100n * PCT)
    expect(feeAprPctScaled(1n, null, 30)).toBeNull()
    expect(feeAprPctScaled(1n, 0n, 30)).toBeNull()
  })

  it('takes the protocol 1/n out of a v3 fee, null when the sides differ', () => {
    expect(v3LpFee(400n, 0, 0)).toBe(400n)
    expect(v3LpFee(400n, 4, 4)).toBe(300n)
    expect(v3LpFee(400n, 4, 5)).toBeNull()
  })
})
