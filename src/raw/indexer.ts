import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { isSwapEvent } from '../registry/swapEvents.js'
import { AssetRegistryTracker } from '../registry/tracker.js'
import { PoolCompositionCache } from '../pool/compositionCache.js'
import { updateErc20Registry } from '../evm/balances.js'
import { rawProcessor } from './processor.js'
import type { RawCall, RawEvent, RawExtrinsic } from './processor.js'
import { RawDatabase } from './database.js'
import {
  buildSnapshotPayload,
  buildSnapshotState,
  detectPoolAffectingSetStorage,
  getOmnipoolAccount,
  getStableswapPoolAccount,
  readOmnipoolState,
  readStableswapState,
  readXYKState,
} from './snapshot.js'
import {
  callAddressToString,
  extractSigner,
  toClickHouseDateTime,
  toJsonString,
} from './json.js'
import type {
  RawBlockRow,
  RawBlockSnapshotRow,
  RawCallRow,
  RawEventRow,
  RawExtrinsicRow,
  SnapshotState,
} from './types.js'

export interface RawRunOptions {
  fromBlock?: number
  toBlock?: number
  pipelineId?: string
}

const SNAPSHOT_FAMILIES = ['assets', 'omnipool', 'xyk', 'stableswap']

function serializeBlock(
  header: {
    height: number
    hash: string
    parentHash: string
    stateRoot?: string
    extrinsicsRoot?: string
    timestamp?: number
    specVersion: number
    validator?: string
  },
  ingestSource: string
): RawBlockRow {
  return {
    block_height: header.height,
    block_hash: header.hash,
    parent_hash: header.parentHash,
    state_root: header.stateRoot ?? null,
    extrinsics_root: header.extrinsicsRoot ?? null,
    block_timestamp: toClickHouseDateTime(header.timestamp),
    spec_version: header.specVersion,
    author: header.validator ?? null,
    ingest_source: ingestSource,
  }
}

function serializeExtrinsic(extrinsic: RawExtrinsic, blockTimestamp: string, ingestSource: string): RawExtrinsicRow {
  return {
    block_height: extrinsic.block.height,
    block_timestamp: blockTimestamp,
    extrinsic_index: extrinsic.index,
    extrinsic_hash: extrinsic.hash ?? '',
    version: extrinsic.version ?? 0,
    signer: extractSigner(extrinsic.signature),
    fee: extrinsic.fee?.toString() ?? null,
    tip: extrinsic.tip?.toString() ?? null,
    success: extrinsic.success ? 1 : 0,
    signature_json: extrinsic.signature ? toJsonString(extrinsic.signature) : null,
    call_name: extrinsic.call?.name ?? '',
    call_args_json: toJsonString(extrinsic.call?.args ?? null),
    error_json: extrinsic.error == null ? null : toJsonString(extrinsic.error),
    ingest_source: ingestSource,
  }
}

function serializeCall(call: RawCall, blockTimestamp: string, ingestSource: string): RawCallRow {
  const callAddress = callAddressToString(call.address)
  if (callAddress == null) {
    throw new Error(`Call ${call.id} is missing address`)
  }

  return {
    block_height: call.block.height,
    block_timestamp: blockTimestamp,
    extrinsic_index: call.extrinsicIndex,
    call_address: callAddress,
    parent_call_address: call.address.length > 1 ? callAddressToString(call.address.slice(0, -1)) : null,
    call_name: call.name ?? '',
    origin_json: call.origin == null ? null : toJsonString(call.origin),
    args_json: toJsonString(call.args ?? null),
    success: call.success == null ? null : (call.success ? 1 : 0),
    error_json: call.error == null ? null : toJsonString(call.error),
    ingest_source: ingestSource,
  }
}

function serializeEvent(event: RawEvent, blockTimestamp: string, ingestSource: string): RawEventRow {
  return {
    block_height: event.block.height,
    block_timestamp: blockTimestamp,
    event_index: event.index,
    extrinsic_index: event.extrinsicIndex ?? null,
    call_address: callAddressToString(event.callAddress),
    phase: event.phase,
    event_name: event.name ?? '',
    args_json: toJsonString(event.args ?? null),
    ingest_source: ingestSource,
  }
}

function serializeSnapshot(
  payloadJson: string,
  block: { height: number; hash: string; timestamp?: number; specVersion: number },
  ingestSource: string
): RawBlockSnapshotRow {
  return {
    block_height: block.height,
    block_hash: block.hash,
    block_timestamp: toClickHouseDateTime(block.timestamp),
    spec_version: block.specVersion,
    snapshot_version: 1,
    families: SNAPSHOT_FAMILIES,
    payload_format: 'json',
    payload_json: payloadJson,
    payload_sha256: createHash('sha256').update(payloadJson).digest('hex'),
    ingest_source: ingestSource,
  }
}

function rawAssetSnapshotInterval(): number {
  const rawInterval = Number.parseInt(
    process.env.RAW_ASSET_SNAPSHOT_INTERVAL ?? `${config.SNAPSHOT_INTERVAL}`,
    10,
  )
  return Number.isFinite(rawInterval) && rawInterval > 0
    ? rawInterval
    : config.SNAPSHOT_INTERVAL
}

export async function runRaw(options: RawRunOptions = {}): Promise<void> {
  const pipelineId = options.pipelineId ?? process.env.RAW_PIPELINE_ID ?? 'raw-main'
  const database = new RawDatabase(pipelineId)
  const { height: lastProcessedBlock } = await database.connect()

  let startBlock = options.fromBlock
  if (startBlock == null) {
    startBlock = lastProcessedBlock
    if (startBlock > 0) {
      console.log(`[Raw] Resuming ${pipelineId} from checkpoint block ${startBlock}`)
    }
  } else {
    console.log(`[Raw] Starting ${pipelineId} from block ${startBlock}`)
  }

  rawProcessor.setBlockRange({
    from: startBlock,
    to: options.toBlock,
  })

  const registry = new AssetRegistryTracker(rawAssetSnapshotInterval())
  const compositionCache = new PoolCompositionCache()

  let currentState: SnapshotState | null = null
  let previousBlockHash: string | null = null
  let previousSpecVersion: number | null = null

  let lastLogBlock = startBlock
  let blocksProcessed = 0
  let extrinsicsPersisted = 0
  let callsPersisted = 0
  let eventsPersisted = 0
  let snapshotsRefreshed = 0
  let snapshotsReused = 0

  rawProcessor.run(database, async (ctx) => {
    previousBlockHash = null
    const ingestSource = ctx.isHead ? 'rpc' : 'sqd'
    const logInterval = ctx.isHead ? 1 : 100

    for (const block of ctx.blocks) {
      const blockHeight = block.header.height
      const blockTimestamp = toClickHouseDateTime(block.header.timestamp)
      const specVersion = block.header.specVersion ?? 0

      if (previousBlockHash != null && block.header.parentHash !== previousBlockHash) {
        console.warn(
          `[Raw][Integrity] Parent hash mismatch at block ${blockHeight}: expected ${previousBlockHash}, got ${block.header.parentHash}`,
        )
      }

      const specChanged = previousSpecVersion != null && specVersion !== previousSpecVersion
      if (specChanged) {
        console.log(`[Raw][Runtime] Upgrade detected at block ${blockHeight}: v${previousSpecVersion} -> v${specVersion}`)
        compositionCache.invalidateAll()
      }

      previousBlockHash = block.header.hash
      previousSpecVersion = specVersion

      ctx.store.addBlocks([serializeBlock(block.header, ingestSource)])

      const extrinsicRows = block.extrinsics.map(extrinsic => serializeExtrinsic(extrinsic, blockTimestamp, ingestSource))
      const callRows = block.calls.map(call => serializeCall(call, blockTimestamp, ingestSource))
      const eventRows = block.events.map(event => serializeEvent(event, blockTimestamp, ingestSource))

      ctx.store.addExtrinsics(extrinsicRows)
      ctx.store.addCalls(callRows)
      ctx.store.addEvents(eventRows)

      extrinsicsPersisted += extrinsicRows.length
      callsPersisted += callRows.length
      eventsPersisted += eventRows.length

      const changedAssets = await registry.maybeSnapshot(blockHeight, block.header)
      const atokenEquivalences = registry.getAtokenEquivalences()
      const atokenIds = registry.getAtokenIds()
      const lpEquivalences = registry.getLpAliases()
      const aaveTokenIds = new Set(atokenIds)
      for (const [, displayId] of lpEquivalences) {
        aaveTokenIds.add(displayId)
      }
      updateErc20Registry(registry.getErc20Contracts(), aaveTokenIds)

      const compositionChanges = compositionCache.processEvents(block.events)
      const compositionChanged =
        compositionChanges.omnipoolChanged ||
        compositionChanges.xykChanged ||
        compositionChanges.stableswapChanged

      const hasSetStorageAffectingPools = detectPoolAffectingSetStorage(block.calls)
      if (hasSetStorageAffectingPools) {
        console.warn(`[Raw][SetStorage] Pool-affecting System.set_storage detected at block ${blockHeight}`)
        compositionCache.invalidateAll()
      }

      const omnipoolAssetIds = await compositionCache.getOmnipoolAssets(block.header)
      const xykPoolEntries = await compositionCache.getXYKPools(block.header)
      const stableswapPoolEntries = await compositionCache.getStableswapPools(block.header)

      const poolAccounts = new Set<string>([getOmnipoolAccount()])
      if (xykPoolEntries != null) {
        for (const pool of xykPoolEntries) {
          poolAccounts.add(pool.poolAccount)
        }
      }
      if (stableswapPoolEntries != null) {
        for (const pool of stableswapPoolEntries) {
          poolAccounts.add(getStableswapPoolAccount(pool.poolId))
        }
      }

      let hasPoolAffectingTransfer = false
      let hasSwapEvents = false
      for (const event of block.events) {
        if (event.name === 'Tokens.Transfer') {
          const args = event.args as { from: string; to: string }
          if (poolAccounts.has(args.from) || poolAccounts.has(args.to)) {
            hasPoolAffectingTransfer = true
          }
        }
        if (isSwapEvent(event.name, specVersion)) {
          hasSwapEvents = true
        }
        if (hasPoolAffectingTransfer && hasSwapEvents) break
      }

      const poolsNeedRefresh =
        currentState == null ||
        specChanged ||
        hasSetStorageAffectingPools ||
        compositionChanged ||
        hasPoolAffectingTransfer ||
        hasSwapEvents

      if (poolsNeedRefresh) {
        const [omnipoolAssets, xykPools, stableswapPools] = await Promise.all([
          omnipoolAssetIds != null ? readOmnipoolState(block.header, omnipoolAssetIds) : Promise.resolve([]),
          xykPoolEntries != null ? readXYKState(block.header, xykPoolEntries) : Promise.resolve([]),
          stableswapPoolEntries != null ? readStableswapState(block.header, stableswapPoolEntries) : Promise.resolve([]),
        ])

        currentState = buildSnapshotState({
          assets: registry.getAssetsMetadata(),
          atokenEquivalences,
          lpEquivalences,
          omnipoolAssets,
          xykPools,
          stableswapPools,
        })
        snapshotsRefreshed++
      } else if (changedAssets.length > 0 && currentState != null) {
        currentState = {
          ...currentState,
          assets: registry.getAssetsMetadata(),
          atoken_equivalences: [...atokenEquivalences].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
          lp_equivalences: [...lpEquivalences].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
        }
      } else {
        snapshotsReused++
      }

      if (currentState == null) {
        throw new Error(`Snapshot state not initialized at block ${blockHeight}`)
      }

      const payload = buildSnapshotPayload(block.header, currentState)
      const payloadJson = toJsonString(payload)
      ctx.store.addSnapshots([
        serializeSnapshot(payloadJson, block.header, ingestSource),
      ])

      blocksProcessed++

      if (blockHeight - lastLogBlock >= logInterval) {
        console.log(
          `[Raw][${ingestSource.toUpperCase()}] Block ${blockHeight} | ` +
          `${extrinsicsPersisted} extrinsics | ` +
          `${callsPersisted} calls | ` +
          `${eventsPersisted} events | ` +
          `${snapshotsRefreshed} refreshed | ` +
          `${snapshotsReused} reused`,
        )

        lastLogBlock = blockHeight
        blocksProcessed = 0
        extrinsicsPersisted = 0
        callsPersisted = 0
        eventsPersisted = 0
        snapshotsRefreshed = 0
        snapshotsReused = 0
      }
    }
  })
}
