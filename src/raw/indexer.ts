import { createHash } from 'node:crypto'
import { validateBlockRange } from '../blockRange.js'
import { config } from '../config.js'
import { isSwapEvent } from '../registry/swapEvents.js'
import { AssetRegistryTracker } from '../registry/tracker.js'
import { PoolCompositionCache } from '../pool/compositionCache.js'
import { updateErc20Registry } from '../evm/balances.js'
import { rawProcessor } from './processor.js'
import type { RawCall, RawEvent, RawExtrinsic } from './processor.js'
import { aliasRowsForBoundEvent, aliasRowsForEvmParticipants } from './accountIdentity.js'
import { extractBalanceObservations } from './balance.js'
import { RawDatabase } from './database.js'
import { extractEvmLogs } from './evmLogs.js'
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
  evmAccountForm,
  extractSigner,
  toClickHouseDateTime,
  toJsonString,
} from './json.js'
import { assertMoneyMarketPositionConfig, extractMoneyMarketRows, snapshotMoneyMarketPositions } from './moneyMarket.js'
import { createClickHouseClient } from '../db/client.js'
import { fetchChainHead, fetchFinalizedHead } from '../rpc/head.js'
import type {
  RawBlockRow,
  RawBlockSnapshotRow,
  RawCallRow,
  RawEventRow,
  RawExtrinsicRow,
  SnapshotState,
} from './types.js'
import { extractXcmBridgeAndOperationRows } from './xcm.js'

export interface RawRunOptions {
  fromBlock?: number
  toBlock?: number
  pipelineId?: string
}

export function boundedRawRangeFromOptions(
  options: Pick<RawRunOptions, 'fromBlock' | 'toBlock'>,
): { fromBlock: number; toBlock: number } | null {
  validateBlockRange(options)
  if (options.toBlock == null) return null
  if (options.fromBlock == null) {
    throw new Error('--from-block is required when --to-block is used for raw range finalization')
  }
  return { fromBlock: options.fromBlock, toBlock: options.toBlock }
}

const SNAPSHOT_FAMILIES = ['assets', 'omnipool', 'xyk', 'stableswap']
type PoolFamily = 'omnipool' | 'xyk' | 'stableswap'

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
    block_timestamp: toClickHouseDateTime(header.timestamp, header.height),
    spec_version: header.specVersion,
    author: header.validator ?? null,
    ingest_source: ingestSource,
  }
}

// Recover the initiating account for natively-unsigned *user* extrinsics whose
// Substrate signature is absent (signer null). evmSenderByExt maps each
// extrinsic index to the H160 from its Ethereum.Executed event, if any.
function recoverEffectiveSigner(
  extrinsic: RawExtrinsic,
  evmSenderByExt: Map<number, string>,
): string | null {
  const callName = extrinsic.call?.name
  if (callName === 'Ethereum.transact') {
    return evmAccountForm(evmSenderByExt.get(extrinsic.index))
  }
  if (callName === 'MultiTransactionPayment.dispatch_permit') {
    return evmAccountForm((extrinsic.call?.args as { from?: unknown } | undefined)?.from)
  }
  return null
}

function serializeExtrinsic(
  extrinsic: RawExtrinsic,
  blockTimestamp: string,
  ingestSource: string,
  evmSenderByExt: Map<number, string>,
): RawExtrinsicRow {
  const signer = extractSigner(extrinsic.signature)
  return {
    block_height: extrinsic.block.height,
    block_timestamp: blockTimestamp,
    extrinsic_index: extrinsic.index,
    extrinsic_hash: extrinsic.hash ?? '',
    version: extrinsic.version ?? 0,
    signer,
    effective_signer: signer == null ? recoverEffectiveSigner(extrinsic, evmSenderByExt) : null,
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
    block_timestamp: toClickHouseDateTime(block.timestamp, block.height),
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

function snapshotTraceEnabled(): boolean {
  return process.env.RAW_SNAPSHOT_TRACE === 'true'
}

// Periodic Money Market position re-aggregation: every N blocks, re-read every
// known borrower's getUserAccountData so the explorer's portfolio history reflects
// interest accrual + oracle price drift between a borrower's own MM actions
// (event-only snapshots otherwise freeze an untouched position). ~12h by default,
// which is ~1 sample per explorer history bucket over a multi-week window.
function mmPeriodicSnapshotEnabled(): boolean {
  return (process.env.RAW_MM_PERIODIC_SNAPSHOT_ENABLED ?? 'true') !== 'false'
}

function mmSnapshotIntervalBlocks(): number {
  const configured = Number.parseInt(process.env.RAW_MM_SNAPSHOT_INTERVAL_BLOCKS ?? '7200', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 7200
}

// Seed the borrower set from positions already in ClickHouse so a freshly started
// worker re-snapshots accounts opened before its range (a fresh wipe just yields an
// empty set, which then grows from event-driven positions as blocks are processed).
async function loadKnownBorrowers(): Promise<Set<string>> {
  const borrowers = new Set<string>()
  const client = createClickHouseClient()
  try {
    const res = await client.query({
      query: `SELECT DISTINCT user_address FROM price_data.raw_money_market_positions WHERE user_address != ''`,
      format: 'JSONEachRow',
    })
    for (const row of await res.json<{ user_address: string }>()) {
      if (row.user_address) borrowers.add(row.user_address)
    }
  } finally {
    await client.close()
  }
  return borrowers
}

function phaseTraceEnabled(): boolean {
  return process.env.RAW_PHASE_TRACE === 'true'
}

async function tracePhase<T>(blockHeight: number, label: string, run: () => Promise<T>): Promise<T> {
  if (!phaseTraceEnabled()) return run()

  const startedAt = Date.now()
  console.log(`[Raw][PhaseTrace] Block ${blockHeight} ${label} start`)
  try {
    const result = await run()
    console.log(`[Raw][PhaseTrace] Block ${blockHeight} ${label} done in ${Date.now() - startedAt}ms`)
    return result
  } catch (error) {
    console.warn(`[Raw][PhaseTrace] Block ${blockHeight} ${label} failed after ${Date.now() - startedAt}ms`, error)
    throw error
  }
}

async function traceSnapshotRead<T>(blockHeight: number, label: string, read: () => Promise<T>): Promise<T> {
  if (!snapshotTraceEnabled()) return read()

  const startedAt = Date.now()
  console.log(`[Raw][SnapshotTrace] Block ${blockHeight} ${label} start`)
  try {
    const result = await read()
    console.log(`[Raw][SnapshotTrace] Block ${blockHeight} ${label} done in ${Date.now() - startedAt}ms`)
    return result
  } catch (error) {
    console.warn(`[Raw][SnapshotTrace] Block ${blockHeight} ${label} failed after ${Date.now() - startedAt}ms`, error)
    throw error
  }
}

function addSwapFamilies(
  event: RawEvent,
  specVersion: number,
  families: Set<PoolFamily>,
  forceAll: () => void,
): void {
  const name = event.name ?? ''
  if (!isSwapEvent(name, specVersion)) return

  if (name.startsWith('Omnipool.')) {
    families.add('omnipool')
    return
  }
  if (name.startsWith('XYK.')) {
    families.add('xyk')
    return
  }
  if (name.startsWith('Stableswap.')) {
    families.add('stableswap')
    return
  }

  if (name.startsWith('Broadcast.Swapped')) {
    const fillerKind = (event.args as { fillerType?: { __kind?: string } } | undefined)?.fillerType?.__kind
    if (fillerKind === 'Omnipool') {
      families.add('omnipool')
    } else if (fillerKind === 'XYK') {
      families.add('xyk')
    } else if (fillerKind === 'Stableswap') {
      families.add('stableswap')
    } else if (fillerKind == null) {
      forceAll()
    }
  }
}

function liveFinalityPollIntervalMs(): number {
  const configured = Number.parseInt(process.env.RAW_LIVE_FINALITY_POLL_MS ?? '12000', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 12_000
}

export async function runRaw(options: RawRunOptions = {}): Promise<void> {
  validateBlockRange(options)
  assertMoneyMarketPositionConfig()

  const pipelineId = options.pipelineId ?? process.env.RAW_PIPELINE_ID ?? 'raw-main'
  const boundedRange = boundedRawRangeFromOptions(options)
  const database = new RawDatabase(pipelineId, boundedRange)
  const { height: lastProcessedBlock } = await database.connect()

  let startBlock = options.fromBlock
  if (startBlock == null) {
    startBlock = lastProcessedBlock
    if (startBlock > 0) {
      console.log(`[Raw] Resuming ${pipelineId} from checkpoint block ${startBlock}`)
    } else if (options.toBlock == null) {
      // Fresh, unbounded run (the live follower): default to chain head and go
      // forward — the supervisor backfills history downward in parallel. Avoids
      // re-indexing from genesis on a clean database. Falls back to 0 only if the
      // head can't be resolved (e.g. a non-HTTP RPC).
      const head = await fetchChainHead(config.RPC_URL)
      if (head != null) {
        startBlock = head
        console.log(`[Raw] Fresh ${pipelineId}: starting live at chain head ${head} (backfill fills history downward)`)
      } else {
        console.warn(`[Raw] Fresh ${pipelineId}: could not resolve chain head from ${config.RPC_URL}; starting from block 0`)
      }
    }
  } else {
    console.log(`[Raw] Starting ${pipelineId} from block ${startBlock}`)
  }

  // FinalDatabase live follower: the subsquid runner only enters its finalized-block
  // follow loop — which then waits at the finalized head indefinitely — when the chain's
  // finalized head is strictly above our checkpoint. If we resume already caught up to the
  // finalized head (e.g. during a GRANDPA finality stall), it instead falls through to
  // processHotBlocks() and crashes on `supportsHotBlocks`, since RawDatabase can't hold
  // unfinalized blocks. Wait here until finality advances past the checkpoint so the runner
  // takes the finalized path; once running, a later stall just makes that loop wait, not
  // crash. Bounded backfill workers never reach the tip, so they skip this.
  if (boundedRange == null) {
    const pollMs = liveFinalityPollIntervalMs()
    let finalizedHead = await fetchFinalizedHead(config.RPC_URL)
    let waitedForFinality = false
    while (finalizedHead != null && finalizedHead <= lastProcessedBlock) {
      if (!waitedForFinality) {
        console.log(
          `[Raw] ${pipelineId}: caught up to finalized head ${finalizedHead} (checkpoint ${lastProcessedBlock}); waiting for on-chain finality to advance before following`,
        )
        waitedForFinality = true
      }
      await new Promise<void>(resolve => setTimeout(resolve, pollMs))
      finalizedHead = await fetchFinalizedHead(config.RPC_URL)
    }
    if (waitedForFinality && finalizedHead != null) {
      console.log(`[Raw] ${pipelineId}: finality advanced to ${finalizedHead}; starting follower`)
    }
  }

  rawProcessor.setBlockRange({
    from: startBlock,
    to: options.toBlock,
  })

  if (boundedRange != null) {
    await database.markRangeRunning(boundedRange.fromBlock, boundedRange.toBlock)
    if (lastProcessedBlock >= boundedRange.toBlock) {
      console.log(`[Raw] Checkpoint already reached ${boundedRange.fromBlock}-${boundedRange.toBlock}; validating finalized range`)
      try {
        await database.finalizeRange(boundedRange.fromBlock, boundedRange.toBlock)
      } catch (error) {
        await database.markRangeFailed(boundedRange.fromBlock, boundedRange.toBlock, error)
        throw error
      }
      return
    }
  }

  const registry = new AssetRegistryTracker(rawAssetSnapshotInterval())
  const compositionCache = new PoolCompositionCache()

  const mmSnapshotEnabled = mmPeriodicSnapshotEnabled()
  const mmSnapshotInterval = mmSnapshotIntervalBlocks()
  let knownBorrowers = new Set<string>()
  if (mmSnapshotEnabled) {
    try {
      knownBorrowers = await loadKnownBorrowers()
      console.log(`[Raw] Money Market periodic snapshot enabled (every ${mmSnapshotInterval} blocks); seeded ${knownBorrowers.size} borrowers`)
    } catch (error) {
      console.warn('[Raw] Failed to seed Money Market borrower set; will accumulate from events', error)
    }
  }

  let currentState: SnapshotState | null = null
  let previousBlockHash: string | null = null
  let previousBlockHeight: number | null = null
  let previousSpecVersion: number | null = null

  let lastLogBlock = startBlock
  let blocksProcessed = 0
  let extrinsicsPersisted = 0
  let callsPersisted = 0
  let eventsPersisted = 0
  let aliasRowsPersisted = 0
  let balanceRowsPersisted = 0
  let evmLogsPersisted = 0
  let moneyMarketRowsPersisted = 0
  let xcmRowsPersisted = 0
  let parserWarningsPersisted = 0
  let snapshotsRefreshed = 0
  let snapshotsReused = 0

  rawProcessor.run(database, async (ctx) => {
    const firstHeight = ctx.blocks[0]?.header.height
    if (firstHeight != null && previousBlockHeight != null) {
      if (firstHeight <= previousBlockHeight) {
        previousBlockHash = null
        previousBlockHeight = null
      } else if (firstHeight > previousBlockHeight + 1) {
        throw new Error(`[Raw][Integrity] Processor gap between blocks ${previousBlockHeight} and ${firstHeight}`)
      }
    }
    const ingestSource = ctx.isHead ? 'rpc' : 'sqd'
    const logInterval = ctx.isHead ? 1 : 100

    for (const block of ctx.blocks) {
      const blockHeight = block.header.height
      const blockTimestamp = toClickHouseDateTime(block.header.timestamp, blockHeight)
      const specVersion = block.header.specVersion ?? 0

      if (previousBlockHash != null && block.header.parentHash !== previousBlockHash) {
        throw new Error(
          `[Raw][Integrity] Parent hash mismatch at block ${blockHeight}: expected ${previousBlockHash}, got ${block.header.parentHash}`,
        )
      }

      const specChanged = previousSpecVersion != null && specVersion !== previousSpecVersion
      if (specChanged) {
        console.log(`[Raw][Runtime] Upgrade detected at block ${blockHeight}: v${previousSpecVersion} -> v${specVersion}`)
        compositionCache.invalidateAll()
      }

      previousBlockHash = block.header.hash
      previousBlockHeight = blockHeight
      previousSpecVersion = specVersion

      ctx.store.addBlocks([serializeBlock(block.header, ingestSource)])

      // Ethereum.transact carries no Substrate signature; its real sender is the
      // H160 surfaced by the Ethereum.Executed event in the same extrinsic.
      const evmSenderByExt = new Map<number, string>()
      for (const event of block.events) {
        if (event.name !== 'Ethereum.Executed' || event.extrinsicIndex == null) continue
        const from = (event.args as { from?: unknown } | undefined)?.from
        if (typeof from === 'string') evmSenderByExt.set(event.extrinsicIndex, from)
      }

      const extrinsicRows = block.extrinsics.map(extrinsic => serializeExtrinsic(extrinsic, blockTimestamp, ingestSource, evmSenderByExt))
      const callRows = block.calls.map(call => serializeCall(call, blockTimestamp, ingestSource))
      const eventRows = block.events.map(event => serializeEvent(event, blockTimestamp, ingestSource))

      ctx.store.addExtrinsics(extrinsicRows)
      ctx.store.addCalls(callRows)
      ctx.store.addEvents(eventRows)

      extrinsicsPersisted += extrinsicRows.length
      callsPersisted += callRows.length
      eventsPersisted += eventRows.length

      const accountAliasRows = block.events.flatMap(event => aliasRowsForBoundEvent(event, blockTimestamp, ingestSource))
      const evmLogRows = extractEvmLogs(block.events, blockTimestamp, ingestSource)
      for (const evmLog of evmLogRows) {
        accountAliasRows.push(...aliasRowsForEvmParticipants(
          evmLog.participants,
          evmLog.block_height,
          evmLog.block_timestamp,
          evmLog.event_index,
          ingestSource,
          evmLog.extrinsic_index,
        ))
      }

      const balances = await tracePhase(blockHeight, 'balances', () => extractBalanceObservations(
          block.header,
          blockTimestamp,
          block.events,
          block.calls,
          ingestSource,
        ))
      const moneyMarket = await tracePhase(blockHeight, 'money_market', () => extractMoneyMarketRows(evmLogRows, ingestSource))
      const xcmBridgeOperations = extractXcmBridgeAndOperationRows(block.events, block.calls, blockTimestamp, ingestSource)

      ctx.store.addAccountAliases(accountAliasRows)
      ctx.store.addEvmLogs(evmLogRows)
      ctx.store.addBalanceObservations(balances.observations)
      ctx.store.addParserWarnings([...balances.warnings, ...moneyMarket.warnings])
      ctx.store.addMoneyMarketEvents(moneyMarket.events)
      ctx.store.addMoneyMarketPositions(moneyMarket.positions)
      ctx.store.addMoneyMarketReserves(moneyMarket.reserves)
      ctx.store.addXcmActivity(xcmBridgeOperations.xcmActivity)
      ctx.store.addBridgeEvidence(xcmBridgeOperations.bridgeEvidence)
      ctx.store.addOperationTraces(xcmBridgeOperations.operationTraces)

      aliasRowsPersisted += accountAliasRows.length
      evmLogsPersisted += evmLogRows.length
      balanceRowsPersisted += balances.observations.length
      parserWarningsPersisted += balances.warnings.length + moneyMarket.warnings.length + evmLogRows.filter(row => row.warning != null).length
      moneyMarketRowsPersisted += moneyMarket.events.length + moneyMarket.positions.length + moneyMarket.reserves.length
      xcmRowsPersisted += xcmBridgeOperations.xcmActivity.length +
        xcmBridgeOperations.bridgeEvidence.length +
        xcmBridgeOperations.operationTraces.length

      // Track every borrower seen via event-driven positions, then re-snapshot the
      // whole set on interval boundaries (deterministic by absolute height so each
      // boundary is covered exactly once across the parallel range workers). eth_call
      // failures degrade to parser warnings, never abort the block.
      if (mmSnapshotEnabled) {
        for (const position of moneyMarket.positions) {
          if (position.user_address) knownBorrowers.add(position.user_address)
        }
        if (blockHeight % mmSnapshotInterval === 0 && knownBorrowers.size > 0) {
          const mmSnapshot = await tracePhase(blockHeight, 'mm_periodic_snapshot', () =>
            snapshotMoneyMarketPositions(knownBorrowers, blockHeight, blockTimestamp, ingestSource))
          ctx.store.addMoneyMarketPositions(mmSnapshot.positions)
          ctx.store.addParserWarnings(mmSnapshot.warnings)
          moneyMarketRowsPersisted += mmSnapshot.positions.length
          parserWarningsPersisted += mmSnapshot.warnings.length
          if (mmSnapshot.positions.length > 0 || mmSnapshot.warnings.length > 0) {
            console.log(`[Raw][MM] Periodic snapshot @${blockHeight}: ${mmSnapshot.positions.length} positions, ${mmSnapshot.warnings.length} warnings (${knownBorrowers.size} borrowers)`)
          }
        }
      }

      const changedAssets = await tracePhase(blockHeight, 'asset_registry', () => registry.maybeSnapshot(blockHeight, block.header))
      const atokenEquivalences = registry.getAtokenEquivalences()
      const atokenIds = registry.getAtokenIds()
      const lpEquivalences = registry.getLpAliases()
      const aaveTokenIds = new Set(atokenIds)
      for (const [, displayId] of lpEquivalences) {
        aaveTokenIds.add(displayId)
      }
      updateErc20Registry(registry.getErc20Contracts(), aaveTokenIds)

      const compositionChanges = compositionCache.processEvents(block.events)
      const refreshFamilies = new Set<PoolFamily>()
      if (compositionChanges.omnipoolChanged) refreshFamilies.add('omnipool')
      if (compositionChanges.xykChanged) refreshFamilies.add('xyk')
      if (compositionChanges.stableswapChanged) refreshFamilies.add('stableswap')
      let forceAllPoolFamilies = currentState == null || specChanged

      const hasSetStorageAffectingPools = detectPoolAffectingSetStorage(block.calls)
      if (hasSetStorageAffectingPools) {
        console.warn(`[Raw][SetStorage] Pool-affecting System.set_storage detected at block ${blockHeight}`)
        compositionCache.invalidateAll()
        forceAllPoolFamilies = true
      }

      const [omnipoolAssetIds, xykPoolEntries, stableswapPoolEntries] = await tracePhase(
        blockHeight,
        'pool_composition',
        () => Promise.all([
          compositionCache.getOmnipoolAssets(block.header),
          compositionCache.getXYKPools(block.header),
          compositionCache.getStableswapPools(block.header),
        ]),
      )

      const omnipoolPoolAccount = getOmnipoolAccount()
      const xykPoolAccounts = new Set<string>()
      const stableswapPoolAccounts = new Set<string>()
      const poolAccounts = new Set<string>([omnipoolPoolAccount])
      if (xykPoolEntries != null) {
        for (const pool of xykPoolEntries) {
          xykPoolAccounts.add(pool.poolAccount)
          poolAccounts.add(pool.poolAccount)
        }
      }
      if (stableswapPoolEntries != null) {
        for (const pool of stableswapPoolEntries) {
          const account = getStableswapPoolAccount(pool.poolId)
          stableswapPoolAccounts.add(account)
          poolAccounts.add(account)
        }
      }

      for (const event of block.events) {
        if (event.name === 'Tokens.Transfer') {
          const args = event.args as { from: string; to: string }
          for (const account of [args.from, args.to]) {
            if (account === omnipoolPoolAccount) {
              refreshFamilies.add('omnipool')
            } else if (xykPoolAccounts.has(account)) {
              refreshFamilies.add('xyk')
            } else if (stableswapPoolAccounts.has(account)) {
              refreshFamilies.add('stableswap')
            } else if (poolAccounts.has(account)) {
              forceAllPoolFamilies = true
            }
          }
        }
        addSwapFamilies(event, specVersion, refreshFamilies, () => {
          forceAllPoolFamilies = true
        })
      }

      const refreshOmnipool = forceAllPoolFamilies || refreshFamilies.has('omnipool')
      const refreshXyk = forceAllPoolFamilies || refreshFamilies.has('xyk')
      const refreshStableswap = forceAllPoolFamilies || refreshFamilies.has('stableswap')
      const poolsNeedRefresh = refreshOmnipool || refreshXyk || refreshStableswap

      if (poolsNeedRefresh) {
        const [omnipoolAssets, xykPools, stableswapPools] = await Promise.all([
          refreshOmnipool && omnipoolAssetIds != null
            ? traceSnapshotRead(blockHeight, `omnipool assets=${omnipoolAssetIds.length}`, () => readOmnipoolState(block.header, omnipoolAssetIds))
            : Promise.resolve(currentState?.omnipool_assets ?? []),
          refreshXyk && xykPoolEntries != null
            ? traceSnapshotRead(blockHeight, `xyk pools=${xykPoolEntries.length}`, () => readXYKState(block.header, xykPoolEntries))
            : Promise.resolve(currentState?.xyk_pools ?? []),
          refreshStableswap && stableswapPoolEntries != null
            ? traceSnapshotRead(blockHeight, `stableswap pools=${stableswapPoolEntries.length}`, () => readStableswapState(block.header, stableswapPoolEntries))
            : Promise.resolve(currentState?.stableswap_pools ?? []),
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
          `${blocksProcessed} blocks | ` +
          `${extrinsicsPersisted} extrinsics | ` +
          `${callsPersisted} calls | ` +
          `${eventsPersisted} events | ` +
          `${aliasRowsPersisted} aliases | ` +
          `${balanceRowsPersisted} balances | ` +
          `${evmLogsPersisted} evm logs | ` +
          `${moneyMarketRowsPersisted} money market rows | ` +
          `${xcmRowsPersisted} xcm/bridge/operation rows | ` +
          `${parserWarningsPersisted} warnings | ` +
          `${snapshotsRefreshed} refreshed | ` +
          `${snapshotsReused} reused`,
        )

        lastLogBlock = blockHeight
        blocksProcessed = 0
        extrinsicsPersisted = 0
        callsPersisted = 0
        eventsPersisted = 0
        aliasRowsPersisted = 0
        balanceRowsPersisted = 0
        evmLogsPersisted = 0
        moneyMarketRowsPersisted = 0
        xcmRowsPersisted = 0
        parserWarningsPersisted = 0
        snapshotsRefreshed = 0
        snapshotsReused = 0
      }
    }
  })
}
