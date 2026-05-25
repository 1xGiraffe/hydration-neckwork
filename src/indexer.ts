import { processor } from './processor.js'
import { calculate_amplification } from '@galacticcouncil/math-stableswap'
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

const BACKFILL_ASSET_SNAPSHOT_INTERVAL = 10_000

// twox128 storage prefixes for pool-related pallets (hex without 0x prefix, 32 chars each)
// System.set_storage keys starting with these prefixes indicate pool state mutations
const POOL_STORAGE_PREFIXES = [
  'Omnipool', 'Tokens', 'XYK', 'Stableswap'
].map(name => xxhashAsHex(name, 128).slice(2))  // 32 hex chars each

export interface RunOptions {
  fromBlock?: number
  toBlock?: number
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
        }
        if (hdxFree && hdxFree > 0n) {
          hdxState.reserve = hdxFree
        }
      } catch {
        // Keep shares fallback if System.Account read fails
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
): Promise<{ pools: StableswapPool[]; totalIssuances: Map<number, bigint> }> {
  const stableswapPools: StableswapPool[] = []
  let totalIssuances = new Map<number, bigint>()

  // Check if Tokens.Accounts storage is available at this block
  if (!storage.tokens.accounts.v108.is(block)) {
    return { pools: stableswapPools, totalIssuances }
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
    if (storage.tokens.totalIssuance.v108.is(block)) {
      const lpAssetIds = pools.map(p => p.poolId)
      const issuances = await storage.tokens.totalIssuance.v108.getMany(block, lpAssetIds)
      for (let i = 0; i < lpAssetIds.length; i++) {
        const val = issuances[i]
        if (val !== undefined && val > 0n) {
          totalIssuances.set(lpAssetIds[i], val)
        }
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
        let peg: any
        if (storage.stableswap.poolPegs.v378.is(block)) {
          peg = await storage.stableswap.poolPegs.v378.get(block, poolEntry.poolId)
        } else if (storage.stableswap.poolPegs.v323.is(block)) {
          peg = await storage.stableswap.poolPegs.v323.get(block, poolEntry.poolId)
        } else if (storage.stableswap.poolPegs.v305.is(block)) {
          peg = await storage.stableswap.poolPegs.v305.get(block, poolEntry.poolId)
        }
        if (peg && peg.current?.length > 0) {
          pegMultipliers = peg.current
        }
      } catch {}

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
    console.error(`[Stableswap] Failed to read state at block ${block.height}:`, error)
  }

  return { pools: stableswapPools, totalIssuances }
}

export async function run(options: RunOptions = {}): Promise<void> {
  const database = new Database()
  const nativeAssetInfo = await loadNativeAssetInfo()
  if (nativeAssetInfo) {
    console.log(
      `[NativeAsset] Loaded ${nativeAssetInfo.symbol} from chain properties ` +
      `(asset_id=${nativeAssetInfo.assetId}, decimals=${nativeAssetInfo.decimals})`,
    )
  }
  const nativeAssetMetadata = nativeAssetInfo ? nativeAssetInfoToMetadata(nativeAssetInfo) : undefined
  const nativeAssetRow = nativeAssetInfo ? nativeAssetInfoToRow(nativeAssetInfo) : undefined
  const snapshotReader = new ClickHouseSnapshotReader({ nativeAssetRow })

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

  const registry = new AssetRegistryTracker(BACKFILL_ASSET_SNAPSHOT_INTERVAL, nativeAssetMetadata, {
    includeUnresolvedAssets: false,
  })
  let historicalRegistryInitialized = false
  const compositionCache = new PoolCompositionCache()
  let previousHistoricalSnapshot: HistoricalSnapshotState | null = null

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
  let lastUnpricedKey = ''
  let atokenEquivalences: [number, number][] = []
  let atokenIds: Set<number> = new Set()
  // LP → wrapper equivalences (e.g. 2-Pool-GDOT(690) → GDOT(69))
  // Detected from asset registry symbol patterns (N-Pool-X → X)
  const lpEquivalences = new Map<number, number>()
  // Tracking for skip rate logging
  let blocksSkipped = 0
  let blocksProcessed = 0
  let swapEventsProcessed = 0

  processor.run(database, async (ctx) => {
    // Reset parent hash validation state at batch boundaries
    // (prevents false positives across batch boundaries per RESEARCH.md Pitfall 4)
    previousBlockHash = null

    // Detect live mode: switch to per-block logging when batch size drops below threshold
    if (!isLiveMode && ctx.blocks.length < 10) {
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
        historicalSnapshotStream = snapshotReader.streamRange(firstBatchBlock, lastBatchBlock)
        await advanceHistoricalSnapshot()
      } catch (error) {
        console.error(
          `[History] Failed to load raw snapshots for batch ${firstBatchBlock}-${lastBatchBlock}, falling back to RPC:`,
          error
        )
      }
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

      if (historicalSnapshot) {
        if (hasSetStorageAffectingPools) {
          console.warn(`[SetStorage] Pool-affecting System.set_storage detected at block ${blockHeight}`)
        }

        if (!historicalRegistryInitialized || hasAssetRegistryChange) {
          await registry.maybeSnapshot(blockHeight, block.header, { force: true })
          historicalRegistryInitialized = true
        }

        const historicalAssetRows = historicalRegistryInitialized
          ? registry.getAssetRows()
          : historicalSnapshot.assetRows
        const historicalDecimals = historicalRegistryInitialized
          ? registry.getDecimals()
          : historicalSnapshot.decimals
        const historicalAtokenEquivalences = historicalRegistryInitialized
          ? registry.getAtokenEquivalences()
          : historicalSnapshot.atokenEquivalences
        const historicalAtokenIds = historicalRegistryInitialized
          ? registry.getAtokenIds()
          : historicalSnapshot.atokenIds
        const historicalLpEquivalences = historicalRegistryInitialized
          ? new Map(registry.getLpAliases())
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
          assetsTracked,
        }
      } else {
        // Asset registry snapshot (every N blocks)
        const newAssets = await registry.maybeSnapshot(blockHeight, block.header, { force: hasAssetRegistryChange })
        if (newAssets.length > 0) {
          ctx.store.addAssets(newAssets)
        }
        if (newAssets.length > 0 || hasAssetRegistryChange) {
          atokenEquivalences = registry.getAtokenEquivalences()
          atokenIds = registry.getAtokenIds()
          // Detect LP → wrapper equivalences from symbol patterns (N-Pool-X → X)
          // LP wrappers are Aave aToken contracts — add to aaveTokenIds for EVM balance reads
          const aaveTokenIds = new Set(atokenIds)
          for (const [lpId, displayId] of registry.getLpAliases()) {
            if (!lpEquivalences.has(lpId)) {
              lpEquivalences.set(lpId, displayId)
              console.log(`[LpAlias] ${lpId} → ${displayId}`)
            }
            aaveTokenIds.add(displayId)
          }
          updateErc20Registry(registry.getErc20Contracts(), aaveTokenIds)
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
            console.error(
              `[Runtime] Storage read failed at block ${blockHeight} (spec_version: ${specVersion}):`,
              error
            )
            continue
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
      pricesCalculated += prices.size

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
        pricesCalculated = 0
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
