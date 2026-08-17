import { describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  GIGAHDX_LAUNCH,
  computeGigahdxApr,
  foldRateSamples,
  type AllocationRow,
  type RateSample,
} from '../../src/public/services/gigahdxApr.ts'

// The GIGAHDX staking APR (Semantics 10). The pinned numbers are computed from
// the spec's formulas, not from this implementation's output:
//
//   votingMeasured = 100 · 8 · paidOut · secondsPerYear/spanSeconds / medianWeighted
//   baseMeasured   = median over w ∈ {7,14,28} of
//                    100 · (rate(anchor)/rate(anchor−w) − 1) · secondsPerYear/(w·86400)
//   floor(stream)  = 100 · dripPerTick · secondsPerYear/3600 / totalStake
//   stream         = max(measured, floor);  total = base + voting
//
// secondsPerYear = 31,556,952 (365.2425 d).

function alloc(overrides: Partial<AllocationRow>): AllocationRow {
  return {
    ref_index: '360', track_id: '1', total_reward: '0', total_weighted_votes: '0',
    block_height: '13000000', event_index: '1', block_timestamp: '2026-11-01 00:00:00',
    ...overrides,
  }
}

// Anchor far enough from launch that no window is clamped: the voting window
// starts Oct 2 (spanSeconds = 5,184,000 exactly) and all three slope windows fit.
const ANCHOR = new Date('2026-12-01T00:00:00.000Z')

const IN_WINDOW: AllocationRow[] = [
  alloc({ ref_index: '360', total_reward: '100000000000000', total_weighted_votes: '1000000000000000000' }),
  alloc({ ref_index: '361', total_reward: '200000000000000', total_weighted_votes: '3000000000000000000', block_timestamp: '2026-11-10 12:00:00' }),
  alloc({ ref_index: '362', total_reward: '300000000000000', total_weighted_votes: '2000000000000000000', block_timestamp: '2026-11-30 23:59:59' }),
]

// Constant supply 1.2e21; totalStake grows through the pot, so the rates are
// 1.0 (28d ago) → 1.002 → 1.004 → 1.01 (anchor). Slopes, annualized:
//   7d: (1.01/1.004 − 1) · ×52.177…  = 31.1818 %
//  14d: (1.01/1.002 − 1) · ×26.088…  = 20.8293 %   ← median
//  28d: (1.01/1.000 − 1) · ×13.044…  = 13.0444 %
const SUPPLY = 1_200_000_000_000_000_000_000n
const SAMPLES = new Map<number, RateSample>([
  [0, { totalStake: 1_212_000_000_000_000_000_000n, supply: SUPPLY }],
  [7, { totalStake: 1_204_800_000_000_000_000_000n, supply: SUPPLY }],
  [14, { totalStake: 1_202_400_000_000_000_000_000n, supply: SUPPLY }],
  [28, { totalStake: 1_200_000_000_000_000_000_000n, supply: SUPPLY }],
])

describe('computeGigahdxApr', () => {
  it('computes both streams and their sum from the pinned example', () => {
    const result = computeGigahdxApr({ allocations: IN_WINDOW, samples: SAMPLES, anchor: ANCHOR })
    // paidOut = 600 HDX over exactly 60 days → 3,652,425e9/yr (10/day × 365.2425).
    expect(result.paidOut).toBe('600000000000000')
    expect(result.paidOutPerYear).toBe('3652425000000000')
    // weights sorted [1e18, 2e18, 3e18]; upper median (index 3 >> 1 = 1) = 2e18.
    expect(result.medianWeightedVotes).toBe('2000000000000000000')
    // votingMeasured = 100 · 8 · 3,652,425e9 / 2e18 = 1.46097 % → half-up at 4dp.
    expect(result.votingAprMeasuredPerc).toBe('1.4610')
    // votingFloor = 100 · 6,164.38e12 · 31,556,952 / (3,600 · 1.212e21): the
    // programme bound beats the measured term, so it is the stream's value.
    expect(result.votingAprFloorPerc).toBe('4.4584')
    expect(result.votingAprPerc).toBe('4.4584')
    // baseMeasured = median{31.1818, 20.8293, 13.0444} = the 14d slope.
    expect(result.baseAprMeasuredPerc).toBe('20.8293')
    expect(result.baseAprFloorPerc).toBe('2.9723')
    expect(result.baseAprPerc).toBe('20.8293')
    // total = 20.8293 + 4.4584, summed on the scaled integers before rendering.
    expect(result.totalAprPerc).toBe('25.2877')
    expect(result.totalStake).toBe('1212000000000000000000')
    expect(result.allocationsInWindow).toBe(3)
    expect(result.votingWindowDays).toBe(60)
  })

  it('skips slope windows older than the pallet and gates the young base to its floor', () => {
    const young = new Date(GIGAHDX_LAUNCH.getTime() + 10 * 86_400_000)
    // Only the 7d window fits a 10-day-old pallet: median of one slope = that slope.
    const result = computeGigahdxApr({
      allocations: [],
      samples: new Map([[0, SAMPLES.get(0)!], [7, SAMPLES.get(7)!], [14, SAMPLES.get(14)!], [28, SAMPLES.get(28)!]]),
      anchor: young,
    })
    expect(result.baseAprMeasuredPerc).toBe('31.1818')
    // Younger than every window: floor stands alone (the launch gate).
    const newborn = computeGigahdxApr({
      allocations: [], samples: SAMPLES, anchor: new Date(GIGAHDX_LAUNCH.getTime() + 86_400_000),
    })
    expect(newborn.baseAprMeasuredPerc).toBeNull()
    expect(newborn.baseAprPerc).toBe(newborn.baseAprFloorPerc)
    expect(result.votingWindowFrom).toBe(GIGAHDX_LAUNCH.toISOString())
  })

  it('skips a slope window whose boundary sample is missing or degenerate', () => {
    const result = computeGigahdxApr({
      allocations: [],
      samples: new Map<number, RateSample>([
        [0, SAMPLES.get(0)!],
        [7, { totalStake: null, supply: null }],
        [14, SAMPLES.get(14)!],
        [28, { totalStake: 0n, supply: 0n }],
      ]),
      anchor: ANCHOR,
    })
    // Only the 14d slope survives.
    expect(result.baseAprMeasuredPerc).toBe('20.8293')
  })

  it('floors the exchange rate at 1 on both endpoints', () => {
    // A boundary where stake < supply reads as rate 1.0, not less: the slope from
    // it equals the slope from an exactly-1.0 boundary.
    const clamped = computeGigahdxApr({
      allocations: [],
      samples: new Map<number, RateSample>([
        [0, SAMPLES.get(0)!],
        [28, { totalStake: 1_100_000_000_000_000_000_000n, supply: SUPPLY }],
      ]),
      anchor: ANCHOR,
    })
    const exact = computeGigahdxApr({
      allocations: [],
      samples: new Map<number, RateSample>([[0, SAMPLES.get(0)!], [28, { totalStake: SUPPLY, supply: SUPPLY }]]),
      anchor: ANCHOR,
    })
    expect(clamped.baseAprMeasuredPerc).toBe(exact.baseAprMeasuredPerc)
  })

  it('excludes allocations outside the half-open voting window', () => {
    const result = computeGigahdxApr({
      allocations: [
        alloc({ block_timestamp: '2026-10-02 00:00:00' }), // == windowFrom: excluded
        alloc({ block_timestamp: '2026-12-01 00:00:01' }), // after anchor: excluded
        alloc({ ref_index: '363', total_reward: '5', total_weighted_votes: '10', block_timestamp: '2026-10-02 00:00:01' }),
      ],
      samples: new Map(), anchor: ANCHOR,
    })
    expect(result.allocationsInWindow).toBe(1)
    expect(result.paidOut).toBe('5')
  })

  it('reports null — never zero — for unknown streams, and a null total when either is', () => {
    const nothing = computeGigahdxApr({ allocations: [], samples: new Map(), anchor: ANCHOR })
    expect(nothing.votingAprPerc).toBeNull()
    expect(nothing.baseAprPerc).toBeNull()
    expect(nothing.totalAprPerc).toBeNull()
    expect(nothing.totalStake).toBeNull()
    expect(nothing.medianWeightedVotes).toBeNull()

    // Stake without allocations: both floors stand, so both streams and the
    // total exist — the programme pays whether or not anyone voted yet.
    const floorsOnly = computeGigahdxApr({
      allocations: [], samples: new Map([[0, { totalStake: 1_212_000_000_000_000_000_000n, supply: SUPPLY }]]), anchor: ANCHOR,
    })
    expect(floorsOnly.votingAprPerc).toBe('4.4584')
    expect(floorsOnly.baseAprPerc).toBe('2.9723')
    expect(floorsOnly.totalAprPerc).toBe('7.4307')
  })
})

describe('foldRateSamples', () => {
  const flows = [
    { event_name: 'Staked', hdx_0: '1000', giga_0: '900', hdx_7: '600', giga_7: '500', hdx_14: '0', giga_14: '0', hdx_28: '0', giga_28: '0' },
    { event_name: 'YieldRealized', hdx_0: '50', giga_0: '0', hdx_7: '0', giga_7: '0', hdx_14: '0', giga_14: '0', hdx_28: '0', giga_28: '0' },
    { event_name: 'Unstaked', hdx_0: '200', giga_0: '150', hdx_7: '0', giga_7: '0', hdx_14: '0', giga_14: '0', hdx_28: '0', giga_28: '0' },
  ]

  it('applies signs per event and adds the pot per boundary', () => {
    const samples = foldRateSamples(flows, { pot_0: '25', pot_7: '10', pot_14: '', pot_28: '' })
    // anchor: 1000 + 50 − 200 + pot 25 = 875 locked+pot; supply 900 − 150 = 750.
    expect(samples.get(0)).toEqual({ totalStake: 875n, supply: 750n })
    expect(samples.get(7)).toEqual({ totalStake: 610n, supply: 500n })
    // A pre-launch boundary sums to zero flows: supply 0 is the degenerate
    // sample the slope math skips.
    expect(samples.get(28)).toEqual({ totalStake: 0n, supply: 0n })
  })

  it('is null — not a zero rate — when nothing is indexed at all', () => {
    expect(foldRateSamples([], undefined).get(0)).toEqual({ totalStake: null, supply: null })
  })
})

// ---------------------------------------------------------------------------
// The route, through the real app: the minimal UI field set, the caching
// header, and that the read path collapses replays (argMax) before summing.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

function fakeClient() {
  const client = {
    query: vi.fn(({ query }: { query: string }) => {
      if (query.includes('-- pub:gigahdx:allocations')) {
        // The dedup contract: rows collapse through argMax before the service sums.
        expect(query).toContain('argMax(total_reward, ingested_at)')
        expect(query).toContain('GROUP BY ref_index, block_height, event_index')
        return result(IN_WINDOW as unknown as Row[])
      }
      if (query.includes('-- pub:gigahdx:stake')) {
        expect(query).toContain('argMax(if(hdx_amount = \'\', \'0\', hdx_amount), ingested_at)')
        return result([{
          event_name: 'Staked',
          hdx_0: '1212000000000000000000', giga_0: '1200000000000000000000',
          hdx_7: '1204800000000000000000', giga_7: '1200000000000000000000',
          hdx_14: '1202400000000000000000', giga_14: '1200000000000000000000',
          hdx_28: '1200000000000000000000', giga_28: '1200000000000000000000',
        }])
      }
      if (query.includes('-- pub:gigahdx:pot')) return result([{ pot_0: '', pot_7: '', pot_14: '', pot_28: '' }])
      if (query.includes('-- pub:gigahdx:anchor')) return result([{ anchor: '2026-12-01 00:00:00' }])
      throw new Error(`unexpected query: ${query.slice(0, 120)}`)
    }),
  }
  return client
}

describe('GET /v1/staking/gigahdx/apr', () => {
  it('serves exactly the UI field set with its declared cache lifetime', async () => {
    const { buildPublicApp } = await import('../../src/public/app.ts')
    const app: FastifyInstance = await buildPublicApp({ client: fakeClient() as never, logger: false })
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/staking/gigahdx/apr' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('public, max-age=300')
      const body = res.json()
      expect(body).toEqual({
        asOf: '2026-12-01T00:00:00.000Z',
        totalAprPerc: '25.2877',
        baseAprPerc: '20.8293',
        votingAprPerc: '4.4584',
        paidOutPerYear: '3652425000000000',
        medianWeightedVotes: '2000000000000000000',
      })
    } finally {
      await app.close()
    }
  })
})
