import type { ClickHouseClient } from '../db/client.ts'
import { SUBSTRATE_RPC_URL, substrateStorageBatch } from './substrateRpc.ts'
import { cachedSwr } from './cache.ts'
import { accountRef, ensurePrices, nttMinterAccounts, nttMinterH160, ocnChainName, usdValue, WORMHOLE_CHAIN_URNS, type PriceInfo } from './explorerService.ts'
import { assetDescriptor } from './explorerAssets.ts'
import {
  base58Encode,
  buildFuse,
  classifyBacking,
  decideInflight,
  decodeAddress,
  decodeBool,
  decodeGetPeer,
  decodeInboundQueuedTransfer,
  decodeRateLimitParams,
  decodeU128Le,
  decodeUint,
  deTrim,
  displayChainAddress,
  encodeBalanceOf,
  encodeGetCurrentInboundCapacity,
  encodeGetInboundLimitParams,
  encodeGetInboundQueuedTransfer,
  encodeIsMessageExecuted,
  encodeGetPeer,
  EVM_SELECTOR,
  hexToBytes,
  HYDRATION_WORMHOLE_CHAIN_ID,
  liveCapacity,
  matchInboundDeposit,
  normalizeScanOperations,
  nttDigest,
  parseLogMessagePublished,
  parseNttRateLimitState,
  parseNttTransceiverMessage,
  parseOriginRpcUrls,
  parseReceivedMessage,
  parseSolanaInboxItem,
  parseSolanaNttConfig,
  parseSuiInboxEntries,
  parseSuiNttState,
  parseSuiPeerEntry,
  parseWormholeLocation,
  RATE_LIMIT_REFILL_SEC,
  rescaleAmount,
  SOLANA_INBOX_RATE_LIMIT_DISCRIMINATOR,
  SOLANA_INBOX_RATE_LIMIT_LENGTH,
  SOLANA_NTT_CONFIG_DISCRIMINATOR,
  SOLANA_NTT_CONFIG_LENGTH,
  SOLANA_NTT_INBOX_ITEM_DISCRIMINATOR,
  SOLANA_NTT_INBOX_ITEM_LENGTH,
  SOLANA_OUTBOX_RATE_LIMIT_DISCRIMINATOR,
  SOLANA_OUTBOX_RATE_LIMIT_LENGTH,
  SOLANA_RELEASE_STATUS,
  summarizeWormhole,
  tokensTotalIssuanceKey,
  TOPIC,
  trimmedDecimalsFor,
  vaaKey,
  wormholeChainFamily,
  type DepositCandidate,
  type ManagerFacts,
  type NormalizedScanOp,
  type NttRateLimitState,
  type OutboundSend,
  type RateLimitParams,
  type WormholeAssetLimits,
  type WormholeAssetRow,
  type WormholeBridgeDetail,
  type WormholeChainState,
  type WormholeFuse,
  type WormholeInflightOp,
  type WormholeQueuedRelease,
  type WormholeStatus,
  type WormholeSummary,
  type WormholeTransferRow,
} from './wormholeNtt.ts'

// Wormhole NTT backing monitor: does the custody locked on each origin chain
// still cover the supply Hydration minted against it?
//
// The whole asset set is DISCOVERED — `EVMAccounts.NttMinterSet` names the
// per-asset manager and the registry's `wh` location names the origin chain and
// token — so a newly bridged asset appears with no code change.
//
// Everything that touches the network runs here, on the coordinated background
// refresher; the request path only reads ClickHouse history plus this snapshot.
// A failed cycle throws, which leaves the previous snapshot in place, and any
// value that could not be read stays null rather than becoming a zero that would
// read as "no backing".

let client: ClickHouseClient
export function initWormholeNttService(c: ClickHouseClient): void { client = c }

const SCAN_URL = process.env.WORMHOLE_SCAN_URL?.trim() ?? 'https://api.wormholescan.io'
const ORIGIN_RPC_URLS = parseOriginRpcUrls(process.env.WORMHOLE_ORIGIN_RPC_URLS)

// Transfers are followed for this long in both directions. Anything older is
// invisible on both sides, and both blind directions raise the residual, so an
// aged stuck transfer degrades to a visible surplus rather than a false deficit.
const LOOKBACK_DAYS = 14
const LOOKBACK_MS = LOOKBACK_DAYS * 86_400_000

// The public Hydration RPC rate-limits, so manager reads are sequential and
// spaced rather than fanned out.
const HYDRATION_RPC_SPACING_MS = 100
const HYDRATION_RPC_TIMEOUT_MS = 8_000
const ORIGIN_RPC_TIMEOUT_MS = 8_000
const SCAN_TIMEOUT_MS = 15_000
// Static per-manager facts (token, peer, peer decimals, mode) change only on a
// redeployment, so they are re-read hourly rather than every cycle.
const STATIC_FACTS_TTL_MS = 3_600_000
const SCAN_SWEEP_PAGES = 3
const SCAN_SWEEP_PAGE_SIZE = 50
const SCAN_MAX_SINGLE_OP_FETCHES = 10
// Bounds the per-emitter VAA listings that defeat the sweep's recency cap. One
// origin transceiver per asset is expected; the cap keeps a surprising answer
// from turning one cycle into an unbounded fan-out.
const SCAN_MAX_EMITTER_LISTINGS = 12
const RECENT_TRANSFER_LIMIT = 25
// Consecutive cycles a shortfall must survive before it is published as one.
const DOWNGRADE_CYCLES = 2
// Pages of the Sui inbox table one cycle will walk (50 entries each).
const SUI_INBOX_MAX_PAGES = 20
// Queue probes are batched into one JSON-RPC array per origin chain, in chunks
// sized like erc20WalletService's balance reads.
const QUEUE_CALL_BATCH = 80

// ───────────────────────────── snapshot ─────────────────────────────

interface DiscoveredAsset {
  assetId: number
  symbol: string
  decimals: number
  manager: string          // hydration manager h160, lowercase
  minterAccount: string    // the manager's widened ETH\0 account id
  originChainId: number
  originToken: string      // 32-byte hex as registered
}

interface ManagerStaticFacts {
  at: number
  token: string | null
  mode: number | null
  chainId: number | null
  peer: string | null
  peerDecimals: number | null
}

interface CustodyRead {
  locked: bigint | null       // in ORIGIN token decimals
  decimals: number | null
  paused: boolean | null
  at: number
}

// One manager's two rate-limiter legs, named from THAT manager's point of view
// and already stated at the Hydration asset's precision. Which Hydration-centric
// direction each becomes depends on the side it was read from: an origin
// manager's outbound leg is Hydration's entry, its inbound leg the release leg
// of a Hydration exit.
interface FusePair { outbound: WormholeFuse | null; inbound: WormholeFuse | null }

interface NttSendRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestampMs: number
  emitter: string            // transceiver h160
  sequence: string
  manager: string            // source NttManager h160
  assetId: number | null
  amount: bigint | null      // de-trimmed to asset decimals
  toChain: number
  trimmedAmount: bigint      // as published, at `trimmedDecimals`
  trimmedDecimals: number
  recipient: string          // origin-chain recipient, 32-byte hex
  messageId: string          // the NttManagerMessage id, as Sui's inbox keys by
  digest: string             // the NTT message identity the origin queues by
}

interface NttReceiveRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestampMs: number
  emitterChainId: number
  emitterAddress: string
  sequence: string
  managers: string[]         // managers that logged TransferRedeemed in the same extrinsic
}

interface NttLogTimeline {
  sends: NttSendRow[]
  receives: NttReceiveRow[]
  redeemedKeys: Set<string>
}

// A queued release as the snapshot holds it: raw integers at the Hydration
// asset's decimals, no valuation — USD is applied when the response is built.
interface QueuedEntry {
  digest: string
  assetId: number
  chainId: number
  amount: bigint
  recipient: string | null
  queuedAtSec: number | null
  releasableAtSec: number | null
  sendKey: string | null   // vaaKey of our own send, so it is not also in flight
}

interface WormholeSnapshot {
  takenAt: number
  hydrationChainId: number
  assets: DiscoveredAsset[]
  facts: Map<number, ManagerStaticFacts>
  pausedLocal: Map<number, boolean>
  issuance: Map<number, bigint>
  // Supply burned at the dead address, read in the SAME pinned block as issuance
  // because it is subtracted from it. Not `flows.burnedOut` — see BackingInput.
  burnedAtDead: Map<number, bigint>
  issuanceBlock: number | null
  custody: Map<number, CustodyRead>
  chains: WormholeChainState[]
  timeline: NttLogTimeline
  inflight: WormholeInflightOp[]
  inflightIn: Map<number, bigint>
  inflightOut: Map<number, bigint>
  inflightCount: Map<number, number>
  queued: QueuedEntry[]
  // Keyed by asset: present only where the origin's queue was actually read, so
  // an unread or unsupported origin stays null instead of claiming nothing is
  // held.
  queuedByAsset: Map<number, bigint>
  queuedCount: Map<number, number>
  // Rate-limiter fuses, per asset and per side. The origin map is what decides
  // whether the row carries limits at all: Hydration's own legs are uncapped, so
  // showing them alone would suggest a headroom nothing measured.
  originFuses: Map<number, FusePair>
  localFuses: Map<number, FusePair>
  // Per asset: whether a shortfall has now been read on two consecutive cycles
  // and may therefore be published as one.
  downgradeConfirmed: Map<number, boolean>
  scan: { configured: boolean; ok: boolean; asOf: string | null }
}

let snapshot: WormholeSnapshot | null = null
export let wormholeSnapshotGeneration = 0
let refreshInFlight: Promise<void> | null = null

/**
 * How many snapshots this process has published. An in-memory integer: a reader
 * that wants to know whether the bridge's state has moved compares it and pays
 * nothing when it has not.
 *
 * The notification evaluator polls it every tick, so a confirmed shortfall
 * reaches a subscriber within one 6s tick of being published rather than waiting
 * out the snapshot lane's 30s rhythm.
 */
export function getWormholeSnapshotGeneration(): number {
  return wormholeSnapshotGeneration
}

// Values that survive a partial failure: per-manager static facts and the last
// custody read per asset, so one bad poll of one chain does not blank it.
const staticFacts = new Map<number, ManagerStaticFacts>()
const lastCustody = new Map<number, CustodyRead>()
// Operations Wormholescan has already reported redeemed never change back, so a
// steady-state cycle only re-checks the ones still pending.
const resolvedScanOps = new Set<string>()
const originEmitters = new Map<string, { chainId: number; address: string }>()
// A released queue entry zeroes its record and can never queue again, so a
// digest observed settled is never probed a second time. This is what keeps a
// steady-state cycle to the handful of digests still unresolved; only a cold
// boot pays for the whole window.
const settledDigests = new Set<string>()
// Digests the origin reported queued. They stay probed even after they age out
// of the lookback window, so a transfer stuck behind the rate limiter for weeks
// keeps being subtracted instead of silently turning into custody surplus.
const knownQueuedDigests = new Set<string>()
// rateLimitDuration() per origin manager, in seconds. Governance can change it,
// so it rides the same hourly refresh as the other static facts.
const rateLimitDurations = new Map<number, { seconds: bigint; at: number }>()
// The last queue read per asset, so one failed poll of one chain does not blank
// a queue the previous cycle measured.
const lastQueued = new Map<number, QueuedEntry[]>()
// Same survival rule for the fuses: a chain that fails on one poll keeps the
// headroom it last reported rather than reading as an unlimited (or spent) one.
const lastOriginFuses = new Map<number, FusePair>()
const lastLocalFuses = new Map<number, FusePair>()
// Outbound digests a peer chain has confirmed it executed. Execution is
// permanent, so this only grows and a steady-state cycle asks about nothing.
const executedDigests = new Set<string>()
// How many consecutive readings an asset has come back below its tolerance. A
// shortfall is only published once a SECOND, INDEPENDENT reading confirms it;
// see `downgradeConfirmed`.
//
// What the damping actually guarantees is "two separate observations of the
// chain, seconds apart, agree" — the artefact it exists for is the indexing lag
// between a mint and its log, which resolves within a block or two. It does NOT
// require two full refresh cycles, and waiting for one cost minutes of latency
// on the one finding here that is worth minutes. So a FIRST sighting arms one
// narrow confirmation pass ~15s out (`scheduleBackingConfirmation`) over the
// flagged assets alone: it re-reads their origin custody, queues and fuses, their
// issuance at a freshly pinned indexed head, and their redemption probes, and
// only if that second reading is still short does the count reach
// DOWNGRADE_CYCLES. The two readings are as independent as two cycles were.
//
// Every other outcome leaves the row unconfirmed, which is the safe direction: a
// clean second reading resets the count to 0 (the next cycle starts the rule
// over), and a failed or unverifiable one leaves it untouched, so the following
// full cycle is still the second agreeing reading — the original two-cycle path
// remains the fallback whenever the fast one cannot read. A recovery needs no
// confirmation at all and applies on the next cycle.
const negativeStreak = new Map<number, number>()
// The Sui peers table lives inside the manager's state object, so its id is
// discovered from that object and memoized with the other static facts.
const suiPeersTable = new Map<number, string>()
// Every manager the discovery pass has seen, kept outside the snapshot so the
// Security timeline can name them before the first refresh completes.
const discoveredManagers = new Map<number, WormholeManagerRef>()

/** A discovered manager, as the Security timeline needs to label its events. */
export interface WormholeManagerRef {
  assetId: number
  symbol: string
  decimals: number
  /** Lowercase 0x H160 of the manager on Hydration's EVM. */
  manager: string
  originChainId: number
  originChainName: string
}

/**
 * The live manager set, from the SAME `EVMAccounts.NttMinterSet` discovery the
 * backing monitor runs on. Re-deriving it elsewhere would let a second list
 * drift — and would readmit the two decoy managers (an NTTUSD test deployment
 * and a superseded PRIME duplicate) that NttMinterSet already excludes.
 */
export function getWormholeManagers(): WormholeManagerRef[] {
  return [...discoveredManagers.values()].sort((a, b) => a.assetId - b.assetId)
}

// ───────────────────────────── discovery ─────────────────────────────

interface LocationRow { asset_id: number; args: string; symbol: string | null; decimals: number | null; min_block: number }

async function discoverAssets(): Promise<{ assets: DiscoveredAsset[]; minBlock: number }> {
  const minters = await nttMinterAccounts()
  if (!minters.size) return { assets: [], minBlock: 0 }
  const res = await client.query({
    query: `WITH loc AS (
              SELECT toUInt32(JSONExtractInt(args_json, 'assetId')) AS asset_id,
                     argMax(args_json, block_height) AS args
              FROM price_data.raw_events
              WHERE event_name IN ('AssetRegistry.LocationSet', 'AssetRegistry.Registered')
                AND args_json LIKE '%"0x7768%'
              GROUP BY asset_id
            )
            SELECT loc.asset_id AS asset_id, loc.args AS args, a.symbol AS symbol, a.decimals AS decimals,
                   (SELECT min(block_height) FROM price_data.raw_events WHERE event_name = 'EVMAccounts.NttMinterSet') AS min_block
            FROM loc LEFT JOIN (SELECT asset_id, symbol, decimals FROM price_data.assets FINAL) AS a USING (asset_id)`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<LocationRow>()
  const assets: DiscoveredAsset[] = []
  let minBlock = 0
  for (const row of rows) {
    minBlock = Math.max(minBlock, Number(row.min_block) || 0)
    const minterAccount = minters.get(Number(row.asset_id))
    if (!minterAccount) continue
    const location = parseWormholeLocation(row.args)
    if (!location) continue
    const fallback = assetDescriptor(Number(row.asset_id))
    assets.push({
      assetId: Number(row.asset_id),
      symbol: row.symbol || fallback.symbol,
      decimals: row.decimals != null ? Number(row.decimals) : fallback.decimals,
      manager: nttMinterH160(minterAccount),
      minterAccount,
      originChainId: location.originChainId,
      originToken: location.originToken,
    })
  }
  assets.sort((a, b) => a.assetId - b.assetId)
  for (const a of assets) {
    discoveredManagers.set(a.assetId, {
      assetId: a.assetId,
      symbol: a.symbol,
      decimals: a.decimals,
      manager: a.manager,
      originChainId: a.originChainId,
      originChainName: chainName(a.originChainId),
    })
  }
  return { assets, minBlock }
}

// ───────────────────────────── indexed NTT logs ─────────────────────────────

interface LogRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  block_timestamp: string
  contract: string
  topics: string[]
  data: string
}

const parseChTimestamp = (value: string): number => Date.parse(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z')) || 0
const sqlList = (values: readonly string[]): string => values.map(v => `'${v.replace(/'/g, '')}'`).join(',')

// The block the whole cycle is stated at: the newest block raw ingestion has
// written, which is the same watermark the response reports as `indexedThrough`.
// It advances on EVERY block rather than only on blocks holding a bridge event,
// so a quiet stretch does not strand the pin.
async function queryIndexedHead(): Promise<number | null> {
  const res = await client.query({
    query: `SELECT max(block_height) AS block_height FROM price_data.raw_blocks`,
    format: 'JSONEachRow',
  })
  const head = Number((await res.json<{ block_height: number }>())[0]?.block_height ?? 0)
  return Number.isSafeInteger(head) && head > 0 ? head : null
}

// Every NTT log Hydration wrote up to the pinned head, in two bounded reads: the
// managers' own rows locate the extrinsics (the bloom index on contract_address
// makes that selective), and the core bridge's LogMessagePublished plus the
// transceivers' ReceivedMessage are then a primary-key read inside those
// extrinsics. Replays collapse under LIMIT 1 BY the event identity.
//
// The upper bound is explicit rather than incidental: it is what makes this set
// and the issuance read describe the same block.
async function loadNttTimeline(assets: readonly DiscoveredAsset[], minBlock: number, maxBlock: number, hydrationChainId: number): Promise<NttLogTimeline> {
  const empty: NttLogTimeline = { sends: [], receives: [], redeemedKeys: new Set() }
  if (!assets.length) return empty
  const managers = assets.map(a => a.manager)
  const assetByManager = new Map(assets.map(a => [a.manager, a]))
  const res = await client.query({
    query: `WITH xs AS (
              SELECT DISTINCT block_height, extrinsic_index
              FROM price_data.raw_evm_logs
              WHERE block_height >= ${Math.max(0, minBlock)} AND block_height <= ${Math.max(0, maxBlock)}
                AND lower(contract_address) IN (${sqlList(managers)})
                AND topic0 IN ('${TOPIC.transferSent}','${TOPIC.transferRedeemed}')
            )
            SELECT block_height, event_index, extrinsic_index, block_timestamp,
                   lower(contract_address) AS contract, topics, data
            FROM price_data.raw_evm_logs
            WHERE (block_height, extrinsic_index) IN (SELECT block_height, extrinsic_index FROM xs)
              AND block_height <= ${Math.max(0, maxBlock)}
              AND topic0 IN ('${TOPIC.logMessagePublished}','${TOPIC.receivedMessage}','${TOPIC.transferRedeemed}')
            ORDER BY block_height, event_index
            LIMIT 1 BY block_height, event_index`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<LogRow>()

  const redeemedManagersByExtrinsic = new Map<string, string[]>()
  for (const row of rows) {
    if (row.topics[0]?.toLowerCase() !== TOPIC.transferRedeemed) continue
    const key = `${row.block_height}:${row.extrinsic_index}`
    const list = redeemedManagersByExtrinsic.get(key) ?? []
    if (!list.includes(row.contract)) list.push(row.contract)
    redeemedManagersByExtrinsic.set(key, list)
  }

  const sends: NttSendRow[] = []
  const receives: NttReceiveRow[] = []
  const redeemedKeys = new Set<string>()
  for (const row of rows) {
    const timestampMs = parseChTimestamp(row.block_timestamp)
    const published = parseLogMessagePublished(row.topics, row.data)
    if (published) {
      const message = parseNttTransceiverMessage(published.payload)
      if (!message) continue
      const manager = (decodeAddress(message.sourceManager) ?? '').toLowerCase()
      const asset = assetByManager.get(manager) ?? null
      sends.push({
        blockHeight: row.block_height,
        eventIndex: row.event_index,
        extrinsicIndex: row.extrinsic_index,
        timestampMs,
        emitter: published.emitter.toLowerCase(),
        sequence: published.sequence.toString(),
        manager,
        assetId: asset?.assetId ?? null,
        amount: asset ? deTrim(message.transfer.trimmedAmount, message.transfer.trimmedDecimals, asset.decimals) : null,
        toChain: message.transfer.toChain,
        trimmedAmount: message.transfer.trimmedAmount,
        trimmedDecimals: message.transfer.trimmedDecimals,
        recipient: message.transfer.recipient,
        messageId: message.messageId,
        digest: nttDigest(hydrationChainId, message.managerMessage),
      })
      continue
    }
    const received = parseReceivedMessage(row.topics, row.data)
    if (!received) continue
    redeemedKeys.add(vaaKey(received.emitterChainId, received.emitterAddress, received.sequence))
    receives.push({
      blockHeight: row.block_height,
      eventIndex: row.event_index,
      extrinsicIndex: row.extrinsic_index,
      timestampMs,
      emitterChainId: received.emitterChainId,
      emitterAddress: received.emitterAddress,
      sequence: received.sequence.toString(),
      managers: redeemedManagersByExtrinsic.get(`${row.block_height}:${row.extrinsic_index}`) ?? [],
    })
  }
  return { sends, receives, redeemedKeys }
}

// ───────────────────────────── Hydration RPC ─────────────────────────────

let lastHydrationCallAt = 0
async function throttle(): Promise<void> {
  // Clamped to one interval so a clock that steps backwards costs a single
  // pause rather than stalling the whole cycle until wall time catches up.
  const wait = Math.min(HYDRATION_RPC_SPACING_MS, HYDRATION_RPC_SPACING_MS - (Date.now() - lastHydrationCallAt))
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  lastHydrationCallAt = Date.now()
}

async function hydrationEthCall(to: string, data: string): Promise<string | null> {
  await throttle()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HYDRATION_RPC_TIMEOUT_MS)
  try {
    const res = await fetch(SUBSTRATE_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    })
    if (!res.ok) return null
    const json = await res.json() as { result?: unknown }
    return typeof json.result === 'string' && json.result !== '0x' ? json.result : null
  } catch { return null } finally { clearTimeout(timer) }
}

interface EvmCall { to: string; data: string }

// One JSON-RPC array for a whole set of Hydration eth_calls. The public RPC
// rate-limits per REQUEST, so batching the local fuse reads costs one throttled
// round trip instead of four per asset.
// `block` pins the calls to a specific height (a hex quantity Frontier accepts
// exactly like a substrate storage read's block hash). The reads that have to
// agree with issuance pass it; everything else takes the head.
async function hydrationEthCallBatch(calls: readonly EvmCall[], block = 'latest'): Promise<(string | null)[]> {
  if (!calls.length) return []
  await throttle()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HYDRATION_RPC_TIMEOUT_MS)
  try {
    const res = await fetch(SUBSTRATE_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(calls.map((call, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [call, block] }))),
    })
    if (!res.ok) return calls.map(() => null)
    const json = await res.json() as unknown
    if (!Array.isArray(json)) return calls.map(() => null)
    const byId = new Map<number, string | null>()
    for (const item of json) {
      const entry = item as { id?: unknown; result?: unknown }
      if (!Number.isInteger(entry?.id)) continue
      byId.set(entry.id as number, typeof entry.result === 'string' && entry.result !== '0x' ? entry.result : null)
    }
    return calls.map((_, id) => byId.get(id) ?? null)
  } catch { return calls.map(() => null) } finally { clearTimeout(timer) }
}

// The block hash the pinned state reads are taken at. Null when the node cannot
// resolve it, which fails the cycle rather than silently reading the head.
async function hydrationBlockHash(blockNumber: number): Promise<string | null> {
  await throttle()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HYDRATION_RPC_TIMEOUT_MS)
  try {
    const res = await fetch(SUBSTRATE_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getBlockHash', params: [blockNumber] }),
    })
    if (!res.ok) return null
    const json = await res.json() as { result?: unknown }
    return typeof json.result === 'string' && /^0x[0-9a-f]{64}$/i.test(json.result) ? json.result : null
  } catch { return null } finally { clearTimeout(timer) }
}

async function readManagerFacts(asset: DiscoveredAsset): Promise<ManagerStaticFacts> {
  const cached = staticFacts.get(asset.assetId)
  if (cached && Date.now() - cached.at < STATIC_FACTS_TTL_MS && cached.peer != null) return cached
  const [tokenRaw, modeRaw, chainIdRaw, peerRaw] = [
    await hydrationEthCall(asset.manager, EVM_SELECTOR.token),
    await hydrationEthCall(asset.manager, EVM_SELECTOR.mode),
    await hydrationEthCall(asset.manager, EVM_SELECTOR.chainId),
    await hydrationEthCall(asset.manager, encodeGetPeer(asset.originChainId)),
  ]
  const peer = decodeGetPeer(peerRaw)
  const mode = decodeUint(modeRaw)
  const chainId = decodeUint(chainIdRaw)
  const facts: ManagerStaticFacts = {
    at: Date.now(),
    token: decodeAddress(tokenRaw),
    mode: mode == null ? null : Number(mode),
    chainId: chainId == null ? null : Number(chainId),
    peer: peer?.address ?? cached?.peer ?? null,
    peerDecimals: peer?.decimals ?? cached?.peerDecimals ?? null,
  }
  if (facts.peer != null) staticFacts.set(asset.assetId, facts)
  return facts
}

// ───────────────────────────── origin chains ─────────────────────────────

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<unknown | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify(body) })
    if (!res.ok) return null
    return await res.json() as unknown
  } catch { return null } finally { clearTimeout(timer) }
}

interface OriginTarget { asset: DiscoveredAsset; peer: string; peerDecimals: number | null }

interface PendingDigest { assetId: number; digest: string }

interface EvmOriginRead {
  custody: Map<number, CustodyRead>
  fuses: Map<number, FusePair>
  // Digests this chain's manager reports it has consumed, or null when the read
  // did not answer — in which case redemption falls back to Wormholescan.
  executed: Set<string> | null
}

// One batched JSON-RPC pass per EVM origin chain: the custody balance the origin
// manager holds of the registered token, whether that manager is paused, both of
// its rate-limiter legs, and — in the SAME pass — whether it has already executed
// each of our still-unresolved outbound messages.
//
// Reading redemption anywhere else lets custody and redemption disagree: an
// unlock that has already reduced custody while the transfer still counts as in
// flight subtracts the same amount twice and reads as a deficit that never
// existed. Asking the manager that holds the custody closes that window.
//
// A manager whose own `token()` disagrees with the registry is not answering for
// the asset we are checking, so its custody is treated as unread.
async function readEvmCustody(
  url: string, targets: readonly OriginTarget[], hydrationChainId: number, pending: readonly PendingDigest[],
): Promise<EvmOriginRead> {
  const out: EvmOriginRead = { custody: new Map(), fuses: new Map(), executed: null }
  const calls: { jsonrpc: '2.0'; id: number; method: 'eth_call'; params: unknown[] }[] = []
  const index = new Map<number, { target: OriginTarget; balance: number; paused: number; token: number; fuse: number }>()
  const push = (call: EvmCall): number => {
    const id = calls.length
    calls.push({ jsonrpc: '2.0', id, method: 'eth_call', params: [call, 'latest'] })
    return id
  }
  const byAsset = new Map(targets.map(t => [t.asset.assetId, t]))
  for (const target of targets) {
    const managerAddress = displayChainAddress('evm', target.peer)
    const tokenAddress = displayChainAddress('evm', target.asset.originToken)
    const balance = push({ to: tokenAddress, data: encodeBalanceOf(managerAddress) })
    const paused = push({ to: managerAddress, data: EVM_SELECTOR.isPaused })
    const token = push({ to: managerAddress, data: EVM_SELECTOR.token })
    const fuse = calls.length
    for (const call of fuseCalls(managerAddress, hydrationChainId)) push(call)
    index.set(target.asset.assetId, { target, balance, paused, token, fuse })
  }
  const executedIds = new Map<string, number>()
  for (const item of pending) {
    const target = byAsset.get(item.assetId)
    if (!target || executedIds.has(item.digest)) continue
    executedIds.set(item.digest, push({ to: displayChainAddress('evm', target.peer), data: encodeIsMessageExecuted(item.digest) }))
  }
  if (!calls.length) return out

  const byId = new Map<number, string | null>()
  let answered = false
  for (let start = 0; start < calls.length; start += QUEUE_CALL_BATCH) {
    const json = await postJson(url, calls.slice(start, start + QUEUE_CALL_BATCH), ORIGIN_RPC_TIMEOUT_MS)
    if (!Array.isArray(json)) continue
    answered = true
    for (const item of json) {
      const entry = item as { id?: unknown; result?: unknown }
      if (!Number.isInteger(entry?.id)) continue
      byId.set(entry.id as number, typeof entry.result === 'string' ? entry.result : null)
    }
  }
  if (!answered) return out

  const at = Date.now()
  for (const [assetId, slot] of index) {
    const registered = displayChainAddress('evm', slot.target.asset.originToken).toLowerCase()
    const reported = decodeAddress(byId.get(slot.token))?.toLowerCase() ?? null
    if (reported != null && reported !== registered) continue
    const locked = decodeUint(byId.get(slot.balance))
    if (locked == null) continue
    out.custody.set(assetId, { locked, decimals: slot.target.peerDecimals, paused: decodeBool(byId.get(slot.paused)), at })
    // rateLimitDuration() rides this batch, so the queue pass finds it memoized
    // instead of asking a second time.
    const duration = decodeUint(byId.get(slot.fuse + 4))
    if (duration == null || duration <= 0n) continue
    rateLimitDurations.set(assetId, { seconds: duration, at })
    const tokenDecimals = slot.target.peerDecimals ?? slot.target.asset.decimals
    out.fuses.set(assetId, {
      outbound: evmFuse(byId.get(slot.fuse) ?? null, byId.get(slot.fuse + 1) ?? null, tokenDecimals, slot.target.asset.decimals, Number(duration)),
      inbound: evmFuse(byId.get(slot.fuse + 2) ?? null, byId.get(slot.fuse + 3) ?? null, tokenDecimals, slot.target.asset.decimals, Number(duration)),
    })
  }

  // An unreadable answer is not "not executed", but it also cannot be trusted as
  // a complete set: the whole chain falls back to the scan for this cycle rather
  // than reporting a partial one as authoritative.
  const executed = new Set<string>()
  for (const [digest, id] of executedIds) {
    const value = decodeBool(byId.get(id))
    if (value == null) return out
    if (value) executed.add(digest)
  }
  out.executed = executed
  return out
}

// The manager program's two rate-limit accounts, found by the account types'
// Anchor discriminators — no PDA derivation, so a program upgrade cannot break
// the lookup. Each holds only the capacity as of its last transfer, so the live
// headroom is recomputed here; Solana states the window nowhere on chain, and
// every leg on every chain uses the same 24-hour refill.
async function readSolanaFuses(url: string, targets: readonly OriginTarget[]): Promise<Map<number, FusePair>> {
  const out = new Map<number, FusePair>()
  const nowSec = Math.floor(Date.now() / 1000)
  const read = async (programId: string, discriminator: string, dataSize: number, offset: number): Promise<NttRateLimitState | null> => {
    const accounts = await postJson(url, {
      jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
      params: [programId, { encoding: 'base64', filters: [{ dataSize }, { memcmp: { offset: 0, bytes: base58Encode(hexToBytes(discriminator)) } }] }],
    }, ORIGIN_RPC_TIMEOUT_MS) as { result?: { account?: { data?: unknown } }[] } | null
    // A manager registers exactly one peer, so exactly one account of each type
    // exists; anything else is not the record this reads.
    if (!Array.isArray(accounts?.result) || accounts.result.length !== 1) return null
    const encoded = (accounts.result[0]?.account?.data as unknown[] | undefined)?.[0]
    if (typeof encoded !== 'string') return null
    return parseNttRateLimitState(Buffer.from(encoded, 'base64'), offset)
  }
  for (const target of targets) {
    const programId = displayChainAddress('solana', target.peer)
    const outbound = await read(programId, SOLANA_OUTBOX_RATE_LIMIT_DISCRIMINATOR, SOLANA_OUTBOX_RATE_LIMIT_LENGTH, 8)
    const inbound = await read(programId, SOLANA_INBOX_RATE_LIMIT_DISCRIMINATOR, SOLANA_INBOX_RATE_LIMIT_LENGTH, 9)
    if (!outbound && !inbound) continue
    // The accounts count in the ORIGIN mint's units.
    const dec = target.peerDecimals ?? target.asset.decimals
    out.set(target.asset.assetId, {
      outbound: computedFuse(outbound, dec, target.asset.decimals, RATE_LIMIT_REFILL_SEC, nowSec),
      inbound: computedFuse(inbound, dec, target.asset.decimals, RATE_LIMIT_REFILL_SEC, nowSec),
    })
  }
  return out
}

// Sui splits the two legs: the outbound limiter sits inline on the manager's
// state object, while the inbound one lives on the peer entry for Hydration
// inside that object's peers table. The table is addressed by its own object id,
// which is only knowable from the state object — hence the second query.
async function readSuiFuses(
  url: string, target: OriginTarget, peersTableId: string, outboundState: NttRateLimitState | null, hydrationChainId: number,
): Promise<FusePair | null> {
  const nowSec = Math.floor(Date.now() / 1000)
  const json = await postJson(url, {
    query: 'query NttPeers($id: SuiAddress!) { address(address: $id) { dynamicFields(first: 50) { nodes { name { json } value { ... on MoveValue { json } } } } } }',
    variables: { id: peersTableId },
  }, ORIGIN_RPC_TIMEOUT_MS) as { data?: { address?: { dynamicFields?: { nodes?: unknown } } } } | null
  const peer = parseSuiPeerEntry(json?.data?.address?.dynamicFields?.nodes, hydrationChainId)
  if (!peer && !outboundState) return null
  const dec = peer?.tokenDecimals ?? target.peerDecimals ?? target.asset.decimals
  return {
    outbound: computedFuse(outboundState, dec, target.asset.decimals, RATE_LIMIT_REFILL_SEC, nowSec),
    inbound: computedFuse(peer?.inboundRateLimit ?? null, dec, target.asset.decimals, RATE_LIMIT_REFILL_SEC, nowSec),
  }
}

// Fully generic from the manager program id: the program's single config account
// is found by its Anchor discriminator, and the custody token account is a fixed
// field inside it — no PDA derivation, so a program upgrade cannot break it.
async function readSolanaCustody(url: string, targets: readonly OriginTarget[]): Promise<Map<number, CustodyRead>> {
  const out = new Map<number, CustodyRead>()
  const discriminator = base58Encode(hexToBytes(SOLANA_NTT_CONFIG_DISCRIMINATOR))
  for (const target of targets) {
    const programId = displayChainAddress('solana', target.peer)
    const accounts = await postJson(url, {
      jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
      params: [programId, { encoding: 'base64', filters: [{ dataSize: SOLANA_NTT_CONFIG_LENGTH }, { memcmp: { offset: 0, bytes: discriminator } }] }],
    }, ORIGIN_RPC_TIMEOUT_MS) as { result?: { account?: { data?: unknown } }[] } | null
    const encoded = Array.isArray(accounts?.result) && accounts.result.length === 1
      ? (accounts.result[0]?.account?.data as unknown[] | undefined)?.[0]
      : undefined
    if (typeof encoded !== 'string') continue
    const config = parseSolanaNttConfig(Buffer.from(encoded, 'base64'))
    if (!config) continue
    if (config.mint !== displayChainAddress('solana', target.asset.originToken)) continue
    const balance = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'getTokenAccountBalance', params: [config.custody] }, ORIGIN_RPC_TIMEOUT_MS) as
      { result?: { value?: { amount?: unknown; decimals?: unknown } } } | null
    const amount = balance?.result?.value?.amount
    if (typeof amount !== 'string') continue
    out.set(target.asset.assetId, {
      locked: BigInt(amount),
      decimals: Number.isSafeInteger(Number(balance?.result?.value?.decimals)) ? Number(balance?.result?.value?.decimals) : target.peerDecimals,
      paused: config.paused,
      at: Date.now(),
    })
  }
  return out
}

interface SuiCustody {
  custody: Map<number, CustodyRead>
  inboxSize: Map<number, number>
  fuses: Map<number, FusePair>
  executed: Set<string> | null
}

// The messages the Sui manager has accepted, read from its inbox table's dynamic
// fields. Each field's KEY carries the NttManagerMessage id, which our own
// indexed sends already know, so an entry attributes back to a send with no
// amount matching at all. Presence means accepted; the release status only says
// whether the tokens have left custody, and a held one keeps its value visible
// as custody surplus rather than as a shortfall.
async function readSuiExecuted(
  url: string, inboxTableId: string, sends: readonly NttSendRow[], hydrationChainId: number,
): Promise<Set<string> | null> {
  const byMessageId = new Map<string, string>()
  for (const send of sends) if (send.digest) byMessageId.set(send.messageId.toLowerCase(), send.digest)
  const executed = new Set<string>()
  let cursor: string | null = null
  // The endpoint caps a page at 50, and the inbox grows by a handful of entries
  // a week, so the page bound is generous rather than tight.
  for (let page = 0; page < SUI_INBOX_MAX_PAGES; page++) {
    const json = await postJson(url, {
      query: 'query NttInbox($id: SuiAddress!, $after: String) { address(address: $id) { dynamicFields(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { name { json } value { ... on MoveValue { json } } } } } }',
      variables: { id: inboxTableId, after: cursor },
    }, ORIGIN_RPC_TIMEOUT_MS) as {
      data?: { address?: { dynamicFields?: { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown } } }
    } | null
    const fields = json?.data?.address?.dynamicFields
    // A page that never arrived leaves the set incomplete, and an incomplete set
    // would read as "in flight" for messages the chain has long since accepted.
    if (!fields || !Array.isArray(fields.nodes)) return null
    for (const entry of parseSuiInboxEntries(fields.nodes)) {
      if (entry.sourceChainId !== hydrationChainId) continue
      const digest = byMessageId.get(entry.messageId.toLowerCase())
      if (digest) executed.add(digest)
    }
    if (fields.pageInfo?.hasNextPage !== true || typeof fields.pageInfo.endCursor !== 'string') return executed
    cursor = fields.pageInfo.endCursor
  }
  return null
}

// The Sui peer handle IS the manager's state object id, and the object's Move
// contents carry the locked balance, the pause flag, the inbox size and the
// outbound rate limiter in one GraphQL read. The inbound limiter needs a second
// query against the peers table the object points at.
async function readSuiCustody(
  url: string, targets: readonly OriginTarget[], hydrationChainId: number, sends: readonly NttSendRow[],
): Promise<SuiCustody> {
  const custody = new Map<number, CustodyRead>()
  const inboxSize = new Map<number, number>()
  const fuses = new Map<number, FusePair>()
  const executed = new Set<string>()
  let executedOk = false
  for (const target of targets) {
    const id = displayChainAddress('sui', target.peer)
    const json = await postJson(url, {
      query: 'query NttState($id: SuiAddress!) { object(address: $id) { version asMoveObject { contents { json } } } }',
      variables: { id },
    }, ORIGIN_RPC_TIMEOUT_MS) as { data?: { object?: { asMoveObject?: { contents?: { json?: unknown } } } } } | null
    const state = parseSuiNttState(json?.data?.object?.asMoveObject?.contents?.json)
    if (!state) continue
    custody.set(target.asset.assetId, { locked: state.balance, decimals: target.peerDecimals, paused: state.paused, at: Date.now() })
    if (state.inboxSize != null) inboxSize.set(target.asset.assetId, state.inboxSize)
    if (state.inboxTableId != null) {
      const accepted = await readSuiExecuted(url, state.inboxTableId, sends, hydrationChainId)
      if (accepted) { executedOk = true; for (const digest of accepted) executed.add(digest) }
    }
    const peersTableId = state.peersTableId ?? suiPeersTable.get(target.asset.assetId) ?? null
    if (peersTableId == null) continue
    suiPeersTable.set(target.asset.assetId, peersTableId)
    const pair = await readSuiFuses(url, target, peersTableId, state.outboundRateLimit, hydrationChainId)
    if (pair) fuses.set(target.asset.assetId, pair)
  }
  return { custody, inboxSize, fuses, executed: executedOk ? executed : null }
}

// ─────────────────────── rate-limiter fuses ───────────────────────

// The four calls one manager answers about its two legs, plus the window they
// refill over. `peerChainId` is whoever sits on the other side of this manager:
// the origin chain for a Hydration manager, Hydration for an origin one.
const fuseCalls = (manager: string, peerChainId: number): EvmCall[] => [
  { to: manager, data: EVM_SELECTOR.getOutboundLimitParams },
  { to: manager, data: EVM_SELECTOR.getCurrentOutboundCapacity },
  { to: manager, data: encodeGetInboundLimitParams(peerChainId) },
  { to: manager, data: encodeGetCurrentInboundCapacity(peerChainId) },
  { to: manager, data: EVM_SELECTOR.rateLimitDuration },
]

// One leg from an EVM manager's answers. The limit arrives as a packed
// TrimmedAmount and the capacity already untrimmed to the manager's own token
// decimals, so the limit is widened to that scale before both are rescaled to
// the Hydration asset's.
function evmFuse(
  paramsRaw: string | null, capacityRaw: string | null,
  tokenDecimals: number, assetDecimals: number, durationSec: number,
): WormholeFuse | null {
  const params: RateLimitParams | null = decodeRateLimitParams(paramsRaw)
  if (!params) return null
  return buildFuse({
    limitRaw: rescaleAmount(params.limit, params.limitDecimals, tokenDecimals),
    capacityRaw: decodeUint(capacityRaw),
    sourceDecimals: tokenDecimals,
    assetDecimals,
    durationSec,
    lastConsumedSec: params.lastTxSec,
  })
}

// A leg whose chain exposes only the stored capacity-at-last-transfer, so the
// live figure is recomputed from the limiter's own refill formula.
function computedFuse(
  state: NttRateLimitState | null, sourceDecimals: number, assetDecimals: number, durationSec: number, nowSec: number,
): WormholeFuse | null {
  if (!state) return null
  return buildFuse({
    limitRaw: state.limit,
    capacityRaw: liveCapacity({ ...state, nowSec, durationSec }),
    sourceDecimals,
    assetDecimals,
    durationSec,
    lastConsumedSec: state.lastTxSec,
  })
}

// Hydration's own managers, in one batched round trip. These legs are
// deliberately uncapped (the u64 trimmed ceiling), so they exist to be SHOWN as
// uncapped rather than to be watched — the origin side carries every real fuse.
async function readLocalFuses(assets: readonly DiscoveredAsset[]): Promise<Map<number, FusePair>> {
  const out = new Map<number, FusePair>()
  const calls: EvmCall[] = []
  const slots: { asset: DiscoveredAsset; at: number }[] = []
  for (const asset of assets) {
    slots.push({ asset, at: calls.length })
    calls.push(...fuseCalls(asset.manager, asset.originChainId))
  }
  const results = await hydrationEthCallBatch(calls)
  for (const slot of slots) {
    const [outParams, outCap, inParams, inCap, durationRaw] = results.slice(slot.at, slot.at + 5)
    const duration = decodeUint(durationRaw)
    if (duration == null || duration <= 0n) continue
    const seconds = Number(duration)
    const dec = slot.asset.decimals
    out.set(slot.asset.assetId, {
      outbound: evmFuse(outParams, outCap, dec, dec, seconds),
      inbound: evmFuse(inParams, inCap, dec, dec, seconds),
    })
  }
  return out
}

// ─────────────────────── supply burned at the dead address ───────────────────────

// Where a gap-closing mint is sent. No key exists for it, so the tokens are out
// of circulation permanently: `Tokens.TotalIssuance` and `totalSupply()` both
// still count them, but they can never be bridged back and need no custody
// behind them.
//
// "Burned at the dead address" is always said in full. The feature already uses
// "burn" for an OUTBOUND bridge transfer's burn (Tokens.Withdrawn, flows.burnedOut),
// which does have custody behind it — the opposite conclusion.
const DEAD_ADDRESS = '000000000000000000000000000000000000dead'
// keccak256("balanceOf(address)")[:4]
const ERC20_BALANCE_OF = '0x70a08231'
// Hydration's per-asset ERC-20 precompile (0x…0001 + asset id), the same one
// erc20WalletService reads: `balanceOf` works for any currency without knowing a
// backing contract, and it resolves an H160 to its widened account id itself.
const erc20Precompile = (assetId: number): string => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')

/**
 * Per asset, the supply burned at the dead address, read AT THE PINNED BLOCK —
 * the same consistency domain as issuance, because it is subtracted from it.
 * Reading it at the head while issuance is pinned would reintroduce exactly the
 * skew the pin removes.
 *
 * Throws when the pinned batch cannot be read, so the cycle fails and the
 * previous snapshot keeps serving. An unread dEaD balance treated as zero would
 * silently restate every token burned there as an unbacked one.
 */
async function readBurnedAtDead(assets: readonly DiscoveredAsset[], atBlock: number): Promise<Map<number, bigint>> {
  const out = new Map<number, bigint>()
  if (!assets.length) return out
  const calls: EvmCall[] = assets.map(asset => ({
    to: erc20Precompile(asset.assetId),
    data: ERC20_BALANCE_OF + '0'.repeat(24) + DEAD_ADDRESS,
  }))
  const results = await hydrationEthCallBatch(calls, '0x' + atBlock.toString(16))
  // A transport failure nulls the whole array, so an all-null answer is the
  // signature of a failed read rather than of assets with nothing burned there.
  if (results.every(value => value == null)) {
    throw new Error(`wormhole snapshot: dead-address balance read at the indexed head ${atBlock} returned nothing`)
  }
  assets.forEach((asset, i) => {
    const value = decodeUint(results[i])
    if (value != null) out.set(asset.assetId, value)
  })
  return out
}

// ─────────────────────── origin rate-limiter queue ───────────────────────

// An origin NttManager rate-limits INBOUND value over a rolling window. A
// transfer past the limit is redeemed — the peer has accepted the message and
// Wormholescan calls the operation completed — but its tokens stay in custody
// until the queue entry is released, so without this term the amount reads as
// unexplained backing surplus.
//
// Both covered families answer from state the sending chain already determined:
// the message digest. EVM keys its queue map by it directly; Solana's manager
// program stores one InboxItem account per redeemed message, enumerated by the
// account type's Anchor discriminator so no address derivation is involved.
// Sui is NOT covered — its state object exposes an inbox size but no per-entry
// release state — so Sui-origin queued transfers still degrade to surplus.

// The outbound digests an EVM origin still has to answer for. An execution is
// permanent, so a digest already confirmed executed is never asked about again
// and a steady-state cycle carries none of these at all.
function pendingOutboundDigests(
  sends: readonly NttSendRow[], targets: readonly OriginTarget[], chainId: number, cutoffMs: number,
): PendingDigest[] {
  const assetIds = new Set(targets.map(t => t.asset.assetId))
  const out: PendingDigest[] = []
  const seen = new Set<string>()
  for (const send of sends) {
    if (send.toChain !== chainId || send.assetId == null || !assetIds.has(send.assetId)) continue
    if (send.digest === '' || send.timestampMs < cutoffMs) continue
    if (executedDigests.has(send.digest) || seen.has(send.digest)) continue
    seen.add(send.digest)
    out.push({ assetId: send.assetId, digest: send.digest })
  }
  return out
}

// The sends whose digests are worth asking about: everything inside the
// lookback window plus anything already known queued, minus everything already
// seen settled.
function queueCandidates(sends: readonly NttSendRow[], assetId: number, chainId: number, cutoffMs: number): NttSendRow[] {
  return sends.filter(s =>
    s.assetId === assetId && s.toChain === chainId && s.digest !== '' && !settledDigests.has(s.digest)
    && (s.timestampMs >= cutoffMs || knownQueuedDigests.has(s.digest)))
}

const queuedEntryFromSend = (
  send: NttSendRow,
  ctx: { chainId: number; hydrationChainId: number },
  amount: bigint,
  recipient: string | null,
  queuedAtSec: number | null,
  releasableAtSec: number | null,
): QueuedEntry => ({
  digest: send.digest,
  assetId: send.assetId as number,
  chainId: ctx.chainId,
  amount,
  recipient,
  queuedAtSec,
  releasableAtSec,
  sendKey: vaaKey(ctx.hydrationChainId, send.emitter, send.sequence),
})

// One batched JSON-RPC array per EVM origin chain: getInboundQueuedTransfer for
// every candidate digest, plus rateLimitDuration() for any manager whose value
// is not memoized. An asset the batch did not answer for is left out of the
// result, so the caller keeps its previous reading rather than reading zero.
async function readEvmQueued(
  url: string,
  targets: readonly OriginTarget[],
  sends: readonly NttSendRow[],
  ctx: { chainId: number; hydrationChainId: number },
  cutoffMs: number,
): Promise<Map<number, QueuedEntry[]>> {
  const out = new Map<number, QueuedEntry[]>()
  interface Slot { target: OriginTarget; send: NttSendRow; id: number }
  const slots: Slot[] = []
  const durationIds = new Map<number, number>()
  const calls: { jsonrpc: '2.0'; id: number; method: 'eth_call'; params: unknown[] }[] = []
  const answered = new Set<number>()

  for (const target of targets) {
    const manager = displayChainAddress('evm', target.peer)
    const memo = rateLimitDurations.get(target.asset.assetId)
    if (!memo || Date.now() - memo.at >= STATIC_FACTS_TTL_MS) {
      const id = calls.length
      calls.push({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: manager, data: EVM_SELECTOR.rateLimitDuration }, 'latest'] })
      durationIds.set(target.asset.assetId, id)
    }
    for (const send of queueCandidates(sends, target.asset.assetId, ctx.chainId, cutoffMs)) {
      const id = calls.length
      calls.push({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: manager, data: encodeGetInboundQueuedTransfer(send.digest) }, 'latest'] })
      slots.push({ target, send, id })
    }
    // A target with no candidate digests still counts as read: its queue is
    // empty because nothing it ever sent is unresolved.
    answered.add(target.asset.assetId)
  }

  const byId = new Map<number, string | null>()
  for (let start = 0; start < calls.length; start += QUEUE_CALL_BATCH) {
    const chunk = calls.slice(start, start + QUEUE_CALL_BATCH)
    const json = await postJson(url, chunk, ORIGIN_RPC_TIMEOUT_MS)
    if (!Array.isArray(json)) {
      // A dropped chunk is unknown, not empty: every asset it covered loses its
      // fresh reading and keeps the previous one.
      for (const call of chunk) {
        const slot = slots.find(s => s.id === call.id)
        if (slot) answered.delete(slot.target.asset.assetId)
      }
      continue
    }
    for (const item of json) {
      const entry = item as { id?: unknown; result?: unknown }
      if (!Number.isInteger(entry?.id)) continue
      byId.set(entry.id as number, typeof entry.result === 'string' ? entry.result : null)
    }
  }

  for (const [assetId, id] of durationIds) {
    const seconds = decodeUint(byId.get(id))
    if (seconds != null) rateLimitDurations.set(assetId, { seconds, at: Date.now() })
  }

  for (const assetId of answered) out.set(assetId, [])
  for (const slot of slots) {
    if (!answered.has(slot.target.asset.assetId)) continue
    const queued = decodeInboundQueuedTransfer(byId.get(slot.id))
    if (queued == null) { answered.delete(slot.target.asset.assetId); out.delete(slot.target.asset.assetId); continue }
    if (queued.amount === 0n) {
      settledDigests.add(slot.send.digest)
      knownQueuedDigests.delete(slot.send.digest)
      continue
    }
    knownQueuedDigests.add(slot.send.digest)
    const duration = rateLimitDurations.get(slot.target.asset.assetId)?.seconds ?? null
    const releasableAtSec = duration != null ? queued.txTimestampSec + Number(duration) : null
    out.get(slot.target.asset.assetId)?.push(queuedEntryFromSend(
      slot.send,
      ctx,
      deTrim(queued.amount, queued.trimmedDecimals, slot.target.asset.decimals),
      queued.recipient,
      queued.txTimestampSec,
      releasableAtSec,
    ))
  }
  return out
}

// Solana holds one InboxItem account per redeemed inbound message. The accounts
// are enumerated by the account type's discriminator and fixed size, so nothing
// here derives an address or depends on an IDL. An item is attributed back to
// the send that produced it by recipient and amount — the manager registers
// exactly one peer, Hydration, so every item is one of our sends; an item no
// indexed send matches is left out, which under-reports the queue and therefore
// only widens a surplus.
async function readSolanaQueued(
  url: string,
  targets: readonly OriginTarget[],
  sends: readonly NttSendRow[],
  ctx: { chainId: number; hydrationChainId: number },
): Promise<{ queued: Map<number, QueuedEntry[]>; executed: Set<string> | null }> {
  const out = new Map<number, QueuedEntry[]>()
  // An InboxItem exists only for a message the program has accepted, so the set
  // of matched items IS this chain's redemption record — read in the same pass
  // as its custody, which is what keeps the two from disagreeing.
  const executed = new Set<string>()
  let answered = false
  const discriminator = base58Encode(hexToBytes(SOLANA_NTT_INBOX_ITEM_DISCRIMINATOR))
  for (const target of targets) {
    const programId = displayChainAddress('solana', target.peer)
    const accounts = await postJson(url, {
      jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
      params: [programId, { encoding: 'base64', filters: [{ dataSize: SOLANA_NTT_INBOX_ITEM_LENGTH }, { memcmp: { offset: 0, bytes: discriminator } }] }],
    }, ORIGIN_RPC_TIMEOUT_MS) as { result?: { account?: { data?: unknown } }[] } | null
    if (!Array.isArray(accounts?.result)) continue
    answered = true

    // Sends are matched oldest first so repeated (recipient, amount) pairs pair
    // up in order rather than all colliding on the same send.
    const candidates = sends
      .filter(s => s.assetId === target.asset.assetId && s.toChain === ctx.chainId && s.digest !== '')
      .sort((a, b) => a.timestampMs - b.timestampMs)
    const claimed = new Set<string>()
    const entries: QueuedEntry[] = []
    for (const account of accounts.result) {
      const encoded = (account?.account?.data as unknown[] | undefined)?.[0]
      if (typeof encoded !== 'string') continue
      const item = parseSolanaInboxItem(Buffer.from(encoded, 'base64'))
      if (!item) continue
      const send = candidates.find(s =>
        !claimed.has(s.digest)
        && displayChainAddress('solana', s.recipient) === item.recipient
        // The item carries the amount at the ORIGIN mint's precision.
        && deTrim(s.trimmedAmount, s.trimmedDecimals, target.peerDecimals ?? s.trimmedDecimals) === item.amount)
      if (!send || send.amount == null) continue
      claimed.add(send.digest)
      executed.add(send.digest)
      if (item.status === SOLANA_RELEASE_STATUS.released) continue
      entries.push(queuedEntryFromSend(send, ctx, send.amount, item.recipient, null, item.releaseAfterSec))
    }
    // Solana enumerates the whole inbox every cycle rather than probing digest
    // by digest, so it neither reads nor fills the settled-digest cache.
    out.set(target.asset.assetId, entries)
  }
  return { queued: out, executed: answered ? executed : null }
}

const chainName = (chainId: number): string => {
  const urn = WORMHOLE_CHAIN_URNS[chainId]
  return (urn ? ocnChainName(urn) : null) ?? `Wormhole chain ${chainId}`
}

// ───────────────────────────── Wormholescan ─────────────────────────────

async function scanGet(path: string): Promise<unknown | null> {
  if (!SCAN_URL) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SCAN_TIMEOUT_MS)
  try {
    const res = await fetch(`${SCAN_URL.replace(/\/$/, '')}${path}`, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) return null
    return await res.json() as unknown
  } catch { return null } finally { clearTimeout(timer) }
}

const scanOperations = (json: unknown): unknown[] => {
  const body = json as { operations?: unknown; data?: unknown } | null
  if (Array.isArray(body?.operations)) return body.operations
  if (Array.isArray(body?.data)) return body.data
  return []
}

// Candidate operations for both directions. The recency sweep covers everything
// current; the per-emitter VAA listings exist because the sweep is capped at a
// few pages and an inbound transfer that never redeemed would otherwise fall off
// the end and stop being counted.
async function loadScanOperations(hydrationChainId: number, redeemedInbound: ReadonlySet<string>): Promise<{ ops: NormalizedScanOp[]; ok: boolean }> {
  if (!SCAN_URL) return { ops: [], ok: false }
  const raw: unknown[] = []
  let ok = false
  for (let page = 0; page < SCAN_SWEEP_PAGES; page++) {
    const json = await scanGet(`/api/v1/operations?includesChain=${hydrationChainId}&pageSize=${SCAN_SWEEP_PAGE_SIZE}&page=${page}`)
    if (json == null) break
    ok = true
    const list = scanOperations(json)
    raw.push(...list)
    if (list.length < SCAN_SWEEP_PAGE_SIZE) break
  }
  const ops = normalizeScanOperations(raw)

  for (const op of ops) {
    if (op.emitterChain === hydrationChainId || !op.emitterChain || !op.emitterAddress) continue
    originEmitters.set(`${op.emitterChain}:${op.emitterAddress}`, { chainId: op.emitterChain, address: op.emitterAddress })
  }

  let budget = SCAN_MAX_SINGLE_OP_FETCHES
  const known = new Set(ops.map(op => vaaKey(op.emitterChain, op.emitterAddress, op.sequence)))
  let listings = SCAN_MAX_EMITTER_LISTINGS
  for (const emitter of originEmitters.values()) {
    if (budget <= 0 || listings-- <= 0) break
    const json = await scanGet(`/api/v1/vaas/${emitter.chainId}/${emitter.address}?pageSize=20`)
    const list = scanOperations(json)
    for (const item of list) {
      if (budget <= 0) break
      const sequence = String((item as { sequence?: unknown })?.sequence ?? '')
      if (!sequence) continue
      const key = vaaKey(emitter.chainId, emitter.address, sequence)
      if (known.has(key) || redeemedInbound.has(key) || resolvedScanOps.has(key)) continue
      budget -= 1
      const single = await scanGet(`/api/v1/operations/${emitter.chainId}/${emitter.address}/${sequence}`)
      const extra = normalizeScanOperations(scanOperations(single).length ? scanOperations(single) : [single])
      for (const op of extra) {
        if (!known.has(vaaKey(op.emitterChain, op.emitterAddress, op.sequence))) { ops.push(op); known.add(vaaKey(op.emitterChain, op.emitterAddress, op.sequence)) }
      }
    }
  }

  for (const op of ops) if (op.redeemedByScan) resolvedScanOps.add(vaaKey(op.emitterChain, op.emitterAddress, op.sequence))
  return { ops, ok }
}

// ───────────────────────────── refresh ─────────────────────────────

/**
 * One reading of the bridge, over every discovered asset or over a named subset.
 *
 * The subset form is what the confirmation pass runs (see
 * `runWormholeBackingConfirmation`): the equation's every ingredient is per
 * asset, so restricting the asset list restricts every read the cycle makes —
 * the origin batches, the pinned issuance and dead-address reads, the redemption
 * and queue probes — with no separate code path that could grade a shortfall
 * differently from the cycle that first saw it.
 *
 * Returns the assets it actually read and a snapshot built from those reads
 * alone; `downgradeConfirmed` is left empty for the caller to grade.
 */
async function readBackingCycle(
  scope: ReadonlySet<number> | null,
): Promise<{ assets: DiscoveredAsset[]; next: WormholeSnapshot }> {
  if (!client) throw new Error('wormhole snapshot: ClickHouse client not initialised')
  const discovered = await discoverAssets()
  const minBlock = discovered.minBlock
  const assets = scope ? discovered.assets.filter(a => scope.has(a.assetId)) : discovered.assets

  // The block every side of the equation is stated at.
  //
  // Issuance comes from chain state and the redemption set from the indexed
  // logs, and indexing runs tens of seconds behind the chain. Read at the
  // chain's head, an inbound transfer is inside issuance before its
  // ReceivedMessage row exists — so it counts as minted supply AND as an
  // in-flight transfer, and the residual drops by its full amount until
  // indexing catches up. The mint and the log land in the SAME extrinsic, so
  // reading state at the indexed head makes the two atomically consistent and
  // the race structurally impossible.
  const indexedHead = await queryIndexedHead()
  if (indexedHead == null) throw new Error('wormhole snapshot: no indexed head to pin the reads to')

  // Static manager facts and the local pause flag, sequentially against the
  // Hydration RPC. A manager that could not be read keeps its previous facts.
  // These come first because a send's digest is taken over our own chain id.
  const facts = new Map<number, ManagerStaticFacts>()
  const pausedLocal = new Map<number, boolean>()
  for (const asset of assets) {
    const read = await readManagerFacts(asset)
    facts.set(asset.assetId, read)
    const paused = decodeBool(await hydrationEthCall(asset.manager, EVM_SELECTOR.isPaused))
    if (paused != null) pausedLocal.set(asset.assetId, paused)
  }

  const hydrationChainId = [...facts.values()].map(f => f.chainId).find(id => id != null && id > 0) ?? HYDRATION_WORMHOLE_CHAIN_ID
  const timeline = await loadNttTimeline(assets, minBlock, indexedHead, hydrationChainId)

  // Hydration's own rate-limiter legs, in one batched round trip. An asset the
  // batch did not answer for keeps its previous reading.
  const localFresh = await readLocalFuses(assets)
  const localFuses = new Map<number, FusePair>()
  for (const asset of assets) {
    const fresh = localFresh.get(asset.assetId)
    if (fresh) lastLocalFuses.set(asset.assetId, fresh)
    const pair = fresh ?? lastLocalFuses.get(asset.assetId)
    if (pair) localFuses.set(asset.assetId, pair)
  }

  // Issuance, read AT the indexed head rather than at the chain's. A pinned
  // read that fails fails the whole cycle — the previous snapshot keeps
  // serving — because falling back to the latest block would reintroduce
  // exactly the skew the pin exists to remove.
  const issuanceBlock = indexedHead
  const issuance = new Map<number, bigint>()
  // The supply burned at the dead address is subtracted from issuance, so it is
  // read at the SAME pinned block — a head-read here would put the two sides of
  // one subtraction in different chain states.
  const burnedAtDead = new Map<number, bigint>()
  if (assets.length) {
    const blockHash = await hydrationBlockHash(indexedHead)
    if (blockHash == null) throw new Error(`wormhole snapshot: no block hash for indexed head ${indexedHead}`)
    const storage = await substrateStorageBatch(assets.map(a => tokensTotalIssuanceKey(a.assetId)), blockHash)
    // A transport failure nulls a whole chunk, so an all-null answer is the
    // signature of a failed read rather than of assets without supply.
    if (storage.every(value => value == null)) throw new Error('wormhole snapshot: issuance read at the indexed head returned nothing')
    assets.forEach((asset, i) => {
      const value = decodeU128Le(storage[i])
      if (value != null) issuance.set(asset.assetId, value)
    })
    for (const [assetId, value] of await readBurnedAtDead(assets, indexedHead)) burnedAtDead.set(assetId, value)
  }

  // Origin custody, grouped by chain so one endpoint answers for all its
  // assets. An unconfigured or failing chain keeps whatever it last reported,
  // with its own timestamp, rather than being blanked.
  const byChain = new Map<number, OriginTarget[]>()
  for (const asset of assets) {
    const fact = facts.get(asset.assetId)
    if (!fact?.peer) continue
    const list = byChain.get(asset.originChainId) ?? []
    list.push({ asset, peer: fact.peer, peerDecimals: fact.peerDecimals })
    byChain.set(asset.originChainId, list)
  }
  const custody = new Map<number, CustodyRead>()
  const suiInbox = new Map<number, number>()
  const chains: WormholeChainState[] = []
  const queuedByAsset = new Map<number, bigint>()
  const queuedCount = new Map<number, number>()
  const queued: QueuedEntry[] = []
  const originFuses = new Map<number, FusePair>()
  const executedOutboundByChain = new Map<number, ReadonlySet<string>>()
  const queueCutoffMs = Date.now() - LOOKBACK_MS
  for (const [chainId, targets] of [...byChain.entries()].sort((a, b) => a[0] - b[0])) {
    const family = wormholeChainFamily(chainId)
    const url = ORIGIN_RPC_URLS.get(chainId)
    let read = new Map<number, CustodyRead>()
    let queueRead = new Map<number, QueuedEntry[]>()
    let fuseRead = new Map<number, FusePair>()
    let executed: Set<string> | null = null
    const queueCtx = { chainId, hydrationChainId }
    if (url) {
      if (family === 'solana') {
        read = await readSolanaCustody(url, targets)
        fuseRead = await readSolanaFuses(url, targets)
        const solana = await readSolanaQueued(url, targets, timeline.sends, queueCtx)
        queueRead = solana.queued
        executed = solana.executed
      } else if (family === 'sui') {
        const sui = await readSuiCustody(url, targets, hydrationChainId, timeline.sends)
        read = sui.custody
        fuseRead = sui.fuses
        executed = sui.executed
        for (const [assetId, size] of sui.inboxSize) suiInbox.set(assetId, size)
        // Sui exposes each inbox entry's release state but not its amount at
        // this precision, so a HELD entry is not subtracted as queued — it
        // keeps degrading to custody surplus, never to a shortfall.
      } else {
        const evm = await readEvmCustody(url, targets, hydrationChainId, pendingOutboundDigests(timeline.sends, targets, chainId, queueCutoffMs))
        read = evm.custody
        fuseRead = evm.fuses
        executed = evm.executed
        queueRead = await readEvmQueued(url, targets, timeline.sends, queueCtx, queueCutoffMs)
      }
    }
    if (executed) {
      for (const digest of executed) executedDigests.add(digest)
      // The persistent cache rides along: an execution is permanent, so a
      // digest confirmed on an earlier cycle stays resolved without being
      // asked about again.
      const merged = new Set(executed)
      for (const send of timeline.sends) {
        if (send.toChain === chainId && executedDigests.has(send.digest)) merged.add(send.digest)
      }
      executedOutboundByChain.set(chainId, merged)
    }
    for (const target of targets) {
      const fresh = fuseRead.get(target.asset.assetId)
      if (fresh) lastOriginFuses.set(target.asset.assetId, fresh)
      const pair = fresh ?? lastOriginFuses.get(target.asset.assetId)
      if (pair) originFuses.set(target.asset.assetId, pair)
    }
    for (const target of targets) {
      const fresh = queueRead.get(target.asset.assetId)
      if (fresh) lastQueued.set(target.asset.assetId, fresh)
      const entries = fresh ?? lastQueued.get(target.asset.assetId)
      if (!entries) continue
      queued.push(...entries)
      queuedByAsset.set(target.asset.assetId, entries.reduce((sum, e) => sum + e.amount, 0n))
      queuedCount.set(target.asset.assetId, entries.length)
    }
    let newest: number | null = null
    for (const target of targets) {
      const fresh = read.get(target.asset.assetId)
      const value = fresh ?? lastCustody.get(target.asset.assetId)
      if (fresh) lastCustody.set(target.asset.assetId, fresh)
      if (!value) continue
      custody.set(target.asset.assetId, value)
      newest = newest == null ? value.at : Math.max(newest, value.at)
    }
    chains.push({
      chainId,
      name: chainName(chainId),
      family,
      configured: url != null,
      ok: url != null && read.size === targets.length,
      asOf: newest != null ? new Date(newest).toISOString() : null,
    })
  }

  // In-flight transfers. Inbound redemption is decided by OUR own
  // ReceivedMessage rows — this chain is the authority on what it has redeemed
  // — and outbound redemption by the target chain's own manager, read in the
  // same pass as its custody; Wormholescan is only the fallback for a chain
  // that did not answer.
  const { ops, ok: scanOk } = await loadScanOperations(hydrationChainId, timeline.redeemedKeys)
  const assetByManager = new Map<string, ManagerFacts>()
  for (const asset of assets) {
    const fact = facts.get(asset.assetId)
    const entry: ManagerFacts = {
      assetId: asset.assetId,
      symbol: asset.symbol,
      decimals: asset.decimals,
      manager: asset.manager,
      originChainId: asset.originChainId,
      peerDecimals: fact?.peerDecimals ?? null,
    }
    assetByManager.set('0x' + asset.manager.replace(/^0x/, '').padStart(64, '0'), entry)
    if (fact?.peer) assetByManager.set('0x' + fact.peer.replace(/^0x/, '').padStart(64, '0'), entry)
  }

  const nowMs = Date.now()
  const outboundSends: OutboundSend[] = timeline.sends
    .filter((s): s is NttSendRow & { assetId: number; amount: bigint } => s.assetId != null && s.amount != null)
    .map(s => ({
      sequence: s.sequence,
      emitterAddress: s.emitter,
      toChain: s.toChain,
      assetId: s.assetId,
      amount: s.amount,
      sentAtMs: s.timestampMs,
      blockHeight: s.blockHeight,
      txRef: s.extrinsicIndex != null ? `${s.blockHeight}-${s.extrinsicIndex}` : null,
      digest: s.digest,
    }))

  // Wormholescan does not index redemptions on Sui, so a Sui-bound send can
  // never be resolved from it. The Sui state object's inbox counts what it has
  // redeemed; the shortfall against our own send count is what is still in
  // flight, and an unread inbox resolves to zero — under-counting in flight
  // only widens the surplus, while over-counting would raise a false deficit.
  const unresolvedOutboundByChain = new Map<number, number>()
  for (const chainId of new Set(outboundSends.map(s => s.toChain))) {
    if (wormholeChainFamily(chainId) !== 'sui') continue
    let pending = 0
    for (const asset of assets) {
      if (asset.originChainId !== chainId) continue
      const inbox = suiInbox.get(asset.assetId)
      if (inbox == null) continue
      const sent = outboundSends.filter(s => s.assetId === asset.assetId).length
      pending += Math.max(0, sent - inbox)
    }
    unresolvedOutboundByChain.set(chainId, pending)
  }

  const inflight = decideInflight(ops, {
    hydrationChainId,
    assetByManager,
    redeemedInbound: timeline.redeemedKeys,
    outboundSends,
    executedOutboundByChain,
    unresolvedOutboundByChain,
    queuedOutbound: new Set(queued.map(q => q.sendKey).filter((k): k is string => k != null)),
    nowMs,
    lookbackMs: LOOKBACK_MS,
  })

  const inflightIn = new Map<number, bigint>()
  const inflightOut = new Map<number, bigint>()
  const inflightCount = new Map<number, number>()
  for (const asset of assets) {
    inflightIn.set(asset.assetId, 0n)
    inflightOut.set(asset.assetId, 0n)
    inflightCount.set(asset.assetId, 0)
  }
  for (const op of inflight) {
    const assetId = op.assetId != null ? Number(op.assetId) : NaN
    if (!inflightCount.has(assetId)) continue
    inflightCount.set(assetId, (inflightCount.get(assetId) ?? 0) + 1)
    if (op.amount == null) continue
    const target = op.direction === 'in' ? inflightIn : inflightOut
    target.set(assetId, (target.get(assetId) ?? 0n) + BigInt(op.amount))
  }

  const next: WormholeSnapshot = {
    takenAt: Date.now(),
    hydrationChainId,
    assets,
    facts,
    pausedLocal,
    issuance,
    burnedAtDead,
    issuanceBlock,
    custody,
    chains,
    timeline,
    inflight,
    inflightIn,
    inflightOut,
    inflightCount,
    queued: [...queued].sort((a, b) => (b.queuedAtSec ?? b.releasableAtSec ?? 0) - (a.queuedAtSec ?? a.releasableAtSec ?? 0)),
    queuedByAsset,
    queuedCount,
    originFuses,
    localFuses,
    // Filled by the caller, once this cycle's own readings have been graded.
    downgradeConfirmed: new Map(),
    scan: { configured: Boolean(SCAN_URL), ok: scanOk, asOf: scanOk ? new Date().toISOString() : null },
  }
  return { assets, next }
}

/**
 * Whether a reading is one the classifier would call a shortfall, and whether it
 * could tell at all. An unverifiable reading (no scan, unconfigured origin) is
 * neither confirmation nor refutation and must move nothing.
 */
type Grade = 'negative' | 'clean' | 'inconclusive'
const gradeOf = (status: WormholeStatus): Grade => {
  if (status === 'deficit' || status === 'attention') return 'negative'
  if (status === 'ok' || status === 'surplus') return 'clean'
  return 'inconclusive'
}

// Publishing IS bumping the generation: responses are built from the snapshot,
// so a new one has to be servable immediately rather than after the response
// TTL, and the notification lane wakes on the same counter.
function publishSnapshot(next: WormholeSnapshot): void {
  snapshot = next
  wormholeSnapshotGeneration += 1
}

export async function refreshWormholeBacking(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const { assets, next } = await readBackingCycle(null)

    // Grade this cycle's readings on their own, then publish only the shortfalls
    // a SECOND, INDEPENDENT reading has confirmed. A reading is graded with
    // `downgradeConfirmed: true` so the streak counts what the classifier WOULD
    // have called a shortfall; the published rows read the streak back.
    //
    // The anti-transient guarantee is "two separate reads, seconds apart, agree"
    // — not "two full cycles". A first sighting therefore schedules ONE narrow
    // confirmation pass ~15s out over the flagged assets alone, and that pass is
    // what promotes the streak to `DOWNGRADE_CYCLES`. The indexing-lag artefact
    // this damping exists for resolves within a block or two, so 15s of
    // separation refutes it exactly as a full cycle did — at a fifth of the
    // latency and a fraction of the reads.
    const prices = await ensurePrices()
    const firstSightings: number[] = []
    for (const asset of assets) {
      const grade = gradeOf(assetBacking(next, asset, prices, true).status)
      const streak = grade === 'negative' ? (negativeStreak.get(asset.assetId) ?? 0) + 1 : 0
      negativeStreak.set(asset.assetId, streak)
      next.downgradeConfirmed.set(asset.assetId, streak >= DOWNGRADE_CYCLES)
      if (streak === 1) firstSightings.push(asset.assetId)
    }

    publishSnapshot(next)
    scheduleBackingConfirmation(firstSightings)
  })().finally(() => { refreshInFlight = null })
  return refreshInFlight
}

// How long after a first sighting the confirming read is taken. Long enough that
// it is a genuinely separate observation of the chain (several Hydration blocks,
// a fresh indexed head, a fresh origin batch), short enough that a real shortfall
// is published inside a minute and a half of appearing.
const CONFIRM_DELAY_MS = 15_000

let confirmTimer: ReturnType<typeof setTimeout> | null = null
let pendingConfirmation: ReadonlySet<number> | null = null

// At most one pass in flight; a cycle that flags more assets while one is armed
// widens the set rather than queueing a second pass.
function scheduleBackingConfirmation(assetIds: readonly number[]): void {
  if (!assetIds.length) return
  pendingConfirmation = new Set([...(pendingConfirmation ?? []), ...assetIds])
  if (confirmTimer) return
  confirmTimer = setTimeout(() => {
    confirmTimer = null
    void runWormholeBackingConfirmation()
  }, CONFIRM_DELAY_MS)
  // Never a reason to hold the process open for it.
  confirmTimer.unref?.()
}

/** Disarms a pending confirmation pass — shutdown, and test teardown. */
export function cancelWormholeBackingConfirmation(): void {
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = null
  pendingConfirmation = null
}

/**
 * The confirming read of a first-sighted shortfall, scoped to the assets that
 * flagged it. Exported so a test can run the pass without waiting out its delay.
 *
 * Every outcome other than "still short" leaves the row UNCONFIRMED, which is
 * the safe direction: a clean reading resets the streak (the next cycle starts
 * the two-reading rule over), and a failed or unverifiable one leaves it exactly
 * where it was rather than inventing either verdict.
 */
export async function runWormholeBackingConfirmation(): Promise<void> {
  const scope = pendingConfirmation
  pendingConfirmation = null
  if (!scope?.size) return
  // Single-flight with the main cycle: a refresh already in progress is reading
  // the same ingredients, and its own grading covers these assets.
  if (refreshInFlight || !snapshot) return
  const generationAtStart = wormholeSnapshotGeneration
  try {
    const { assets, next } = await readBackingCycle(scope)
    const prices = await ensurePrices()
    const confirmed = new Set<number>()
    for (const asset of assets) {
      const grade = gradeOf(assetBacking(next, asset, prices, true).status)
      if (grade === 'inconclusive') continue
      if (grade === 'clean') { negativeStreak.set(asset.assetId, 0); continue }
      negativeStreak.set(asset.assetId, DOWNGRADE_CYCLES)
      confirmed.add(asset.assetId)
    }
    if (!confirmed.size) return
    // A full cycle that published while this pass was reading has already graded
    // these assets from newer readings; merging behind it would move the snapshot
    // backwards.
    if (wormholeSnapshotGeneration !== generationAtStart || !snapshot) return
    publishSnapshot(mergeConfirmation(snapshot, next, assets, confirmed))
  } catch (err) {
    // An unconfirmed shortfall keeps serving as `ok` until the next cycle looks
    // again — a monitor that could not read must not publish a verdict.
    console.error('[wormhole] backing confirmation pass failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * The confirming pass's readings, laid over the published snapshot for the
 * assets it actually re-read.
 *
 * Only the per-asset ingredients move. The chain rows keep describing the last
 * FULL read of each chain — this pass asked about a few assets on it, which is
 * not the same statement — and `takenAt` stays the full cycle's for the same
 * reason: the rest of the snapshot really is that old.
 */
function mergeConfirmation(
  base: WormholeSnapshot,
  fresh: WormholeSnapshot,
  assets: readonly DiscoveredAsset[],
  confirmed: ReadonlySet<number>,
): WormholeSnapshot {
  const ids = new Set(assets.map(a => a.assetId))
  const overlay = <V>(from: Map<number, V>, onto: Map<number, V>): Map<number, V> => {
    const out = new Map(onto)
    for (const id of ids) {
      const value = from.get(id)
      if (value !== undefined) out.set(id, value)
    }
    return out
  }
  const downgradeConfirmed = new Map(base.downgradeConfirmed)
  for (const id of confirmed) downgradeConfirmed.set(id, true)
  return {
    ...base,
    facts: overlay(fresh.facts, base.facts),
    pausedLocal: overlay(fresh.pausedLocal, base.pausedLocal),
    issuance: overlay(fresh.issuance, base.issuance),
    burnedAtDead: overlay(fresh.burnedAtDead, base.burnedAtDead),
    // Unread anywhere; kept as the newest head a read in this snapshot was
    // pinned to.
    issuanceBlock: fresh.issuanceBlock ?? base.issuanceBlock,
    custody: overlay(fresh.custody, base.custody),
    // Fresh contributes only the ops it could attribute to a scoped asset: the
    // scoped pass's manager map holds nothing else, so every other op comes
    // back from it as an unattributed (null-asset) row that would double the
    // rows base already carries for them.
    inflight: [
      ...base.inflight.filter(op => op.assetId == null || !ids.has(Number(op.assetId))),
      ...fresh.inflight.filter(op => op.assetId != null && ids.has(Number(op.assetId))),
    ],
    inflightIn: overlay(fresh.inflightIn, base.inflightIn),
    inflightOut: overlay(fresh.inflightOut, base.inflightOut),
    inflightCount: overlay(fresh.inflightCount, base.inflightCount),
    queued: [...base.queued.filter(q => !ids.has(q.assetId)), ...fresh.queued],
    queuedByAsset: overlay(fresh.queuedByAsset, base.queuedByAsset),
    queuedCount: overlay(fresh.queuedCount, base.queuedCount),
    originFuses: overlay(fresh.originFuses, base.originFuses),
    localFuses: overlay(fresh.localFuses, base.localFuses),
    downgradeConfirmed,
    // The scoped pass reached Wormholescan too; a successful read is the newer
    // and strictly better statement, a failed one says nothing about the whole.
    scan: fresh.scan.ok ? fresh.scan : base.scan,
  }
}

// ───────────────────────────── request-time build ─────────────────────────────

interface HeadRow { block_height: number; block_timestamp: string }
interface TokenEventRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  block_timestamp: string
  event_name: string
  currency_id: number
  who: string
  from_account: string
  to_account: string
  amount: string
}

async function queryHead(): Promise<HeadRow | null> {
  const res = await client.query({
    query: `SELECT max(block_height) AS block_height, max(block_timestamp) AS block_timestamp FROM price_data.raw_blocks`,
    format: 'JSONEachRow',
  })
  return (await res.json<HeadRow>())[0] ?? null
}

// The token movements inside the extrinsics the NTT logs identified. An outbound
// send burns from the manager's ETH\0 account (Tokens.Withdrawn) after a transfer
// into it names the sender; an inbound redemption mints straight to the recipient
// (Tokens.Deposited) with no marker of its own.
async function queryTokenLegs(pairs: readonly string[]): Promise<TokenEventRow[]> {
  if (!pairs.length) return []
  const tuples = pairs.map(pair => {
    const at = pair.indexOf(':')
    return `(${Number(pair.slice(0, at))},${Number(pair.slice(at + 1))})`
  }).join(',')
  const res = await client.query({
    query: `SELECT block_height, event_index, extrinsic_index, block_timestamp, event_name,
                   toUInt32(JSONExtractInt(args_json, 'currencyId')) AS currency_id,
                   lower(JSONExtractString(args_json, 'who')) AS who,
                   lower(JSONExtractString(args_json, 'from')) AS from_account,
                   lower(JSONExtractString(args_json, 'to')) AS to_account,
                   JSONExtractString(args_json, 'amount') AS amount
            FROM price_data.raw_events
            WHERE (block_height, extrinsic_index) IN (${tuples})
              AND event_name IN ('Tokens.Withdrawn', 'Tokens.Deposited', 'Tokens.Transfer')
            ORDER BY block_height, event_index
            LIMIT 1 BY block_height, event_index`,
    format: 'JSONEachRow',
  })
  return res.json<TokenEventRow>()
}

export async function getWormholeBridgeDetail(): Promise<WormholeBridgeDetail> {
  return cachedSwr('explorer:security-wormhole', 20_000, 120_000, buildWormholeBridgeDetail, wormholeSnapshotGeneration)
}

const usdOf = (prices: Map<number, PriceInfo>, assetId: number, raw: bigint | null, decimals: number): number | null =>
  raw == null ? null : usdValue(prices, assetId, raw.toString(), decimals)

const addUsd = (total: number | null, value: number | null): number | null => (value == null ? total : (total ?? 0) + value)

// One asset's whole backing verdict, in ONE place. The response rows and the
// notification lane both read it, so a subscriber can never be told a number the
// page they are sent to disagrees with.
interface AssetBacking {
  locked: bigint | null
  /** GROSS supply, as the chain reports it. */
  issuance: bigint | null
  /** The part of it burned at the dead address, which the equation subtracts. */
  burned: bigint | null
  inflightIn: bigint | null
  inflightOut: bigint | null
  queued: bigint | null
  originConfigured: boolean
  scanEnabled: boolean
  status: WormholeStatus
  statusDetail: string
  residual: bigint | null
  residualUsd: number | null
}

function assetBacking(
  snap: WormholeSnapshot, asset: DiscoveredAsset, prices: Map<number, PriceInfo>,
  // Override for the refresh pass, which grades a cycle's own reading before the
  // streak it feeds has been counted.
  gradeUndamped = false,
): AssetBacking {
  const custody = snap.custody.get(asset.assetId) ?? null
  const originConfigured = snap.chains.find(c => c.chainId === asset.originChainId)?.configured ?? false
  // Custody is read at the ORIGIN token's precision; the parity equation is
  // stated at the Hydration asset's.
  const locked = custody?.locked != null
    ? rescaleAmount(custody.locked, custody.decimals ?? asset.decimals, asset.decimals)
    : null
  const issuance = snap.issuance.get(asset.assetId) ?? null
  const burned = snap.burnedAtDead.get(asset.assetId) ?? null
  const scanEnabled = snap.scan.configured && snap.scan.ok
  const inflightIn = scanEnabled ? snap.inflightIn.get(asset.assetId) ?? 0n : null
  const inflightOut = scanEnabled ? snap.inflightOut.get(asset.assetId) ?? 0n : null
  const queued = snap.queuedByAsset.get(asset.assetId) ?? null
  const verdict = classifyBacking({
    locked, issuance, burned, inflightIn, inflightOut, queued,
    decimals: asset.decimals,
    symbol: asset.symbol,
    priceUsd: prices.get(asset.assetId)?.price ?? null,
    originConfigured,
    scanEnabled,
    lookbackDays: LOOKBACK_DAYS,
    downgradeConfirmed: gradeUndamped || (snap.downgradeConfirmed.get(asset.assetId) ?? false),
  })
  return {
    locked, issuance, burned, inflightIn, inflightOut, queued, originConfigured, scanEnabled,
    status: verdict.status,
    statusDetail: verdict.detail,
    residual: verdict.residual,
    residualUsd: usdOf(prices, asset.assetId, verdict.residual, asset.decimals),
  }
}

// The Hydration-centric fuse block for one asset, or null where the origin's
// limiters went unread — showing only the local (uncapped) legs would suggest a
// headroom nothing measured.
function assetLimits(snap: WormholeSnapshot, assetId: number): WormholeAssetLimits | null {
  const origin = snap.originFuses.get(assetId)
  if (!origin) return null
  const local = snap.localFuses.get(assetId) ?? null
  return {
    in: origin.outbound,
    out: origin.inbound,
    localOut: local?.outbound ?? null,
    localIn: local?.inbound ?? null,
  }
}

async function buildWormholeBridgeDetail(): Promise<WormholeBridgeDetail> {
  const snap = snapshot
  const [head, prices] = await Promise.all([queryHead(), ensurePrices()])
  const empty: WormholeBridgeDetail = {
    assets: [],
    inflight: [],
    queued: [],
    recent: [],
    totals: { lockedUsd: null, issuanceUsd: null, inflightUsd: null, deficitUsd: null, surplusUsd: null },
    chains: [],
    scan: { configured: Boolean(SCAN_URL), ok: false, asOf: null },
    hydrationChainId: HYDRATION_WORMHOLE_CHAIN_ID,
    asOf: null,
    indexedThrough: head ? { block: head.block_height, at: head.block_timestamp } : null,
  }
  if (!snap) return empty

  const pairs = new Set<string>()
  for (const send of snap.timeline.sends) if (send.extrinsicIndex != null) pairs.add(`${send.blockHeight}:${send.extrinsicIndex}`)
  for (const receive of snap.timeline.receives) if (receive.extrinsicIndex != null) pairs.add(`${receive.blockHeight}:${receive.extrinsicIndex}`)
  const legs = await queryTokenLegs([...pairs])

  const legsByExtrinsic = new Map<string, TokenEventRow[]>()
  for (const leg of legs) {
    const key = `${leg.block_height}:${leg.extrinsic_index}`
    const list = legsByExtrinsic.get(key) ?? []
    list.push(leg)
    legsByExtrinsic.set(key, list)
  }

  const assetById = new Map(snap.assets.map(a => [a.assetId, a]))
  const assetByManager = new Map(snap.assets.map(a => [a.manager, a]))
  const nowMs = Date.now()
  const windowStart = nowMs - LOOKBACK_MS

  const mintedIn = new Map<number, bigint>()
  const burnedOut = new Map<number, bigint>()
  const transfers14d = new Map<number, { out: number; in: number }>()
  for (const asset of snap.assets) {
    mintedIn.set(asset.assetId, 0n)
    burnedOut.set(asset.assetId, 0n)
    transfers14d.set(asset.assetId, { out: 0, in: 0 })
  }
  const rows: WormholeTransferRow[] = []

  for (const send of snap.timeline.sends) {
    const asset = send.assetId != null ? assetById.get(send.assetId) : assetByManager.get(send.manager)
    if (!asset || send.extrinsicIndex == null) continue
    const extrinsicLegs = legsByExtrinsic.get(`${send.blockHeight}:${send.extrinsicIndex}`) ?? []
    // The burn from the manager's own ETH\0 account is the exact sent amount.
    const burn = extrinsicLegs.find(l => l.event_name === 'Tokens.Withdrawn' && l.currency_id === asset.assetId && l.who === asset.minterAccount)
    const amount = burn ? BigInt(burn.amount) : send.amount
    if (amount == null) continue
    burnedOut.set(asset.assetId, (burnedOut.get(asset.assetId) ?? 0n) + amount)
    // The leg that funded the burn names the sender: a plain transfer of the
    // asset INTO the manager's ETH\0 account, which is why an NTT send reads as
    // an ordinary transfer in the activity feed.
    const sender = extrinsicLegs.find(l => l.event_name === 'Tokens.Transfer' && l.currency_id === asset.assetId && l.to_account === asset.minterAccount)?.from_account || null
    if (send.timestampMs >= windowStart) transfers14d.get(asset.assetId)!.out += 1
    rows.push({
      direction: 'out',
      assetId: String(asset.assetId),
      symbol: asset.symbol,
      amount: amount.toString(),
      amountUsd: usdOf(prices, asset.assetId, amount, asset.decimals),
      account: sender,
      accountRef: sender ? accountRef(sender) : null,
      counterpartyChainId: send.toChain,
      blockHeight: send.blockHeight,
      eventIndex: send.eventIndex,
      extrinsicIndex: send.extrinsicIndex,
      timestamp: new Date(send.timestampMs).toISOString(),
      sequence: send.sequence,
    })
  }

  for (const receive of snap.timeline.receives) {
    const asset = receive.managers.map(m => assetByManager.get(m)).find(a => a != null) ?? null
    if (!asset || receive.extrinsicIndex == null) continue
    const extrinsicLegs = legsByExtrinsic.get(`${receive.blockHeight}:${receive.extrinsicIndex}`) ?? []
    const candidates: DepositCandidate[] = extrinsicLegs
      .filter(l => l.event_name === 'Tokens.Deposited')
      .map(l => ({ eventIndex: l.event_index, assetId: l.currency_id, who: l.who, amount: BigInt(l.amount || '0') }))
    const trimmed = trimmedDecimalsFor(asset.decimals, snap.facts.get(asset.assetId)?.peerDecimals ?? null)
    const mint = matchInboundDeposit(candidates, asset.assetId, asset.decimals, trimmed)
    if (!mint) continue
    mintedIn.set(asset.assetId, (mintedIn.get(asset.assetId) ?? 0n) + mint.amount)
    if (receive.timestampMs >= windowStart) transfers14d.get(asset.assetId)!.in += 1
    rows.push({
      direction: 'in',
      assetId: String(asset.assetId),
      symbol: asset.symbol,
      amount: mint.amount.toString(),
      amountUsd: usdOf(prices, asset.assetId, mint.amount, asset.decimals),
      account: mint.who || null,
      accountRef: mint.who ? accountRef(mint.who) : null,
      counterpartyChainId: receive.emitterChainId,
      blockHeight: receive.blockHeight,
      eventIndex: receive.eventIndex,
      extrinsicIndex: receive.extrinsicIndex,
      timestamp: new Date(receive.timestampMs).toISOString(),
      sequence: receive.sequence,
    })
  }

  rows.sort((a, b) => b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex)

  let lockedUsd: number | null = null
  let issuanceUsd: number | null = null
  let deficitUsd: number | null = null
  let surplusUsd: number | null = null
  const assetRows: WormholeAssetRow[] = snap.assets.map(asset => {
    const fact = snap.facts.get(asset.assetId) ?? null
    const custody = snap.custody.get(asset.assetId) ?? null
    const family = wormholeChainFamily(asset.originChainId)
    const backing = assetBacking(snap, asset, prices)
    const minted = mintedIn.get(asset.assetId) ?? 0n
    // Supply burned by an OUTBOUND bridge transfer — not the dead-address term
    // (`backing.burned`), which is what the parity equation subtracts.
    const burnedOutOf = burnedOut.get(asset.assetId) ?? 0n
    const { issuance, locked, residualUsd } = backing
    lockedUsd = addUsd(lockedUsd, usdOf(prices, asset.assetId, locked, asset.decimals))
    issuanceUsd = addUsd(issuanceUsd, usdOf(prices, asset.assetId, issuance, asset.decimals))
    if (residualUsd != null && (backing.status === 'deficit' || backing.status === 'attention')) deficitUsd = (deficitUsd ?? 0) + Math.abs(residualUsd)
    if (residualUsd != null && backing.status === 'surplus') surplusUsd = (surplusUsd ?? 0) + residualUsd
    return {
      assetId: String(asset.assetId),
      symbol: asset.symbol,
      decimals: asset.decimals,
      originChainId: asset.originChainId,
      originChainName: chainName(asset.originChainId),
      originToken: displayChainAddress(family, asset.originToken),
      manager: asset.manager,
      mode: fact?.mode == null ? null : fact.mode === 1 ? 'burning' : 'locking',
      pausedLocal: snap.pausedLocal.get(asset.assetId) ?? null,
      pausedOrigin: custody?.paused ?? null,
      peer: fact?.peer ? displayChainAddress(family, fact.peer) : null,
      limits: assetLimits(snap, asset.assetId),
      issuance: issuance?.toString() ?? null,
      burned: backing.burned?.toString() ?? null,
      locked: locked?.toString() ?? null,
      inflightIn: backing.inflightIn?.toString() ?? null,
      inflightOut: backing.inflightOut?.toString() ?? null,
      inflightCount: backing.scanEnabled ? snap.inflightCount.get(asset.assetId) ?? 0 : null,
      queued: backing.queued?.toString() ?? null,
      queuedCount: backing.queued != null ? snap.queuedCount.get(asset.assetId) ?? 0 : null,
      residual: backing.residual?.toString() ?? null,
      flows: {
        mintedIn: minted.toString(),
        burnedOut: burnedOutOf.toString(),
        // The part of supply NTT flows do not explain — the pre-NTT remainder.
        // It should hold still; drift means another path is minting the asset.
        //
        // GROSS issuance on purpose. Supply burned at the dead address arrives as
        // an ordinary NTT inbound redemption that simply names 0x…dEaD as its
        // recipient (verified on chain: SUI's 10 tokens are the mint in
        // 13,405,928-2, alongside that extrinsic's ReceivedMessage and
        // TransferRedeemed), so `mintedIn` already counts it. Netting it out of
        // issuance while it stays inside `mintedIn` would drop nonNtt by the same
        // amount and read as a supply path disappearing.
        nonNtt: issuance != null ? (issuance - minted + burnedOutOf).toString() : null,
      },
      issuanceUsd: usdOf(prices, asset.assetId, issuance, asset.decimals),
      lockedUsd: usdOf(prices, asset.assetId, locked, asset.decimals),
      residualUsd,
      status: backing.status,
      statusDetail: backing.statusDetail,
      transfers14d: transfers14d.get(asset.assetId) ?? { out: 0, in: 0 },
    }
  })

  assetRows.sort((a, b) => {
    if (a.issuanceUsd == null && b.issuanceUsd == null) return a.symbol.localeCompare(b.symbol)
    if (a.issuanceUsd == null) return 1
    if (b.issuanceUsd == null) return -1
    return b.issuanceUsd - a.issuanceUsd
  })

  // $0 is a measurement, not a default: with no valued residual anywhere (every
  // chain unconfigured, or every asset unpriced) the deficit/surplus totals are
  // unknown, and `worstStatus` carries the story instead.
  const measuredAny = assetRows.some(r => r.residualUsd != null)

  let inflightUsd: number | null = snap.scan.configured ? 0 : null
  const inflight = snap.inflight.map(op => {
    const assetId = op.assetId != null ? Number(op.assetId) : null
    const asset = assetId != null ? assetById.get(assetId) : null
    const amountUsd = asset && op.amount != null ? usdValue(prices, asset.assetId, op.amount, asset.decimals) : null
    if (amountUsd != null) inflightUsd = (inflightUsd ?? 0) + amountUsd
    return { ...op, amountUsd }
  })

  const nowSec = Math.floor(nowMs / 1000)
  const queued: WormholeQueuedRelease[] = snap.queued.flatMap(entry => {
    const asset = assetById.get(entry.assetId)
    if (!asset) return []
    return [{
      digest: entry.digest,
      assetId: String(entry.assetId),
      symbol: asset.symbol,
      amount: entry.amount.toString(),
      amountUsd: usdOf(prices, asset.assetId, entry.amount, asset.decimals),
      chainId: entry.chainId,
      recipient: entry.recipient,
      queuedAt: entry.queuedAtSec != null ? new Date(entry.queuedAtSec * 1000).toISOString() : null,
      releasableAt: entry.releasableAtSec != null ? new Date(entry.releasableAtSec * 1000).toISOString() : null,
      // An unknown release time is reported as not yet releasable rather than
      // as an invitation to call a release that may revert.
      releasable: entry.releasableAtSec != null && nowSec >= entry.releasableAtSec,
    }]
  })

  return {
    assets: assetRows,
    inflight,
    queued,
    recent: rows.slice(0, RECENT_TRANSFER_LIMIT),
    totals: {
      lockedUsd, issuanceUsd, inflightUsd,
      deficitUsd: measuredAny ? deficitUsd ?? 0 : null,
      surplusUsd: measuredAny ? surplusUsd ?? 0 : null,
    },
    chains: snap.chains,
    scan: snap.scan,
    hydrationChainId: snap.hydrationChainId,
    asOf: new Date(snap.takenAt).toISOString(),
    indexedThrough: head ? { block: head.block_height, at: head.block_timestamp } : null,
  }
}

// The additive block the Security dashboard carries. Null until the first
// snapshot lands, so the dashboard degrades to its previous shape rather than
// claiming a backing state nothing has measured.
export async function getWormholeSummary(): Promise<WormholeSummary | null> {
  if (!snapshot) return null
  try {
    return summarizeWormhole(await getWormholeBridgeDetail())
  } catch (err) {
    console.error('[wormhole] summary unavailable:', err instanceof Error ? err.message : err)
    return null
  }
}

// ───────────────────── notification accessor ─────────────────────

/** One origin rate-limiter leg, reduced to what an alert has to say about it. */
export interface WormholeAlertFuse {
  /** How much of the window's allowance is spent, 0…100. */
  utilizationPct: number
  /** The limit at the asset's own precision, as a human number. */
  limit: number
  /** The window it refills over — read from the chain, not assumed to be 24h. */
  durationSec: number
}

/** One asset's alertable state, as the notification lane reads it. */
export interface WormholeAlertAsset {
  assetId: number
  symbol: string
  originChainName: string
  status: WormholeStatus
  /** Negative when supply exceeds backing; null when custody is unread. */
  residualUsd: number | null
  pausedLocal: boolean | null
  pausedOrigin: boolean | null
  /**
   * The ORIGIN chain's two fuses, Hydration-centric: `in` is the entry leg (the
   * origin manager's outbound limiter) and `out` the release leg of an exit (its
   * inbound limiter). Hydration's own legs are deliberately absent — they are
   * uncapped at the u64 trimmed ceiling, so a utilization read off them is
   * always ~0 and would only add noise; the origin side carries every real fuse.
   */
  fuses: { in: WormholeAlertFuse | null; out: WormholeAlertFuse | null }
}

/** One transfer the origin's rate limiter is holding, as the lane reads it. */
export interface WormholeAlertQueued {
  digest: string
  symbol: string
  /** Human amount at the asset's decimals; the message renders a rounded form. */
  amount: number
  chainName: string
  releasableAt: string | null
}

export interface WormholeAlertState {
  assets: WormholeAlertAsset[]
  queued: WormholeAlertQueued[]
  asOf: string
}

/**
 * The alertable slice of the in-memory snapshot — no ClickHouse, no chain call.
 * It is derived through `assetBacking`, the same function the response rows are
 * built from, so an alert and the page it links to state one verdict.
 *
 * Null until the first snapshot lands: a lane must never read "no deficit" from
 * a monitor that has not measured anything yet.
 */
export async function getWormholeAlertState(): Promise<WormholeAlertState | null> {
  const snap = snapshot
  if (!snap) return null
  const prices = await ensurePrices()
  const alertFuse = (fuse: WormholeFuse | null | undefined, decimals: number): WormholeAlertFuse | null =>
    (fuse ? { utilizationPct: fuse.utilizationPct, limit: Number(BigInt(fuse.limit)) / 10 ** decimals, durationSec: fuse.durationSec } : null)
  const assets = snap.assets.map(asset => {
    const backing = assetBacking(snap, asset, prices)
    // The same fuse block the page renders (`assetLimits`), so an alert and
    // /security/wormhole state one utilization rather than two.
    const limits = assetLimits(snap, asset.assetId)
    return {
      assetId: asset.assetId,
      symbol: asset.symbol,
      originChainName: chainName(asset.originChainId),
      status: backing.status,
      residualUsd: backing.residualUsd,
      pausedLocal: snap.pausedLocal.get(asset.assetId) ?? null,
      pausedOrigin: snap.custody.get(asset.assetId)?.paused ?? null,
      fuses: { in: alertFuse(limits?.in, asset.decimals), out: alertFuse(limits?.out, asset.decimals) },
    }
  })
  const bySymbol = new Map(snap.assets.map(a => [a.assetId, a]))
  const queued = snap.queued.flatMap(entry => {
    const asset = bySymbol.get(entry.assetId)
    if (!asset) return []
    return [{
      digest: entry.digest,
      symbol: asset.symbol,
      amount: Number(entry.amount) / 10 ** asset.decimals,
      chainName: chainName(entry.chainId),
      releasableAt: entry.releasableAtSec != null ? new Date(entry.releasableAtSec * 1000).toISOString() : null,
    }]
  })
  return { assets, queued, asOf: new Date(snap.takenAt).toISOString() }
}

export type { WormholeBridgeDetail, WormholeQueuedRelease, WormholeSummary }
