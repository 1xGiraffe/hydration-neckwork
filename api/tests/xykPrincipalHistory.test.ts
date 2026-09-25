import { describe, expect, it } from 'vitest'
import { testBucketing } from './support/bucketing.ts'
import { xykShareLegs } from '../src/services/explorerService.ts'
import { loadXykPrincipalHistory } from '../src/services/lpHistory.ts'

const ACC = `0x${'bb'.repeat(32)}`

function fakeClient(rows: { farm: unknown[]; registry: unknown[]; reserves: unknown[]; totals: unknown[] }) {
  return {
    query: async (opts: { query: string }) => {
      const q = opts.query
      const data = q.includes('xyk_farm_principal_intervals') ? rows.farm
        : q.includes('xyk_pool_registry') ? rows.registry
        : q.includes('xyk_pool_reserve_history') ? rows.reserves
        : q.includes('xyk_lp_total_shares_history') ? rows.totals
        : []
      return { json: async () => data }
    },
  } as never
}

describe('xykShareLegs', () => {
  it('splits reserves proportionally to the share of total supply', () => {
    expect(xykShareLegs(100n, 1000n, 2000n, 1000n)).toEqual({ amountA: 100n, amountB: 200n })
  })

  it('floors integer division (never rounds up redeemable value)', () => {
    // 10*3/7 = 4.28 → 4
    expect(xykShareLegs(3n, 10n, 10n, 7n)).toEqual({ amountA: 4n, amountB: 4n })
  })

  it('returns zero legs when total supply is zero (guard, never divides by 0)', () => {
    expect(xykShareLegs(100n, 1000n, 2000n, 0n)).toEqual({ amountA: 0n, amountB: 0n })
  })

  it('returns zero legs for zero shares', () => {
    expect(xykShareLegs(0n, 1000n, 2000n, 1000n)).toEqual({ amountA: 0n, amountB: 0n })
  })

  it('preserves precision above Number.MAX_SAFE_INTEGER (bigint end to end)', () => {
    const reserveA = 48_263_702_471_630_511_420_724_993n
    const total = 35_086_411_155_782_830_652_965_829n
    const shares = 9_007_199_254_740_993n * 1000n // > 2^53
    const { amountA } = xykShareLegs(shares, reserveA, 5_000_000_000_000_000_000n, total)
    expect(amountA).toBe((reserveA * shares) / total)
    expect(typeof amountA).toBe('bigint')
  })
})

describe('loadXykPrincipalHistory', () => {
  const minb = 1000, bucket = 10, n = 5
  const bk = testBucketing(minb, bucket, n)
  const registry = [{ lp_asset_id: 42, pool_account: '0xpool', asset_a: 10, asset_b: 20 }]
  const reserves = [{ pool_account: '0xpool', b: -1, ra: '1000000', rb: '2000000' }]
  const totals = [{ lp_asset_id: 42, b: -1, total: '1000000' }]

  it('resolves farmed LP principal + forward-filled pool state per bucket', async () => {
    const client = (fakeClient({
      farm: [{ lp_asset_id: 42, principal_shares_raw: '500', valid_from_block: 1005, valid_to_block: 0 }],
      registry, reserves, totals,
    }))
    const hist = await loadXykPrincipalHistory(client, [ACC], [], bk)
    expect([...hist.lpAssetIds]).toEqual([42])
    expect(hist.underlyingAssetIds.sort()).toEqual([10, 20])
    // Deposit active from block 1005 → owned at every bucket end (1009..1050):
    expect(hist.farmSharesByLp.get(42)).toEqual(Array(n + 1).fill(500n))
    const st = hist.stateByLp.get(42)![3]!
    expect(st).toMatchObject({ assetA: 10, assetB: 20, reserveA: 1_000_000n, reserveB: 2_000_000n, totalShares: 1_000_000n })
  })

  it('resolves a directly-held LP token (candidate asset) even with no farm deposit', async () => {
    const client = (fakeClient({ farm: [], registry, reserves, totals }))
    const hist = await loadXykPrincipalHistory(client, [ACC], [42], bk)
    expect([...hist.lpAssetIds]).toEqual([42])
    expect(hist.farmSharesByLp.size).toBe(0)
    expect(hist.stateByLp.get(42)![0]).toMatchObject({ reserveA: 1_000_000n, totalShares: 1_000_000n })
  })

  it('pairs reserves with the snapshot asset order, not the registry (PoolCreated) order', async () => {
    // The registry preserves PoolCreated order (EWT 252525 first, DOT 5 second); the
    // reserve snapshot stores the pool the other way round (DOT first), and reserve_a
    // therefore belongs to DOT. Pairing reserve_a with the registry's asset_a (EWT)
    // mis-associates the leg and — because EWT is 18-dec and DOT 10-dec — inflates the
    // value ~1e8×. The state must pair each reserve with the snapshot's own asset id.
    const client = (fakeClient({
      farm: [],
      registry: [{ lp_asset_id: 42, pool_account: '0xpool', asset_a: 252525, asset_b: 5 }],
      reserves: [{ pool_account: '0xpool', b: -1, aa: 5, ab: 252525, ra: '3000000', rb: '9000000' }],
      totals: [{ lp_asset_id: 42, b: -1, total: '1000000' }],
    }))
    const hist = await loadXykPrincipalHistory(client, [ACC], [42], bk)
    const st = hist.stateByLp.get(42)![0]!
    expect(st).toMatchObject({ assetA: 5, assetB: 252525, reserveA: 3_000_000n, reserveB: 9_000_000n })
  })

  it('pairs by the snapshot order when one of its assets is HDX (asset 0), never reading 0 as missing', async () => {
    // Registry (PoolCreated) order is (1000286, HDX); the sampled row stores (HDX, 1000286).
    // A 0 id is HDX, not an absent column — only a (0, 0) pair is a legacy row.
    const client = (fakeClient({
      farm: [],
      registry: [{ lp_asset_id: 1000438, pool_account: '0xpool', asset_a: 1000286, asset_b: 0 }],
      reserves: [{ pool_account: '0xpool', b: -1, aa: 0, ab: 1000286, ra: '7000000', rb: '203305074956348449' }],
      totals: [{ lp_asset_id: 1000438, b: -1, total: '1000000' }],
    }))
    const hist = await loadXykPrincipalHistory(client, [ACC], [1000438], bk)
    expect(hist.stateByLp.get(1000438)![0]).toMatchObject({ assetA: 0, assetB: 1000286, reserveA: 7_000_000n, reserveB: 203_305_074_956_348_449n })
  })

  it('falls back to registry order for legacy reserve rows without snapshot asset ids', async () => {
    const client = (fakeClient({ farm: [], registry, reserves, totals }))  // reserves have no aa/ab
    const hist = await loadXykPrincipalHistory(client, [ACC], [42], bk)
    expect(hist.stateByLp.get(42)![0]).toMatchObject({ assetA: 10, assetB: 20, reserveA: 1_000_000n, reserveB: 2_000_000n })
  })

  it('returns empty when the account touches no XYK LP (no candidates, no farm)', async () => {
    const client = (fakeClient({ farm: [], registry: [], reserves: [], totals: [] }))
    const hist = await loadXykPrincipalHistory(client, [ACC], [], bk)
    expect(hist.lpAssetIds.size).toBe(0)
    expect(hist.underlyingAssetIds).toEqual([])
  })
})
