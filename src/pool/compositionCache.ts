import type { Block } from '../types/support.ts'
import * as storage from '../types/storage.ts'

interface XYKPoolEntry {
  poolAccount: string  // AccountId32 hex
  assetA: number
  assetB: number
}

interface StableswapPoolEntry {
  poolId: number
  assets: number[]
  // Cache pool metadata needed for price calc (amplification params, fee)
  initialAmplification: number
  finalAmplification: number
  initialBlock: number
  finalBlock: number
  fee: number
}

export class PoolCompositionCache {
  // Omnipool: set of asset IDs
  private omnipoolAssets: number[] | null = null
  // XYK: list of pool entries (account -> asset pair)
  private xykPools: XYKPoolEntry[] | null = null
  // Stableswap: list of pool entries
  private stableswapPools: StableswapPoolEntry[] | null = null

  // Track whether bootstrap has been done
  private omnipoolBootstrapped = false
  private xykBootstrapped = false
  private stableswapBootstrapped = false

  /**
   * Process events from a block to update cache.
   * Call this BEFORE reading pool state for the block.
   * Returns flags indicating which caches were invalidated.
   */
  processEvents(events: { name: string; args: any }[]): {
    omnipoolChanged: boolean
    xykChanged: boolean
    stableswapChanged: boolean
  } {
    let omnipoolChanged = false
    let xykChanged = false
    let stableswapChanged = false

    for (const event of events) {
      switch (event.name) {
        case 'Omnipool.TokenAdded':
          // Surgical add: push new asset ID to cached array
          if (this.omnipoolAssets !== null) {
            this.omnipoolAssets.push(event.args.assetId)
            console.log(`[PoolCache] Incremental: Omnipool asset added (assetId=${event.args.assetId})`)
          }
          // If cache not bootstrapped yet, do nothing -- bootstrap will pick it up
          omnipoolChanged = true
          break
        case 'Omnipool.TokenRemoved':
          // Surgical remove: filter out asset ID
          if (this.omnipoolAssets !== null) {
            this.omnipoolAssets = this.omnipoolAssets.filter(id => id !== event.args.assetId)
            console.log(`[PoolCache] Incremental: Omnipool asset removed (assetId=${event.args.assetId})`)
          }
          omnipoolChanged = true
          break
        case 'XYK.PoolCreated':
          // Surgical add: push new pool entry
          if (this.xykPools !== null) {
            this.xykPools.push({
              poolAccount: event.args.pool as string,
              assetA: event.args.assetA,
              assetB: event.args.assetB,
            })
            console.log(`[PoolCache] Incremental: XYK pool created (assetA=${event.args.assetA}, assetB=${event.args.assetB})`)
          }
          xykChanged = true
          break
        case 'XYK.PoolDestroyed':
          // Surgical remove: filter out pool by account
          if (this.xykPools !== null) {
            const poolAccount = event.args.pool as string
            this.xykPools = this.xykPools.filter(p => p.poolAccount !== poolAccount)
            console.log(`[PoolCache] Incremental: XYK pool destroyed (assetA=${event.args.assetA}, assetB=${event.args.assetB})`)
          }
          xykChanged = true
          break
        case 'Stableswap.PoolCreated':
          // Surgical add: push new pool entry with metadata
          if (this.stableswapPools !== null) {
            this.stableswapPools.push({
              poolId: event.args.poolId,
              assets: event.args.assets,
              initialAmplification: event.args.amplification,
              finalAmplification: event.args.amplification,
              initialBlock: 0,
              finalBlock: 0,
              fee: event.args.fee,
            })
            console.log(`[PoolCache] Incremental: Stableswap pool created (poolId=${event.args.poolId}, assets=[${event.args.assets.join(',')}])`)
          }
          stableswapChanged = true
          break
        case 'Stableswap.LiquidityAdded':
          // LiquidityAdded doesn't change composition, ignore
          break
      }
    }

    return { omnipoolChanged, xykChanged, stableswapChanged }
  }

  /**
   * Invalidate all cached pool compositions.
   * Called on runtime upgrades where storage migrations may have
   * changed pool compositions without emitting events.
   */
  invalidateAll(): void {
    this.omnipoolBootstrapped = false
    this.omnipoolAssets = null
    this.xykBootstrapped = false
    this.xykPools = null
    this.stableswapBootstrapped = false
    this.stableswapPools = null
    console.log('[PoolCache] All caches invalidated (runtime upgrade)')
  }

  /**
   * Get Omnipool asset IDs. Bootstraps from storage on first call.
   * Returns null if Omnipool storage is not available at this block.
   */
  async getOmnipoolAssets(block: Block): Promise<number[] | null> {
    if (!storage.omnipool.assets.v115.is(block)) return null
    if (!this.omnipoolBootstrapped) {
      const pairs = await storage.omnipool.assets.v115.getPairs(block)

      this.omnipoolAssets = pairs
        .filter(([_, state]) => state !== undefined)
        .map(([assetId, _]) => assetId)
      this.omnipoolBootstrapped = true
      console.log(`[PoolCache] Bootstrap omnipool at block ${block.height}: ${this.omnipoolAssets.length} assets`)
    }
    return this.omnipoolAssets
  }

  /**
   * Get XYK pool entries. Bootstraps from storage on first call.
   */
  async getXYKPools(block: Block): Promise<XYKPoolEntry[] | null> {
    if (!storage.xyk.poolAssets.v183.is(block)) return null
    if (!this.xykBootstrapped) {
      const pairs = await storage.xyk.poolAssets.v183.getPairs(block)
      this.xykPools = pairs
        .filter(([_, assetPair]) => assetPair !== undefined)
        .map(([poolAccount, assetPair]) => ({
          poolAccount: poolAccount as string,
          assetA: assetPair![0],
          assetB: assetPair![1],
        }))
      this.xykBootstrapped = true
      console.log(`[PoolCache] Bootstrap xyk at block ${block.height}: ${this.xykPools.length} pools`)
    }
    return this.xykPools
  }

  /**
   * Get Stableswap pool entries. Bootstraps from storage on first call.
   */
  async getStableswapPools(block: Block): Promise<StableswapPoolEntry[] | null> {
    if (!storage.stableswap.pools.v183.is(block)) return null
    if (!this.stableswapBootstrapped) {
      const pairs = await storage.stableswap.pools.v183.getPairs(block)
      this.stableswapPools = pairs
        .filter(([_, poolInfo]) => poolInfo !== undefined)
        .map(([poolId, poolInfo]) => ({
          poolId,
          assets: poolInfo!.assets,
          initialAmplification: poolInfo!.initialAmplification,
          finalAmplification: poolInfo!.finalAmplification,
          initialBlock: poolInfo!.initialBlock,
          finalBlock: poolInfo!.finalBlock,
          fee: poolInfo!.fee,
        }))
      this.stableswapBootstrapped = true
      console.log(`[PoolCache] Bootstrap stableswap at block ${block.height}: ${this.stableswapPools.length} pools`)
    }
    return this.stableswapPools
  }
}
