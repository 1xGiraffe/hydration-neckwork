import { afterEach, describe, expect, it, vi } from 'vitest'
import { PoolCompositionCache } from '../../src/pool/compositionCache.ts'

interface CacheState {
  omnipoolAssets: number[] | null
  xykPools: Array<{ poolAccount: string; assetA: number; assetB: number }> | null
  stableswapPools: Array<{ poolId: number; assets: number[] }> | null
}

function state(cache: PoolCompositionCache): CacheState {
  return cache as unknown as CacheState
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PoolCompositionCache incremental updates', () => {
  it('keeps replayed creation events idempotent', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = new PoolCompositionCache()
    state(cache).omnipoolAssets = []
    state(cache).xykPools = []
    state(cache).stableswapPools = []
    const events = [
      { name: 'Omnipool.TokenAdded', args: { assetId: 42 } },
      { name: 'XYK.PoolCreated', args: { pool: '0xpool', assetA: 1, assetB: 2 } },
      { name: 'Stableswap.PoolCreated', args: { poolId: 100, assets: [1, 2], amplification: 10, fee: 1 } },
    ]

    cache.processEvents(events)
    cache.processEvents(events)

    expect(state(cache).omnipoolAssets).toEqual([42])
    expect(state(cache).xykPools).toEqual([{ poolAccount: '0xpool', assetA: 1, assetB: 2 }])
    expect(state(cache).stableswapPools).toHaveLength(1)
    expect(state(cache).stableswapPools?.[0]).toMatchObject({ poolId: 100, assets: [1, 2] })
  })

  it('updates a replayed pool identity without duplicating it', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = new PoolCompositionCache()
    state(cache).xykPools = [{ poolAccount: '0xpool', assetA: 1, assetB: 2 }]

    cache.processEvents([{
      name: 'XYK.PoolCreated',
      args: { pool: '0xpool', assetA: 3, assetB: 4 },
    }])

    expect(state(cache).xykPools).toEqual([{ poolAccount: '0xpool', assetA: 3, assetB: 4 }])
  })

  it('fails closed on malformed composition events', () => {
    const cache = new PoolCompositionCache()
    state(cache).omnipoolAssets = []

    expect(() => cache.processEvents([{
      name: 'Omnipool.TokenAdded',
      args: { assetId: 'not-a-number' },
    }])).toThrow('Omnipool.TokenAdded.assetId is not a non-negative integer')
  })
})
