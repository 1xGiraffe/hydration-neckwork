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

function eventArgs(value: unknown, eventName: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object') {
    throw new Error(`${eventName} has no decodable arguments`)
  }
  return value as Record<string, unknown>
}

function numberArg(args: Record<string, unknown>, name: string, eventName: string): number {
  const value = args[name]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${eventName}.${name} is not a non-negative integer`)
  }
  return value as number
}

function stringArg(args: Record<string, unknown>, name: string, eventName: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${eventName}.${name} is not a non-empty string`)
  }
  return value
}

function numberArrayArg(args: Record<string, unknown>, name: string, eventName: string): number[] {
  const value = args[name]
  if (!Array.isArray(value) || !value.every(item => Number.isSafeInteger(item) && item >= 0)) {
    throw new Error(`${eventName}.${name} is not an array of non-negative integers`)
  }
  return value
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
  // A pallet can legitimately be absent before launch. Once a codec has worked,
  // however, losing compatibility after a runtime upgrade must fail closed
  // instead of turning a live pool family into an empty/stale snapshot.
  private omnipoolSupported = false
  private xykSupported = false
  private stableswapSupported = false

  /**
   * Process events from a block to update cache.
   * Call this BEFORE reading pool state for the block.
   * Returns flags indicating which caches were invalidated.
   */
  processEvents(events: Array<{ name: string; args: unknown }>): {
    omnipoolChanged: boolean
    xykChanged: boolean
    stableswapChanged: boolean
  } {
    let omnipoolChanged = false
    let xykChanged = false
    let stableswapChanged = false

    for (const event of events) {
      switch (event.name) {
        case 'Omnipool.TokenAdded': {
          const assetId = numberArg(eventArgs(event.args, event.name), 'assetId', event.name)
          // Surgical add: push new asset ID to cached array
          if (this.omnipoolAssets !== null && !this.omnipoolAssets.includes(assetId)) {
            this.omnipoolAssets.push(assetId)
            console.log(`[PoolCache] Incremental: Omnipool asset added (assetId=${assetId})`)
          }
          // If cache not bootstrapped yet, do nothing -- bootstrap will pick it up
          omnipoolChanged = true
          break
        }
        case 'Omnipool.TokenRemoved': {
          const assetId = numberArg(eventArgs(event.args, event.name), 'assetId', event.name)
          // Surgical remove: filter out asset ID
          if (this.omnipoolAssets !== null) {
            this.omnipoolAssets = this.omnipoolAssets.filter(id => id !== assetId)
            console.log(`[PoolCache] Incremental: Omnipool asset removed (assetId=${assetId})`)
          }
          omnipoolChanged = true
          break
        }
        case 'XYK.PoolCreated': {
          const args = eventArgs(event.args, event.name)
          // Surgical add: push new pool entry
          if (this.xykPools !== null) {
            const entry = {
              poolAccount: stringArg(args, 'pool', event.name),
              assetA: numberArg(args, 'assetA', event.name),
              assetB: numberArg(args, 'assetB', event.name),
            }
            const existingIndex = this.xykPools.findIndex(pool => pool.poolAccount === entry.poolAccount)
            if (existingIndex < 0) {
              this.xykPools.push(entry)
              console.log(`[PoolCache] Incremental: XYK pool created (assetA=${entry.assetA}, assetB=${entry.assetB})`)
            } else {
              this.xykPools[existingIndex] = entry
            }
          }
          xykChanged = true
          break
        }
        case 'XYK.PoolDestroyed': {
          const args = eventArgs(event.args, event.name)
          const poolAccount = stringArg(args, 'pool', event.name)
          // Surgical remove: filter out pool by account
          if (this.xykPools !== null) {
            this.xykPools = this.xykPools.filter(p => p.poolAccount !== poolAccount)
            console.log(`[PoolCache] Incremental: XYK pool destroyed (assetA=${numberArg(args, 'assetA', event.name)}, assetB=${numberArg(args, 'assetB', event.name)})`)
          }
          xykChanged = true
          break
        }
        case 'Stableswap.PoolCreated': {
          const args = eventArgs(event.args, event.name)
          // Surgical add: push new pool entry with metadata
          if (this.stableswapPools !== null) {
            const entry = {
              poolId: numberArg(args, 'poolId', event.name),
              assets: numberArrayArg(args, 'assets', event.name),
              initialAmplification: numberArg(args, 'amplification', event.name),
              finalAmplification: numberArg(args, 'amplification', event.name),
              initialBlock: 0,
              finalBlock: 0,
              fee: numberArg(args, 'fee', event.name),
            }
            const existingIndex = this.stableswapPools.findIndex(pool => pool.poolId === entry.poolId)
            if (existingIndex < 0) {
              this.stableswapPools.push(entry)
              console.log(`[PoolCache] Incremental: Stableswap pool created (poolId=${entry.poolId}, assets=[${entry.assets.join(',')}])`)
            } else {
              this.stableswapPools[existingIndex] = entry
            }
          }
          stableswapChanged = true
          break
        }
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
    if (!storage.omnipool.assets.v115.is(block)) {
      if (this.omnipoolSupported) throw new Error(`Unsupported Omnipool.Assets storage at block ${block.height}`)
      return null
    }
    this.omnipoolSupported = true
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
    if (!storage.xyk.poolAssets.v183.is(block)) {
      if (this.xykSupported) throw new Error(`Unsupported XYK.PoolAssets storage at block ${block.height}`)
      return null
    }
    this.xykSupported = true
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
    if (!storage.stableswap.pools.v183.is(block)) {
      if (this.stableswapSupported) throw new Error(`Unsupported Stableswap.Pools storage at block ${block.height}`)
      return null
    }
    this.stableswapSupported = true
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
