import { processor } from './processor.js'
import { calculate_amplification } from '@galacticcouncil/math-stableswap'
import { Database } from './db/database.js'
import { AssetRegistryTracker } from './registry/tracker.js'
import { PoolCompositionCache } from './pool/compositionCache.js'
import { resolvePrices } from './price/graph.js'
import { config } from './config.js'
import { validateBlockRange } from './blockRange.js'
import { deriveOmnipoolAccount, deriveStableswapPoolAccount } from './util/account.js'
import { u8aToHex } from '@polkadot/util'
import type { OmnipoolAssetState, XYKPool, StableswapPool } from './price/types.ts'
import type { Block } from './types/support.ts'
import * as storage from './types/storage.ts'
import { hasAssetRegistryMetadataEvent } from './registry/events.js'
import { isSwapEvent } from './registry/swapEvents.js'
import { extractTradeVolumeFromSwaps, extractVolumeFromSwaps, mergePriceAndVolumeRows } from './blocks/extractVolume.js'
import { readErc20Balances, isKnownErc20, updateErc20Registry } from './evm/balances.js'
import {
  ClickHouseSnapshotReader,
  diffAssetRows,
  type HistoricalSnapshotEntry,
  type HistoricalSnapshotState,
} from './history/clickhouseSnapshotReader.js'
import {
  loadNativeAssetInfo,
  nativeAssetInfoToMetadata,
  nativeAssetInfoToRow,
} from './nativeAsset.js'
import { toClickHouseBlockTime } from './db/timestamp.js'
import { fetchChainHead } from './rpc/head.js'
import { detectPoolAffectingSetStorage } from './raw/snapshot.js'
import { createSnapshotRpcClient, loadRuntimeAt } from './scripts/snapshotRuntime.js'
import { extractRuntimeErrorNames } from './raw/runtimeErrorNames.js'
import type { RpcClient } from '@subsquid/rpc-client'
import type { ClickHouseStore } from './store/clickhouseStore.js'

const BACKFILL_ASSET_SNAPSHOT_INTERVAL = 10_000

let errorNamesRpc: RpcClient | null = null
// Snapshot a spec version's pallet error names into runtime_error_names. Loads
// metadata over RPC only at baseline + each runtime upgrade (rare), never per
// block. Non-fatal: a fetch failure is logged and left to the next restart /
// the one-time backfill — it must never stall indexing.
async function snapshotRuntimeErrorNames(store: ClickHouseStore, hash: string, specVersion: number): Promise<void> {
  try {
    errorNamesRpc ??= createSnapshotRpcClient()
    const runtime = await loadRuntimeAt(errorNamesRpc, hash)
    const rows = extractRuntimeErrorNames(runtime.metadata, specVersion)
    if (rows.length) store.addRuntimeErrorNames(rows)
  } catch (error) {
    console.error(`[Runtime] error-name snapshot failed at ${hash} (spec_version ${specVersion}):`, error)
  }
}

export interface RunOptions {
  fromBlock?: number
  toBlock?: number
  pipelineId?: string
  requireFinalizedRaw?: boolean
}

function getHistoricalSnapshotEntry(
  result: IteratorResult<HistoricalSnapshotEntry, void> | null,
): HistoricalSnapshotEntry | null {
  if (result == null || result.done === true) {
    return null
  }

  return result.value
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

function syncRegistryPricingState(
  registry: AssetRegistryTracker,
  existingLpEquivalences: Map<number, number>,
): {
  atokenEquivalences: [number, number][]
  atokenIds: Set<number>
  lpEquivalences: Map<number, number>
} {
  const atokenEquivalences = registry.getAtokenEquivalences()
  const atokenIds = registry.getAtokenIds()
  const lpEquivalences = new Map(existingLpEquivalences)
  const aaveTokenIds = new Set(atokenIds)

  for (const [lpId, displayId] of registry.getLpAliases()) {
    if (!lpEquivalences.has(lpId)) {
      lpEquivalences.set(lpId, displayId)
      console.log(`[LpAlias] ${lpId} → ${displayId}`)
    }
    aaveTokenIds.add(displayId)
  }

  updateErc20Registry(registry.getErc20Contracts(), aaveTokenIds)

  return { atokenEquivalences, atokenIds, lpEquivalences }
}

/**
 * Read Omnipool asset states from chain storage using cached asset IDs
 *
 * Reads real token reserves from Tokens.Accounts storage for the Omnipool sovereign account.
 * Fails closed when a required storage codec/read is unavailable so an unknown
 * runtime cannot be checkpointed with plausible-looking fallback reserves.
 */
async function readOmnipoolState(block: Block, assetIds: number[]): Promise<Map<number, OmnipoolAssetState>> {
  const omnipoolAssets = new Map<number, OmnipoolAssetState>()

  if (!storage.omnipool.assets.v115.is(block)) {
    throw new Error(`Unsupported Omnipool.Assets storage at block ${block.height}`)
  }

  try {
    // Use getMany to batch-read asset states for known assets
    const assetStates = await storage.omnipool.assets.v115.getMany(block, assetIds)

    // Batch-read all Tokens.Accounts reserves in one call
    let balances: Awaited<ReturnType<typeof storage.tokens.accounts.v108.getMany>> | undefined
    if (!storage.tokens.accounts.v108.is(block)) {
      throw new Error(`Unsupported Tokens.Accounts storage at block ${block.height}`)
    }
    try {
      const keys = assetIds.map(id => [omnipoolAccount, id] as [string, number])
      balances = await storage.tokens.accounts.v108.getMany(block, keys)
    } catch (error) {
      throw new Error(`Tokens.Accounts reserve read failed at block ${block.height}`, { cause: error })
    }

    // Collect ERC20 assets that need EVM balance reads
    const erc20Gaps: Array<{ idx: number; assetId: number }> = []

    for (let i = 0; i < assetIds.length; i++) {
      const assetId = assetIds[i]
      const assetState = assetStates[i]
      if (!assetState) continue

      // For ERC20 assets, Tokens.Accounts is stale/empty — always read from EVM.
      // For native assets, use Tokens.Accounts balance or fall back to shares.
      let reserve = assetState.shares
      if (isKnownErc20(assetId)) {
        erc20Gaps.push({ idx: i, assetId })
      } else if (balances && balances[i] && balances[i]!.free > 0n) {
        reserve = balances[i]!.free
      }

      omnipoolAssets.set(assetId, {
        hubReserve: assetState.hubReserve,
        reserve,
        shares: assetState.shares,
        protocolShares: assetState.protocolShares,
        cap: assetState.cap,
        tradable: assetState.tradable.bits,
      })
    }

    // HDX (asset 0) is the native token — its balance lives in System.Account,
    // not Tokens.Accounts. Read it separately to get the correct reserve.
    const hdxState = omnipoolAssets.get(0)
    if (hdxState) {
      try {
        let hdxFree: bigint | undefined
        if (storage.system.account.v205.is(block)) {
          const acct = await storage.system.account.v205.get(block, omnipoolAccount)
          hdxFree = acct?.data.free
        } else if (storage.system.account.v100.is(block)) {
          const acct = await storage.system.account.v100.get(block, omnipoolAccount)
          hdxFree = acct?.data.free
        } else {
          throw new Error(`Unsupported System.Account storage at block ${block.height}`)
        }
        if (hdxFree && hdxFree > 0n) {
          hdxState.reserve = hdxFree
        }
      } catch (error) {
        throw new Error(`System.Account HDX reserve read failed at block ${block.height}`, { cause: error })
      }
    }

    // Fill ERC20 gaps from EVM storage
    if (erc20Gaps.length > 0) {
      const erc20AssetIds = erc20Gaps.map(g => g.assetId)
      const evmBalances = await readErc20Balances(block, erc20AssetIds, omnipoolAccount)
      for (let g = 0; g < erc20Gaps.length; g++) {
        if (evmBalances[g] > 0n) {
          const state = omnipoolAssets.get(erc20Gaps[g].assetId)
          if (state) {
            state.reserve = evmBalances[g]
          }
        }
      }
    }
  } catch (error) {
    throw new Error(`Failed to read Omnipool state at block ${block.height}`, { cause: error })
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

  if (!storage.tokens.accounts.v108.is(block)) {
    throw new Error(`Unsupported Tokens.Accounts storage for XYK pools at block ${block.height}`)
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
    throw new Error(`Failed to read XYK state at block ${block.height}`, { cause: error })
  }

  return xykPools
}

let stableswapPegStorageSeen = false

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
): Promise<{ pools: StableswapPool[]; totalIssuances: Map<number, bigint> }> {
  const stableswapPools: StableswapPool[] = []
  let totalIssuances = new Map<number, bigint>()

  if (!storage.tokens.accounts.v108.is(block)) {
    throw new Error(`Unsupported Tokens.Accounts storage for Stableswap pools at block ${block.height}`)
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

    // Batch-read TotalIssuance for each pool's LP token (LP assetId == poolId)
    if (!storage.tokens.totalIssuance.v108.is(block)) {
      throw new Error(`Unsupported Tokens.TotalIssuance storage at block ${block.height}`)
    }
    const lpAssetIds = pools.map(p => p.poolId)
    const issuances = await storage.tokens.totalIssuance.v108.getMany(block, lpAssetIds)
    for (let i = 0; i < lpAssetIds.length; i++) {
      const val = issuances[i]
      if (val !== undefined && val > 0n) {
        totalIssuances.set(lpAssetIds[i], val)
      }
    }

    // Map results back to per-pool reserves using offsets
    for (let i = 0; i < pools.length; i++) {
      const poolEntry = pools[i]

      // Calculate current amplification parameter using the official stableswap math package.
      // This keeps ramp periods aligned with the protocol implementation.
      const currentBlock = block.height
      let amplification: bigint
      try {
        amplification = BigInt(calculate_amplification(
          poolEntry.initialAmplification.toString(),
          poolEntry.finalAmplification.toString(),
          poolEntry.initialBlock.toString(),
          poolEntry.finalBlock.toString(),
          currentBlock.toString(),
        ))
      } catch {
        if (currentBlock >= poolEntry.finalBlock) {
          amplification = BigInt(poolEntry.finalAmplification)
        } else if (currentBlock <= poolEntry.initialBlock) {
          amplification = BigInt(poolEntry.initialAmplification)
        } else {
          const totalBlocks = poolEntry.finalBlock - poolEntry.initialBlock
          const elapsedBlocks = currentBlock - poolEntry.initialBlock
          const initialAmp = BigInt(poolEntry.initialAmplification)
          const finalAmp = BigInt(poolEntry.finalAmplification)

          amplification = initialAmp +
            ((finalAmp - initialAmp) * BigInt(elapsedBlocks)) / BigInt(totalBlocks)
        }
      }

      // Extract reserves for this pool using offset.
      // For ERC20 assets (aTokens, HOLLAR), Tokens.Accounts returns null —
      // fall back to reading EVM.AccountStorages via SQD.
      const startIdx = poolOffsets[i]
      const reserves: bigint[] = []
      let hasErc20Gap = false

      for (let j = 0; j < poolEntry.assets.length; j++) {
        const balance = balances[startIdx + j]
        if (balance && balance.free > 0n) {
          reserves.push(balance.free)
        } else {
          reserves.push(0n)
          if (isKnownErc20(poolEntry.assets[j])) {
            hasErc20Gap = true
          }
        }
      }

      // Fill ERC20 gaps from EVM storage
      if (hasErc20Gap) {
        const poolAccount = getStableswapPoolAccount(poolEntry.poolId)
        const evmBalances = await readErc20Balances(block, poolEntry.assets, poolAccount)
        for (let j = 0; j < reserves.length; j++) {
          if (reserves[j] === 0n && evmBalances[j] > 0n) {
            reserves[j] = evmBalances[j]
          }
        }
      }

      // Read peg info if available (drifting peg pools like GDOT, GETH, GSOL)
      let pegMultipliers: [bigint, bigint][] | undefined
      try {
        let peg: { current?: Array<[bigint, bigint]> } | undefined
        let pegStorageSupported = false
        if (storage.stableswap.poolPegs.v378.is(block)) {
          pegStorageSupported = true
          peg = await storage.stableswap.poolPegs.v378.get(block, poolEntry.poolId)
        } else if (storage.stableswap.poolPegs.v323.is(block)) {
          pegStorageSupported = true
          peg = await storage.stableswap.poolPegs.v323.get(block, poolEntry.poolId)
        } else if (storage.stableswap.poolPegs.v305.is(block)) {
          pegStorageSupported = true
          peg = await storage.stableswap.poolPegs.v305.get(block, poolEntry.poolId)
        }
        if (!pegStorageSupported && stableswapPegStorageSeen) {
          throw new Error(`Unsupported Stableswap.PoolPegs storage at block ${block.height}`)
        }
        stableswapPegStorageSeen ||= pegStorageSupported
        const currentPeg = peg?.current
        if (currentPeg != null && currentPeg.length > 0) {
          pegMultipliers = currentPeg
        }
      } catch (error) {
        throw new Error(`Failed to read stableswap peg at block ${block.height} for pool ${poolEntry.poolId}`, { cause: error })
      }

      stableswapPools.push({
        poolId: poolEntry.poolId,
        assets: poolEntry.assets,
        reserves,
        amplification,
        fee: poolEntry.fee,
        totalIssuance: totalIssuances.get(poolEntry.poolId),
        pegMultipliers,
      })
    }
  } catch (error) {
    throw new Error(`Failed to read Stableswap state at block ${block.height}`, { cause: error })
  }

  return { pools: stableswapPools, totalIssuances }
}

export async function run(options: RunOptions = {}): Promise<void> {
  validateBlockRange(options)
  const pipelineId = options.pipelineId ?? process.env.INDEXER_PIPELINE_ID ?? 'main'
  const requireFinalizedRaw = options.requireFinalizedRaw ?? process.env.MAIN_REQUIRE_FINALIZED_RAW !== 'false'
  const deferHistoricalPublication = options.toBlock != null && requireFinalizedRaw
  const database = new Database(pipelineId, {
    deferPublication: deferHistoricalPublication,
    publishAtBlock: options.toBlock,
    startAtGenesis: options.fromBlock === 0,
  })
  const nativeAssetInfo = await loadNativeAssetInfo()
  if (nativeAssetInfo) {
    console.log(
      `[NativeAsset] Loaded ${nativeAssetInfo.symbol} from chain properties ` +
      `(asset_id=${nativeAssetInfo.assetId}, decimals=${nativeAssetInfo.decimals})`,
    )
  }
  const nativeAssetMetadata = nativeAssetInfo ? nativeAssetInfoToMetadata(nativeAssetInfo) : undefined
  const nativeAssetRow = nativeAssetInfo ? nativeAssetInfoToRow(nativeAssetInfo) : undefined
  const snapshotReader = new ClickHouseSnapshotReader({
    nativeAssetRow,
    finalizedOnly: requireFinalizedRaw,
  })

  const { height: lastProcessedBlock } = await database.connect()

  let startBlock = options.fromBlock
  if (startBlock === undefined) {
    // Resume from last checkpoint
    startBlock = lastProcessedBlock
    if (startBlock > 0) {
      console.log(`[Main] Resuming ${pipelineId} from checkpoint: block ${startBlock}`)
    } else if (options.toBlock == null) {
      // Fresh, unbounded run (the live follower): default to chain head and go
      // forward; backfill fills history downward. Avoids re-indexing from genesis
      // on a clean database. Falls back to 0 if the head can't be resolved.
      const head = await fetchChainHead(config.RPC_URL)
      if (head != null) {
        startBlock = head
        console.log(`[Main] Fresh ${pipelineId}: starting live at chain head ${head} (backfill fills history downward)`)
      } else {
        console.warn(`[Main] Fresh ${pipelineId}: could not resolve chain head from ${config.RPC_URL}; starting from block 0`)
      }
    }
  } else {
    console.log(`[Main] Starting ${pipelineId} from block ${startBlock} (--from-block override)`)
  }

  if (requireFinalizedRaw) {
    console.log('[Main] Historical raw snapshot reads require finalized raw ranges')
  }
  if (deferHistoricalPublication) {
    console.log('[Main] Deferring historical publication until the bounded range completes')
  }

  // Override processor's block range
  processor.setBlockRange({
    from: startBlock,
    to: options.toBlock,
  })

  const registry = new AssetRegistryTracker(BACKFILL_ASSET_SNAPSHOT_INTERVAL, nativeAssetMetadata, {
    includeUnresolvedAssets: false,
  })
  let historicalRegistryInitialized = false
  const compositionCache = new PoolCompositionCache()
  let previousHistoricalSnapshot: HistoricalSnapshotState | null = null

  let lastLogBlock = startBlock
  const archiveLogInterval = 1000
  const liveLogInterval = 1
  let currentLogInterval = archiveLogInterval
  let isLiveMode = false

  // State tracking for parent hash validation and runtime upgrades
  let previousBlockHash: string | null = null
  let previousBlockHeight: number | null = null
  let previousSpecVersion: number | null = null

    // Previous prices for carry-forward optimization
  let previousPrices: Map<number, string> | null = null
  let lastUnpricedKey = ''
  let atokenEquivalences: [number, number][] = []
  let atokenIds: Set<number> = new Set()
  // LP → wrapper equivalences (e.g. 2-Pool-GDOT(690) → GDOT(69))
  // Detected from asset registry symbol patterns (N-Pool-X → X)
  let lpEquivalences = new Map<number, number>()
  // Tracking for skip rate logging
  let blocksSkipped = 0
  let blocksProcessed = 0
  let swapEventsProcessed = 0

  await processor.run(database, async (ctx) => {
    // Preserve continuity across sequential batches. A retry/backward replay
    // resets the boundary state; a forward gap is an integrity failure. Every
    // block inside the batch is checked below as well.
    const firstHeight = ctx.blocks[0]?.header.height
    if (firstHeight != null && previousBlockHeight != null) {
      if (firstHeight <= previousBlockHeight) {
        previousBlockHash = null
        previousBlockHeight = null
      } else if (firstHeight > previousBlockHeight + 1) {
        throw new Error(`[Integrity] Processor gap between blocks ${previousBlockHeight} and ${firstHeight}`)
      }
    }

    // Detect live mode from the processor context. Small bounded historical ranges
    // must still use finalized raw snapshots and must not be treated as live.
    if (!isLiveMode && ctx.isHead && options.toBlock == null) {
      console.log('[Progress] Caught up to chain tip, switching to live mode (volumes now active)')
      isLiveMode = true
      currentLogInterval = liveLogInterval
      registry.setSnapshotInterval(config.SNAPSHOT_INTERVAL)
    }

    let historicalSnapshotStream: AsyncGenerator<HistoricalSnapshotEntry, void, unknown> | null = null
    let nextHistoricalSnapshot: IteratorResult<HistoricalSnapshotEntry, void> | null = null
    let matchedHistoricalSnapshots = 0
    let historicalSnapshotStreamFailed = false
    const firstBatchBlock = ctx.blocks[0]?.header.height
    const lastBatchBlock = ctx.blocks[ctx.blocks.length - 1]?.header.height
    const advanceHistoricalSnapshot = async (): Promise<void> => {
      if (historicalSnapshotStream == null || historicalSnapshotStreamFailed) return

      try {
        nextHistoricalSnapshot = await historicalSnapshotStream.next()
      } catch (error) {
        if (requireFinalizedRaw) {
          throw new Error(
            `Failed while streaming finalized raw snapshots for batch ${firstBatchBlock}-${lastBatchBlock}: ` +
            (error instanceof Error ? error.message : String(error)),
          )
        }
        historicalSnapshotStreamFailed = true
        nextHistoricalSnapshot = null
        console.error(
          `[History] Failed while streaming raw snapshots for batch ${firstBatchBlock}-${lastBatchBlock}, falling back to RPC for remaining blocks:`,
          error,
        )
        await historicalSnapshotStream.return(undefined)
        historicalSnapshotStream = null
      }
    }
    // Use stored raw snapshots whenever they exist, even if this batch reaches head.
    // Falling back to RPC should be a per-block missing-snapshot case, not a whole-batch
    // decision based on ctx.isHead.
    const shouldLoadHistoricalSnapshots = !isLiveMode && ctx.blocks.length > 0
    if (shouldLoadHistoricalSnapshots) {
      try {
        if (requireFinalizedRaw) {
          await snapshotReader.assertFinalizedCoverage(firstBatchBlock, lastBatchBlock)
        }
        historicalSnapshotStream = snapshotReader.streamRange(firstBatchBlock, lastBatchBlock)
        await advanceHistoricalSnapshot()
      } catch (error) {
        if (requireFinalizedRaw) {
          throw error
        }
        console.error(
          `[History] Failed to load raw snapshots for batch ${firstBatchBlock}-${lastBatchBlock}, falling back to RPC:`,
          error
        )
      }
    }

    for (const block of ctx.blocks) {
      const blockHeight = block.header.height
      const blockTimestamp = toClickHouseBlockTime(block.header.timestamp, blockHeight)
      const specVersion = block.header.specVersion ?? 0

      // Parent hash validation (data integrity check)
      if (previousBlockHash !== null && block.header.parentHash !== previousBlockHash) {
        throw new Error(
          `[Integrity] Parent hash mismatch at block ${blockHeight}: ` +
          `expected ${previousBlockHash}, got ${block.header.parentHash}`
        )
      }
      previousBlockHash = block.header.hash
      previousBlockHeight = blockHeight

      // First block of this run: ensure the baseline spec version's error names
      // exist (no upgrade event fires for the initial version, e.g. at genesis).
      if (previousSpecVersion === null) {
        await snapshotRuntimeErrorNames(ctx.store, block.header.hash, specVersion)
      }

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
        await snapshotRuntimeErrorNames(ctx.store, block.header.hash, specVersion)
        // Re-bootstrap pool caches: storage migrations may change pool compositions without emitting events
        compositionCache.invalidateAll()
      }
      previousSpecVersion = specVersion

      const hasSetStorageAffectingPools = detectPoolAffectingSetStorage(block.calls)
      const hasAssetRegistryChange = hasAssetRegistryMetadataEvent(block.events)
      let currentAtokenEquivalences = atokenEquivalences
      let currentAtokenIds = atokenIds
      let currentLpEquivalences = lpEquivalences
      let decimals = registry.getDecimals()
      let assetsTracked = registry.getCacheSize()
      let shouldProcess = true
      let omnipoolAssets = new Map<number, OmnipoolAssetState>()
      let xykPools: XYKPool[] = []
      let stableswapPools: StableswapPool[] = []
      let totalIssuances = new Map<number, bigint>()
      let historicalSnapshot: HistoricalSnapshotState | null = null
      while (true) {
        const currentHistoricalEntry = getHistoricalSnapshotEntry(nextHistoricalSnapshot)
        if (currentHistoricalEntry == null || currentHistoricalEntry.blockHeight >= blockHeight) {
          break
        }
        await advanceHistoricalSnapshot()
      }
      const currentHistoricalEntry = getHistoricalSnapshotEntry(nextHistoricalSnapshot)
      if (currentHistoricalEntry != null && currentHistoricalEntry.blockHeight === blockHeight) {
        historicalSnapshot = currentHistoricalEntry.snapshot
        matchedHistoricalSnapshots += 1
        await advanceHistoricalSnapshot()
      }

      if (historicalSnapshot == null && shouldLoadHistoricalSnapshots && requireFinalizedRaw) {
        throw new Error(`Missing finalized raw snapshot for historical block ${blockHeight}`)
      }

      if (historicalSnapshot) {
        if (hasSetStorageAffectingPools) {
          console.warn(`[SetStorage] Pool-affecting System.set_storage detected at block ${blockHeight}`)
        }

        if (!historicalRegistryInitialized || hasAssetRegistryChange) {
          await registry.maybeSnapshot(blockHeight, block.header, { force: true })
          ;({ atokenEquivalences, atokenIds, lpEquivalences } =
            syncRegistryPricingState(registry, lpEquivalences))
          historicalRegistryInitialized = true
        }

        const historicalAssetRows = historicalRegistryInitialized
          ? registry.getAssetRows()
          : historicalSnapshot.assetRows
        const historicalDecimals = historicalRegistryInitialized
          ? registry.getDecimals()
          : historicalSnapshot.decimals
        const historicalAtokenEquivalences = historicalRegistryInitialized
          ? atokenEquivalences
          : historicalSnapshot.atokenEquivalences
        const historicalAtokenIds = historicalRegistryInitialized
          ? atokenIds
          : historicalSnapshot.atokenIds
        const historicalLpEquivalences = historicalRegistryInitialized
          ? lpEquivalences
          : historicalSnapshot.lpEquivalences

        currentAtokenEquivalences = historicalAtokenEquivalences
        currentAtokenIds = historicalAtokenIds
        currentLpEquivalences = historicalLpEquivalences
        decimals = historicalDecimals
        assetsTracked = historicalAssetRows.length

        const changedAssets = diffAssetRows(previousHistoricalSnapshot?.assetRows ?? null, historicalAssetRows)
        if (changedAssets.length > 0) {
          ctx.store.addAssets(changedAssets)
        }

        const compositionChanged = previousHistoricalSnapshot != null &&
          historicalSnapshot.compositionKey !== previousHistoricalSnapshot.compositionKey

        let hasPoolAffectingTransfer = false
        let hasSwapEvents = false
        for (const event of block.events) {
          if (event.name === 'Tokens.Transfer') {
            const args = event.args as { currencyId: number; from: string; to: string; amount: bigint }
            if (historicalSnapshot.poolAccounts.has(args.from) || historicalSnapshot.poolAccounts.has(args.to)) {
              hasPoolAffectingTransfer = true
            }
          }
          if (isSwapEvent(event.name, specVersion)) {
            hasSwapEvents = true
          }
          if (hasPoolAffectingTransfer && hasSwapEvents) break
        }

        if (!hasPoolAffectingTransfer && !hasSetStorageAffectingPools && !compositionChanged && !hasSwapEvents && previousPrices !== null) {
          shouldProcess = false
        } else {
          omnipoolAssets = historicalSnapshot.omnipoolAssets
          xykPools = historicalSnapshot.xykPools
          stableswapPools = historicalSnapshot.stableswapPools
          totalIssuances = historicalSnapshot.totalIssuances
        }

        previousHistoricalSnapshot = {
          ...historicalSnapshot,
          assetRows: historicalAssetRows,
          decimals: historicalDecimals,
          atokenEquivalences: historicalAtokenEquivalences,
          atokenIds: historicalAtokenIds,
          lpEquivalences: historicalLpEquivalences,
        }
      } else {
        // Asset registry snapshot (every N blocks)
        const newAssets = await registry.maybeSnapshot(blockHeight, block.header, { force: hasAssetRegistryChange })
        if (newAssets.length > 0) {
          ctx.store.addAssets(newAssets)
        }
        if (newAssets.length > 0 || hasAssetRegistryChange) {
          ;({ atokenEquivalences, atokenIds, lpEquivalences } =
            syncRegistryPricingState(registry, lpEquivalences))
        }

        currentAtokenEquivalences = atokenEquivalences
        currentAtokenIds = atokenIds
        currentLpEquivalences = lpEquivalences
        decimals = registry.getDecimals()
        assetsTracked = registry.getCacheSize()

        // Update pool composition cache from events
        const compositionChanges = compositionCache.processEvents(block.events)
        const compositionChanged = compositionChanges.omnipoolChanged ||
          compositionChanges.xykChanged ||
          compositionChanges.stableswapChanged

        if (hasSetStorageAffectingPools) {
          console.warn(`[SetStorage] Pool-affecting System.set_storage detected at block ${blockHeight}`)
          compositionCache.invalidateAll()
        }

        const omnipoolAssetIds = await compositionCache.getOmnipoolAssets(block.header)
        const xykPoolEntries = await compositionCache.getXYKPools(block.header)
        const stableswapPoolEntries = await compositionCache.getStableswapPools(block.header)

        // Build set of known pool accounts for transfer event filtering
        const poolAccounts = new Set<string>()
        poolAccounts.add(omnipoolAccount)

        if (xykPoolEntries) {
          for (const pool of xykPoolEntries) {
            poolAccounts.add(pool.poolAccount)
          }
        }

        if (stableswapPoolEntries) {
          for (const pool of stableswapPoolEntries) {
            poolAccounts.add(getStableswapPoolAccount(pool.poolId))
          }
        }

        let hasPoolAffectingTransfer = false
        let hasSwapEvents = false
        for (const event of block.events) {
          if (event.name === 'Tokens.Transfer') {
            const args = event.args as { currencyId: number; from: string; to: string; amount: bigint }
            if (poolAccounts.has(args.from) || poolAccounts.has(args.to)) {
              hasPoolAffectingTransfer = true
            }
          }
          if (isSwapEvent(event.name, specVersion)) {
            hasSwapEvents = true
          }
          if (hasPoolAffectingTransfer && hasSwapEvents) break
        }

        if (!hasPoolAffectingTransfer && !hasSetStorageAffectingPools && !compositionChanged && !hasSwapEvents && previousPrices !== null) {
          shouldProcess = false
        } else {
          try {
            let stableswapResult: { pools: StableswapPool[]; totalIssuances: Map<number, bigint> }
            ;[omnipoolAssets, xykPools, stableswapResult] = await Promise.all([
              omnipoolAssetIds
                ? readOmnipoolState(block.header, omnipoolAssetIds)
                : Promise.resolve(new Map()),
              xykPoolEntries
                ? readXYKState(block.header, xykPoolEntries)
                : Promise.resolve([]),
              stableswapPoolEntries
                ? readStableswapState(block.header, stableswapPoolEntries)
                : Promise.resolve({ pools: [], totalIssuances: new Map() }),
            ])
            stableswapPools = stableswapResult.pools
            totalIssuances = stableswapResult.totalIssuances
          } catch (error) {
            throw new Error(
              `[Runtime] Storage read failed at block ${blockHeight} (spec_version: ${specVersion})`,
              { cause: error },
            )
          }
        }
      }

      if (!shouldProcess) {
        blocksSkipped++

        ctx.store.addBlocks([{
          block_height: blockHeight,
          block_timestamp: blockTimestamp,
          spec_version: specVersion,
        }])

        continue
      }

      blocksProcessed++

      const { prices, hopCounts, unpricedConnected } = resolvePrices(
        omnipoolAssets,
        xykPools,
        stableswapPools,
        decimals,
        config.USD_REFERENCE_IDS[0] ?? 10,
        config.LRNA_ASSET_ID,
        config.OMNIPOOL_BRIDGE_IDS,
        currentAtokenEquivalences,
        totalIssuances,
        config.USD_REFERENCE_IDS,
        {
          minGraphPathLiquidityUsd: config.GRAPH_MIN_PATH_LIQUIDITY_USD,
          lpEquivalences: currentLpEquivalences,
        },
      )

      const unpricedKey = unpricedConnected.join(',')
      if (unpricedKey !== lastUnpricedKey) {
        if (unpricedConnected.length > 0) {
          console.log(
            `[Pricing] Block ${blockHeight}: ${unpricedConnected.length} unpriced assets with pool connections: ${unpricedConnected.join(', ')}`
          )
        } else if (lastUnpricedKey !== '') {
          console.log(`[Pricing] Block ${blockHeight}: all connected assets now priced`)
        }
        lastUnpricedKey = unpricedKey
      }

      previousPrices = prices

      const atokenToBase = new Map(currentAtokenEquivalences.map(([base, aToken]) => [aToken, base]))
      const canonicalVolumeAssetId = (assetId: number): number => {
        const baseId = atokenToBase.get(assetId)
        const canonicalId = baseId ?? assetId
        return currentLpEquivalences.get(canonicalId) ?? canonicalId
      }

      // Extract volume from swap events in this block
      const volumeRows = extractVolumeFromSwaps(
        block.events,
        blockHeight,
        specVersion,
        prices,
        decimals,
        canonicalVolumeAssetId
      )
      const tradeVolumeRows = extractTradeVolumeFromSwaps(
        block.events,
        blockHeight,
        specVersion,
        prices,
        decimals,
        canonicalVolumeAssetId
      )
      swapEventsProcessed += block.events.filter(event => isSwapEvent(event.name, specVersion)).length

      // Copy LP token prices to their wrapper tokens (e.g. 2-Pool-GDOT(690) → GDOT(69))
      // Detected from Aave ReserveInitialized EVM events
      for (const [lpId, wrapperId] of currentLpEquivalences) {
        const lpPrice = prices.get(lpId)
        if (lpPrice && !prices.has(wrapperId)) {
          prices.set(wrapperId, lpPrice)
          hopCounts.set(wrapperId, hopCounts.get(lpId) ?? 0)
        }
      }

      const lpIds = new Set(currentLpEquivalences.keys())
      const priceRows = Array.from(prices.entries())
        .filter(([assetId, usdPrice]) => !currentAtokenIds.has(assetId) && !lpIds.has(assetId) && parseFloat(usdPrice) > 0)
        .map(([assetId, usdPrice]) => ({
          asset_id: assetId,
          block_height: blockHeight,
          usd_price: usdPrice,
          hops: hopCounts.get(assetId) ?? 0,
        }))

      // Merge price rows with volume rows (combines both into single batch)
      const combinedRows = mergePriceAndVolumeRows(priceRows, volumeRows)
        .filter(row => parseFloat(row.usd_price) > 0)
        .map(row => ({ ...row, block_timestamp: blockTimestamp }))
      ctx.store.addPrices(combinedRows)
      ctx.store.addTradeVolumes(tradeVolumeRows)

      ctx.store.addBlocks([{
        block_height: blockHeight,
        block_timestamp: blockTimestamp,
        spec_version: specVersion,
      }])

      if (blockHeight - lastLogBlock >= currentLogInterval) {
        const mode = isLiveMode ? 'LIVE' : 'ARCHIVE'
        const skipRate = blocksSkipped + blocksProcessed > 0
          ? ((blocksSkipped / (blocksSkipped + blocksProcessed)) * 100).toFixed(1)
          : '0.0'
        console.log(
          `[${mode}] Block ${blockHeight} | ` +
          `${previousPrices?.size ?? 0} prices/block | ` +
          `${Math.floor(swapEventsProcessed)} swaps | ` +
          `${assetsTracked} assets tracked | ` +
          `${skipRate}% skipped | ` +
          `spec_version: ${specVersion}`
        )
        lastLogBlock = blockHeight
        blocksSkipped = 0
        blocksProcessed = 0
        swapEventsProcessed = 0
      }
    }

    if (historicalSnapshotStream != null) {
      const missingSnapshots = ctx.blocks.length - matchedHistoricalSnapshots
      if (missingSnapshots > 0) {
        console.log(
          `[History] Missing ${missingSnapshots} raw snapshots in batch ${firstBatchBlock}-${lastBatchBlock}, falling back to RPC for those blocks`
        )
      }
      await historicalSnapshotStream.return(undefined)
    }
  })

}
