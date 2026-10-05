import type { ClickHouseClient } from '../db/client.ts'
import { SUBSTRATE_RPC_URL, substrateStorageBatch } from './substrateRpc.ts'
import { cachedSwr } from './cache.ts'
import { accountRef, ensurePrices, nttMinterAccounts, nttMinterH160, ocnChainName, WORMHOLE_CHAIN_URNS, type PriceInfo } from './explorerService.ts'
import { usdOfRaw } from './assetValue.ts'
import { assetIdFromPrecompile, erc20Precompile } from './chainPrimitives.ts'
import { setWormholeBridges, type WormholeAssetBridge, type WormholeBridgePeer } from './wormholeRemoteTokens.ts'
import { assetDescriptor } from './explorerAssets.ts'
import {
  base58Encode,
  buildFuse,
  buildPeerHistories,
  changeOriginFromEvents,
  classifyLegs,
  backingTolerance,
  lockboxPayout,
  messageForDigest,
  parsePeerEvent,
  peerEvidence,
  resolveOriginRpcUrls,
  transceiverMessagesIn,
  WORMHOLE_CHAINS,
  wormholeChainName,
  gradeBacking,
  advanceStreak,
  INDEX_STALE_AFTER_MS,
  decideInflight,
  decodeAbiString,
  decodeAddress,
  decodeBool,
  decodeGetPeer,
  decodeInboundQueuedTransfer,
  decodeRateLimitParams,
  decodeAggregate3,
  decodeU128Le,
  decodeUint,
  deTrim,
  displayChainAddress,
  encodeAggregate3,
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
  MULTICALL3_ADDRESS,
  normalizeScanOperations,
  nttDigest,
  parseLogMessagePublished,
  parseNttQueuedTransfer,
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
  wormholeExplorerUrl,
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
  type BackingLeg,
  type DepositCandidate,
  type PeerChange,
  type PeerEvidence,
  type PeerHistory,
  type WormholeLockboxRow,
  type WormholePeerLimits,
  type WormholePeerRow,
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
  type WormholeTokenRef,
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
// One endpoint per Wormhole chain: the chain table's public endpoints, with the
// deployment's WORMHOLE_ORIGIN_RPC_URLS map layered over them (see
// `WORMHOLE_CHAINS`). A peer on a chain absent from both is still listed, as
// unverified, never skipped.
const ORIGIN_RPC_URLS = resolveOriginRpcUrls(parseOriginRpcUrls(process.env.WORMHOLE_ORIGIN_RPC_URLS))

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
// Legs per aggregate3. One eth_call carries the whole pass at the sizes in play
// (a chain's assets × 7, plus a digest each for the unresolved transfers); the
// chunk exists so a surprising fan-out cannot build one call the node's gas cap
// refuses, which would read as the chain not answering at all.
const MULTICALL_BATCH = 80

// ───────────────────────────── snapshot ─────────────────────────────

interface DiscoveredAsset {
  assetId: number
  symbol: string
  decimals: number
  manager: string          // hydration manager h160, lowercase
  minterAccount: string    // the manager's widened ETH\0 account id
  /**
   * The PRIMARY origin: the registry `wh` location's chain where the asset has
   * one; otherwise derived from the manager's peers (`derivePrimaryOrigin`) —
   * Hydration itself for an asset Hydration locks, else its first lockbox.
   */
  originChainId: number
  originToken: string | null  // 32-byte hex as registered; null without a `wh` location
  /** The token Hydration's manager answers for: an ERC-20 precompile or an Erc20 asset's contract. */
  hydrationToken: string | null
}

interface ManagerPeer {
  chainId: number
  peer: string
  decimals: number | null
  /** How the live answer and the indexed PeerUpdated history agree. */
  evidence: PeerEvidence | null
}

interface ManagerStaticFacts {
  at: number
  token: string | null
  mode: number | null
  chainId: number | null
  /** The registry origin's peer, kept for the fields that name a single origin. */
  peer: string | null
  peerDecimals: number | null
  /**
   * EVERY chain this manager has registered a peer on, not just the registry
   * origin. A burning manager can be backed by more than one locking custody —
   * WETH is held on both Ethereum and Robinhood — and reading only the
   * registry origin understates backing by whatever the others hold.
   */
  peers: ManagerPeer[]
  /** The indexed registrations these peers were read against (`indexedPeerSignature`). */
  indexedPeers: string
}

interface CustodyRead {
  /**
   * In the PEER token's decimals. For a lockbox (the default) the custody its
   * manager holds; for a spoke (`role: 'spoke'`) the gross supply minted there.
   */
  locked: bigint | null
  decimals: number | null
  paused: boolean | null
  at: number
  /** What the reading is. Absent on readers that only ever see lockboxes. */
  role?: 'lockbox' | 'spoke'
  /** A spoke's supply at the dead address, in the same decimals. */
  burned?: bigint | null
  /**
   * Set on a reading carried over from an earlier cycle because the origin
   * chain did not answer this one. The figure is still the best available and
   * still shown; what it may not do is carry a shortfall to a verdict.
   */
  stale?: boolean
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

/**
 * One inbound transfer as Hydration's manager EXECUTED it — minted (or, for a
 * locking manager, released) on the spot, or queued by Hydration's own inbound
 * limiter. The amount is the payload's, read out of the call that delivered
 * the VAA and matched to the manager's own digest, so it is exact whatever the
 * manager's mode and whichever way the tokens move on this side.
 */
interface NttInboundExec {
  blockHeight: number
  extrinsicIndex: number | null
  eventIndex: number
  timestampMs: number
  manager: string
  assetId: number | null
  sourceChain: number
  digest: string
  /** At asset decimals; null when the payload could not be found in the call. */
  amount: bigint | null
  recipient: string | null
  /** InboundTransferQueued rather than TransferRedeemed: held by Hydration's limiter. */
  queued: boolean
}

interface NttLogTimeline {
  sends: NttSendRow[]
  receives: NttReceiveRow[]
  redeemedKeys: Set<string>
  /** Every inbound execution by a discovered manager, with its amount. */
  inbound: NttInboundExec[]
  /** Digests a manager has completed (TransferRedeemed), across all history. */
  redeemedDigests: Set<string>
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
  /** `out`: an exit held by the peer (`chainId` = peer). `in`: an arrival held by Hydration (`chainId` = Hydration). */
  direction: 'in' | 'out'
  /** Where the held transfer came from: Hydration for an exit, the source chain for an arrival. */
  fromChainId: number
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
  // How far `issuanceBlock` trailed wall clock when it was pinned; null when the
  // head could not be dated. Feeds the stale-index guard (INDEX_STALE_AFTER_MS).
  indexLagMs: number | null
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
  // Rate-limiter fuses, keyed `assetId:chainId` on both sides: each peer
  // manager's own pair, and Hydration's manager's outbound leg with its inbound
  // leg FOR THAT chain. The origin map is what decides whether a row carries
  // limits at all — showing only Hydration's legs would suggest a headroom
  // nothing measured on the far side.
  originFuses: Map<string, FusePair>
  localFuses: Map<string, FusePair>
  // ── per peer (keyed `assetId:chainId`) ──
  /** The peers each asset's Hydration manager has, as this cycle used them. */
  peers: Map<number, ManagerPeer[]>
  /** Each peer's reading — custody for a lockbox, supply for a spoke — fresh or carried over (`stale`). */
  peerReads: Map<string, CustodyRead>
  /** Each peer manager's deployment facts on its own chain (mode, token, other peers). */
  peerStatics: Map<string, PeerStatic>
  /** Held by a limiter, per (asset, chain): the peer's for an exit, Hydration's for an arrival. */
  queuedByPeer: Map<string, { peer: bigint; hydration: bigint; peerKnown: boolean }>
  /** Hydration's own custody for every asset its manager locks, at the pinned block. */
  hydrationLocked: Map<number, bigint>
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
// custody read, so one bad poll of one chain does not blank it. Custody is keyed
// `assetId:chainId` because an asset can be backed on more than one chain, and
// one chain's carried-over reading must not stand in for another's.
const staticFacts = new Map<number, ManagerStaticFacts>()
const lastCustody = new Map<string, CustodyRead>()
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
// so it rides the same hourly refresh as the other static facts. Keyed
// `assetId:chainId`: one asset's managers on two chains keep two windows, and
// keying by asset alone let the last chain read overwrite the others'.
const rateLimitDurations = new Map<string, { seconds: bigint; at: number }>()
// token() per origin manager: which ERC-20 it answers for, lowercased. A manager
// cannot change it without being redeployed, so it rides the same hourly refresh
// — and the check it feeds (a manager whose token disagrees with the registry is
// not answering for this asset) keeps being made on every cycle, from the memo.
// Keyed `assetId:chainId` — one asset's custody managers on different chains
// each lock their own local token.
const managerTokens = new Map<string, { address: string; at: number }>()
// The last queue read per (asset, chain), so one failed poll of one chain does
// not blank a queue the previous cycle measured — nor stand in for another
// chain's.
const lastQueued = new Map<string, QueuedEntry[]>()
// Same survival rule for the fuses: a chain that fails on one poll keeps the
// headroom it last reported rather than reading as an unlimited (or spent) one.
// Keyed `assetId:chainId` on both sides: Hydration's inbound limit is per
// source chain, and every peer manager has its own pair.
const lastOriginFuses = new Map<string, FusePair>()
const lastLocalFuses = new Map<string, FusePair>()
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
const suiPeersTable = new Map<string, string>()
// The Solana program's mint and mode per (asset, chain), and the Sui manager's
// mode — the non-EVM halves of a peer's identity, read with its custody.
const solanaMints = new Map<string, { mint: string; mode: number }>()
const suiModes = new Map<string, string | null>()
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

// Discovery re-derived the `wh` location map from raw_events on every cycle, and
// that read prunes on nothing: `event_name` is not in the sort key and the
// filter is a LIKE over args_json, so it scanned 18.8M rows — 88 times an hour —
// to rebuild a map that only moves when an asset is registered or relocated.
//
// It is made incremental on the property the aggregate already has: argMax over
// the union of two disjoint block ranges is argMax over the whole, so the part
// below a settled floor is kept and only newer blocks are re-read. The floor
// trails the head by the usual reorg margin, so anything a reorg could rewrite
// is in the re-read window.
const WH_LOCATION_REORG_MARGIN_BLOCKS = 600
let whLocationCache: { upTo: number; byAsset: Map<number, { args: string; block: number }> } | null = null
// A minimum over an append-only event: once non-zero it can never move, because
// a later NttMinterSet can only land at a HIGHER block.
let nttMinterMinBlock = 0

/** Discovery's incremental state. The registry is append-only on chain, so
 *  production never needs this; a test that shrinks its fake registry does. */
/** Every per-process memo of deployment facts (manager peers, peer statics). Tests only. */
export function resetWormholeStaticFactsForTests(): void {
  staticFacts.clear()
  peerStatics.clear()
  managerTokens.clear()
  rateLimitDurations.clear()
  lastCustody.clear()
  lastOriginFuses.clear()
  lastLocalFuses.clear()
  lastQueued.clear()
  negativeStreak.clear()
}

export function resetWormholeDiscoveryForTests(): void {
  whLocationCache = null
  nttMinterMinBlock = 0
  peerEventCache = null
  peerHistories = new Map()
  managerTokenMemo.clear()
  hydrationTokenMeta.clear()
  solanaLayouts.clear()
  solanaLayoutRejected.clear()
  solanaInboxCache.clear()
  solanaLastLocked.clear()
}

// ─────────────────────── peer registrations, from the index ───────────────────────

// Every PeerUpdated / SetWormholePeer log Hydration has written, read
// incrementally on the same reorg-margin rule as the `wh` locations: the part
// at or below the settled floor is kept, only newer blocks are re-read. The set
// is a few dozen rows ever; the first read of a process is the only full one.
const PEER_EVENT_REORG_MARGIN_BLOCKS = 600
let peerEventCache: { upTo: number; changes: PeerChange[] } | null = null
// TC proposal hash → motion index. A proposal's index never changes.
const motionIndexByHash = new Map<string, number>()
// The peer history the last discovery built: contract → chain → history.
let peerHistories = new Map<string, Map<number, PeerHistory>>()
// A non-minter manager's token(), memoized with the other static facts.
const managerTokenMemo = new Map<string, { token: string | null; at: number }>()
// Hydration-side token metadata for assets the price registry does not carry.
const hydrationTokenMeta = new Map<string, { symbol: string | null; name: string | null; decimals: number | null; at: number }>()
// Transceiver → the manager it serves (`nttManager()`), a deployment fact.
const transceiverManager = new Map<string, { manager: string | null; at: number }>()

interface PeerLogRow { block_height: number; event_index: number; extrinsic_index: number | null; block_timestamp: string; contract: string; topics: string[]; data: string }

async function loadPeerChanges(head: number | null): Promise<PeerChange[]> {
  const from = peerEventCache?.upTo ?? -1
  const res = await client.query({
    query: `SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS block_timestamp,
                   lower(contract_address) AS contract, topics, data
            FROM price_data.raw_evm_logs
            WHERE topic0 IN ('${TOPIC.peerUpdated}','${TOPIC.wormholePeerSet}')
              AND block_height > {from:Int64}
            ORDER BY block_height, event_index
            LIMIT 1 BY block_height, event_index`,
    query_params: { from }, format: 'JSONEachRow',
  })
  const rows = (await res.json<PeerLogRow>()) ?? []
  const parsed = rows.flatMap(row => {
    const event = parsePeerEvent(row.topics ?? [], row.data ?? '')
    return event ? [{ row, event }] : []
  })
  // Who made each change: the events of the extrinsic that carried it.
  const pairs = [...new Set(parsed.filter(p => p.row.extrinsic_index != null).map(p => `${p.row.block_height}:${p.row.extrinsic_index}`))]
  const eventsByPair = new Map<string, { eventName: string; args: unknown }[]>()
  if (pairs.length) {
    const tuples = pairs.map(pair => { const [b, x] = pair.split(':'); return `(${Number(b)},${Number(x)})` }).join(',')
    const evRes = await client.query({
      query: `SELECT block_height, extrinsic_index, event_name, args_json
              FROM price_data.raw_events
              WHERE (block_height, extrinsic_index) IN (${tuples})
                AND event_name IN ('TechnicalCommittee.Executed', 'Ethereum.Executed')
              LIMIT 1 BY block_height, event_index`,
      format: 'JSONEachRow',
    })
    for (const r of (await evRes.json<{ block_height: number; extrinsic_index: number; event_name: string; args_json: string }>()) ?? []) {
      const key = `${r.block_height}:${r.extrinsic_index}`
      let args: unknown = null
      try { args = JSON.parse(r.args_json) } catch { args = null }
      eventsByPair.set(key, [...(eventsByPair.get(key) ?? []), { eventName: r.event_name, args }])
    }
    const hashes = [...new Set([...eventsByPair.values()].flat()
      .filter(e => e.eventName === 'TechnicalCommittee.Executed')
      .map(e => String((e.args as { proposalHash?: unknown } | null)?.proposalHash ?? '').toLowerCase())
      .filter(h => /^0x[0-9a-f]{64}$/.test(h) && !motionIndexByHash.has(h)))]
    if (hashes.length) {
      const motionRes = await client.query({
        query: `SELECT lower(JSONExtractString(args_json, 'proposalHash')) AS hash,
                       toUInt32(JSONExtractInt(args_json, 'proposalIndex')) AS motion
                FROM price_data.raw_events
                WHERE event_name = 'TechnicalCommittee.Proposed'
                  AND lower(JSONExtractString(args_json, 'proposalHash')) IN (${sqlList(hashes)})`,
        format: 'JSONEachRow',
      })
      for (const r of (await motionRes.json<{ hash: string; motion: number }>()) ?? []) motionIndexByHash.set(r.hash, Number(r.motion))
    }
  }
  const fresh: PeerChange[] = parsed.map(({ row, event }) => ({
    contract: row.contract,
    blockHeight: Number(row.block_height),
    eventIndex: Number(row.event_index),
    extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
    timestampMs: parseChTimestamp(row.block_timestamp),
    event,
    origin: changeOriginFromEvents(
      row.extrinsic_index == null ? null : Number(row.extrinsic_index),
      eventsByPair.get(`${row.block_height}:${row.extrinsic_index}`) ?? [],
      motionIndexByHash,
    ),
  }))
  const all = [...(peerEventCache?.changes ?? []), ...fresh]
  const floor = head == null ? from : Math.max(from, head - PEER_EVENT_REORG_MARGIN_BLOCKS)
  peerEventCache = { upTo: floor, changes: all.filter(c => c.blockHeight <= floor) }
  return all
}

/** The token a manager answers for, memoized for the static-facts window. */
async function managerToken(manager: string): Promise<string | null> {
  const memo = managerTokenMemo.get(manager)
  if (memo && Date.now() - memo.at < STATIC_FACTS_TTL_MS) return memo.token
  const token = decodeAddress(await hydrationEthCall(manager, EVM_SELECTOR.token))?.toLowerCase() ?? null
  if (token != null || !memo) managerTokenMemo.set(manager, { token: token ?? memo?.token ?? null, at: Date.now() })
  return token ?? memo?.token ?? null
}

/** symbol()/name()/decimals() of a Hydration-side token, memoized. */
async function readHydrationTokenMeta(token: string): Promise<{ symbol: string | null; name: string | null; decimals: number | null }> {
  const memo = hydrationTokenMeta.get(token)
  if (memo && Date.now() - memo.at < STATIC_FACTS_TTL_MS) return memo
  const [symbolRaw, nameRaw, decimalsRaw] = await hydrationEthCallBatch([
    { to: token, data: EVM_SELECTOR.symbol },
    { to: token, data: EVM_SELECTOR.name },
    { to: token, data: EVM_SELECTOR.decimals },
  ])
  const decimals = decodeUint(decimalsRaw)
  const meta = { symbol: decodeAbiString(symbolRaw), name: decodeAbiString(nameRaw), decimals: decimals == null ? null : Number(decimals), at: Date.now() }
  hydrationTokenMeta.set(token, meta)
  return meta
}

/** The ETH\0-widened account a Hydration manager burns from (as NttMinterSet stores it). */
const widenManager = (h160: string): string => '0x45544800' + h160.replace(/^0x/, '').toLowerCase() + '0'.repeat(16)

async function discoverAssets(): Promise<{ assets: DiscoveredAsset[]; minBlock: number }> {
  const minters = await nttMinterAccounts()
  const from = whLocationCache?.upTo ?? -1
  const [locRes, headRow] = await Promise.all([
    client.query({
      query: `SELECT toUInt32(JSONExtractInt(args_json, 'assetId')) AS asset_id,
                     argMax(args_json, block_height) AS args,
                     max(block_height) AS block
              FROM price_data.raw_events
              WHERE event_name IN ('AssetRegistry.LocationSet', 'AssetRegistry.Registered')
                AND args_json LIKE '%"0x7768%'
                AND block_height > {from:Int64}
              GROUP BY asset_id`,
      query_params: { from }, format: 'JSONEachRow',
    }),
    queryIndexedHead(),
  ])
  const byAsset = new Map(whLocationCache?.byAsset ?? [])
  for (const r of await locRes.json<{ asset_id: number; args: string; block: number }>()) {
    const prev = byAsset.get(Number(r.asset_id))
    // Strictly newer wins, which is exactly what argMax over the whole range did.
    if (!prev || Number(r.block) >= prev.block) byAsset.set(Number(r.asset_id), { args: r.args, block: Number(r.block) })
  }
  // An unread head leaves the floor where it was: nothing new is settled, so
  // the next cycle simply re-reads the same window.
  const floor = headRow == null ? from : Math.max(from, headRow - WH_LOCATION_REORG_MARGIN_BLOCKS)
  // Only entries settled at or below the floor may be kept: one above it has to
  // be re-read, or a reorg that moved a location would never be seen again.
  whLocationCache = { upTo: floor, byAsset: new Map([...byAsset].filter(([, v]) => v.block <= floor)) }
  if (!nttMinterMinBlock && minters.size) {
    const minRes = await client.query({
      query: `SELECT min(block_height) AS min_block FROM price_data.raw_events WHERE event_name = 'EVMAccounts.NttMinterSet'`,
      format: 'JSONEachRow',
    })
    nttMinterMinBlock = Number((await minRes.json<{ min_block: number }>())[0]?.min_block ?? 0) || 0
  }

  // The manager set is the UNION of two on-chain statements: the runtime's
  // minter registry (EVMAccounts.NttMinterSet — every Hydration manager that
  // mints) and every contract that registered an NTT peer here (PeerUpdated —
  // which is also how a LOCKING manager, which never needs minting rights,
  // shows up: HDX and HOLLAR are locked on Hydration, not minted). A contract
  // whose token() is not a registry asset is not bridging one (the NTTUSD test
  // deployment), and where two managers claim one asset the minter registry's
  // wins — the other is a superseded deployment.
  const changes = await loadPeerChanges(headRow)
  peerHistories = buildPeerHistories(changes)
  const managerContracts = new Set(changes.filter(c => c.event.kind === 'manager').map(c => c.contract.toLowerCase()))
  const minterByAsset = new Map([...minters].map(([assetId, account]) => [assetId, nttMinterH160(account).toLowerCase()]))
  const minterManagers = new Set(minterByAsset.values())
  const managerByAsset = new Map<number, { manager: string; minterAccount: string; token: string | null; lastEvent: number }>()
  for (const [assetId, manager] of minterByAsset) {
    managerByAsset.set(assetId, { manager, minterAccount: minters.get(assetId)!, token: null, lastEvent: Number.MAX_SAFE_INTEGER })
  }
  const nonMinters = [...managerContracts].filter(m => !minterManagers.has(m)).sort()
  const tokenByManager = new Map<string, string | null>()
  for (const manager of nonMinters) tokenByManager.set(manager, await managerToken(manager))
  const erc20Tokens = [...tokenByManager.values()].filter((t): t is string => t != null && assetIdFromPrecompile(t) == null)
  const assetByErc20 = new Map<string, number>()
  if (erc20Tokens.length) {
    const res = await client.query({
      query: `SELECT asset_id, lower(evm_address) AS evm_address FROM price_data.assets FINAL WHERE lower(evm_address) IN (${sqlList(erc20Tokens)})`,
      format: 'JSONEachRow',
    })
    for (const r of (await res.json<{ asset_id: number; evm_address: string }>()) ?? []) {
      if (r.evm_address) assetByErc20.set(r.evm_address, Number(r.asset_id))
    }
  }
  for (const manager of nonMinters) {
    const token = tokenByManager.get(manager) ?? null
    if (token == null) continue
    const assetId = assetIdFromPrecompile(token) ?? assetByErc20.get(token) ?? null
    if (assetId == null) continue
    const lastEvent = Math.max(...[...(peerHistories.get(manager)?.values() ?? [])].map(h => h.changes.at(-1)?.blockHeight ?? 0), 0)
    const prev = managerByAsset.get(assetId)
    if (prev && prev.lastEvent >= lastEvent) continue
    managerByAsset.set(assetId, { manager, minterAccount: widenManager(manager), token, lastEvent })
  }
  if (!managerByAsset.size) return { assets: [], minBlock: 0 }

  const ids = [...managerByAsset.keys()]
  const metaRes = await client.query({
    query: `SELECT asset_id, symbol, decimals FROM price_data.assets FINAL WHERE asset_id IN (${ids.join(',') || '0'})`,
    format: 'JSONEachRow',
  })
  const meta = new Map((await metaRes.json<{ asset_id: number; symbol: string | null; decimals: number | null }>())
    .map(m => [Number(m.asset_id), m]))
  const assets: DiscoveredAsset[] = []
  let minBlock = nttMinterMinBlock
  for (const [assetId, entry] of [...managerByAsset].sort((a, b) => a[0] - b[0])) {
    const loc = byAsset.get(assetId)
    const location = loc ? parseWormholeLocation(loc.args) : null
    // A minter-registered asset was always required to carry a `wh` location;
    // that stays the rule, so a stray minter registration does not invent an
    // asset. A manager found through its peers needs none.
    if (minterManagers.has(entry.manager) && !location) continue
    const history = peerHistories.get(entry.manager)
    const firstEvent = Math.min(...[...(history?.values() ?? [])].map(h => h.first.blockHeight))
    if (Number.isFinite(firstEvent) && firstEvent > 0) minBlock = minBlock ? Math.min(minBlock, firstEvent) : firstEvent
    const hydrationToken = entry.token ?? erc20Precompile(assetId)
    let symbol = meta.get(assetId)?.symbol ?? null
    let decimals = meta.get(assetId)?.decimals ?? null
    if (symbol == null || decimals == null) {
      // Not in the price registry (yet): the token answers for itself.
      const own = await readHydrationTokenMeta(hydrationToken)
      symbol = symbol ?? own.symbol
      decimals = decimals ?? own.decimals
    }
    const fallback = assetDescriptor(assetId)
    // Provisional primary origin for an asset without a `wh` location: its
    // first registered peer. `derivePrimaryOrigin` settles it once the
    // manager's own mode has been read.
    const firstPeer = [...(history?.values() ?? [])].sort((a, b) => a.first.blockHeight - b.first.blockHeight)[0]?.chainId
    assets.push({
      assetId,
      symbol: symbol || fallback.symbol,
      decimals: decimals != null ? Number(decimals) : fallback.decimals,
      manager: entry.manager,
      minterAccount: entry.minterAccount,
      originChainId: location?.originChainId ?? firstPeer ?? HYDRATION_WORMHOLE_CHAIN_ID,
      originToken: location?.originToken ?? null,
      hydrationToken,
    })
  }
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

// The same head, with how far it trailed wall clock at the moment it was read.
// The backing cycle pins issuance to this block, so its age is how far the
// supply half of the equation lags the live custody half — the input to the
// stale-index guard in `classifyBacking`. Read in the same query as the height
// so the two describe one block.
async function queryIndexedHeadPin(): Promise<{ height: number; lagMs: number | null } | null> {
  const res = await client.query({
    query: `SELECT max(block_height) AS block_height, max(block_timestamp) AS block_timestamp FROM price_data.raw_blocks`,
    format: 'JSONEachRow',
  })
  const row = (await res.json<{ block_height: number; block_timestamp: string }>())[0]
  const height = Number(row?.block_height ?? 0)
  if (!Number.isSafeInteger(height) || height <= 0) return null
  const at = row?.block_timestamp ? parseChTimestamp(String(row.block_timestamp)) : 0
  return { height, lagMs: at > 0 ? Math.max(0, Date.now() - at) : null }
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
  const empty: NttLogTimeline = { sends: [], receives: [], redeemedKeys: new Set(), inbound: [], redeemedDigests: new Set() }
  if (!assets.length) return empty
  const managers = assets.map(a => a.manager)
  const assetByManager = new Map(assets.map(a => [a.manager, a]))
  const res = await client.query({
    query: `WITH xs AS (
              SELECT DISTINCT block_height, extrinsic_index
              FROM price_data.raw_evm_logs
              WHERE block_height >= ${Math.max(0, minBlock)} AND block_height <= ${Math.max(0, maxBlock)}
                AND lower(contract_address) IN (${sqlList(managers)})
                AND topic0 IN ('${TOPIC.transferSent}','${TOPIC.transferRedeemed}','${TOPIC.inboundTransferQueued}')
            )
            SELECT block_height, event_index, extrinsic_index, block_timestamp,
                   lower(contract_address) AS contract, topics, data
            FROM price_data.raw_evm_logs
            WHERE (block_height, extrinsic_index) IN (SELECT block_height, extrinsic_index FROM xs)
              AND block_height <= ${Math.max(0, maxBlock)}
              AND topic0 IN ('${TOPIC.logMessagePublished}','${TOPIC.receivedMessage}','${TOPIC.transferRedeemed}','${TOPIC.inboundTransferQueued}')
            ORDER BY block_height, event_index
            LIMIT 1 BY block_height, event_index`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<LogRow>()

  const redeemedManagersByExtrinsic = new Map<string, string[]>()
  // Per extrinsic, every inbound execution a discovered manager logged: the
  // NTT digest it completed or queued.
  const executionsByExtrinsic = new Map<string, { row: LogRow; digest: string; queued: boolean }[]>()
  const redeemedDigests = new Set<string>()
  for (const row of rows) {
    const topic = row.topics[0]?.toLowerCase()
    const key = `${row.block_height}:${row.extrinsic_index}`
    if (topic === TOPIC.transferRedeemed) {
      const list = redeemedManagersByExtrinsic.get(key) ?? []
      if (!list.includes(row.contract)) list.push(row.contract)
      redeemedManagersByExtrinsic.set(key, list)
    }
    if (!assetByManager.has(row.contract)) continue
    const digest = topic === TOPIC.transferRedeemed
      ? (row.topics[1] ?? '').toLowerCase()
      : topic === TOPIC.inboundTransferQueued ? parseNttQueuedTransfer(row.topics, row.data)?.digest?.toLowerCase() ?? '' : ''
    if (!/^0x[0-9a-f]{64}$/.test(digest)) continue
    if (topic === TOPIC.transferRedeemed) redeemedDigests.add(digest)
    executionsByExtrinsic.set(key, [...(executionsByExtrinsic.get(key) ?? []), { row, digest, queued: topic === TOPIC.inboundTransferQueued }])
  }

  const sends: NttSendRow[] = []
  const receives: NttReceiveRow[] = []
  const redeemedKeys = new Set<string>()
  const sourceChainsByExtrinsic = new Map<string, number[]>()
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
    const key = `${row.block_height}:${row.extrinsic_index}`
    sourceChainsByExtrinsic.set(key, [...new Set([...(sourceChainsByExtrinsic.get(key) ?? []), received.emitterChainId])])
    receives.push({
      blockHeight: row.block_height,
      eventIndex: row.event_index,
      extrinsicIndex: row.extrinsic_index,
      timestampMs,
      emitterChainId: received.emitterChainId,
      emitterAddress: received.emitterAddress,
      sequence: received.sequence.toString(),
      managers: redeemedManagersByExtrinsic.get(key) ?? [],
    })
  }

  // The amount of every inbound execution, from the payload in its own call.
  const inbound: NttInboundExec[] = []
  const callArgs = await callArgsFor([...executionsByExtrinsic.keys()], maxBlock)
  for (const [key, executions] of executionsByExtrinsic) {
    const messages = transceiverMessagesIn(callArgs.get(key) ?? '')
    const chains = sourceChainsByExtrinsic.get(key) ?? []
    for (const { row, digest, queued } of executions) {
      const asset = assetByManager.get(row.contract) ?? null
      // A completion of an earlier queued transfer carries no new message; it
      // is already counted at the queueing, so it is not a second arrival.
      if (!chains.length) continue
      let found: { message: ReturnType<typeof messageForDigest>; chain: number } | null = null
      for (const chain of chains) {
        const message = messageForDigest(messages, chain, digest)
        if (message) { found = { message, chain }; break }
      }
      inbound.push({
        blockHeight: row.block_height,
        extrinsicIndex: row.extrinsic_index,
        eventIndex: row.event_index,
        timestampMs: parseChTimestamp(row.block_timestamp),
        manager: row.contract,
        assetId: asset?.assetId ?? null,
        // With a single source chain in the extrinsic the chain is known even
        // when the payload is not; with several it needs the payload to say.
        sourceChain: found?.chain ?? (chains.length === 1 ? chains[0] : 0),
        digest,
        amount: found?.message && asset
          ? deTrim(found.message.transfer.trimmedAmount, found.message.transfer.trimmedDecimals, asset.decimals)
          : null,
        recipient: found?.message?.transfer.recipient ?? null,
        queued,
      })
    }
  }
  return { sends, receives, redeemedKeys, inbound, redeemedDigests }
}

// The call arguments of `block:extrinsic` pairs — where an inbound VAA's payload
// (and so its amount) lives. Immutable chain history, so pairs safely below the
// head are memoized for the life of the process; near-head pairs are re-read.
const CALL_ARGS_FINALITY_MARGIN_BLOCKS = 600
const callArgsMemo = new Map<string, string>()
async function callArgsFor(pairs: readonly string[], head: number): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const missing: string[] = []
  for (const key of pairs) {
    if (key.endsWith(':null')) continue
    const hit = callArgsMemo.get(key)
    if (hit !== undefined) out.set(key, hit)
    else missing.push(key)
  }
  for (let start = 0; start < missing.length; start += 2_000) {
    const chunk = missing.slice(start, start + 2_000)
    const tuples = chunk.map(key => { const [b, x] = key.split(':'); return `(${Number(b)},${Number(x)})` }).join(',')
    const res = await client.query({
      query: `SELECT block_height, extrinsic_index, call_args_json
              FROM price_data.raw_extrinsics
              WHERE (block_height, extrinsic_index) IN (${tuples})
              LIMIT 1 BY block_height, extrinsic_index`,
      format: 'JSONEachRow',
    })
    for (const r of (await res.json<{ block_height: number; extrinsic_index: number; call_args_json: string }>()) ?? []) {
      const key = `${r.block_height}:${r.extrinsic_index}`
      out.set(key, r.call_args_json ?? '')
      if (Number(r.block_height) <= head - CALL_ARGS_FINALITY_MARGIN_BLOCKS) callArgsMemo.set(key, r.call_args_json ?? '')
    }
  }
  return out
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

/**
 * The chains worth asking a manager whether it has a peer there.
 *
 * Every chain the manager's own PeerUpdated history names — the authoritative
 * statement of what it was ever pointed at — plus the asset's registry origin
 * and every chain this deployment has an endpoint for, so a peer whose event
 * the index somehow lacks still surfaces (as `live-only` evidence) rather than
 * vanishing. Asking about arbitrary ids beyond those would be an unbounded
 * sweep of Wormhole's number space.
 */
function peerCandidateChains(asset: DiscoveredAsset): number[] {
  const indexed = [...(peerHistories.get(asset.manager)?.keys() ?? [])]
  return [...new Set([asset.originChainId, ...indexed, ...ORIGIN_RPC_URLS.keys()])]
    .filter(c => c !== HYDRATION_WORMHOLE_CHAIN_ID)
    .sort((a, b) => a - b)
}

// The manager's registrations as the index states them this cycle. Discovery
// re-reads the peer events every cycle (the confirmation pass included), so a
// peer registered since the facts were cached changes this and forces a fresh
// read — a new lockbox's custody is counted from the cycle its event is indexed,
// not up to an hour later.
function indexedPeerSignature(manager: string): string {
  return [...(peerHistories.get(manager)?.values() ?? [])]
    .map(h => `${h.chainId}:${h.current?.event.peer ?? ''}`)
    .sort()
    .join(',')
}

async function readManagerFacts(asset: DiscoveredAsset): Promise<ManagerStaticFacts> {
  const cached = staticFacts.get(asset.assetId)
  const indexedPeers = indexedPeerSignature(asset.manager)
  if (cached && Date.now() - cached.at < STATIC_FACTS_TTL_MS && cached.peers.length && cached.indexedPeers === indexedPeers) return cached
  const candidates = peerCandidateChains(asset)
  const [tokenRaw, modeRaw, chainIdRaw, ...peerRaws] = [
    await hydrationEthCall(asset.manager, EVM_SELECTOR.token),
    await hydrationEthCall(asset.manager, EVM_SELECTOR.mode),
    await hydrationEthCall(asset.manager, EVM_SELECTOR.chainId),
    ...await Promise.all(candidates.map(c => hydrationEthCall(asset.manager, encodeGetPeer(c)))),
  ]
  const history = peerHistories.get(asset.manager)
  const peers: ManagerPeer[] = []
  candidates.forEach((chainId, i) => {
    const decoded = decodeGetPeer(peerRaws[i] ?? null)
    const indexed = history?.get(chainId)?.current ?? null
    const evidence = peerEvidence(indexed?.event.peer ?? null, decoded?.address ?? null)
    // The live answer is what is in force; an indexed peer the chain did not
    // confirm this cycle (it failed to answer) is still a peer — the index
    // never invents one — so it is carried, marked by its evidence.
    if (decoded?.address) peers.push({ chainId, peer: decoded.address, decimals: decoded.decimals, evidence })
    else if (indexed?.event.peer && peerRaws[i] == null) {
      peers.push({ chainId, peer: indexed.event.peer, decimals: indexed.event.decimals, evidence })
    }
  })
  const origin = peers.find(p => p.chainId === asset.originChainId)
  const mode = decodeUint(modeRaw)
  const chainId = decodeUint(chainIdRaw)
  const facts: ManagerStaticFacts = {
    at: Date.now(),
    token: decodeAddress(tokenRaw),
    mode: mode == null ? cached?.mode ?? null : Number(mode),
    chainId: chainId == null ? null : Number(chainId),
    peer: origin?.peer ?? cached?.peer ?? null,
    peerDecimals: origin?.decimals ?? cached?.peerDecimals ?? null,
    peers: peers.length ? peers : cached?.peers ?? [],
    indexedPeers,
  }
  if (facts.peers.length) staticFacts.set(asset.assetId, facts)
  return facts
}

/**
 * The primary origin of an asset with no registry `wh` location, once the
 * manager's mode is known: Hydration itself when Hydration LOCKS the token (its
 * native home — HDX, HOLLAR), otherwise the asset's first registered peer.
 * An asset with a `wh` location keeps the registry's answer.
 */
function derivePrimaryOrigin(asset: DiscoveredAsset, facts: ManagerStaticFacts | undefined, hydrationChainId: number): number {
  if (asset.originToken != null) return asset.originChainId
  if (facts?.mode === 0) return hydrationChainId
  return asset.originChainId
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

/**
 * A whole EVM pass as ONE `eth_call`: the legs go to Multicall3, which answers
 * them all at one block. The origin endpoints meter per METHOD, so a JSON-RPC
 * array of N reads costs N however few HTTP requests carry it — folding a pass
 * into one aggregate3 is the difference between ~56 billed calls a minute and 2.
 *
 * Failure semantics are exactly the per-call ones they replace: a leg that
 * reverted comes back null (never a zero, which a custody reader would take for
 * an emptied vault), and a chunk the chain did not answer leaves every leg it
 * carried unset, so the caller keeps its previous reading rather than
 * publishing a gap.
 */
async function postMulticall(url: string, calls: readonly EvmCall[]): Promise<Map<number, string | null>> {
  const byId = new Map<number, string | null>()
  for (let start = 0; start < calls.length; start += MULTICALL_BATCH) {
    const chunk = calls.slice(start, start + MULTICALL_BATCH)
    const json = await postJson(url, {
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: MULTICALL3_ADDRESS, data: encodeAggregate3(chunk) }, 'latest'],
    }, ORIGIN_RPC_TIMEOUT_MS) as { result?: unknown } | null
    const results = decodeAggregate3(typeof json?.result === 'string' ? json.result : null, chunk.length)
    if (!results) continue
    results.forEach((result, i) => byId.set(start + i, result))
  }
  return byId
}

interface OriginTarget {
  asset: DiscoveredAsset
  peer: string
  peerDecimals: number | null
  /** The chain this peer is on. Differs from `asset.originChainId` for a second custody. */
  chainId: number
  /**
   * The token whose balance is this peer's custody, when it is already known —
   * the registry's own origin token on the registry origin chain. Null on any
   * other chain: the registry names one token on one chain, so there the peer
   * manager's own `token()` is the only authority, and it is adopted rather than
   * checked against an address that describes a different chain.
   */
  expectedToken: string | null
}

interface PendingDigest { assetId: number; digest: string }

/**
 * Fold one chain's custody reading into the asset's running total.
 *
 * Custodies are stated in their own chain's token decimals, so each is rescaled
 * to the first one seen before it is added. A reading that is stale, paused or
 * of unknown scale carries that property to the total: a sum containing one
 * carried-over balance is itself carried over, and a paused custody anywhere is
 * a paused custody for the asset. A balance that cannot be rescaled is dropped
 * rather than added at the wrong magnitude — the total then reads low, which the
 * verdict treats as unverified, never as a confirmed shortfall.
 */
export function addCustody(prev: CustodyRead | undefined, next: CustodyRead, fallbackDecimals: number): CustodyRead {
  if (!prev) return next
  if (prev.locked == null || next.locked == null) {
    return { ...prev, locked: prev.locked ?? next.locked, stale: true, at: Math.max(prev.at, next.at) }
  }
  const scale = (value: bigint, from: number | null, to: number | null): bigint | null => {
    const f = from ?? fallbackDecimals, t = to ?? fallbackDecimals
    if (f === t) return value
    return t > f ? value * 10n ** BigInt(t - f) : value / 10n ** BigInt(f - t)
  }
  const added = scale(next.locked, next.decimals, prev.decimals)
  if (added == null) return { ...prev, stale: true }
  return {
    locked: prev.locked + added,
    decimals: prev.decimals,
    paused: prev.paused === true || next.paused === true ? true : prev.paused ?? next.paused,
    at: Math.max(prev.at, next.at),
    ...(prev.stale || next.stale ? { stale: true } : {}),
  }
}

interface EvmOriginRead {
  custody: Map<number, CustodyRead>
  fuses: Map<number, FusePair>
  // Digests this chain's manager reports it has consumed, or null when the read
  // did not answer — in which case redemption falls back to Wormholescan.
  executed: Set<string> | null
  /** Per asset: what this chain's manager is and holds, beyond the balance. */
  peers: Map<number, PeerStatic>
}

/**
 * A peer manager's deployment facts on its own chain: its mode, the token it
 * answers for and that token's identity, and which OTHER chains it has peers
 * on. A manager changes none of these without governance acting on it, so they
 * ride the hourly memo; a spoke's supply and a lockbox's balance are read every
 * cycle.
 */
interface PeerStatic {
  mode: number | null
  token: string | null
  name: string | null
  symbol: string | null
  decimals: number | null
  /** Other Wormhole chains (known to the chain table) the peer manager has a peer on. */
  alsoPeers: number[] | null
  at: number
}

// Keyed `assetId:chainId` — one asset's managers on different chains are
// different deployments.
const peerStatics = new Map<string, PeerStatic>()

/** Chains a peer manager is asked about for peers of its own, besides Hydration. */
const otherKnownChains = (self: number, hydrationChainId: number): number[] =>
  Object.keys(WORMHOLE_CHAINS).map(Number).filter(c => c !== self && c !== hydrationChainId)

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
// The peer's MODE decides what its balance means. A LOCKING peer is a lockbox:
// its custody is `token.balanceOf(manager)`. A BURNING peer is a spoke: the
// supply minted there is `token.totalSupply()`, less what sits at the dead
// address. Both are read on every pass; the mode picks one.
//
// A manager whose own `token()` disagrees with the registry is not answering for
// the asset we are checking, so its custody is treated as unread.
async function readEvmCustody(
  url: string, targets: readonly OriginTarget[], hydrationChainId: number, pending: readonly PendingDigest[],
): Promise<EvmOriginRead> {
  const out: EvmOriginRead = { custody: new Map(), fuses: new Map(), executed: null, peers: new Map() }
  const calls: EvmCall[] = []
  interface CustodySlot {
    target: OriginTarget
    /** Token-bound reads; -1 until the token is known. */
    balance: number
    supply: number
    dead: number
    paused: number
    // A manager's token(), mode, peers and its rate-limit window are deployment
    // facts, so they are asked for only when their hourly memo has run out; on
    // every other cycle the slot carries no id and the memo answers.
    token: number | null
    mode: number | null
    meta: number | null
    alsoPeers: { chainId: number; id: number }[] | null
    fuse: number
    duration: number | null
  }
  const index = new Map<number, CustodySlot>()
  const push = (call: EvmCall): number => calls.push(call) - 1
  const byAsset = new Map(targets.map(t => [t.asset.assetId, t]))
  const now = Date.now()
  const memoLive = (memo: { at: number } | undefined): boolean => !!memo && now - memo.at < STATIC_FACTS_TTL_MS
  const tokenReads = (token: string, manager: string) => ({
    balance: push({ to: token, data: encodeBalanceOf(manager) }),
    supply: push({ to: token, data: EVM_SELECTOR.totalSupply }),
    dead: push({ to: token, data: encodeBalanceOf(DEAD_ADDRESS) }),
  })
  for (const target of targets) {
    const assetId = target.asset.assetId
    const memoKey = `${assetId}:${target.chainId}`
    const managerAddress = displayChainAddress('evm', target.peer)
    const memo = peerStatics.get(memoKey)
    const live = memoLive(memo)
    // Which token holds this peer's custody. On the registry origin the registry
    // says so; on any other chain only the peer manager does, so until its
    // `token()` has been read there is no address to ask for a balance and the
    // balance call is deferred to the follow-up pass below.
    const tokenAddress = target.expectedToken != null
      ? displayChainAddress('evm', target.expectedToken)
      : managerTokens.get(memoKey)?.address ?? null
    const reads = tokenAddress == null ? { balance: -1, supply: -1, dead: -1 } : tokenReads(tokenAddress, managerAddress)
    const paused = push({ to: managerAddress, data: EVM_SELECTOR.isPaused })
    const token = tokenAddress != null && memoLive(managerTokens.get(memoKey))
      ? null
      : push({ to: managerAddress, data: EVM_SELECTOR.token })
    const mode = live ? null : push({ to: managerAddress, data: EVM_SELECTOR.mode })
    const meta = live || tokenAddress == null ? null : push({ to: tokenAddress, data: EVM_SELECTOR.name })
    if (meta != null) { push({ to: tokenAddress!, data: EVM_SELECTOR.symbol }); push({ to: tokenAddress!, data: EVM_SELECTOR.decimals }) }
    const alsoPeers = live ? null : otherKnownChains(target.chainId, hydrationChainId).map(chainId => ({
      chainId, id: push({ to: managerAddress, data: encodeGetPeer(chainId) }),
    }))
    const fuse = calls.length
    for (const call of fuseCalls(managerAddress, hydrationChainId)) push(call)
    const duration = memoLive(rateLimitDurations.get(memoKey))
      ? null
      : push({ to: managerAddress, data: EVM_SELECTOR.rateLimitDuration })
    index.set(assetId, { target, ...reads, paused, token, mode, meta, alsoPeers, fuse, duration })
  }
  const executedIds = new Map<string, number>()
  for (const item of pending) {
    const target = byAsset.get(item.assetId)
    if (!target || executedIds.has(item.digest)) continue
    executedIds.set(item.digest, push({ to: displayChainAddress('evm', target.peer), data: encodeIsMessageExecuted(item.digest) }))
  }
  if (!calls.length) return out

  const byId = await postMulticall(url, calls)
  if (!byId.size) return out

  const at = Date.now()
  const deferred: { assetId: number; slot: CustodySlot; token: string }[] = []
  const settle = (assetId: number, slot: CustodySlot, values: { balance: string | null | undefined; supply: string | null | undefined; dead: string | null | undefined }, peer: PeerStatic) => {
    // BURNING (1) makes this chain a spoke; anything else — LOCKING (0), or a
    // mode that could not be read — is read as custody, the way every peer was
    // read before modes were asked for.
    const spoke = peer.mode === 1
    const amount = decodeUint(spoke ? values.supply : values.balance)
    if (amount == null) return
    const burned = spoke ? decodeUint(values.dead) : null
    out.custody.set(assetId, {
      locked: amount,
      decimals: slot.target.peerDecimals ?? peer.decimals,
      paused: decodeBool(byId.get(slot.paused)),
      at,
      role: spoke ? 'spoke' : 'lockbox',
      burned: spoke ? burned : null,
    })
  }
  for (const [assetId, slot] of index) {
    const memoKey = `${assetId}:${slot.target.chainId}`
    // Fresh when this cycle asked, otherwise the memo's — a manager only ever
    // changes the token it answers for by being redeployed.
    const reported = slot.token == null
      ? managerTokens.get(memoKey)?.address ?? null
      : decodeAddress(byId.get(slot.token))?.toLowerCase() ?? null
    // Only the registry origin has an address to check against. Elsewhere the
    // registry describes a different chain's token, so comparing to it would
    // reject every second custody; the peer manager Hydration itself points at
    // is the authority for what it locks.
    if (slot.target.expectedToken != null) {
      const registered = displayChainAddress('evm', slot.target.expectedToken).toLowerCase()
      if (reported != null && reported !== registered) continue
    }
    if (slot.token != null && reported != null) managerTokens.set(memoKey, { address: reported, at })
    const prevStatic = peerStatics.get(memoKey)
    const modeRead = slot.mode == null ? prevStatic?.mode ?? null : decodeUint(byId.get(slot.mode))
    const decimalsRead = slot.meta == null ? prevStatic?.decimals ?? null : decodeUint(byId.get(slot.meta + 2))
    const peer: PeerStatic = {
      mode: modeRead == null ? prevStatic?.mode ?? null : Number(modeRead),
      token: reported ?? prevStatic?.token ?? null,
      name: slot.meta == null ? prevStatic?.name ?? null : decodeAbiString(byId.get(slot.meta)) ?? prevStatic?.name ?? null,
      symbol: slot.meta == null ? prevStatic?.symbol ?? null : decodeAbiString(byId.get(slot.meta + 1)) ?? prevStatic?.symbol ?? null,
      decimals: decimalsRead == null ? prevStatic?.decimals ?? null : Number(decimalsRead),
      alsoPeers: slot.alsoPeers == null
        ? prevStatic?.alsoPeers ?? null
        : slot.alsoPeers.every(p => byId.has(p.id))
          ? slot.alsoPeers.filter(p => decodeGetPeer(byId.get(p.id) ?? null) != null).map(p => p.chainId)
          : prevStatic?.alsoPeers ?? null,
      // A pass that asked nothing static keeps the memo's age, so it expires on
      // schedule; one that asked restarts it — but only once the mode answered.
      at: slot.mode == null ? prevStatic?.at ?? at : byId.has(slot.mode) ? at : 0,
    }
    peerStatics.set(memoKey, peer)
    out.peers.set(assetId, peer)
    // A peer whose token was unknown when the batch was built has no balance in
    // it; now that its manager has named the token, ask in the follow-up pass so
    // a newly discovered custody counts from its first cycle rather than reading
    // as zero until the next one.
    if (slot.balance < 0) {
      if (reported != null) deferred.push({ assetId, slot, token: reported })
    } else {
      settle(assetId, slot, { balance: byId.get(slot.balance), supply: byId.get(slot.supply), dead: byId.get(slot.dead) }, peer)
    }
    // The window rides this pass only when its memo has expired; the queue pass
    // reads the same memo rather than asking a second time.
    const duration = slot.duration == null
      ? rateLimitDurations.get(memoKey)?.seconds ?? null
      : decodeUint(byId.get(slot.duration))
    if (duration == null || duration <= 0n) continue
    rateLimitDurations.set(memoKey, { seconds: duration, at: slot.duration == null ? rateLimitDurations.get(memoKey)!.at : at })
    const tokenDecimals = slot.target.peerDecimals ?? peer.decimals ?? slot.target.asset.decimals
    out.fuses.set(assetId, {
      outbound: evmFuse(byId.get(slot.fuse) ?? null, byId.get(slot.fuse + 1) ?? null, tokenDecimals, slot.target.asset.decimals, Number(duration)),
      inbound: evmFuse(byId.get(slot.fuse + 2) ?? null, byId.get(slot.fuse + 3) ?? null, tokenDecimals, slot.target.asset.decimals, Number(duration)),
    })
  }

  // The balances (and token identity) that could not be asked for until their
  // token was named.
  if (deferred.length) {
    const followCalls: EvmCall[] = []
    const slots = deferred.map(d => {
      const manager = displayChainAddress('evm', d.slot.target.peer)
      const base = followCalls.length
      followCalls.push(
        { to: d.token, data: encodeBalanceOf(manager) },
        { to: d.token, data: EVM_SELECTOR.totalSupply },
        { to: d.token, data: encodeBalanceOf(DEAD_ADDRESS) },
        { to: d.token, data: EVM_SELECTOR.name },
        { to: d.token, data: EVM_SELECTOR.symbol },
        { to: d.token, data: EVM_SELECTOR.decimals },
      )
      return { ...d, base }
    })
    const followUp = await postMulticall(url, followCalls)
    for (const d of slots) {
      const memoKey = `${d.assetId}:${d.slot.target.chainId}`
      const peer = peerStatics.get(memoKey)!
      const decimals = decodeUint(followUp.get(d.base + 5))
      const named: PeerStatic = {
        ...peer,
        name: decodeAbiString(followUp.get(d.base + 3)) ?? peer.name,
        symbol: decodeAbiString(followUp.get(d.base + 4)) ?? peer.symbol,
        decimals: decimals == null ? peer.decimals : Number(decimals),
      }
      peerStatics.set(memoKey, named)
      out.peers.set(d.assetId, named)
      settle(d.assetId, d.slot, { balance: followUp.get(d.base), supply: followUp.get(d.base + 1), dead: followUp.get(d.base + 2) }, named)
    }
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

// ───── Solana: discover once an hour, read every cycle in one call ─────
//
// Every account the backing check needs is found by its Anchor discriminator
// (no PDA derivation, so a program upgrade cannot break the lookup) — and that
// lookup is `getProgramAccounts`, a scan of the whole program and the dearest
// call an RPC provider meters. None of the addresses it finds ever move: a
// manager has one config account and one rate-limit account per direction. So
// they are discovered on the static-facts clock, and each cycle reads all of
// them, for every Solana asset at once, in ONE `getMultipleAccounts` — the config
// (paused flag), the mint (decimals; a spoke's supply), the custody token account
// and both limiters. Run every minute for three assets, the per-cycle scans had
// used up a metered key's monthly allowance; this is ~1 call a minute.
//
// The rate-limit accounts hold only the capacity as of their last transfer, so
// the live headroom is recomputed here; Solana states the window nowhere on
// chain, and every leg on every chain uses the same 24-hour refill.

interface SolanaLayout {
  config: string
  mint: string
  mode: number
  custody: string
  outboxRateLimit: string | null
  inboxRateLimit: string | null
  at: number
}
const solanaLayouts = new Map<string, SolanaLayout>()
// The last custody (lockbox) or supply (spoke) each program answered, per `assetId:chainId`.
const solanaLastLocked = new Map<string, bigint>()

// SPL Token (and Token-2022, whose base layout is the same): a mint's supply is a
// u64 at 36 and its decimals the byte at 44; a token account's amount a u64 at 64.
const SPL_MINT_SUPPLY_OFFSET = 36
const SPL_MINT_DECIMALS_OFFSET = 44
const SPL_ACCOUNT_AMOUNT_OFFSET = 64
// A layout whose limiter lookup went unanswered is retried this soon rather than
// running without that limiter for the whole static-facts hour.
const SOLANA_LAYOUT_RETRY_MS = 5 * 60_000

const hasDiscriminator = (bytes: Buffer | null | undefined, discriminatorHex: string): bytes is Buffer =>
  bytes != null && bytes.length >= 8 && bytes.subarray(0, 8).toString('hex') === discriminatorHex

/**
 * The one account of a type a program holds. Null when the node did not answer;
 * `{ account: null }` when it answered with none or with several — a final
 * answer, not one worth asking again within the hour.
 */
async function findProgramAccount(url: string, programId: string, discriminatorHex: string, dataSize: number): Promise<{ account: { pubkey: string; data: Buffer } | null } | null> {
  const accounts = await postJson(url, {
    jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
    params: [programId, { encoding: 'base64', filters: [{ dataSize }, { memcmp: { offset: 0, bytes: base58Encode(hexToBytes(discriminatorHex)) } }] }],
  }, ORIGIN_RPC_TIMEOUT_MS) as { result?: { pubkey?: unknown; account?: { data?: unknown } }[] } | null
  if (!Array.isArray(accounts?.result)) return null
  // A manager registers exactly one peer, so exactly one account of each of these
  // types exists; anything else is not the record this looks for.
  if (accounts.result.length !== 1) return { account: null }
  const only = accounts.result[0]
  const encoded = (only?.account?.data as unknown[] | undefined)?.[0]
  if (typeof only?.pubkey !== 'string' || typeof encoded !== 'string') return { account: null }
  return { account: { pubkey: only.pubkey, data: Buffer.from(encoded, 'base64') } }
}

// A program that answered but is not the deployment the registry names (no
// single config, or a config for another mint) is remembered as such for the
// static-facts hour rather than rescanned every cycle.
const solanaLayoutRejected = new Map<string, number>()

async function solanaLayout(url: string, target: OriginTarget): Promise<SolanaLayout | null> {
  const key = `${target.asset.assetId}:${target.chainId}`
  const known = solanaLayouts.get(key)
  if (known && Date.now() - known.at < STATIC_FACTS_TTL_MS) return known
  const rejectedAt = solanaLayoutRejected.get(key)
  if (rejectedAt != null && Date.now() - rejectedAt < STATIC_FACTS_TTL_MS) return null
  const programId = displayChainAddress('solana', target.peer)
  const found = await findProgramAccount(url, programId, SOLANA_NTT_CONFIG_DISCRIMINATOR, SOLANA_NTT_CONFIG_LENGTH)
  // An unanswered rediscovery keeps the layout it already has rather than going blind.
  if (!found) return known ?? null
  const config = found.account ? parseSolanaNttConfig(found.account.data) : null
  if (!found.account || !config
    || (target.expectedToken != null && config.mint !== displayChainAddress('solana', target.expectedToken))) {
    solanaLayoutRejected.set(key, Date.now())
    return null
  }
  const outbox = await findProgramAccount(url, programId, SOLANA_OUTBOX_RATE_LIMIT_DISCRIMINATOR, SOLANA_OUTBOX_RATE_LIMIT_LENGTH)
  const inbox = await findProgramAccount(url, programId, SOLANA_INBOX_RATE_LIMIT_DISCRIMINATOR, SOLANA_INBOX_RATE_LIMIT_LENGTH)
  // Only an unanswered limiter lookup is retried early; one that answered without
  // a single account runs without that limiter for the hour.
  const complete = outbox != null && inbox != null
  const layout: SolanaLayout = {
    config: found.account.pubkey, mint: config.mint, mode: config.mode, custody: config.custody,
    outboxRateLimit: outbox ? outbox.account?.pubkey ?? null : known?.outboxRateLimit ?? null,
    inboxRateLimit: inbox ? inbox.account?.pubkey ?? null : known?.inboxRateLimit ?? null,
    at: complete ? Date.now() : Date.now() - STATIC_FACTS_TTL_MS + SOLANA_LAYOUT_RETRY_MS,
  }
  solanaLayoutRejected.delete(key)
  solanaLayouts.set(key, layout)
  solanaMints.set(key, { mint: config.mint, mode: config.mode })
  return layout
}

/** Raw account data per address; null when the node did not answer, so the caller keeps its last reading. */
async function readSolanaAccounts(url: string, keys: readonly string[]): Promise<Map<string, Buffer | null> | null> {
  const out = new Map<string, Buffer | null>()
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100)
    const res = await postJson(url, {
      jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [chunk, { encoding: 'base64' }],
    }, ORIGIN_RPC_TIMEOUT_MS) as { result?: { value?: ({ data?: unknown } | null)[] } } | null
    const values = res?.result?.value
    if (!Array.isArray(values) || values.length !== chunk.length) return null
    chunk.forEach((address, j) => {
      const encoded = (values[j]?.data as unknown[] | undefined)?.[0]
      out.set(address, typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : null)
    })
  }
  return out
}

async function readSolanaState(url: string, targets: readonly OriginTarget[]): Promise<{ custody: Map<number, CustodyRead>; fuses: Map<number, FusePair> }> {
  const custody = new Map<number, CustodyRead>()
  const fuses = new Map<number, FusePair>()
  const layouts: [OriginTarget, SolanaLayout][] = []
  for (const target of targets) {
    const layout = await solanaLayout(url, target)
    if (layout) layouts.push([target, layout])
  }
  if (!layouts.length) return { custody, fuses }
  const keys = [...new Set(layouts.flatMap(([, l]) => [
    l.config, l.mint, ...(l.mode === 1 ? [] : [l.custody]),
    ...(l.outboxRateLimit ? [l.outboxRateLimit] : []), ...(l.inboxRateLimit ? [l.inboxRateLimit] : []),
  ]))]
  const accounts = await readSolanaAccounts(url, keys)
  if (!accounts) return { custody, fuses }
  const nowSec = Math.floor(Date.now() / 1000)
  for (const [target, layout] of layouts) {
    const key = `${target.asset.assetId}:${target.chainId}`
    const configBytes = accounts.get(layout.config)
    const config = hasDiscriminator(configBytes, SOLANA_NTT_CONFIG_DISCRIMINATOR) ? parseSolanaNttConfig(configBytes) : null
    // A config that no longer names what was discovered means the layout is stale:
    // say nothing this cycle and rediscover on the next.
    if (!config || config.mint !== layout.mint || config.custody !== layout.custody || config.mode !== layout.mode) {
      solanaLayouts.delete(key)
      continue
    }
    // A BURNING program (mode 1) is a spoke: what it answers for is the mint's
    // whole supply, not a custody account's balance.
    const spoke = layout.mode === 1
    const mint = accounts.get(layout.mint)
    const source = spoke ? mint : accounts.get(layout.custody)
    const amountOffset = spoke ? SPL_MINT_SUPPLY_OFFSET : SPL_ACCOUNT_AMOUNT_OFFSET
    if (mint && mint.length > SPL_MINT_DECIMALS_OFFSET && source && source.length >= amountOffset + 8) {
      const locked = source.readBigUInt64LE(amountOffset)
      // A redemption moves this reading — a lockbox releases (custody falls), a
      // spoke mints (supply rises) — so the inbox scan that would still count it
      // queued or in flight is dropped and taken again in this same cycle.
      const previous = solanaLastLocked.get(key)
      if (previous != null && (spoke ? locked > previous : locked < previous)) {
        solanaInboxCache.delete(displayChainAddress('solana', target.peer))
      }
      solanaLastLocked.set(key, locked)
      custody.set(target.asset.assetId, {
        locked,
        decimals: mint[SPL_MINT_DECIMALS_OFFSET],
        paused: config.paused,
        at: Date.now(),
        role: spoke ? 'spoke' : 'lockbox',
        burned: null,
      })
    }
    const outBytes = layout.outboxRateLimit ? accounts.get(layout.outboxRateLimit) : null
    const inBytes = layout.inboxRateLimit ? accounts.get(layout.inboxRateLimit) : null
    const outbound = hasDiscriminator(outBytes, SOLANA_OUTBOX_RATE_LIMIT_DISCRIMINATOR) ? parseNttRateLimitState(outBytes, 8) : null
    const inbound = hasDiscriminator(inBytes, SOLANA_INBOX_RATE_LIMIT_DISCRIMINATOR) ? parseNttRateLimitState(inBytes, 9) : null
    if (!outbound && !inbound) continue
    // The accounts count in the ORIGIN mint's units.
    const dec = target.peerDecimals ?? target.asset.decimals
    fuses.set(target.asset.assetId, {
      outbound: computedFuse(outbound, dec, target.asset.decimals, RATE_LIMIT_REFILL_SEC, nowSec),
      inbound: computedFuse(inbound, dec, target.asset.decimals, RATE_LIMIT_REFILL_SEC, nowSec),
    })
  }
  return { custody, fuses }
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
    // Only a LOCKING Sui manager holds a balance that is custody; a burning one
    // would answer for a treasury's supply, which this reader does not take, so
    // it stays unread (and its asset unverified) rather than misread.
    if (state.mode == null || /^lock/i.test(state.mode)) {
      custody.set(target.asset.assetId, { locked: state.balance, decimals: target.peerDecimals, paused: state.paused, at: Date.now(), role: 'lockbox', burned: null })
    }
    suiModes.set(`${target.asset.assetId}:${target.chainId}`, state.mode)
    if (state.inboxSize != null) inboxSize.set(target.asset.assetId, state.inboxSize)
    if (state.inboxTableId != null) {
      const accepted = await readSuiExecuted(url, state.inboxTableId, sends, hydrationChainId)
      if (accepted) { executedOk = true; for (const digest of accepted) executed.add(digest) }
    }
    const peersKey = `${target.asset.assetId}:${target.chainId}`
    const peersTableId = state.peersTableId ?? suiPeersTable.get(peersKey) ?? null
    if (peersTableId == null) continue
    suiPeersTable.set(peersKey, peersTableId)
    const pair = await readSuiFuses(url, target, peersTableId, state.outboundRateLimit, hydrationChainId)
    if (pair) fuses.set(target.asset.assetId, pair)
  }
  return { custody, inboxSize, fuses, executed: executedOk ? executed : null }
}

// ─────────────────────── rate-limiter fuses ───────────────────────

// The four calls one manager answers about its two legs, plus the window they
// refill over. `peerChainId` is whoever sits on the other side of this manager:
// the origin chain for a Hydration manager, Hydration for an origin one.
// The four legs that move with every transfer. The window they are measured
// over (`rateLimitDuration`) is a deployment fact and is memoized separately.
const fuseCalls = (manager: string, peerChainId: number): EvmCall[] => [
  { to: manager, data: EVM_SELECTOR.getOutboundLimitParams },
  { to: manager, data: EVM_SELECTOR.getCurrentOutboundCapacity },
  { to: manager, data: encodeGetInboundLimitParams(peerChainId) },
  { to: manager, data: encodeGetCurrentInboundCapacity(peerChainId) },
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

// Hydration's own managers, in one batched round trip: each manager's single
// outbound leg and window, plus its inbound leg for EVERY peer chain — the
// inbound limit is per source chain (TC motion 387 set WETH's from Robinhood
// Chain to 69/day while Ethereum's stayed uncapped), so reading only the
// primary origin's would state one chain's limit for all of them.
// Keyed `assetId:chainId`; the outbound leg repeats on every chain of an asset.
async function readLocalFuses(assets: readonly DiscoveredAsset[], peerChains: ReadonlyMap<number, readonly number[]>): Promise<Map<string, FusePair>> {
  const out = new Map<string, FusePair>()
  const calls: EvmCall[] = []
  const slots: { asset: DiscoveredAsset; at: number; chains: number[]; duration: number | null }[] = []
  const now = Date.now()
  for (const asset of assets) {
    const chains = [...new Set(peerChains.get(asset.assetId) ?? [asset.originChainId])]
    const memo = rateLimitDurations.get(`${asset.assetId}:local`)
    const at = calls.length
    calls.push(
      { to: asset.manager, data: EVM_SELECTOR.getOutboundLimitParams },
      { to: asset.manager, data: EVM_SELECTOR.getCurrentOutboundCapacity },
    )
    // The window is a deployment fact: asked for only when its memo has run out.
    const duration = memo && now - memo.at < STATIC_FACTS_TTL_MS ? null : calls.push({ to: asset.manager, data: EVM_SELECTOR.rateLimitDuration }) - 1
    slots.push({ asset, at, chains, duration })
    for (const chainId of chains) {
      calls.push(
        { to: asset.manager, data: encodeGetInboundLimitParams(chainId) },
        { to: asset.manager, data: encodeGetCurrentInboundCapacity(chainId) },
      )
    }
  }
  const results = await hydrationEthCallBatch(calls)
  for (const slot of slots) {
    const [outParams, outCap] = results.slice(slot.at, slot.at + 2)
    const memoKey = `${slot.asset.assetId}:local`
    const asked = slot.duration == null ? null : decodeUint(results[slot.duration])
    if (asked != null && asked > 0n) rateLimitDurations.set(memoKey, { seconds: asked, at: now })
    const duration = asked ?? rateLimitDurations.get(memoKey)?.seconds ?? null
    if (duration == null || duration <= 0n) continue
    const seconds = Number(duration)
    const dec = slot.asset.decimals
    const outbound = evmFuse(outParams, outCap, dec, dec, seconds)
    const legsAt = slot.at + (slot.duration == null ? 2 : 3)
    slot.chains.forEach((chainId, i) => {
      const at = legsAt + i * 2
      out.set(`${slot.asset.assetId}:${chainId}`, { outbound, inbound: evmFuse(results[at], results[at + 1], dec, dec, seconds) })
    })
  }
  return out
}

/**
 * Hydration's own custody for every asset whose Hydration manager LOCKS: the
 * token's balance held by the manager, read AT THE PINNED BLOCK — the same
 * consistency domain as the indexed sends and receives it is compared with.
 * An unread asset is simply absent (its row reads unverified), never zero.
 */
async function readHydrationLocked(assets: readonly DiscoveredAsset[], atBlock: number): Promise<Map<number, bigint>> {
  const out = new Map<number, bigint>()
  if (!assets.length) return out
  const results = await hydrationEthCallBatch(assets.map(asset => ({
    to: asset.hydrationToken ?? erc20Precompile(asset.assetId),
    data: encodeBalanceOf(asset.manager),
  })), '0x' + atBlock.toString(16))
  assets.forEach((asset, i) => {
    const value = decodeUint(results[i])
    if (value != null) out.set(asset.assetId, value)
  })
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
  direction: 'out',
  fromChainId: ctx.hydrationChainId,
})

// One aggregate3 per EVM origin chain: getInboundQueuedTransfer for every
// candidate digest, plus rateLimitDuration() for any manager whose value is not
// memoized. An asset the pass did not answer for is left out of the result, so
// the caller keeps its previous reading rather than reading zero.
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
  const calls: EvmCall[] = []
  const answered = new Set<number>()

  for (const target of targets) {
    const manager = displayChainAddress('evm', target.peer)
    const memo = rateLimitDurations.get(`${target.asset.assetId}:${ctx.chainId}`)
    if (!memo || Date.now() - memo.at >= STATIC_FACTS_TTL_MS) {
      durationIds.set(target.asset.assetId, calls.push({ to: manager, data: EVM_SELECTOR.rateLimitDuration }) - 1)
    }
    for (const send of queueCandidates(sends, target.asset.assetId, ctx.chainId, cutoffMs)) {
      const id = calls.push({ to: manager, data: encodeGetInboundQueuedTransfer(send.digest) }) - 1
      slots.push({ target, send, id })
    }
    // A target with no candidate digests still counts as read: its queue is
    // empty because nothing it ever sent is unresolved.
    answered.add(target.asset.assetId)
  }

  const byId = await postMulticall(url, calls)
  // A leg the chain never answered is unknown, not empty: every asset it covered
  // loses its fresh reading and keeps the previous one.
  for (const slot of slots) {
    if (!byId.has(slot.id)) answered.delete(slot.target.asset.assetId)
  }

  for (const [assetId, id] of durationIds) {
    const seconds = decodeUint(byId.get(id))
    if (seconds != null) rateLimitDurations.set(`${assetId}:${ctx.chainId}`, { seconds, at: Date.now() })
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
    const duration = rateLimitDurations.get(`${slot.target.asset.assetId}:${ctx.chainId}`)?.seconds ?? null
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
// The inbox is the one Solana read that still has to enumerate: an InboxItem is
// created per redeemed message, so its address set grows with every arrival.
// Nothing about it is urgent while no send toward Solana is waiting — a
// redemption only ever moves a send from in flight to settled — so the scan runs
// every SOLANA_INBOX_TTL_MS, and every SOLANA_INBOX_PENDING_TTL_MS while a send is
// held in the inbox by the rate limiter or one from the last day is not there yet
// (an older one that never arrived is stuck, not about to land, and does not keep
// the fast clock running). A redemption the slow clock would miss still moves the
// program's custody, which drops the cached scan (`readSolanaState`), and the
// confirmation pass always scans afresh: a shortfall is never confirmed against
// an inbox read before the custody it is compared with.
const SOLANA_INBOX_TTL_MS = 10 * 60_000
const SOLANA_INBOX_PENDING_TTL_MS = 60_000
const SOLANA_INBOX_PENDING_WINDOW_MS = 86_400_000
const solanaInboxCache = new Map<string, { at: number; accounts: { account?: { data?: unknown } }[]; released: Set<string>; held: Set<string> }>()

async function solanaInboxAccounts(url: string, programId: string, ttlMs: number): Promise<{ account?: { data?: unknown } }[] | null> {
  const cached = solanaInboxCache.get(programId)
  if (cached && Date.now() - cached.at < ttlMs) return cached.accounts
  const res = await postJson(url, {
    jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
    params: [programId, { encoding: 'base64', filters: [{ dataSize: SOLANA_NTT_INBOX_ITEM_LENGTH }, { memcmp: { offset: 0, bytes: base58Encode(hexToBytes(SOLANA_NTT_INBOX_ITEM_DISCRIMINATOR)) } }] }],
  }, ORIGIN_RPC_TIMEOUT_MS) as { result?: { account?: { data?: unknown } }[] } | null
  // An unanswered scan serves the last one it has; a redemption it missed only
  // keeps a send counted as in flight a little longer.
  if (!Array.isArray(res?.result)) return cached?.accounts ?? null
  solanaInboxCache.set(programId, { at: Date.now(), accounts: res.result, released: cached?.released ?? new Set(), held: cached?.held ?? new Set() })
  return res.result
}

async function readSolanaQueued(
  url: string,
  targets: readonly OriginTarget[],
  sends: readonly NttSendRow[],
  ctx: { chainId: number; hydrationChainId: number },
  fresh: boolean,
): Promise<{ queued: Map<number, QueuedEntry[]>; executed: Set<string> | null }> {
  const out = new Map<number, QueuedEntry[]>()
  // An InboxItem exists only for a message the program has accepted, so the set
  // of matched items IS this chain's redemption record — read in the same pass
  // as its custody, which is what keeps the two from disagreeing.
  const executed = new Set<string>()
  let answered = false
  for (const target of targets) {
    const programId = displayChainAddress('solana', target.peer)
    // Sends are matched oldest first so repeated (recipient, amount) pairs pair
    // up in order rather than all colliding on the same send.
    const candidates = sends
      .filter(s => s.assetId === target.asset.assetId && s.toChain === ctx.chainId && s.digest !== '')
      .sort((a, b) => a.timestampMs - b.timestampMs)
    const last = solanaInboxCache.get(programId)
    const inFlight = (last?.held.size ?? 0) > 0
      || candidates.some(s => Date.now() - s.timestampMs < SOLANA_INBOX_PENDING_WINDOW_MS && !last?.released.has(s.digest) && !last?.held.has(s.digest))
    const accounts = await solanaInboxAccounts(url, programId, fresh ? 0 : inFlight ? SOLANA_INBOX_PENDING_TTL_MS : SOLANA_INBOX_TTL_MS)
    if (!accounts) continue
    answered = true

    const claimed = new Set<string>()
    // Only a RELEASED item is settled: one still held in the inbox is a transfer
    // in flight however old it is, and keeps the scan on its fast clock until it
    // goes out.
    const released = new Set<string>()
    const held = new Set<string>()
    const entries: QueuedEntry[] = []
    for (const account of accounts) {
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
      if (item.status === SOLANA_RELEASE_STATUS.released) { released.add(send.digest); continue }
      held.add(send.digest)
      entries.push(queuedEntryFromSend(send, ctx, send.amount, item.recipient, null, item.releaseAfterSec))
    }
    // Solana enumerates the whole inbox rather than probing digest by digest, so
    // it neither reads nor fills the settled-digest cache.
    const cachedInbox = solanaInboxCache.get(programId)
    if (cachedInbox) { cachedInbox.released = released; cachedInbox.held = held }
    out.set(target.asset.assetId, entries)
  }
  return { queued: out, executed: answered ? executed : null }
}

// The chain table names the chains it knows; the explorer's URN map names the
// rest, so a chain the bridge reaches but the table does not list still gets a
// name rather than a number.
const chainName = (chainId: number): string => {
  if (WORMHOLE_CHAINS[chainId]) return wormholeChainName(chainId)
  const urn = WORMHOLE_CHAIN_URNS[chainId]
  return (urn ? ocnChainName(urn) : null) ?? wormholeChainName(chainId)
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
  const scoped = scope ? discovered.assets.filter(a => scope.has(a.assetId)) : discovered.assets

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
  const headPin = await queryIndexedHeadPin()
  if (headPin == null) throw new Error('wormhole snapshot: no indexed head to pin the reads to')
  const indexedHead = headPin.height

  // Static manager facts and the local pause flag, sequentially against the
  // Hydration RPC. A manager that could not be read keeps its previous facts.
  // These come first because a send's digest is taken over our own chain id.
  const facts = new Map<number, ManagerStaticFacts>()
  const pausedLocal = new Map<number, boolean>()
  for (const asset of scoped) {
    const read = await readManagerFacts(asset)
    facts.set(asset.assetId, read)
    const paused = decodeBool(await hydrationEthCall(asset.manager, EVM_SELECTOR.isPaused))
    if (paused != null) pausedLocal.set(asset.assetId, paused)
  }

  const hydrationChainId = [...facts.values()].map(f => f.chainId).find(id => id != null && id > 0) ?? HYDRATION_WORMHOLE_CHAIN_ID
  // The primary origin, settled now that each manager's mode is known.
  const assets = scoped.map(asset => {
    const originChainId = derivePrimaryOrigin(asset, facts.get(asset.assetId), hydrationChainId)
    if (originChainId !== asset.originChainId) {
      const ref = discoveredManagers.get(asset.assetId)
      if (ref) discoveredManagers.set(asset.assetId, { ...ref, originChainId, originChainName: chainName(originChainId) })
    }
    return originChainId === asset.originChainId ? asset : { ...asset, originChainId }
  })
  const timeline = await loadNttTimeline(assets, minBlock, indexedHead, hydrationChainId)
  await resolveTransceivers()

  // Every peer of every asset, as the Hydration manager reports them (with the
  // indexed history as evidence). This — not the registry's single origin — is
  // the set every read below walks.
  const peers = new Map<number, ManagerPeer[]>()
  for (const asset of assets) {
    const fact = facts.get(asset.assetId)
    const list = fact?.peers.length
      ? fact.peers
      : fact?.peer ? [{ chainId: asset.originChainId, peer: fact.peer, decimals: fact.peerDecimals, evidence: null }] : []
    peers.set(asset.assetId, list)
  }

  // Hydration's own rate-limiter legs, in one batched round trip, per peer
  // chain. A leg the batch did not answer for keeps its previous reading.
  const localFresh = await readLocalFuses(assets, new Map(assets.map(a => [a.assetId, (peers.get(a.assetId) ?? []).map(p => p.chainId)])))
  const localFuses = new Map<string, FusePair>()
  for (const asset of assets) {
    for (const chainId of new Set([asset.originChainId, ...(peers.get(asset.assetId) ?? []).map(p => p.chainId)])) {
      const key = `${asset.assetId}:${chainId}`
      const fresh = localFresh.get(key)
      if (fresh) lastLocalFuses.set(key, fresh)
      const pair = fresh ?? lastLocalFuses.get(key)
      if (pair) localFuses.set(key, pair)
    }
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
  // Hydration's own custody, for the assets Hydration locks rather than mints.
  const hydrationLocked = new Map<number, bigint>()
  if (assets.length) {
    const blockHash = await hydrationBlockHash(indexedHead)
    if (blockHash == null) throw new Error(`wormhole snapshot: no block hash for indexed head ${indexedHead}`)
    const storage = await substrateStorageBatch(assets.map(a => tokensTotalIssuanceKey(a.assetId)), blockHash)
    // A transport failure nulls a whole chunk, so an all-null answer is the
    // signature of a failed read rather than of assets without supply. (A
    // locking asset — HDX's issuance lives in Balances, HOLLAR's in its ERC-20 —
    // legitimately reads null here; its custody is read below instead.)
    const minting = assets.filter(a => facts.get(a.assetId)?.mode !== 0)
    if (minting.length && minting.every(a => storage[assets.indexOf(a)] == null)) {
      throw new Error('wormhole snapshot: issuance read at the indexed head returned nothing')
    }
    assets.forEach((asset, i) => {
      const value = decodeU128Le(storage[i])
      if (value != null) issuance.set(asset.assetId, value)
    })
    // A storage read cannot tell a key that is ABSENT (an asset whose supply is
    // still zero — nothing minted yet) from one that went unanswered. The
    // token's own totalSupply() — byte-for-byte the same figure — can, so a
    // minting asset left without issuance asks it, at the same pinned block.
    const unanswered = minting.filter(a => !issuance.has(a.assetId))
    if (unanswered.length) {
      const supplies = await hydrationEthCallBatch(unanswered.map(a => ({
        to: a.hydrationToken ?? erc20Precompile(a.assetId), data: EVM_SELECTOR.totalSupply,
      })), '0x' + indexedHead.toString(16))
      unanswered.forEach((asset, i) => {
        const value = decodeUint(supplies[i])
        if (value != null) issuance.set(asset.assetId, value)
      })
    }
    for (const [assetId, value] of await readBurnedAtDead(assets, indexedHead)) burnedAtDead.set(assetId, value)
    const locking = assets.filter(a => facts.get(a.assetId)?.mode === 0)
    for (const [assetId, value] of await readHydrationLocked(locking, indexedHead)) hydrationLocked.set(assetId, value)
  }

  // Peer reads, grouped by chain so one endpoint answers for all its assets.
  // One entry per (asset, peer chain): WETH is read on Ethereum AND Robinhood
  // Chain, HDX on Robinhood, each by its own manager there. An
  // unconfigured or failing chain keeps whatever it last reported, with its own
  // timestamp, rather than being blanked.
  const byChain = new Map<number, OriginTarget[]>()
  for (const asset of assets) {
    for (const p of peers.get(asset.assetId) ?? []) {
      const list = byChain.get(p.chainId) ?? []
      list.push({
        asset,
        peer: p.peer,
        peerDecimals: p.decimals,
        chainId: p.chainId,
        expectedToken: p.chainId === asset.originChainId && asset.originToken != null ? asset.originToken : null,
      })
      byChain.set(p.chainId, list)
    }
  }
  const custody = new Map<number, CustodyRead>()
  const peerReads = new Map<string, CustodyRead>()
  const peerStaticsNow = new Map<string, PeerStatic>()
  const suiInbox = new Map<number, number>()
  const chains: WormholeChainState[] = []
  const queuedByAsset = new Map<number, bigint>()
  const queuedCount = new Map<number, number>()
  const queuedByPeer = new Map<string, { peer: bigint; hydration: bigint; peerKnown: boolean }>()
  const queued: QueuedEntry[] = []
  const originFuses = new Map<string, FusePair>()
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
        const state = await readSolanaState(url, targets)
        read = state.custody
        fuseRead = state.fuses
        const solana = await readSolanaQueued(url, targets, timeline.sends, queueCtx, scope != null)
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
        for (const [assetId, peer] of evm.peers) peerStaticsNow.set(`${assetId}:${chainId}`, peer)
        queueRead = await readEvmQueued(url, targets, timeline.sends, queueCtx, queueCutoffMs)
      }
    }
    for (const target of targets) {
      const key = `${target.asset.assetId}:${chainId}`
      if (!peerStaticsNow.has(key)) {
        const memo = peerStatics.get(key)
        if (memo) peerStaticsNow.set(key, memo)
        else if (family !== 'evm') {
          const sol = solanaMints.get(key)
          const suiMode = suiModes.get(key)
          peerStaticsNow.set(key, {
            mode: sol ? sol.mode : suiMode == null ? null : /^burn/i.test(suiMode) ? 1 : 0,
            token: sol?.mint ?? (target.expectedToken ? displayChainAddress(family, target.expectedToken) : null),
            name: null, symbol: null, decimals: target.peerDecimals, alsoPeers: null, at: Date.now(),
          })
        }
      }
    }
    // An execution is permanent, so what this cycle learned joins the persistent
    // set and stays resolved whether or not the chain answers again. The set is
    // handed to `decideInflight` whole; the per-chain entry stays this cycle's
    // own answer, which is what "the chain was asked and said no" means.
    if (executed) {
      for (const digest of executed) executedDigests.add(digest)
      executedOutboundByChain.set(chainId, executed)
    }
    for (const target of targets) {
      const key = `${target.asset.assetId}:${chainId}`
      const fresh = fuseRead.get(target.asset.assetId)
      if (fresh) lastOriginFuses.set(key, fresh)
      const pair = fresh ?? lastOriginFuses.get(key)
      if (pair) originFuses.set(key, pair)
    }
    for (const target of targets) {
      const key = `${target.asset.assetId}:${chainId}`
      const fresh = queueRead.get(target.asset.assetId)
      if (fresh) lastQueued.set(key, fresh)
      const entries = fresh ?? lastQueued.get(key)
      if (!entries) continue
      queued.push(...entries)
      const sum = entries.reduce((total, e) => total + e.amount, 0n)
      // Summed over chains: one asset can have exits held on two of them.
      queuedByAsset.set(target.asset.assetId, (queuedByAsset.get(target.asset.assetId) ?? 0n) + sum)
      queuedCount.set(target.asset.assetId, (queuedCount.get(target.asset.assetId) ?? 0) + entries.length)
      queuedByPeer.set(key, { peer: sum, hydration: 0n, peerKnown: true })
    }
    let newest: number | null = null
    let readCount = 0
    for (const target of targets) {
      const fresh = read.get(target.asset.assetId)
      // Remembered per (asset, chain): two custodies for one asset must not
      // overwrite each other's last-known reading.
      const memoKey = `${target.asset.assetId}:${chainId}`
      if (fresh) { lastCustody.set(memoKey, fresh); readCount += 1 }
      // A carried-over reading is marked as one on its way out, so the verdict
      // can tell "custody is this" from "custody was this when we last got an
      // answer". The remembered entry itself stays unmarked.
      const remembered = lastCustody.get(memoKey)
      const value = fresh ?? (remembered ? { ...remembered, stale: true } : undefined)
      if (!value) continue
      peerReads.set(memoKey, value)
      newest = newest == null ? value.at : Math.max(newest, value.at)
      // The per-asset custody total keeps its old meaning — custody across the
      // PEER lockboxes — for the fields that read it (the pause flag, alerts).
      if (value.role === 'spoke') continue
      custody.set(target.asset.assetId, addCustody(custody.get(target.asset.assetId), value, target.asset.decimals))
    }
    chains.push({
      chainId,
      name: chainName(chainId),
      family,
      configured: url != null,
      ok: url != null && readCount === targets.length,
      asOf: newest != null ? new Date(newest).toISOString() : null,
      layer: WORMHOLE_CHAINS[chainId]?.layer ?? null,
    })
  }

  // Arrivals Hydration's OWN inbound limiter is holding: executed (and queued)
  // here, not yet minted or released. The tokens are locked on the source
  // chain and not yet supply here, so they join the queued term exactly as an
  // exit held by a peer does.
  const durationSec = (assetId: number, chainId: number) => {
    const fuse = localFuses.get(`${assetId}:${chainId}`)?.inbound
    return fuse?.durationSec ?? null
  }
  for (const exec of timeline.inbound) {
    if (!exec.queued || exec.assetId == null || timeline.redeemedDigests.has(exec.digest) || exec.amount == null) continue
    if (!assets.some(a => a.assetId === exec.assetId)) continue
    const key = `${exec.assetId}:${exec.sourceChain}`
    const queuedAtSec = Math.floor(exec.timestampMs / 1000)
    const window = durationSec(exec.assetId, exec.sourceChain)
    queued.push({
      digest: exec.digest,
      assetId: exec.assetId,
      chainId: hydrationChainId,
      fromChainId: exec.sourceChain,
      direction: 'in',
      amount: exec.amount,
      recipient: exec.recipient,
      queuedAtSec,
      releasableAtSec: window != null ? queuedAtSec + window : null,
      sendKey: null,
    })
    queuedByAsset.set(exec.assetId, (queuedByAsset.get(exec.assetId) ?? 0n) + exec.amount)
    queuedCount.set(exec.assetId, (queuedCount.get(exec.assetId) ?? 0) + 1)
    const prev = queuedByPeer.get(key) ?? { peer: 0n, hydration: 0n, peerKnown: false }
    queuedByPeer.set(key, { ...prev, hydration: prev.hydration + exec.amount })
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
    // Every peer manager names this asset, so an operation resolves whichever
    // end Wormholescan names — a Robinhood WETH transfer as readily as an
    // Ethereum one.
    for (const p of peers.get(asset.assetId) ?? []) {
      assetByManager.set('0x' + p.peer.replace(/^0x/, '').padStart(64, '0'), { ...entry, peerDecimals: p.decimals ?? entry.peerDecimals })
    }
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
      if (!(peers.get(asset.assetId) ?? []).some(p => p.chainId === chainId)) continue
      const inbox = suiInbox.get(asset.assetId)
      if (inbox == null) continue
      const sent = outboundSends.filter(s => s.assetId === asset.assetId && s.toChain === chainId).length
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
    executedOutbound: executedDigests,
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
    indexLagMs: headPin.lagMs,
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
    peers,
    peerReads,
    peerStatics: peerStaticsNow,
    queuedByPeer,
    hydrationLocked,
    // Filled by the caller, once this cycle's own readings have been graded.
    downgradeConfirmed: new Map(),
    scan: { configured: Boolean(SCAN_URL), ok: scanOk, asOf: scanOk ? new Date().toISOString() : null },
  }
  return { assets, next }
}

// Grading lives in the pure layer (`gradeBacking`, `advanceStreak`) so the
// streak rule is unit-tested alongside the classifier that feeds it.
const gradeOf = gradeBacking

// Publishing IS bumping the generation: responses are built from the snapshot,
// so a new one has to be servable immediately rather than after the response
// TTL, and the notification lane wakes on the same counter.
function publishSnapshot(next: WormholeSnapshot): void {
  snapshot = next
  wormholeSnapshotGeneration += 1
  publishRemoteTokens(next)
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
      // An inconclusive reading (stale custody, a stalled index) holds the
      // count where it stood: it is neither a second agreeing reading nor a
      // refutation of the first.
      const streak = advanceStreak(negativeStreak.get(asset.assetId) ?? 0, grade)
      negativeStreak.set(asset.assetId, streak)
      next.downgradeConfirmed.set(asset.assetId, streak >= DOWNGRADE_CYCLES)
      if (grade === 'negative' && streak === 1) firstSightings.push(asset.assetId)
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
  // The same, for maps keyed `assetId:chainId`: every chain of a re-read asset
  // moves together, so a chain the pass no longer reports is dropped with it.
  const overlayKeyed = <V>(from: Map<string, V>, onto: Map<string, V>): Map<string, V> => {
    const out = new Map([...onto].filter(([key]) => !ids.has(Number(key.slice(0, key.indexOf(':'))))))
    for (const [key, value] of from) if (ids.has(Number(key.slice(0, key.indexOf(':'))))) out.set(key, value)
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
    // Snapshot-wide, and the base's on purpose: the merge only carries assets
    // the confirming pass graded as a shortfall, which the guard allows only on
    // a fresh head, and the base cycle that flagged them was fresh too — so
    // both readings agree on it and the base's describes the other assets.
    indexLagMs: base.indexLagMs,
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
    originFuses: overlayKeyed(fresh.originFuses, base.originFuses),
    localFuses: overlayKeyed(fresh.localFuses, base.localFuses),
    peers: overlay(fresh.peers, base.peers),
    peerReads: overlayKeyed(fresh.peerReads, base.peerReads),
    peerStatics: overlayKeyed(fresh.peerStatics, base.peerStatics),
    queuedByPeer: overlayKeyed(fresh.queuedByPeer, base.queuedByPeer),
    hydrationLocked: overlay(fresh.hydrationLocked, base.hydrationLocked),
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
  usdOfRaw(prices, assetId, raw, decimals)

const addUsd = (total: number | null, value: number | null): number | null => (value == null ? total : (total ?? 0) + value)

// One asset's whole backing verdict, in ONE place. The response rows and the
// notification lane both read it, so a subscriber can never be told a number the
// page they are sent to disagrees with.
interface AssetBacking {
  /** Σ custody over every lockbox, at asset decimals. */
  locked: bigint | null
  /** Σ GROSS supply over every spoke (Hydration's TotalIssuance when it mints). */
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
  legs: BackingLeg[]
}

const peerKey = (assetId: number, chainId: number): string => `${assetId}:${chainId}`

/** Hydration's own role for an asset: its manager LOCKS (mode 0) or mints. */
const hydrationRoleOf = (snap: WormholeSnapshot, assetId: number): 'lockbox' | 'spoke' | null => {
  const mode = snap.facts.get(assetId)?.mode
  return mode === 0 ? 'lockbox' : mode === 1 ? 'spoke' : null
}

/**
 * Every chain of one asset as a leg of the backing equation, at the asset's
 * decimals: Hydration's own side (its custody when it locks, its pinned
 * issuance when it mints) and each peer (custody for a lockbox, supply for a
 * spoke). An unknown Hydration mode is read as minting, the shape every asset
 * had before modes were asked for.
 */
function backingLegs(snap: WormholeSnapshot, asset: DiscoveredAsset): BackingLeg[] {
  const legs: BackingLeg[] = []
  if (hydrationRoleOf(snap, asset.assetId) === 'lockbox') {
    legs.push({ chainId: snap.hydrationChainId, role: 'lockbox', amount: snap.hydrationLocked.get(asset.assetId) ?? null, burned: null, fresh: true, readable: true })
  } else {
    legs.push({
      chainId: snap.hydrationChainId, role: 'spoke',
      amount: snap.issuance.get(asset.assetId) ?? null,
      burned: snap.burnedAtDead.get(asset.assetId) ?? null,
      burnedExpected: true,
      fresh: true, readable: true,
    })
  }
  for (const p of snap.peers.get(asset.assetId) ?? []) {
    const read = snap.peerReads.get(peerKey(asset.assetId, p.chainId)) ?? null
    const statics = snap.peerStatics.get(peerKey(asset.assetId, p.chainId)) ?? null
    const role: 'lockbox' | 'spoke' = read?.role ?? (statics?.mode === 1 ? 'spoke' : 'lockbox')
    const from = read?.decimals ?? asset.decimals
    legs.push({
      chainId: p.chainId,
      role,
      amount: read?.locked != null ? rescaleAmount(read.locked, from, asset.decimals) : null,
      burned: read?.burned != null ? rescaleAmount(read.burned, from, asset.decimals) : null,
      burnedExpected: wormholeChainFamily(p.chainId) === 'evm',
      fresh: read != null && read.stale !== true,
      readable: snap.chains.find(c => c.chainId === p.chainId)?.configured ?? ORIGIN_RPC_URLS.has(p.chainId),
    })
  }
  return legs
}

function assetBacking(
  snap: WormholeSnapshot, asset: DiscoveredAsset, prices: Map<number, PriceInfo>,
  // Override for the refresh pass, which grades a cycle's own reading before the
  // streak it feeds has been counted.
  gradeUndamped = false,
): AssetBacking {
  const legs = backingLegs(snap, asset)
  const scanEnabled = snap.scan.configured && snap.scan.ok
  const inflightIn = scanEnabled ? snap.inflightIn.get(asset.assetId) ?? 0n : null
  const inflightOut = scanEnabled ? snap.inflightOut.get(asset.assetId) ?? 0n : null
  const queued = snap.queuedByAsset.get(asset.assetId) ?? null
  const verdict = classifyLegs({
    inflightIn, inflightOut, queued,
    decimals: asset.decimals,
    symbol: asset.symbol,
    priceUsd: prices.get(asset.assetId)?.price ?? null,
    indexLagMs: snap.indexLagMs,
    scanEnabled,
    lookbackDays: LOOKBACK_DAYS,
    downgradeConfirmed: gradeUndamped || (snap.downgradeConfirmed.get(asset.assetId) ?? false),
  }, legs, chainName)
  return {
    locked: verdict.sums.locked,
    issuance: verdict.sums.issuance,
    burned: verdict.sums.burned,
    inflightIn, inflightOut, queued,
    originConfigured: legs.some(l => l.readable && l.role === 'lockbox'),
    scanEnabled,
    status: verdict.status,
    statusDetail: verdict.detail,
    residual: verdict.residual,
    residualUsd: usdOf(prices, asset.assetId, verdict.residual, asset.decimals),
    legs,
  }
}

// The Hydration-centric fuse block for one asset's PRIMARY origin, or null
// where that origin's limiters went unread — showing only the local (uncapped)
// legs would suggest a headroom nothing measured. Read per chain: an asset
// with two peers keeps two blocks (see `peerLimits`), and this one is the
// primary's, never whichever chain happened to be read last.
function assetLimits(snap: WormholeSnapshot, asset: Pick<DiscoveredAsset, 'assetId' | 'originChainId'>): WormholeAssetLimits | null {
  const origin = snap.originFuses.get(peerKey(asset.assetId, asset.originChainId))
  if (!origin) return null
  const local = snap.localFuses.get(peerKey(asset.assetId, asset.originChainId)) ?? null
  return {
    in: origin.outbound,
    out: origin.inbound,
    localOut: local?.outbound ?? null,
    localIn: local?.inbound ?? null,
  }
}

/** Both sides' legs between Hydration and one peer chain. */
function peerLimits(snap: WormholeSnapshot, assetId: number, chainId: number): WormholePeerLimits | null {
  const peer = snap.originFuses.get(peerKey(assetId, chainId)) ?? null
  const local = snap.localFuses.get(peerKey(assetId, chainId)) ?? null
  if (!peer && !local) return null
  return {
    peerOut: peer?.outbound ?? null,
    peerIn: peer?.inbound ?? null,
    hydrationIn: local?.inbound ?? null,
    hydrationOut: local?.outbound ?? null,
  }
}

interface PeerFlow { received: bigint | null; sent: bigint; transfersIn: number; transfersOut: number }

/**
 * Every indexed transfer between Hydration and each peer chain, per asset:
 * sends by their payload amount, arrivals by the amount their own VAA carried
 * (matched to the manager's digest). One arrival whose payload could not be
 * found leaves that chain's received total unknown rather than short.
 */
function peerFlows(snap: WormholeSnapshot): Map<string, PeerFlow> {
  const out = new Map<string, PeerFlow>()
  const at = (key: string) => out.get(key) ?? { received: 0n, sent: 0n, transfersIn: 0, transfersOut: 0 }
  for (const send of snap.timeline.sends) {
    if (send.assetId == null || send.amount == null) continue
    const key = peerKey(send.assetId, send.toChain)
    const flow = at(key)
    out.set(key, { ...flow, sent: flow.sent + send.amount, transfersOut: flow.transfersOut + 1 })
  }
  for (const exec of snap.timeline.inbound) {
    if (exec.assetId == null) continue
    const key = peerKey(exec.assetId, exec.sourceChain)
    const flow = at(key)
    out.set(key, {
      ...flow,
      received: flow.received == null || exec.amount == null ? null : flow.received + exec.amount,
      transfersIn: flow.transfersIn + 1,
    })
  }
  return out
}

const tokenRef = (statics: PeerStatic | null | undefined, fallbackAddress: string | null, fallbackDecimals: number | null): WormholeTokenRef | null => {
  const address = statics?.token ?? fallbackAddress
  if (!address) return null
  return { address, name: statics?.name ?? null, symbol: statics?.symbol ?? null, decimals: statics?.decimals ?? fallbackDecimals }
}

/**
 * Every peer of one asset as a response row, plus Hydration's own custody when
 * Hydration is the lockbox. Pure over the snapshot: no chain or ClickHouse read.
 */
function peerRows(
  snap: WormholeSnapshot, asset: DiscoveredAsset, backing: AssetBacking, prices: Map<number, PriceInfo>, flows: Map<string, PeerFlow>,
): WormholePeerRow[] {
  const tol = backingTolerance(asset.decimals, prices.get(asset.assetId)?.price ?? null)
  const hydrationIsLockbox = hydrationRoleOf(snap, asset.assetId) === 'lockbox'
  const circulating = !hydrationIsLockbox && backing.legs[0]?.amount != null
    ? backing.legs[0].amount - (backing.legs[0].burned ?? 0n)
    : null
  const history = peerHistories.get(asset.manager)
  const transceiverPeers = transceiverPeersFor(asset.manager)
  const scanEnabled = backing.scanEnabled
  const rows: WormholePeerRow[] = []
  for (const p of snap.peers.get(asset.assetId) ?? []) {
    const key = peerKey(asset.assetId, p.chainId)
    const family = wormholeChainFamily(p.chainId)
    const info = WORMHOLE_CHAINS[p.chainId] ?? null
    const leg = backing.legs.find(l => l.chainId === p.chainId) ?? null
    const read = snap.peerReads.get(key) ?? null
    const statics = snap.peerStatics.get(key) ?? null
    const chain = snap.chains.find(c => c.chainId === p.chainId)
    const configured = chain?.configured ?? ORIGIN_RPC_URLS.has(p.chainId)
    const mode = statics?.mode == null ? null : statics.mode === 1 ? 'burning' : 'locking'
    const role = leg?.role ?? null
    const ops = snap.inflight.filter(op => op.assetId === String(asset.assetId))
    const pendingInOps = ops.filter(op => op.direction === 'in' && op.fromChainId === p.chainId)
    const pendingOutOps = ops.filter(op => op.direction === 'out' && op.toChainId === p.chainId)
    const sumOps = (list: WormholeInflightOp[]) => list.reduce((total, op) => total + (op.amount != null ? BigInt(op.amount) : 0n), 0n)
    const inflightIn = scanEnabled ? sumOps(pendingInOps) : null
    const inflightOut = scanEnabled ? sumOps(pendingOutOps) : null
    const held = snap.queuedByPeer.get(key) ?? null
    const flow = flows.get(key) ?? { received: 0n, sent: 0n, transfersIn: 0, transfersOut: 0 }
    const fuses = peerLimits(snap, asset.assetId, p.chainId)
    let status: WormholePeerRow['status']
    let statusDetail: string
    let payout: WormholePeerRow['payout'] = null
    if (!configured) {
      status = 'unconfigured'
      statusDetail = `${chainName(p.chainId)} has no read endpoint on this deployment, so this ${role === 'spoke' ? 'supply' : 'lockbox'} is not counted and the asset reads unverified.`
    } else if (role === 'spoke') {
      status = leg?.amount == null || !leg.fresh ? 'unverified' : 'ok'
      statusDetail = leg?.amount == null
        ? 'The supply minted on this chain could not be read this cycle.'
        : leg.fresh ? 'Supply minted on this chain against custody elsewhere; counted on the supply side of the equation.'
          : 'Supply carried over from an earlier read.'
    } else {
      const result = lockboxPayout({
        balance: leg?.amount ?? null,
        received: flow.received,
        sent: flow.sent,
        pendingIn: inflightIn ?? 0n,
        pendingOut: (inflightOut ?? 0n) + (held?.peer ?? 0n),
        inboundCapacity: fuses?.peerIn ? BigInt(fuses.peerIn.capacity) : null,
        circulating,
        tolerance: tol,
        fresh: leg?.fresh ?? false,
        sharedWith: statics?.alsoPeers ?? [],
        symbol: asset.symbol,
        decimals: asset.decimals,
      })
      status = result.status
      statusDetail = result.detail
      payout = {
        capacity: result.capacity?.toString() ?? null,
        potential: result.potential?.toString() ?? null,
        coversPotential: result.coversPotential,
        baseline: result.baseline?.toString() ?? null,
      }
    }
    const indexed = history?.get(p.chainId) ?? null
    const balance = leg?.amount ?? null
    rows.push({
      chainId: p.chainId,
      chainName: chainName(p.chainId),
      family,
      layer: info?.layer ?? null,
      riskNote: info?.riskNote ?? null,
      primary: p.chainId === asset.originChainId,
      manager: displayChainAddress(family, p.peer),
      mode,
      role,
      token: tokenRef(statics, p.chainId === asset.originChainId && asset.originToken ? displayChainAddress(family, asset.originToken) : null, p.decimals),
      balance: balance?.toString() ?? null,
      balanceUsd: usdOf(prices, asset.assetId, balance, asset.decimals),
      burned: role === 'spoke' ? leg?.burned?.toString() ?? null : null,
      paused: read?.paused ?? null,
      configured,
      fresh: leg?.fresh ?? false,
      asOf: read ? new Date(read.at).toISOString() : null,
      limits: fuses,
      inflightIn: inflightIn?.toString() ?? null,
      inflightOut: inflightOut?.toString() ?? null,
      inflightCount: scanEnabled ? pendingInOps.length + pendingOutOps.length : null,
      queued: held?.peerKnown ? held.peer.toString() : null,
      queuedHydration: (held?.hydration ?? 0n).toString(),
      flows: {
        received: flow.received?.toString() ?? null,
        sent: flow.sent.toString(),
        net: flow.received != null ? (flow.received - flow.sent).toString() : null,
        transfersIn: flow.transfersIn,
        transfersOut: flow.transfersOut,
      },
      payout,
      status,
      statusDetail,
      evidence: p.evidence,
      since: indexed ? {
        blockHeight: indexed.first.blockHeight,
        timestamp: new Date(indexed.first.timestampMs).toISOString(),
        extrinsicIndex: indexed.first.extrinsicIndex,
        origin: indexed.first.origin,
      } : null,
      changes: indexed?.changes.length ?? 0,
      transceiverPeer: transceiverPeers.get(p.chainId) ? displayChainAddress(family, transceiverPeers.get(p.chainId)!) : null,
      alsoPeers: statics?.alsoPeers ?? [],
    })
  }
  // Primary first, then by when the peer was added.
  return rows.sort((a, b) => Number(b.primary) - Number(a.primary) || (a.since?.blockHeight ?? 0) - (b.since?.blockHeight ?? 0) || a.chainId - b.chainId)
}

/** chain → the remote transceiver Hydration's transceiver for `manager` registered. */
function transceiverPeersFor(manager: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const [contract, byChain] of peerHistories) {
    if (transceiverManager.get(contract)?.manager !== manager) continue
    for (const [chainId, h] of byChain) if (h.current?.event.kind === 'transceiver' && h.current.event.peer) out.set(chainId, h.current.event.peer)
  }
  return out
}

/** Map every transceiver that registered a peer to the manager it serves (hourly memo). */
async function resolveTransceivers(): Promise<void> {
  const now = Date.now()
  for (const [contract, byChain] of peerHistories) {
    if (![...byChain.values()].some(h => h.changes.some(c => c.event.kind === 'transceiver'))) continue
    const memo = transceiverManager.get(contract)
    if (memo && now - memo.at < STATIC_FACTS_TTL_MS) continue
    const manager = decodeAddress(await hydrationEthCall(contract, EVM_SELECTOR.nttManager))?.toLowerCase() ?? null
    transceiverManager.set(contract, { manager: manager ?? memo?.manager ?? null, at: manager ? now : memo?.at ?? 0 })
  }
}

/** The lockboxes of one asset, flattened: each peer lockbox, and Hydration's own where it locks. */
function lockboxRows(snap: WormholeSnapshot, asset: DiscoveredAsset, backing: AssetBacking, peers: readonly WormholePeerRow[], prices: Map<number, PriceInfo>): WormholeLockboxRow[] {
  const out: WormholeLockboxRow[] = []
  if (hydrationRoleOf(snap, asset.assetId) === 'lockbox') {
    const balance = snap.hydrationLocked.get(asset.assetId) ?? null
    const graded = backing.status === 'deficit' || backing.status === 'attention' ? 'attention'
      : backing.status === 'ok' || backing.status === 'surplus' ? 'ok' : 'unverified'
    out.push({
      assetId: String(asset.assetId), symbol: asset.symbol, decimals: asset.decimals,
      chainId: snap.hydrationChainId, chainName: chainName(snap.hydrationChainId), layer: WORMHOLE_CHAINS[snap.hydrationChainId]?.layer ?? null,
      token: asset.hydrationToken ? { address: asset.hydrationToken, name: null, symbol: asset.symbol, decimals: asset.decimals } : null,
      balance: balance?.toString() ?? null,
      balanceUsd: usdOf(prices, asset.assetId, balance, asset.decimals),
      capacity: balance != null ? (balance - (backing.inflightOut ?? 0n)).toString() : null,
      status: graded,
      statusDetail: `Hydration's own manager locks ${asset.symbol}; what it holds backs the supply minted on its peers. ${backing.statusDetail}`,
    })
  }
  for (const p of peers) {
    if (p.role !== 'lockbox') continue
    out.push({
      assetId: String(asset.assetId), symbol: asset.symbol, decimals: asset.decimals,
      chainId: p.chainId, chainName: p.chainName, layer: p.layer, token: p.token,
      balance: p.balance, balanceUsd: p.balanceUsd,
      capacity: p.payout?.capacity ?? null,
      status: p.status, statusDetail: p.statusDetail,
    })
  }
  return out
}

/** Publish each asset's chains for the activity rows and asset page (see wormholeRemoteTokens.ts). */
function publishRemoteTokens(snap: WormholeSnapshot): void {
  const out: WormholeAssetBridge[] = []
  for (const asset of snap.assets) {
    const list: WormholeBridgePeer[] = []
    const peersOrdered = [...(snap.peers.get(asset.assetId) ?? [])]
      .sort((a, b) => Number(b.chainId === asset.originChainId) - Number(a.chainId === asset.originChainId))
    for (const p of peersOrdered) {
      const key = peerKey(asset.assetId, p.chainId)
      const family = wormholeChainFamily(p.chainId)
      const statics = snap.peerStatics.get(key) ?? null
      // A peer whose token is not read yet is still a registered chain of the
      // asset: it is listed with the token unread rather than left out.
      const ref = tokenRef(statics, p.chainId === asset.originChainId && asset.originToken ? displayChainAddress(family, asset.originToken) : null, p.decimals)
      const role = snap.peerReads.get(key)?.role ?? (statics?.mode === 1 ? 'spoke' : statics?.mode === 0 ? 'lockbox' : null)
      const info = WORMHOLE_CHAINS[p.chainId] ?? null
      list.push({
        chainId: p.chainId, chainName: chainName(p.chainId), address: ref?.address ?? null, name: ref?.name ?? null, symbol: ref?.symbol ?? null,
        decimals: ref?.decimals ?? p.decimals, role,
        explorerUrl: family === 'evm' && ref ? wormholeExplorerUrl(p.chainId, ref.address) : null,
        layer: info?.layer ?? null,
        riskNote: info?.riskNote ?? null,
        primary: p.chainId === asset.originChainId,
      })
    }
    out.push({
      assetId: asset.assetId,
      hydrationRole: hydrationRoleOf(snap, asset.assetId),
      primaryChainId: asset.originChainId,
      primaryChainName: chainName(asset.originChainId),
      manager: asset.manager,
      peers: list,
    })
  }
  setWormholeBridges(out)
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
    lockboxes: [],
    scan: { configured: Boolean(SCAN_URL), ok: false, asOf: null },
    hydrationChainId: HYDRATION_WORMHOLE_CHAIN_ID,
    asOf: null,
    indexedThrough: head ? { block: head.block_height, at: head.block_timestamp } : null,
    indexLagSec: null,
    indexBehind: false,
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
  const remoteToken = (assetId: number, chainId: number): WormholeTokenRef | null => {
    const asset = assetById.get(assetId)
    if (!asset) return null
    const p = (snap.peers.get(assetId) ?? []).find(x => x.chainId === chainId)
    if (!p) return null
    const family = wormholeChainFamily(chainId)
    return tokenRef(snap.peerStatics.get(peerKey(assetId, chainId)), chainId === asset.originChainId && asset.originToken ? displayChainAddress(family, asset.originToken) : null, p.decimals)
  }

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
      counterpartyToken: remoteToken(asset.assetId, send.toChain),
    })
  }

  // The exact amount of each arrival, keyed by where its manager logged it.
  const execByExtrinsic = new Map<string, NttInboundExec[]>()
  for (const exec of snap.timeline.inbound) {
    const key = `${exec.blockHeight}:${exec.extrinsicIndex}`
    execByExtrinsic.set(key, [...(execByExtrinsic.get(key) ?? []), exec])
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
    // A locking manager releases rather than mints, so no deposit marks the
    // arrival; its own VAA payload states the amount and recipient instead.
    const exec = mint ? null : (execByExtrinsic.get(`${receive.blockHeight}:${receive.extrinsicIndex}`) ?? [])
      .find(e => e.assetId === asset.assetId && e.sourceChain === receive.emitterChainId && e.amount != null && !e.queued) ?? null
    const amount = mint?.amount ?? exec?.amount ?? null
    if (amount == null) continue
    const who = mint?.who || (exec?.recipient ? recipientAccount(exec.recipient) : null)
    mintedIn.set(asset.assetId, (mintedIn.get(asset.assetId) ?? 0n) + amount)
    if (receive.timestampMs >= windowStart) transfers14d.get(asset.assetId)!.in += 1
    rows.push({
      direction: 'in',
      assetId: String(asset.assetId),
      symbol: asset.symbol,
      amount: amount.toString(),
      amountUsd: usdOf(prices, asset.assetId, amount, asset.decimals),
      account: who || null,
      accountRef: who ? accountRef(who) : null,
      counterpartyChainId: receive.emitterChainId,
      blockHeight: receive.blockHeight,
      eventIndex: receive.eventIndex,
      extrinsicIndex: receive.extrinsicIndex,
      timestamp: new Date(receive.timestampMs).toISOString(),
      sequence: receive.sequence,
      counterpartyToken: remoteToken(asset.assetId, receive.emitterChainId),
    })
  }

  rows.sort((a, b) => b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex)

  const flows = peerFlows(snap)
  let lockedUsd: number | null = null
  let issuanceUsd: number | null = null
  let deficitUsd: number | null = null
  let surplusUsd: number | null = null
  const lockboxes: WormholeLockboxRow[] = []
  const assetRows: WormholeAssetRow[] = snap.assets.map(asset => {
    const fact = snap.facts.get(asset.assetId) ?? null
    const custody = snap.custody.get(asset.assetId) ?? null
    const family = wormholeChainFamily(asset.originChainId)
    const backing = assetBacking(snap, asset, prices)
    const hydrationRole = hydrationRoleOf(snap, asset.assetId)
    const minted = mintedIn.get(asset.assetId) ?? 0n
    // Supply burned by an OUTBOUND bridge transfer — not the dead-address term
    // (`backing.burned`), which is what the parity equation subtracts.
    const burnedOutOf = burnedOut.get(asset.assetId) ?? 0n
    const { issuance, locked, residualUsd } = backing
    lockedUsd = addUsd(lockedUsd, usdOf(prices, asset.assetId, locked, asset.decimals))
    issuanceUsd = addUsd(issuanceUsd, usdOf(prices, asset.assetId, issuance, asset.decimals))
    if (residualUsd != null && (backing.status === 'deficit' || backing.status === 'attention')) deficitUsd = (deficitUsd ?? 0) + Math.abs(residualUsd)
    if (residualUsd != null && backing.status === 'surplus') surplusUsd = (surplusUsd ?? 0) + residualUsd
    const peers = peerRows(snap, asset, backing, prices, flows)
    const assetLockboxes = lockboxRows(snap, asset, backing, peers, prices)
    lockboxes.push(...assetLockboxes)
    const primaryPeer = (snap.peers.get(asset.assetId) ?? []).find(p => p.chainId === asset.originChainId) ?? null
    const hydrationIssuance = snap.issuance.get(asset.assetId) ?? null
    return {
      assetId: String(asset.assetId),
      symbol: asset.symbol,
      decimals: asset.decimals,
      originChainId: asset.originChainId,
      originChainName: chainName(asset.originChainId),
      originToken: asset.originToken ? displayChainAddress(family, asset.originToken) : null,
      manager: asset.manager,
      mode: fact?.mode == null ? null : fact.mode === 1 ? 'burning' : 'locking',
      pausedLocal: snap.pausedLocal.get(asset.assetId) ?? null,
      pausedOrigin: custody?.paused ?? (peers.some(p => p.paused === true) ? true : peers.some(p => p.paused === false) ? false : null),
      peer: primaryPeer ? displayChainAddress(family, primaryPeer.peer) : null,
      limits: assetLimits(snap, asset),
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
        //
        // Only where Hydration MINTS: a locking manager's flows are releases
        // and locks of a token whose supply NTT never touches, so there is no
        // remainder to state.
        nonNtt: hydrationRole !== 'lockbox' && hydrationIssuance != null ? (hydrationIssuance - minted + burnedOutOf).toString() : null,
      },
      issuanceUsd: usdOf(prices, asset.assetId, issuance, asset.decimals),
      lockedUsd: usdOf(prices, asset.assetId, locked, asset.decimals),
      residualUsd,
      status: backing.status,
      statusDetail: backing.statusDetail,
      transfers14d: transfers14d.get(asset.assetId) ?? { out: 0, in: 0 },
      hydrationRole,
      hydrationLocked: hydrationRole === 'lockbox' ? snap.hydrationLocked.get(asset.assetId)?.toString() ?? null : null,
      hydrationToken: asset.hydrationToken,
      peers,
      lockboxCount: assetLockboxes.length,
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
    const amountUsd = asset ? usdOfRaw(prices, asset.assetId, op.amount, asset.decimals) : null
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
      direction: entry.direction,
      fromChainId: entry.fromChainId,
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
    lockboxes,
    scan: snap.scan,
    hydrationChainId: snap.hydrationChainId,
    asOf: new Date(snap.takenAt).toISOString(),
    indexedThrough: head ? { block: head.block_height, at: head.block_timestamp } : null,
    indexLagSec: snap.indexLagMs != null ? Math.round(snap.indexLagMs / 1000) : null,
    indexBehind: snap.indexLagMs == null || snap.indexLagMs > INDEX_STALE_AFTER_MS,
  }
}

/**
 * The Hydration account an NTT recipient names. Hydration-bound transfers carry
 * an EVM recipient (20 bytes, left-padded), which is the ETH\0-widened account
 * on this side; a full 32-byte value is an account id as it stands.
 */
function recipientAccount(recipient: string): string {
  const body = recipient.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  return /^0{24}/.test(body) ? '0x45544800' + body.slice(24) + '0'.repeat(16) : '0x' + body
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

export type { CustodyRead }

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
    const limits = assetLimits(snap, asset)
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
