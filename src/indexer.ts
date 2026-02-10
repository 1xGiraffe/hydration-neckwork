import { processor } from './processor.js'
import { Database } from './db/database.js'
import { AssetRegistryTracker } from './registry/tracker.js'
import { PoolCompositionCache } from './pool/compositionCache.js'
import { resolvePrices } from './price/graph.js'
import { config } from './config.js'
import { deriveOmnipoolAccount, deriveStableswapPoolAccount } from './util/account.js'
import { u8aToHex } from '@polkadot/util'
import { xxhashAsHex } from '@polkadot/util-crypto'
import type { OmnipoolAssetState, XYKPool, StableswapPool } from './price/types.ts'
import type { Block } from './types/support.ts'
import * as storage from './types/storage.ts'

// twox128 storage prefixes for pool-related pallets (hex without 0x prefix, 32 chars each)
// System.set_storage keys starting with these prefixes indicate pool state mutations
const POOL_STORAGE_PREFIXES = [
  'Omnipool', 'Tokens', 'XYK', 'Stableswap'
].map(name => xxhashAsHex(name, 128).slice(2))  // 32 hex chars each

export interface RunOptions {
  fromBlock?: number
  toBlock?: number
}

// Derive and cache the Omnipool sovereign account (constant across all blocks)
// Convert to hex string for SQD storage API compatibility (Bytes = string)
const omnipoolAccount = u8aToHex(deriveOmnipoolAccount())

// Cache for Stableswap pool sovereign accounts (derived from pool IDs)
// Key: pool ID, Value: hex-encoded AccountId32
const stableswapAccountCache = new Map<number, string>()

function getStableswapPoolAccount(poolId: number): string {
  let account = stableswapAccountCache.get(poolId)
  if (!account) {
    account = u8aToHex(deriveStableswapPoolAccount(poolId))
    stableswapAccountCache.set(poolId, account)
  }
  return account
}

/**
 * Detect System.set_storage calls that modify pool-related storage
 *
 * System.set_storage is a sudo/governance call that directly writes arbitrary storage keys,
 * bypassing normal pallet logic and therefore not emitting events. If it modifies pool-related
 * storage (Omnipool, Tokens, XYK, Stableswap), we need to detect it and invalidate caches.
 *
 * Storage keys start with twox128(PalletName) = 16 bytes = 32 hex chars.
 * We compare the first 32 hex chars of each key against our known pool pallet prefixes.
 */
function detectPoolAffectingSetStorage(calls: { name?: string; args?: any }[]): boolean {
  for (const call of calls) {
    if (call.name !== 'System.set_storage') continue

    // args.items is Vec<(Vec<u8>, Vec<u8>)> decoded as array of [key, value] hex strings
    const items = call.args?.items as Array<[string, string]> | undefined
    if (!items) continue

    for (const [key] of items) {
      // Storage key starts with twox128(PalletName) = 16 bytes = 32 hex chars
      // The key may have 0x prefix from SQD decoding
      const prefix = key.startsWith('0x') ? key.slice(2, 34) : key.slice(0, 32)

      if (POOL_STORAGE_PREFIXES.some(p => prefix === p)) {
        return true
      }
    }
  }
  return false
}

/**
 * Read Omnipool asset states from chain storage using cached asset IDs
 *
 * Reads real token reserves from Tokens.Accounts storage for the Omnipool sovereign account.
 * Falls back to shares proxy if Tokens.Accounts read fails.
 */
async function readOmnipoolState(block: Block, assetIds: number[]): Promise<Map<number, OmnipoolAssetState>> {
  const omnipoolAssets = new Map<number, OmnipoolAssetState>()

  // Check if Omnipool storage is available at this block
  if (!storage.omnipool.assets.v115.is(block)) {
    return omnipoolAssets
  }

  try {
    // Use getMany to batch-read asset states for known assets
    const assetStates = await storage.omnipool.assets.v115.getMany(block, assetIds)

    // Batch-read all Tokens.Accounts reserves in one call
    let balances: (typeof storage.tokens.accounts.v108 extends { getMany: (...args: any[]) => Promise<infer R> } ? R : never) | undefined
    if (storage.tokens.accounts.v108.is(block)) {
      try {
        const keys = assetIds.map(id => [omnipoolAccount, id] as [string, number])
        balances = await storage.tokens.accounts.v108.getMany(block, keys)
      } catch {
        // Fallback to shares proxy for ALL assets if batch read fails
      }
    }

    for (let i = 0; i < assetIds.length; i++) {
      const assetId = assetIds[i]
      const assetState = assetStates[i]
      if (!assetState) continue

      // Use batched balance result or fallback to shares
      let reserve = assetState.shares
      if (balances && balances[i]) {
        reserve = balances[i]!.free
      }

      omnipoolAssets.set(assetId, {
        hubReserve: assetState.hubReserve,
        reserve,  // Real reserve from Tokens.Accounts, or shares as fallback
        shares: assetState.shares,
        protocolShares: assetState.protocolShares,
        cap: assetState.cap,
        tradable: assetState.tradable.bits,
      })
    }
  } catch (error) {
    console.error(`[Omnipool] Failed to read state at block ${block.height}:`, error)
  }

  return omnipoolAssets
}

/**
 * Read XYK pool states from chain storage using cached pool entries
 *
 * XYK pools are indexed by their sovereign account (AccountId32).
 * We use cached pool entries (account -> asset pair) and read only Tokens.Accounts
 * for the pool's token reserves.
 */
async function readXYKState(
  block: Block,
  pools: Array<{ poolAccount: string; assetA: number; assetB: number }>
): Promise<XYKPool[]> {
  const xykPools: XYKPool[] = []

  // Check if Tokens.Accounts storage is available at this block
  if (!storage.tokens.accounts.v108.is(block)) {
    return xykPools
  }

  try {
    // Batch-read all pool balances in one call (2 keys per pool)
    const keys: [string, number][] = []
    for (const { poolAccount, assetA, assetB } of pools) {
      keys.push([poolAccount, assetA])
      keys.push([poolAccount, assetB])
    }

    const balances = await storage.tokens.accounts.v108.getMany(block, keys)

    // Process results in pairs (index i*2 and i*2+1 for pool i)
    for (let i = 0; i < pools.length; i++) {
      const { assetA, assetB } = pools[i]
      const balanceA = balances[i * 2]
      const balanceB = balances[i * 2 + 1]

      if (balanceA && balanceB) {
        xykPools.push({
          assetA,
          assetB,
          reserveA: balanceA.free,
          reserveB: balanceB.free,
        })
      }
    }
  } catch (error) {
    console.error(`[XYK] Failed to read state at block ${block.height}:`, error)
  }

  return xykPools
}

/**
 * Read Stableswap pool states from chain storage using cached pool entries
 *
 * Uses cached pool metadata (assets, amplification params, fee) and only reads
 * token reserves from Tokens.Accounts per block.
 *
 * Reserves are read from the pool's sovereign account via Tokens.Accounts.
 * Each pool's sovereign account is derived from PalletId("stblpool") + pool_id sub-account.
 */
async function readStableswapState(
  block: Block,
  pools: Array<{
    poolId: number
    assets: number[]
    initialAmplification: number
    finalAmplification: number
    initialBlock: number
    finalBlock: number
    fee: number
  }>
): Promise<StableswapPool[]> {
  const stableswapPools: StableswapPool[] = []

  // Check if Tokens.Accounts storage is available at this block
  if (!storage.tokens.accounts.v108.is(block)) {
    return stableswapPools
  }

  try {
    // Batch-read all pool reserves across all pools in one call
    const keys: [string, number][] = []
    const poolOffsets: number[] = []  // Track starting index for each pool

    for (const poolEntry of pools) {
      poolOffsets.push(keys.length)  // Current pool starts at this index
      const poolAccount = getStableswapPoolAccount(poolEntry.poolId)
      for (const assetId of poolEntry.assets) {
        keys.push([poolAccount, assetId])
      }
    }

    const balances = await storage.tokens.accounts.v108.getMany(block, keys)

    // Map results back to per-pool reserves using offsets
    for (let i = 0; i < pools.length; i++) {
      const poolEntry = pools[i]

      // Calculate current amplification parameter
      // Amplification can change over time (ramping)
      const currentBlock = block.height
      let amplification: bigint

      if (currentBlock >= poolEntry.finalBlock) {
        amplification = BigInt(poolEntry.finalAmplification)
      } else if (currentBlock <= poolEntry.initialBlock) {
        amplification = BigInt(poolEntry.initialAmplification)
      } else {
        // Linear interpolation between initial and final
        const totalBlocks = poolEntry.finalBlock - poolEntry.initialBlock
        const elapsedBlocks = currentBlock - poolEntry.initialBlock
        const initialAmp = BigInt(poolEntry.initialAmplification)
        const finalAmp = BigInt(poolEntry.finalAmplification)

        amplification = initialAmp +
          ((finalAmp - initialAmp) * BigInt(elapsedBlocks)) / BigInt(totalBlocks)
      }

      // Extract reserves for this pool using offset
      const startIdx = poolOffsets[i]
      const reserves: bigint[] = []

      for (let j = 0; j < poolEntry.assets.length; j++) {
        const balance = balances[startIdx + j]
        reserves.push(balance ? balance.free : 0n)
      }

      stableswapPools.push({
        poolId: poolEntry.poolId,
        assets: poolEntry.assets,
        reserves,  // Real reserves from Tokens.Accounts
        amplification,
        fee: poolEntry.fee,
      })
    }
  } catch (error) {
    console.error(`[Stableswap] Failed to read state at block ${block.height}:`, error)
  }

  return stableswapPools
}

export async function run(options: RunOptions = {}): Promise<void> {
  const database = new Database()

  const { height: lastProcessedBlock } = await database.connect()

  let startBlock = options.fromBlock
  if (startBlock === undefined) {
    // Resume from last checkpoint
    startBlock = lastProcessedBlock
    if (startBlock > 0) {
      console.log(`[Main] Resuming from checkpoint: block ${startBlock}`)
    }
  } else {
    console.log(`[Main] Starting from block ${startBlock} (--from-block override)`)
  }

  // Override processor's block range
  processor.setBlockRange({
    from: startBlock,
    to: options.toBlock,
  })

  const registry = new AssetRegistryTracker(config.SNAPSHOT_INTERVAL_BACKFILL)
  const compositionCache = new PoolCompositionCache()

  let lastLogBlock = startBlock
  let pricesCalculated = 0
  const archiveLogInterval = 1000
  const liveLogInterval = 1
  let currentLogInterval = archiveLogInterval
  let isLiveMode = false

  // State tracking for parent hash validation and runtime upgrades
  let previousBlockHash: string | null = null
  let previousSpecVersion: number | null = null

  // Previous prices for carry-forward optimization
  let previousPrices: Map<number, string> | null = null
  // Tracking for skip rate logging
  let blocksSkipped = 0
  let blocksProcessed = 0

  // SQD processor owns process lifecycle via runProgram()
  // With HotDatabase, the Runner will enter processHotBlocks() which is an
  // infinite loop that subscribes to new blocks and keeps the process alive
  processor.run(database, async (ctx) => {
    // Reset parent hash validation state at batch boundaries
    // (prevents false positives across batch boundaries per RESEARCH.md Pitfall 4)
    previousBlockHash = null

    // Detect live mode: switch to per-block logging when batch size drops below threshold
    if (!isLiveMode && ctx.blocks.length < 10) {
      console.log('[Progress] Caught up to chain tip, switching to live mode')
      isLiveMode = true
      currentLogInterval = liveLogInterval
      registry.setSnapshotInterval(config.SNAPSHOT_INTERVAL)
    }

    for (const block of ctx.blocks) {
      const blockHeight = block.header.height
      const blockTimestamp = new Date(block.header.timestamp ?? 0)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, '')
      const specVersion = block.header.specVersion ?? 0

      // Parent hash validation (data integrity check)
      if (previousBlockHash !== null && block.header.parentHash !== previousBlockHash) {
        console.warn(
          `[Integrity] Parent hash mismatch at block ${blockHeight}: ` +
          `expected ${previousBlockHash}, got ${block.header.parentHash}`
        )
      }
      previousBlockHash = block.header.hash

      // Runtime upgrade detection
      if (previousSpecVersion !== null && specVersion !== previousSpecVersion) {
        console.log(
          `[Runtime] Upgrade detected at block ${blockHeight}: ` +
          `v${previousSpecVersion} → v${specVersion}`
        )
        ctx.store.addRuntimeUpgrades([{
          block_height: blockHeight,
          spec_version: specVersion,
          prev_spec_version: previousSpecVersion,
        }])
        // Re-bootstrap pool caches: storage migrations may change pool compositions without emitting events
        compositionCache.invalidateAll()
      }
      previousSpecVersion = specVersion

      // Asset registry snapshot (every N blocks)
      const newAssets = await registry.maybeSnapshot(blockHeight, block.header)
      if (newAssets.length > 0) {
        ctx.store.addAssets(newAssets)
      }

      // Update pool composition cache from events
      const compositionChanges = compositionCache.processEvents(block.events)
      const compositionChanged = compositionChanges.omnipoolChanged ||
        compositionChanges.xykChanged ||
        compositionChanges.stableswapChanged

      // Detect System.set_storage calls that modify pool storage
      const hasSetStorageAffectingPools = detectPoolAffectingSetStorage(block.calls)
      if (hasSetStorageAffectingPools) {
        console.warn(`[SetStorage] Pool-affecting System.set_storage detected at block ${blockHeight}`)
        compositionCache.invalidateAll()
      }

      const omnipoolAssetIds = await compositionCache.getOmnipoolAssets(block.header)
      const xykPoolEntries = await compositionCache.getXYKPools(block.header)
      const stableswapPoolEntries = await compositionCache.getStableswapPools(block.header)

      // Build set of known pool accounts for transfer event filtering
      const poolAccounts = new Set<string>()

      // Omnipool sovereign account (constant)
      poolAccounts.add(omnipoolAccount)

      // XYK pool accounts (from cache)
      if (xykPoolEntries) {
        for (const pool of xykPoolEntries) {
          poolAccounts.add(pool.poolAccount)
        }
      }

      // Stableswap pool accounts (derived from pool IDs)
      if (stableswapPoolEntries) {
        for (const pool of stableswapPoolEntries) {
          poolAccounts.add(getStableswapPoolAccount(pool.poolId))
        }
      }

      // Check if any transfer events affect known pool accounts
      let hasPoolAffectingTransfer = false
      for (const event of block.events) {
        if (event.name === 'Tokens.Transfer') {
          const args = event.args as { currencyId: number; from: string; to: string; amount: bigint }
          if (poolAccounts.has(args.from) || poolAccounts.has(args.to)) {
            hasPoolAffectingTransfer = true
            break
          }
        }
      }

      if (!hasPoolAffectingTransfer && !hasSetStorageAffectingPools && !compositionChanged && previousPrices !== null) {
        blocksSkipped++

        ctx.store.addBlocks([{
          block_height: blockHeight,
          block_timestamp: blockTimestamp,
          spec_version: specVersion,
        }])

        continue
      }

      blocksProcessed++

      let omnipoolAssets, xykPools, stableswapPools
      try {
        omnipoolAssets = omnipoolAssetIds
          ? await readOmnipoolState(block.header, omnipoolAssetIds)
          : new Map()
        xykPools = xykPoolEntries
          ? await readXYKState(block.header, xykPoolEntries)
          : []
        stableswapPools = stableswapPoolEntries
          ? await readStableswapState(block.header, stableswapPoolEntries)
          : []
      } catch (error) {
        console.error(
          `[Runtime] Storage read failed at block ${blockHeight} (spec_version: ${specVersion}):`,
          error
        )
        continue
      }

      const decimals = registry.getDecimals()
      const prices = resolvePrices(
        omnipoolAssets,
        xykPools,
        stableswapPools,
        decimals,
        config.USDT_ASSET_ID,
        config.LRNA_ASSET_ID
      )

      previousPrices = prices
      pricesCalculated += prices.size

      const priceRows = Array.from(prices.entries()).map(([assetId, usdtPrice]) => ({
        asset_id: assetId,
        block_height: blockHeight,
        usdt_price: usdtPrice,
      }))
      ctx.store.addPrices(priceRows)

      ctx.store.addBlocks([{
        block_height: blockHeight,
        block_timestamp: blockTimestamp,
        spec_version: specVersion,
      }])

      if (blockHeight - lastLogBlock >= currentLogInterval) {
        const assetsTracked = registry.getCacheSize()
        const mode = isLiveMode ? 'LIVE' : 'ARCHIVE'
        const skipRate = blocksSkipped + blocksProcessed > 0
          ? ((blocksSkipped / (blocksSkipped + blocksProcessed)) * 100).toFixed(1)
          : '0.0'
        console.log(
          `[${mode}] Block ${blockHeight} | ` +
          `${previousPrices?.size ?? 0} prices/block | ` +
          `${assetsTracked} assets tracked | ` +
          `${skipRate}% skipped | ` +
          `spec_version: ${specVersion}`
        )
        lastLogBlock = blockHeight
        pricesCalculated = 0
        blocksSkipped = 0
        blocksProcessed = 0
      }
    }
  })
}
