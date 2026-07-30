import { describe, expect, it } from 'vitest'
import {
  initExplorerService,
  loadOmnipoolPrincipalHistory,
  omnipoolLegsForBucket,
  omnipoolRemoveLiquidity,
  type DecodedPosition,
  type OmnipoolAssetState,
} from '../src/services/explorerService.ts'

const ACC = `0x${'aa'.repeat(32)}`

function fakeClient(rows: { intervals: unknown[]; state: unknown[]; pool: unknown[] }) {
  return {
    query: async (opts: { query: string }) => {
      const q = opts.query
      const data = q.includes('omnipool_position_owner_intervals') ? rows.intervals
        : q.includes('omnipool_position_state_events') ? rows.state
        : q.includes('omnipool_pool_state_history') ? rows.pool
        : []
      return { json: async () => data }
    },
  } as never
}

const FIXED = 10n ** 18n

function pos(assetId: number, shares: bigint): DecodedPosition {
  return { assetId, amount: shares, shares, priceNum: FIXED, priceDen: FIXED }
}

const pool = (o: Partial<OmnipoolAssetState> = {}): OmnipoolAssetState =>
  ({ reserve: 1_000_000n, hub: 500_000n, shares: 2_000_000n, ...o })

describe('omnipoolLegsForBucket', () => {
  it('values a position once even if it appears both bare and farmed', () => {
    const p = pos(10, 1000n)
    const legs = omnipoolLegsForBucket([
      { positionId: '1', assetId: 10, state: p, pool: pool() },
      { positionId: '1', assetId: 10, state: p, pool: pool() },
    ])
    expect(legs).toHaveLength(1)
  })

  it('skips a position with no pool state (never fabricates a zero leg)', () => {
    const legs = omnipoolLegsForBucket([
      { positionId: '2', assetId: 10, state: pos(10, 1000n), pool: undefined },
    ])
    expect(legs).toHaveLength(0)
  })

  it('skips a position whose state has zero shares', () => {
    const legs = omnipoolLegsForBucket([
      { positionId: '3', assetId: 10, state: pos(10, 0n), pool: pool() },
    ])
    expect(legs).toHaveLength(0)
  })

  it('returns exactly omnipoolRemoveLiquidity legs, preserving values above 2^53', () => {
    const bigShares = 9_007_199_254_740_993n * 1000n // > Number.MAX_SAFE_INTEGER
    const st = pool({
      reserve: 48_263_702_471_630_511_420_724_993n,
      hub: 46_968_735_321_535_740n,
      shares: 35_086_411_155_782_830_652_965_829n,
    })
    const p = pos(9, bigShares)
    const expected = omnipoolRemoveLiquidity(st, p)
    const legs = omnipoolLegsForBucket([{ positionId: '9', assetId: 9, state: p, pool: st }])
    expect(legs).toHaveLength(1)
    expect(legs[0].liquidity).toBe(expected.liquidity)
    expect(legs[0].hub).toBe(expected.hub)
    expect(typeof legs[0].liquidity).toBe('bigint')
  })
})

describe('loadOmnipoolPrincipalHistory', () => {
  // minb=1000, bucket=10, n=5 → bucketEndBlock: b0=1009,b1=1019,b2=1029,b3=1039,b4=1049,b5=1050.
  const minb = 1000, bucket = 10, n = 5
  const poolState: OmnipoolAssetState = { reserve: 1_000_000n, hub: 500_000n, shares: 2_000_000n }
  const posState: DecodedPosition = { assetId: 10, amount: 1000n, shares: 1000n, priceNum: 10n ** 18n, priceDen: 10n ** 18n }

  it('resolves ownership per bucket, dedups bare/farmed, and values from historical state', async () => {
    initExplorerService(fakeClient({
      // Position '1': bare [1015,1025) then farmed [1025, open) — same account, no overlap.
      intervals: [
        { position_id: '1', valid_from_block: 1015, valid_to_block: 1025 },
        { position_id: '1', valid_from_block: 1025, valid_to_block: 0 },
      ],
      state: [
        { position_id: '1', block_height: 1002, event_kind: 'created', asset_id: 10, amount_raw: '1000', shares_raw: '1000', price_raw: (10n ** 18n).toString(), active: 1 },
      ],
      // Pre-range pool snapshot (b=-1) forward-fills to every bucket.
      pool: [
        { asset_id: 10, b: -1, reserve: '1000000', hub_reserve: '500000', shares: '2000000' },
      ],
    }))

    const hist = await loadOmnipoolPrincipalHistory([ACC], minb, bucket, n)
    const expected = omnipoolRemoveLiquidity(poolState, posState)

    expect(hist.assetIds).toEqual([10])
    expect(hist.legsByBucket).toHaveLength(n + 1)
    // Not owned before valid_from (bucket end 1009 < 1015):
    expect(hist.legsByBucket[0]).toHaveLength(0)
    expect(hist.fromBucket).toBe(1)
    // Owned bare in bucket 1, farmed in bucket 2 — each valued exactly once:
    expect(hist.legsByBucket[1]).toHaveLength(1)
    expect(hist.legsByBucket[2]).toHaveLength(1)
    expect(hist.legsByBucket[1][0]).toMatchObject({ assetId: 10, liquidity: expected.liquidity, hub: expected.hub })
    expect(hist.legsByBucket[5][0].liquidity).toBe(expected.liquidity)
  })

  it('drops a position from the bucket once it is destroyed', async () => {
    initExplorerService(fakeClient({
      intervals: [{ position_id: '2', valid_from_block: 1005, valid_to_block: 0 }],
      state: [
        { position_id: '2', block_height: 1002, event_kind: 'created', asset_id: 10, amount_raw: '1000', shares_raw: '1000', price_raw: (10n ** 18n).toString(), active: 1 },
        { position_id: '2', block_height: 1035, event_kind: 'destroyed', asset_id: 0, amount_raw: '', shares_raw: '', price_raw: '', active: 0 },
      ],
      pool: [{ asset_id: 10, b: -1, reserve: '1000000', hub_reserve: '500000', shares: '2000000' }],
    }))
    const hist = await loadOmnipoolPrincipalHistory([ACC], minb, bucket, n)
    // Destroyed at 1035: present through bucket 3 (end 1039 sees the destroy → none), so
    // legs exist for buckets 0..2 (ends 1009,1019,1029 < 1035) and vanish from bucket 3.
    expect(hist.legsByBucket[2]).toHaveLength(1)
    expect(hist.legsByBucket[3]).toHaveLength(0)
    expect(hist.legsByBucket[5]).toHaveLength(0)
  })
})
