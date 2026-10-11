import { createHash } from 'node:crypto'
import { validateBlockRange } from '../blockRange.js'
import { config } from '../config.js'
import { isSwapEvent } from '../registry/swapEvents.js'
import { AssetRegistryTracker } from '../registry/tracker.js'
import { hasAssetRegistryMetadataEvent } from '../registry/events.js'
import { AtokenReserveMap } from '../registry/atokenReserves.js'
import { PoolCompositionCache } from '../pool/compositionCache.js'
import { updateErc20Registry } from '../evm/balances.js'
import { rawProcessor } from './processor.js'
import type { RawCall, RawEvent, RawExtrinsic } from './processor.js'
import { aliasRowsForBoundEvent, aliasRowsForEvmParticipants, dedupeAliasRows } from './accountIdentity.js'
import { extractBalanceObservations } from './balance.js'
import { withoutRelayChainProof } from './callArgs.js'
import { RawDatabase } from './database.js'
import { extractEvmLogs } from './evmLogs.js'
import {
  buildSnapshotPayload,
  buildSnapshotState,
  detectPoolAffectingSetStorage,
  getOmnipoolAccount,
  getStableswapPoolAccount,
  poolPalletEventFamily,
  readOmnipoolState,
  readStableswapState,
  readXYKState,
  eventAccounts,
  eventCurrencyId,
  refreshAccruingPoolFields,
} from './snapshot.js'
import {
  callAddressToString,
  evmAccountForm,
  extractSigner,
  toClickHouseDateTime,
  toJsonString,
} from './json.js'
import { assertMoneyMarketPositionConfig, extractMoneyMarketRows, moneyMarketDefinitions, moneyMarketEthCallBatch, snapshotMoneyMarketCollateralFlags, snapshotMoneyMarketPositions } from './moneyMarket.js'
import { openPositionKey, trackOpenPositions } from './moneyMarketSnapshot.js'
import { priceStepThresholdFromEnvironment } from './moneyMarketPrices.js'
import { cadenceFromEnvironment, loadExactHolderSeed, loadSupersetHolderSeed, MoneyMarketTriggerPhase, readPairs, type TriggerBlock } from './moneyMarketTriggerPhase.js'
import { captureLmFarmEntries, entryEventsFromRawEvents } from './lmFarmEntries.js'
import { accountStateBalanceCandidates, accountStateTargets, captureAccountState, type AccountStateRuntime } from './accountState.js'
import { synthesizeNestedCallRows, type EvmExecution, type RuntimeCallDecoder } from './nestedCalls.js'
import { createClickHouseClient } from '../db/client.js'
import { minutesFromEnvironment } from '../util/env.js'
import { isMvSnapshotGridHeight, retainsSnapshotAtHeight, snapshotEveryNBlocksFromEnvironment } from './snapshotCadence.js'
import { fetchChainHead, fetchFinalizedHead } from '../rpc/head.js'
import type {
  RawBlockRow,
  RawBlockSnapshotRow,
  RawCallRow,
  RawEventRow,
  RawExtrinsicRow,
  SnapshotState,
} from './types.js'
import { extractXcmActivityRows } from './xcm.js'

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
// Substrate signature is absent (signer null). evmExecutionByExt maps each
// extrinsic index to the H160 sender (and exit reason) from its
// Ethereum.Executed event, if any.
function recoverEffectiveSigner(
  extrinsic: RawExtrinsic,
  evmExecutionByExt: Map<number, EvmExecution>,
): string | null {
  const callName = extrinsic.call?.name
  if (callName === 'Ethereum.transact') {
    return evmAccountForm(evmExecutionByExt.get(extrinsic.index)?.from ?? undefined)
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
  evmExecutionByExt: Map<number, EvmExecution>,
): RawExtrinsicRow {
  const signer = extractSigner(extrinsic.signature)
  return {
    block_height: extrinsic.block.height,
    block_timestamp: blockTimestamp,
    extrinsic_index: extrinsic.index,
    extrinsic_hash: extrinsic.hash ?? '',
    version: extrinsic.version ?? 0,
    signer,
    effective_signer: signer == null ? recoverEffectiveSigner(extrinsic, evmExecutionByExt) : null,
    fee: extrinsic.fee?.toString() ?? null,
    tip: extrinsic.tip?.toString() ?? null,
    success: extrinsic.success ? 1 : 0,
    signature_json: extrinsic.signature ? toJsonString(extrinsic.signature) : null,
    call_name: extrinsic.call?.name ?? '',
    call_args_json: toJsonString(withoutRelayChainProof(extrinsic.call?.name, extrinsic.call?.args ?? null)),
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
    args_json: toJsonString(withoutRelayChainProof(call.name, call.args ?? null)),
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

// Chain time between asset-registry scans, not a block count: the interval is a
// duration, and a block count only expresses one at a fixed block time.
function rawAssetSnapshotIntervalMinutes(): number {
  return minutesFromEnvironment('RAW_ASSET_SNAPSHOT_INTERVAL_MINUTES', config.SNAPSHOT_INTERVAL_MINUTES, {
    name: 'RAW_ASSET_SNAPSHOT_INTERVAL',
  })
}

function snapshotTraceEnabled(): boolean {
  return process.env.RAW_SNAPSHOT_TRACE === 'true'
}

// The (market, holder) pairs whose projected aggregate is non-zero, seeded from
// the projection and then kept current from every observation this worker writes.
// The trigger phase records a zero only for one of these: it is the exit of a
// position no pool event announced (a native aToken transfer), and skipping it
// would leave the stale aggregate current for good. They are also the raw-live
// cadence cohort. A fresh database yields an empty set that fills from the
// event-driven positions as blocks are processed.
async function loadOpenPositions(): Promise<Set<string>> {
  const open = new Set<string>()
  const client = createClickHouseClient()
  try {
    const res = await client.query({
      query: `SELECT user_address, pool_address
              FROM (
                SELECT user_address, pool_address, argMaxMerge(position_state) AS pos
                FROM price_data.money_market_latest_positions
                WHERE user_address != ''
                GROUP BY user_address, pool_address
              )
              WHERE tupleElement(pos, 'total_collateral_base') > 0 OR tupleElement(pos, 'total_debt_base') > 0`,
      format: 'JSONEachRow',
    })
    for (const row of await res.json<{ user_address: string; pool_address: string }>()) {
      open.add(openPositionKey(row.pool_address, row.user_address))
    }
  } finally {
    await client.close()
  }
  return open
}

// The money-market trigger phase (moneyMarketTriggerPhase.ts): price-step, config
// and chain-time cadence re-reads of getUserAccountData, and the collateral bitmap
// of every user whose bit a block can have moved. On by default.
function mmTriggersEnabled(): boolean {
  return (process.env.RAW_MM_TRIGGERS_ENABLED ?? 'true') !== 'false'
}

// The account-state hook (accountState.ts): locks, vesting, conviction votes and
// proxies of the accounts a block's events/calls name. On by default.
function accountStateEnabled(): boolean {
  return (process.env.RAW_ACCOUNT_STATE_ENABLED ?? 'true') !== 'false'
}

// The reserve holder index the trigger phase reads from. raw-live (unbounded) folds
// EXACT balances from a seed at its first block; a bounded range worker — whose
// history below its range may not be indexed yet — reads the SUPERSET of every
// account ever known to hold a reserve. An exact seed that cannot be built (a start
// at or below B0, ClickHouse unavailable) falls back to the superset.
async function createMoneyMarketTriggerPhase(startBlock: number, bounded: boolean): Promise<MoneyMarketTriggerPhase> {
  const markets = moneyMarketDefinitions().map(m => ({ key: m.key, pool: m.poolProxy }))
  const make = (mode: 'exact' | 'superset') => new MoneyMarketTriggerPhase({
    markets,
    mode,
    thresholdBp100: priceStepThresholdFromEnvironment(),
    cadence: cadenceFromEnvironment(),
    ethCall: moneyMarketEthCallBatch,
    readPositions: (users, blockHeight, blockTimestamp, ingestSource, options) =>
      snapshotMoneyMarketPositions(users, blockHeight, blockTimestamp, ingestSource, options),
    readCollateral: (users, blockHeight, poolProxy) => snapshotMoneyMarketCollateralFlags(users, blockHeight, poolProxy),
  })
  const client = createClickHouseClient()
  try {
    if (!bounded) {
      try {
        const seed = await loadExactHolderSeed(client, startBlock)
        const phase = make('exact')
        phase.index.seedBalances(seed)
        console.log(`[Raw][MM] Trigger phase: exact holder index seeded below block ${startBlock} (${seed.length} token balances)`)
        return phase
      } catch (error) {
        console.warn('[Raw][MM] Exact holder seed unavailable; using the holder superset', error)
      }
    }
    const phase = make('superset')
    phase.index.seedHolders(await loadSupersetHolderSeed(client))
    console.log('[Raw][MM] Trigger phase: holder superset seeded')
    return phase
  } finally {
    await client.close()
  }
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
  // Startup wait only (the follower's own head polling is RPC_HEAD_POLL_MS):
  // how often to re-check finality when we resumed already caught up to the
  // finalized head. 4s keeps the resume-into-follow handoff under one block at a
  // 6s block time — at 2s it is two blocks, so drop it to 1500-2000ms then (it is
  // one extra chain_getFinalizedHead against a local RPC, only during startup).
  const configured = Number.parseInt(process.env.RAW_LIVE_FINALITY_POLL_MS ?? '4000', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 4_000
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

  const registry = new AssetRegistryTracker(rawAssetSnapshotIntervalMinutes())
  const compositionCache = new PoolCompositionCache()

  // Throws on a cadence that would stop populating the % 600 pool-history MVs,
  // before a single block is indexed.
  const snapshotEveryNBlocks = snapshotEveryNBlocksFromEnvironment()
  if (snapshotEveryNBlocks > 1) {
    console.warn(
      `[Raw] RAW_SNAPSHOT_EVERY_N_BLOCKS=${snapshotEveryNBlocks}: raw_block_snapshots keeps one row per ${snapshotEveryNBlocks} blocks. ` +
      'The main (price) pipeline requires a snapshot row for every historical block it replays ' +
      '(src/indexer.ts, "Missing finalized raw snapshot"), so any range it has not already processed will fail.',
    )
  }

  // Authoritative wrapper↔base relation for the snapshot payload the price
  // pipeline replays; reloaded when the asset registry changes.
  const atokenReserves = new AtokenReserveMap()
  await atokenReserves.refresh()

  let mmTriggers: MoneyMarketTriggerPhase | null = null
  let openPositions = new Set<string>()
  if (mmTriggersEnabled()) {
    try {
      mmTriggers = await createMoneyMarketTriggerPhase(startBlock, boundedRange != null)
    } catch (error) {
      // Without a holder index a price step cannot name its holders: run without
      // the phase rather than guess, and say so.
      console.error('[Raw][MM] Trigger phase disabled: holder index could not be seeded', error)
    }
    if (mmTriggers != null) {
      try {
        openPositions = await loadOpenPositions()
        console.log(`[Raw][MM] Trigger phase: seeded ${openPositions.size} open positions`)
      } catch (error) {
        console.warn('[Raw][MM] Failed to seed the open money-market positions; will accumulate from events', error)
      }
    }
  }
  const accountStateOn = accountStateEnabled()

  let currentState: SnapshotState | null = null
  let previousBlockHash: string | null = null
  let previousBlockHeight: number | null = null
  let previousBlockTimestampMs: number | null = null
  let previousSpecVersion: number | null = null
  // The block after an upgrade block runs the new runtime's migrations
  // (on_runtime_upgrade executes at the start of the first block the new code
  // executes), which may rewrite pool storage with no event: read it whole too.
  let upgradeMigrationPending = false

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
  let lmEntryRowsPersisted = 0
  let accountStateRowsPersisted = 0
  let mmTriggerRowsPersisted = 0
  let parserWarningsPersisted = 0
  let snapshotsRefreshed = 0
  let snapshotsReused = 0

  rawProcessor.run(database, async (ctx) => {
    const firstHeight = ctx.blocks[0]?.header.height
    if (firstHeight != null && previousBlockHeight != null) {
      if (firstHeight <= previousBlockHeight) {
        previousBlockHash = null
        previousBlockHeight = null
        previousBlockTimestampMs = null
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

      // Captured before the update: the money-market cadence below asks whether
      // this block is the first one past a chain-time boundary, which needs the
      // previous block's timestamp.
      const priorBlockTimestampMs = previousBlockTimestampMs

      previousBlockHash = block.header.hash
      previousBlockHeight = blockHeight
      previousBlockTimestampMs = block.header.timestamp ?? null
      previousSpecVersion = specVersion

      ctx.store.addBlocks([serializeBlock(block.header, ingestSource)])

      // Ethereum.transact carries no Substrate signature; its real sender is the
      // H160 surfaced by the Ethereum.Executed event in the same extrinsic. The
      // exit reason rides along for the nested-call synthesis below: the extrinsic
      // succeeds even when the EVM execution reverted, so the exit reason is the
      // only truth about whether a dispatch-precompile call actually ran.
      const evmExecutionByExt = new Map<number, EvmExecution>()
      for (const event of block.events) {
        if (event.name !== 'Ethereum.Executed' || event.extrinsicIndex == null) continue
        const args = event.args as { from?: unknown; exitReason?: { __kind?: unknown } } | undefined
        const from = args?.from
        const exitKind = args?.exitReason?.__kind
        evmExecutionByExt.set(event.extrinsicIndex, {
          from: typeof from === 'string' ? from : null,
          exitKind: typeof exitKind === 'string' ? exitKind : null,
        })
      }

      const extrinsicRows = block.extrinsics.map(extrinsic => serializeExtrinsic(extrinsic, blockTimestamp, ingestSource, evmExecutionByExt))
      const callRows = block.calls.map(call => serializeCall(call, blockTimestamp, ingestSource))
      const eventRows = block.events.map(event => serializeEvent(event, blockTimestamp, ingestSource))

      // Inner calls of the wrappers subsquid does not decompose (dispatch
      // precompile calldata, gasless permits, Dispatcher.*), as identifiable
      // synthetic raw_calls rows — see nestedCalls.ts for the invariants.
      const runtime = block.header._runtime
      const decodeRuntimeCall: RuntimeCallDecoder = hex => {
        const record = runtime.toCallRecord(runtime.decodeCall(hex))
        return { name: record.name, args: JSON.parse(toJsonString(record.args ?? null)) as unknown }
      }
      const synthetic = synthesizeNestedCallRows({
        rows: callRows,
        evmExecutionByExtrinsic: evmExecutionByExt,
        decodeCall: decodeRuntimeCall,
      })

      ctx.store.addExtrinsics(extrinsicRows)
      ctx.store.addCalls(callRows)
      ctx.store.addCalls(synthetic.rows)
      ctx.store.addEvents(eventRows)

      extrinsicsPersisted += extrinsicRows.length
      callsPersisted += callRows.length + synthetic.rows.length
      eventsPersisted += eventRows.length

      // Liquidity-mining farm entries (raw_lm_farm_entries): an entry's stake is
      // storage-only, so every deposit this block's SharesDeposited/Redeposited
      // events name is read at the block's end, decoded by the runtime that
      // EXECUTED the block — the parent's code (see lmFarmEntries.ts). No RPC for a
      // block without such events. Like the money-market position reads below, a
      // failed read degrades to a parser warning for that deposit and never aborts
      // the block; the anchors loop (atoken-anchor) repairs what it names each
      // cycle, and snapshot-lm-entries.ts is the manual repair.
      const lmEntryEvents = entryEventsFromRawEvents(eventRows)
      if (lmEntryEvents.length > 0) {
        const lm = await tracePhase(blockHeight, 'lm_farm_entries', () => captureLmFarmEntries(
          { height: blockHeight, hash: block.header.hash, timestamp: blockTimestamp },
          lmEntryEvents,
          // The parent-state runtime (not header.specVersion's): see lmFarmEntries.ts.
          block.header._runtime,
          ingestSource,
        ))
        ctx.store.addLmFarmEntries(lm.rows)
        ctx.store.addParserWarnings(lm.warnings)
        lmEntryRowsPersisted += lm.rows.length
        parserWarningsPersisted += lm.warnings.length
        if (lm.warnings.length > 0) {
          console.warn(`[Raw][LM] Block ${blockHeight}: ${lm.warnings.length} farm-entry deposit read(s) failed (${lm.warnings[0].warning}); recorded as raw_parser_warnings`)
        }
      }

      // Bound events go in first so that when a block both binds an address and
      // logs it, the explicit binding is the row `dedupeAliasRows` keeps for the
      // key the two share.
      const candidateAliasRows = block.events.flatMap(event => aliasRowsForBoundEvent(event, blockTimestamp, ingestSource))
      const evmLogRows = extractEvmLogs(block.events, blockTimestamp, ingestSource)
      for (const evmLog of evmLogRows) {
        candidateAliasRows.push(...aliasRowsForEvmParticipants(
          evmLog.participants,
          evmLog.block_height,
          evmLog.block_timestamp,
          evmLog.event_index,
          ingestSource,
          evmLog.extrinsic_index,
        ))
      }
      const accountAliasRows = dedupeAliasRows(candidateAliasRows)

      // The money-market prices of this block against b − 1 start now, so the RPC
      // round trip overlaps the balance and position reads below; the trigger phase
      // awaits it after the block's own event-driven reads.
      const triggerBlock: TriggerBlock = {
        height: blockHeight,
        timestamp: blockTimestamp,
        timestampMs: block.header.timestamp,
        previousTimestampMs: priorBlockTimestampMs,
        ingestSource,
      }
      if (mmTriggers != null && triggerBlock.previousTimestampMs == null && blockHeight > 0) {
        // A worker's first block (or the first after a restart of the batch): b − 1's
        // timestamp from the parent state, so the cadence grid fires here exactly as
        // it would for a worker that processed b − 1 itself.
        try {
          const parentNow = await block.header._runtime.getStorage(block.header.parentHash, 'Timestamp.Now')
          const ms = Number(parentNow)
          if (Number.isFinite(ms) && ms > 0) triggerBlock.previousTimestampMs = ms
        } catch (error) {
          console.warn(`[Raw][MM] Block ${blockHeight}: parent timestamp unreadable; cadence cannot fire on this block`, error)
        }
      }
      const mmObservation = mmTriggers?.observe(triggerBlock, evmLogRows)

      // Account state (raw_account_state_observations): the accounts this block's
      // governance/vesting/staking/lock/proxy events and calls name, read at the
      // block's end with the runtime that EXECUTED it (as the LM entries above).
      // Each also gets a System.Account observation through the balance phase.
      const accountState = accountStateOn
        ? accountStateTargets(eventRows, [...callRows, ...synthetic.rows])
        : { targets: [], sources: [] }
      const accountStateCapture = accountState.targets.length > 0
        ? tracePhase(blockHeight, 'account_state', () => captureAccountState(
          { height: blockHeight, hash: block.header.hash, parentHash: block.header.parentHash, timestamp: blockTimestamp },
          accountState.targets,
          // The parent-state runtime (not header.specVersion's): see lmFarmEntries.ts.
          block.header._runtime as unknown as AccountStateRuntime,
          ingestSource,
        ))
        : null

      const balances = await tracePhase(blockHeight, 'balances', () => extractBalanceObservations(
          block.header,
          blockTimestamp,
          block.events,
          block.calls,
          ingestSource,
          accountStateBalanceCandidates(accountState.sources),
        ))
      const moneyMarket = await tracePhase(blockHeight, 'money_market', () => extractMoneyMarketRows(evmLogRows, ingestSource))
      const xcmActivityRows = extractXcmActivityRows(block.events, block.calls, blockTimestamp, ingestSource)

      ctx.store.addAccountAliases(accountAliasRows)
      ctx.store.addEvmLogs(evmLogRows)
      ctx.store.addBalanceObservations(balances.observations)
      ctx.store.addParserWarnings([...balances.warnings, ...moneyMarket.warnings, ...synthetic.warnings])
      ctx.store.addMoneyMarketEvents(moneyMarket.events)
      ctx.store.addMoneyMarketPositions(moneyMarket.positions)
      ctx.store.addMoneyMarketReserves(moneyMarket.reserves)
      ctx.store.addXcmActivity(xcmActivityRows)

      aliasRowsPersisted += accountAliasRows.length
      evmLogsPersisted += evmLogRows.length
      balanceRowsPersisted += balances.observations.length
      parserWarningsPersisted += balances.warnings.length + moneyMarket.warnings.length + synthetic.warnings.length + evmLogRows.filter(row => row.warning != null).length
      moneyMarketRowsPersisted += moneyMarket.events.length + moneyMarket.positions.length + moneyMarket.reserves.length
      xcmRowsPersisted += xcmActivityRows.length

      if (accountStateCapture != null) {
        const captured = await accountStateCapture
        ctx.store.addAccountStateObservations(captured.rows)
        ctx.store.addParserWarnings(captured.warnings)
        accountStateRowsPersisted += captured.rows.length
        parserWarningsPersisted += captured.warnings.length
        if (captured.warnings.length > 0) {
          console.warn(`[Raw][AccountState] Block ${blockHeight}: ${captured.warnings.length} account-state read(s) failed (${captured.warnings[0].warning}); recorded as raw_parser_warnings`)
        }
      }

      // Pairs this block's own events read already: the trigger phase reads each
      // (block, pool, user) at most once.
      const mmReadThisBlock = readPairs(moneyMarket.positions)

      // Money-market trigger phase (moneyMarketTriggerPhase.ts): price steps against
      // b − 1, configuration logs and the chain-time cadence re-read the holders whose
      // health factor moved with no event of their own — getUserAccountData AS
      // OBSERVED at this block, one read per (pool, user), never a computed value —
      // and the collateral bitmap of every user whose bit the block can have moved.
      if (mmTriggers != null && mmObservation != null) {
        const phase = mmTriggers
        trackOpenPositions(openPositions, moneyMarket.positions)
        const observation = await mmObservation
        const triggered = await tracePhase(blockHeight, 'mm_triggers', () => phase.run(triggerBlock, evmLogRows, observation, {
          alreadyRead: mmReadThisBlock,
          eventReads: moneyMarket.positionReads,
          openPositions,
        }))
        trackOpenPositions(openPositions, triggered.positions)
        ctx.store.addMoneyMarketPositions(triggered.positions)
        ctx.store.addMoneyMarketOraclePrices(triggered.oraclePrices)
        ctx.store.addMoneyMarketCollateralAnchors(triggered.collateral)
        ctx.store.addParserWarnings(triggered.warnings)
        mmTriggerRowsPersisted += triggered.positions.length
        moneyMarketRowsPersisted += triggered.positions.length + triggered.collateral.length
        parserWarningsPersisted += triggered.warnings.length
        if (triggered.stats.steppedReserves > 0 || triggered.stats.configPools > 0 || triggered.stats.cadencePools > 0) {
          console.log(`[Raw][MM] Triggers @${blockHeight}: ${triggered.stats.steppedReserves} stepped reserve(s), ${triggered.stats.configPools} config, ${triggered.stats.cadencePools} cadence market(s) → ${triggered.stats.planned} read(s), ${triggered.positions.length} positions, ${triggered.stats.collateralReads} collateral read(s), ${triggered.warnings.length} warnings`)
        }
      }

      // Force the scan when this block carries an asset-registry event: the raw
      // pipeline sees every event, and the snapshot payload written for this and
      // every following block must carry the post-change registry (a rename that
      // waits for the periodic scan bakes the OLD name into ~100 minutes of
      // snapshot payloads, which replay/backfill then treats as era truth).
      const changedAssets = await tracePhase(blockHeight, 'asset_registry', () => registry.maybeSnapshot(blockHeight, block.header, { force: hasAssetRegistryMetadataEvent(block.events) }))
      if (changedAssets.length > 0) await atokenReserves.refresh()
      const atokenEquivalences = registry.getAtokenEquivalences(atokenReserves.underlyings)
      const atokenIds = registry.getAtokenIds(atokenReserves.underlyings)
      const lpEquivalences = registry.getLpAliases(atokenReserves.underlyings)
      updateErc20Registry(registry.getErc20Contracts(), registry.getReserveAtokenIds(atokenReserves.underlyings), atokenReserves.reserves)

      const compositionChanges = compositionCache.processEvents(block.events)
      const refreshFamilies = new Set<PoolFamily>()
      if (compositionChanges.omnipoolChanged) refreshFamilies.add('omnipool')
      if (compositionChanges.xykChanged) refreshFamilies.add('xyk')
      if (compositionChanges.stableswapChanged) refreshFamilies.add('stableswap')
      // A pool-history grid height is always read whole: the reused state carries
      // what the last refresh saw, and some fields move every block with no event —
      // an aToken leg accrues its reserve's interest, a stableswap ramp steps its
      // amplification — so a reused grid row would sample the refresh block's values
      // into the history tables, not this block's. One full read per grid step.
      let forceAllPoolFamilies = currentState == null || specChanged || upgradeMigrationPending || isMvSnapshotGridHeight(blockHeight)
      upgradeMigrationPending = specChanged

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
      const stableswapShareIds = new Set<number>()
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
          stableswapShareIds.add(pool.poolId)
          poolAccounts.add(account)
        }
      }

      for (const event of block.events) {
        for (const account of eventAccounts(event)) {
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
        const currencyId = eventCurrencyId(event)
        if (currencyId != null && stableswapShareIds.has(currencyId)) refreshFamilies.add('stableswap')
        const palletFamily = poolPalletEventFamily(event)
        if (palletFamily != null) refreshFamilies.add(palletFamily)
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

      // A reused family still moves every block where its value is a function of
      // time: Erc20 (aToken) legs accrue interest, a stableswap ramp steps its
      // amplification. Restate those fields for this block (one batched EVM read).
      const reusedFamilies = { omnipool: !refreshOmnipool, xyk: !refreshXyk, stableswap: !refreshStableswap }
      if (reusedFamilies.omnipool || reusedFamilies.xyk || reusedFamilies.stableswap) {
        const state = currentState
        const accrued = await tracePhase(blockHeight, 'pool_accrual', () => refreshAccruingPoolFields(block.header, state, reusedFamilies))
        if (accrued.omnipool_assets !== state.omnipool_assets || accrued.xyk_pools !== state.xyk_pools || accrued.stableswap_pools !== state.stableswap_pools) {
          currentState = { ...state, ...accrued }
        }
      }

      // The ~273 KB payload is built and stored per block by default. Under a
      // thinned cadence the serialization is skipped too, not just the row — the
      // JSON is the cost, and `currentState` (which the next block reuses) is
      // maintained above regardless of whether this height is written out.
      if (retainsSnapshotAtHeight(blockHeight, snapshotEveryNBlocks)) {
        const payload = buildSnapshotPayload(block.header, currentState)
        const payloadJson = toJsonString(payload)
        ctx.store.addSnapshots([
          serializeSnapshot(payloadJson, block.header, ingestSource),
        ])
      }

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
          `${xcmRowsPersisted} xcm rows | ` +
          `${lmEntryRowsPersisted} lm entry rows | ` +
          `${accountStateRowsPersisted} account state rows | ` +
          `${mmTriggerRowsPersisted} mm trigger rows | ` +
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
        lmEntryRowsPersisted = 0
        accountStateRowsPersisted = 0
        mmTriggerRowsPersisted = 0
        parserWarningsPersisted = 0
        snapshotsRefreshed = 0
        snapshotsReused = 0
      }
    }
  })
}
