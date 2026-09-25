import { beforeEach, describe, expect, it } from 'vitest'
import { resetCacheForTests } from '../src/services/cache.ts'
import { aggregateMmIncentiveClaims, loadMmIncentiveClaims } from '../src/services/mmIncentiveClaims.ts'

// Claimed lending incentives: all-time RewardsClaimed per (market, reward asset), each
// claim at the hourly candle closed by its own block, filed under the reward's primary
// market. Registry is empty under test, so every asset is the synthetic 12-decimal one.

const E12 = 10n ** 12n
const USD = 10n ** 12n
const DOT = '0x0000000000000000000000000000000100000005'
const USDT = '0x000000000000000000000000000000010000000a'
const H = `0x${'4a'.repeat(20)}`

beforeEach(() => resetCacheForTests())

describe('aggregateMmIncentiveClaims', () => {
  it('totals per market and reward, sums priced claims only and counts the rest', () => {
    const rows = [
      { reward: DOT, ts: 1, amount: 2n * E12 },
      { reward: DOT, ts: 2, amount: 3n * E12 },
      { reward: USDT, ts: 3, amount: E12 },
      { reward: '0xnot-an-asset', ts: 4, amount: E12 },
    ]
    const out = aggregateMmIncentiveClaims(rows, r => (r === USDT ? 'gigahdx' : 'core'), (id, amount, i) => (id === 5 && i === 0 ? amount * 2n : null))
    expect(out).toEqual([
      { marketKey: 'core', rewardAssetId: 5, amount: 5n * E12, valueUsd: 4n * E12, claims: 2, unpricedClaims: 1 },
      // Every claim unpriced: null, never zero.
      { marketKey: 'gigahdx', rewardAssetId: 10, amount: E12, valueUsd: null, claims: 1, unpricedClaims: 1 },
    ])
  })
})

describe('loadMmIncentiveClaims', () => {
  it('reads the holders\' claims key-first, files them under the primary market and values each at its closed candle', async () => {
    const seen: Array<{ query: string; params: Record<string, unknown> }> = []
    const T = 1_750_000_000
    const client = {
      query: async (o: { query: string; query_params?: Record<string, unknown> }) => {
        seen.push({ query: o.query, params: o.query_params ?? {} })
        const rows = o.query.includes('-- mm:incentive-claims-total')
          ? [{ reward: DOT, ts: T, amount: String(2n * E12) }, { reward: DOT, ts: T + 7_200, amount: String(E12) }]
          : o.query.includes('-- mm:incentive-programmes')
            ? [{ asset: 'a-core', reward: DOT }, { asset: 'a-giga', reward: DOT }]
            // DOT closes: $1 for the hour closing at T, $3 for the hour closing at T+7,200 (still open at the first claim).
            : o.query.includes('-- mm:incentive-claim-closes')
              ? [{ asset_id: 5, closed_at: T, px: '1' }, { asset_id: 5, closed_at: T + 7_200, px: '3' }]
              : []
        return { json: async () => rows }
      },
    }
    const out = await loadMmIncentiveClaims(client as never, [H.toUpperCase().replace('0X', '0x'), 'junk'], [{ atoken: 'A-CORE', marketKey: 'core' }, { atoken: 'a-giga', marketKey: 'gigahdx' }])
    // A reward spanning core and gigahdx is filed under core.
    expect(out).toEqual([{ marketKey: 'core', rewardAssetId: 5, amount: 3n * E12, valueUsd: 2n * USD + 3n * USD, claims: 2, unpricedClaims: 0 }])
    const claims = seen.find(s => s.query.includes('-- mm:incentive-claims-total'))!
    expect(claims.params.hs).toEqual([H])
    expect(claims.query).toContain('FROM price_data.mm_incentive_claims FINAL')
    expect(claims.query).toContain('WHERE user_address IN {hs:Array(String)}')
    const closes = seen.find(s => s.query.includes('-- mm:incentive-claim-closes'))!
    expect(closes.query).toContain('price_data.ohlc_1h')
    expect(closes.params).toMatchObject({ ids: [5], maxT: T + 7_200 - 3_600 })
  })

  it('reads nothing without a holder, and no candles without a claim', async () => {
    const seen: string[] = []
    const client = { query: async (o: { query: string }) => { seen.push(o.query); return { json: async () => [] } } }
    expect(await loadMmIncentiveClaims(client as never, ['junk'], [])).toEqual([])
    expect(seen).toEqual([])
    expect(await loadMmIncentiveClaims(client as never, [H], [])).toEqual([])
    expect(seen.filter(q => q.includes('-- mm:incentive-claim-closes'))).toEqual([])
  })
})
