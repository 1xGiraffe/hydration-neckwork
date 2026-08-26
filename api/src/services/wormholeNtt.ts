import { keccakAsHex, xxhashAsU8a } from '@polkadot/util-crypto'
import { u8aConcat, u8aToHex } from '@polkadot/util'

// Pure domain layer for the Wormhole NTT backing monitor: the log/payload
// parsers, the origin-chain decoders, the de-trim arithmetic, the Wormholescan
// normalizer and the backing classifier. Nothing here touches ClickHouse, the
// network or module state, so every rule below is testable against real bytes.
//
// Hydration bridges these assets with Wormhole NTT (Native Token Transfers),
// not the Portal token bridge. One NttManager per asset runs in BURNING mode on
// Hydration's EVM; the origin chain's manager runs in LOCKING mode and holds the
// custody the Hydration supply is a claim on. Every origin manager registers
// exactly one peer — Hydration — so per asset, in raw units:
//
//   locked == issuance + inflightIn + inflightOut + queued + residual
//
// `residual > 0` is benign: origin custody was seeded above the pre-NTT supply
// it had to back. `residual < 0` means minted supply exceeds backing, which is
// the condition this monitor exists to catch.
//
// `queued` is the third state between "in flight" and "settled": the origin
// manager runs an inbound rate limiter, so a transfer can be burned here AND
// redeemed at the peer yet still held in custody until its release window
// opens. Wormholescan reports such an operation as completed, so without this
// term the amount reads as unexplained custody surplus.

// ───────────────────────────── response shapes ─────────────────────────────

export type WormholeStatus = 'ok' | 'surplus' | 'attention' | 'deficit' | 'unverified' | 'unconfigured'
export type WormholeChainFamily = 'evm' | 'solana' | 'sui'

// The shared account descriptor, narrowed to the two fields this module can
// state without importing the explorer's identity graph. The service fills it
// with the full `accountRef()` object — identity, tag, icon and all — so a pill
// renders a bridge counterparty exactly as every other account surface does.
export interface WormholeAccountRef {
  accountId: string
  address: string
}

// One rate-limiter leg as a fuse: how much value may still cross before the
// limiter starts holding transfers, expressed at the Hydration asset's own
// precision whatever units the chain it was read from keeps it in.
export interface WormholeFuse {
  limit: string            // raw integer, asset decimals
  capacity: string         // live capacity now, raw, asset decimals
  utilizationPct: number   // (limit − capacity) / limit × 100, clamped 0…100
  durationSec: number      // the window the limit refills over, read not assumed
  lastConsumedAt: string | null
}

// The four legs an asset's transfers pass through. Direction names are
// Hydration-centric: `in` is the origin manager's OUTBOUND limiter (the peer
// chain letting value leave towards Hydration) and `out` is its INBOUND limiter
// (the release leg of a Hydration exit — the one that held sUSDS). The two
// local legs are read for honesty; Hydration's own managers are deliberately
// uncapped, so the origin side carries every real fuse.
export interface WormholeAssetLimits {
  in: WormholeFuse | null
  out: WormholeFuse | null
  localOut: WormholeFuse | null
  localIn: WormholeFuse | null
}

export interface WormholeAssetRow {
  assetId: string
  symbol: string
  decimals: number
  originChainId: number
  originChainName: string
  originToken: string | null
  manager: string
  mode: 'burning' | 'locking' | null
  pausedLocal: boolean | null
  pausedOrigin: boolean | null
  peer: string | null
  // Null where the origin chain is unconfigured or went unread this cycle.
  limits: WormholeAssetLimits | null
  // GROSS supply, exactly as `Tokens.TotalIssuance` / `totalSupply()` report it.
  issuance: string | null
  // The part of that supply sitting at the dead address (0x…dEaD), which the
  // parity equation subtracts: `locked = (issuance − burned) + inflightIn +
  // inflightOut + queued + residual`. Gap-closing mints are sent there, no key
  // exists for the account, so those tokens can never be bridged back and need
  // no custody. Null where the read failed; 0 for every asset with none.
  //
  // Distinct from `flows.burnedOut`, which counts supply burned by an OUTBOUND
  // bridge transfer — that one still has custody behind it on the origin chain.
  burned: string | null
  locked: string | null
  inflightIn: string | null
  inflightOut: string | null
  inflightCount: number | null
  // Held by the origin manager's inbound rate limiter. Null where the origin
  // could not be read, or where its family has no queue reader yet (Sui).
  queued: string | null
  queuedCount: number | null
  residual: string | null
  flows: { mintedIn: string; burnedOut: string; nonNtt: string | null }
  issuanceUsd: number | null
  lockedUsd: number | null
  residualUsd: number | null
  status: WormholeStatus
  statusDetail: string
  transfers14d: { out: number; in: number }
}

export interface WormholeInflightOp {
  id: string
  direction: 'in' | 'out'
  assetId: string | null
  symbol: string | null
  amount: string | null
  amountUsd: number | null
  fromChainId: number
  toChainId: number
  sequence: string
  sentAt: string | null
  sourceTx: string | null
}

export interface WormholeTransferRow {
  direction: 'in' | 'out'
  assetId: string
  symbol: string
  amount: string
  amountUsd: number | null
  account: string | null
  // Additive companion to `account`: the pill-ready descriptor, so the surface
  // renders an address the same way every other account surface does.
  accountRef: WormholeAccountRef | null
  counterpartyChainId: number
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  sequence: string | null
}

// A transfer the origin chain has redeemed but its rate limiter still holds.
// The digest is the NTT message identity the origin manager keys the queue by;
// it is not a transaction hash and no explorer resolves it.
export interface WormholeQueuedRelease {
  digest: string
  assetId: string
  symbol: string
  amount: string
  amountUsd: number | null
  chainId: number
  recipient: string | null
  queuedAt: string | null
  releasableAt: string | null
  releasable: boolean
}

export interface WormholeChainState {
  chainId: number
  name: string
  family: WormholeChainFamily
  configured: boolean
  ok: boolean
  asOf: string | null
}

export interface WormholeBridgeDetail {
  assets: WormholeAssetRow[]
  inflight: WormholeInflightOp[]
  queued: WormholeQueuedRelease[]
  recent: WormholeTransferRow[]
  totals: {
    lockedUsd: number | null
    issuanceUsd: number | null
    inflightUsd: number | null
    deficitUsd: number | null
    surplusUsd: number | null
  }
  chains: WormholeChainState[]
  scan: { configured: boolean; ok: boolean; asOf: string | null }
  hydrationChainId: number
  asOf: string | null
  indexedThrough: { block: number; at: string } | null
}

export interface WormholeSummary {
  assets: number
  lockedUsd: number | null
  issuanceUsd: number | null
  inflightCount: number | null
  inflightUsd: number | null
  queuedCount: number | null
  queuedUsd: number | null
  worstStatus: WormholeStatus
  deficitUsd: number | null
  surplusUsd: number | null
  asOf: string | null
}

// ───────────────────────────── chain identity ─────────────────────────────

// Hydration's own Wormhole chain id. Discovered per cycle from the managers'
// `chainId()` so a redeployment cannot silently invalidate it; this is only the
// value used until the first successful read.
export const HYDRATION_WORMHOLE_CHAIN_ID = 73

// Wormhole numbers chains itself. Only the family matters to the read recipes:
// Solana is chain 1, Sui is chain 21, and everything else Hydration carries is
// an EVM chain reachable by JSON-RPC. An unknown future id with a configured
// endpoint is treated as EVM rather than skipped.
export function wormholeChainFamily(chainId: number): WormholeChainFamily {
  if (chainId === 1) return 'solana'
  if (chainId === 21) return 'sui'
  return 'evm'
}

// ───────────────────────────── base58 ─────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = BASE58_ALPHABET[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out || '1'
}

export function base58Decode(value: string): Uint8Array | null {
  let n = 0n
  for (const c of value) {
    const i = BASE58_ALPHABET.indexOf(c)
    if (i < 0) return null
    n = n * 58n + BigInt(i)
  }
  const digits: number[] = []
  while (n > 0n) { digits.unshift(Number(n % 256n)); n /= 256n }
  let leading = 0
  for (const c of value) { if (c !== '1') break; leading++ }
  return new Uint8Array([...new Array<number>(leading).fill(0), ...digits])
}

// ───────────────────────────── hex helpers ─────────────────────────────

const stripHex = (hex: string): string => (hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex).toLowerCase()

export function hexToBytes(hex: string): Uint8Array {
  const body = stripHex(hex)
  if (body.length % 2 !== 0 || /[^0-9a-f]/.test(body)) return new Uint8Array()
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '0x'
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const bigintAt = (bytes: Uint8Array, offset: number, length: number): bigint => {
  let n = 0n
  for (let i = 0; i < length; i++) n = (n << 8n) | BigInt(bytes[offset + i] ?? 0)
  return n
}

// ─────────────────────── substrate storage keys ───────────────────────
// orml-tokens keys its currency maps with Twox64Concat over the SCALE-encoded
// u32 asset id. Reimplemented here rather than shared with securityService so
// the layout is pinned by this module's own tests.

const u32Le = (n: number): Uint8Array => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
const twox64Concat = (b: Uint8Array): Uint8Array => u8aConcat(xxhashAsU8a(b, 64), b)

export function storagePrefix(pallet: string, item: string): string {
  return u8aToHex(u8aConcat(xxhashAsU8a(pallet, 128), xxhashAsU8a(item, 128)))
}

export function tokensTotalIssuanceKey(assetId: number): string {
  return storagePrefix('Tokens', 'TotalIssuance') + u8aToHex(twox64Concat(u32Le(assetId))).slice(2)
}

// A u128 storage value is little-endian SCALE. An unreadable key must surface as
// null (unknown), never as 0n (a claim that the asset has no supply).
export function decodeU128Le(hex: string | null | undefined): bigint | null {
  if (!hex) return null
  const bytes = hexToBytes(hex)
  if (bytes.length < 16) return null
  let n = 0n
  for (let i = 15; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

export function decodeU32Le(hex: string | null | undefined): number | null {
  if (!hex) return null
  const bytes = hexToBytes(hex)
  if (bytes.length < 4) return null
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
}

// ─────────────────────── EVM call encoding ───────────────────────

export const EVM_SELECTOR = {
  mode: '0x295a5212',            // mode()
  token: '0xfc0c546a',           // token()
  chainId: '0x9a8a0592',         // chainId()
  isPaused: '0xb187bd26',        // isPaused()
  getPeer: '0xc128d170',         // getPeer(uint16)
  balanceOf: '0x70a08231',       // balanceOf(address)
  // IRateLimiter, from the verified NttManager ABI:
  //   getInboundQueuedTransfer(bytes32 digest)
  //     → (TrimmedAmount amount /*uint72*/, uint64 txTimestamp, address recipient)
  //   rateLimitDuration() → uint64 (seconds)
  getInboundQueuedTransfer: '0xfd96063c',
  rateLimitDuration: '0x74aa7bfc',
  // isMessageExecuted(bytes32 digest) → bool. The receiving manager's own record
  // that it consumed a message, and the only redemption authority that cannot
  // disagree with the custody balance read in the same pass.
  isMessageExecuted: '0x396c16b7',
  // Rate-limiter views. The `getCurrent*Capacity` pair is the only honest
  // source for headroom: the struct's own capacity field is the capacity AT THE
  // LAST TRANSFER and does not include the refill since. getOutboundLimitParams
  // is declared `pure` in the ABI even though it reads storage; it answers over
  // eth_call regardless.
  getCurrentOutboundCapacity: '0xf5cfec18',
  getOutboundLimitParams: '0x86e11ffa',
  getCurrentInboundCapacity: '0x02717250',
  getInboundLimitParams: '0xd788c147',
} as const

export function encodeGetPeer(chainId: number): string {
  return EVM_SELECTOR.getPeer + chainId.toString(16).padStart(64, '0')
}

export function encodeGetCurrentInboundCapacity(chainId: number): string {
  return EVM_SELECTOR.getCurrentInboundCapacity + chainId.toString(16).padStart(64, '0')
}

export function encodeGetInboundLimitParams(chainId: number): string {
  return EVM_SELECTOR.getInboundLimitParams + chainId.toString(16).padStart(64, '0')
}

export function encodeGetInboundQueuedTransfer(digest: string): string {
  return EVM_SELECTOR.getInboundQueuedTransfer + stripHex(digest).padStart(64, '0')
}

export function encodeIsMessageExecuted(digest: string): string {
  return EVM_SELECTOR.isMessageExecuted + stripHex(digest).padStart(64, '0')
}

export function encodeBalanceOf(address: string): string {
  return EVM_SELECTOR.balanceOf + stripHex(address).padStart(64, '0')
}

// eth_call results are 32-byte words. A missing/short/garbage answer is unknown,
// so every decoder below returns null rather than a plausible zero.
export function decodeUint(result: string | null | undefined): bigint | null {
  if (typeof result !== 'string' || !/^0x[0-9a-f]*$/i.test(result) || result.length < 4) return null
  try { return BigInt(result) } catch { return null }
}

export function decodeBool(result: string | null | undefined): boolean | null {
  const v = decodeUint(result)
  return v == null ? null : v !== 0n
}

export function decodeAddress(result: string | null | undefined): string | null {
  if (typeof result !== 'string') return null
  const body = stripHex(result)
  if (body.length < 64) return null
  return '0x' + body.slice(24, 64)
}

// NttManager.getPeer(uint16) returns (bytes32 peerAddress, uint8 tokenDecimals).
// The peer is a bytes32 because it must hold a Solana program id or a Sui object
// id as easily as an EVM address; narrowing happens per family, not here.
export interface NttPeer { address: string; decimals: number }
export function decodeGetPeer(result: string | null | undefined): NttPeer | null {
  if (typeof result !== 'string') return null
  const body = stripHex(result)
  if (body.length < 128) return null
  const address = '0x' + body.slice(0, 64)
  if (/^0x0+$/.test(address)) return null
  return { address, decimals: Number(BigInt('0x' + body.slice(64, 128))) }
}

// Hydration's per-asset ERC-20 precompile is 0x…0001 followed by the 4-byte
// big-endian asset id, so an NTT payload's sourceToken names the registry asset
// directly.
export function assetIdFromPrecompile(token: string): number | null {
  const body = stripHex(token).padStart(64, '0')
  if (!/^0{55}1[0-9a-f]{8}$/.test(body)) return null
  return Number.parseInt(body.slice(-8), 16)
}

// ─────────────────────── registry `wh` location ───────────────────────

// Wormhole-bridged assets carry a purely local X3 location:
//   X3(GeneralKey("wh"), GeneralIndex(<wormhole chain id>), GeneralKey(<32-byte token>))
// A GeneralKey's `data` is a fixed 32-byte field with `length` naming the real
// key size, so the padding has to come off before "wh" means anything.
export interface WormholeLocation { assetId: number; originChainId: number; originToken: string }

interface JunctionLike { __kind?: unknown; value?: unknown; data?: unknown; length?: unknown }

function generalKeyBytes(junction: JunctionLike, expected?: number): string | null {
  const padded = typeof junction.data === 'string' ? stripHex(junction.data) : null
  if (padded == null) return null
  const declared = typeof junction.length === 'number' ? junction.length : null
  const key = declared != null && declared * 2 <= padded.length ? padded.slice(0, declared * 2) : padded
  return expected == null || key.length === expected * 2 ? '0x' + key : null
}

export function parseWormholeLocation(argsJson: string): WormholeLocation | null {
  let parsed: unknown
  try { parsed = JSON.parse(argsJson) } catch { return null }
  const args = parsed as { assetId?: unknown; location?: { parents?: unknown; interior?: { __kind?: unknown; value?: unknown } } } | null
  const assetId = Number(args?.assetId)
  if (!Number.isSafeInteger(assetId)) return null
  const location = args?.location
  if (!location || location.parents !== 0) return null
  const interior = location.interior
  if (interior?.__kind !== 'X3' || !Array.isArray(interior.value) || interior.value.length !== 3) return null
  const [marker, chain, token] = interior.value as JunctionLike[]
  if (marker?.__kind !== 'GeneralKey' || generalKeyBytes(marker, 2) !== '0x7768') return null
  if (chain?.__kind !== 'GeneralIndex' || token?.__kind !== 'GeneralKey') return null
  const originChainId = Number(chain.value)
  const originToken = generalKeyBytes(token, 32)
  if (!Number.isSafeInteger(originChainId) || originChainId <= 0 || originToken == null) return null
  return { assetId, originChainId, originToken }
}

// A 32-byte origin token or peer handle rendered the way its own chain writes it:
// an EVM address is the low 20 bytes, a Solana account is base58 over all 32, and
// a Sui object id stays hex.
export function displayChainAddress(family: WormholeChainFamily, bytes32: string): string {
  const body = stripHex(bytes32).padStart(64, '0')
  if (family === 'solana') return base58Encode(hexToBytes(body))
  if (family === 'evm' && /^0{24}/.test(body)) return '0x' + body.slice(24)
  return '0x' + body
}

// ─────────────────────── NTT wire format ───────────────────────

export const TOPIC = {
  // Core bridge: LogMessagePublished(address indexed sender, uint64 sequence,
  // uint32 nonce, bytes payload, uint8 consistencyLevel)
  logMessagePublished: '0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2',
  // Transceiver: ReceivedMessage(bytes32 digest, uint16 emitterChainId,
  // bytes32 emitterAddress, uint64 sequence)
  receivedMessage: '0xf6fc529540981400dc64edf649eb5e2e0eb5812a27f8c81bac2c1d317e71a5f0',
  // NttManager: TransferRedeemed(bytes32 indexed digest)
  transferRedeemed: '0x504e6efe18ab9eed10dc6501a417f5b12a2f7f2b1593aed9b89f9bce3cf29a91',
  // NttManager: TransferSent(bytes32 recipient, bytes32 refundAddress,
  // uint256 amount, uint256 fee, uint16 recipientChain, uint64 msgSequence).
  // Its `msgSequence` is the manager's own counter, NOT the VAA sequence, so it
  // is only a cross-check; LogMessagePublished carries the VAA sequence.
  transferSent: '0xe54e51e42099622516fa3b48e9733581c9dbdcb771cafb093f745a0532a35982',
  // Governance actions on a manager, from the verified NttManager ABI. NTT uses
  // its own PausableUpgradeable, so the pair is Paused(bool)/NotPaused(bool) —
  // NOT OpenZeppelin's Paused(address)/Unpaused(address).
  paused: '0x0e2fb031ee032dc02d8011dc50b816eb450cf856abd8261680dac74f72165bd2',
  notPaused: '0xe11c2112add17fb763d3bd59f63b10429c3e11373da4fb8ef6725107a2fdc4b0',
  // OutboundTransferLimitUpdated(uint256 oldLimit, uint256 newLimit) — both
  // untrimmed to the token's own decimals by the emitter.
  outboundLimitUpdated: '0x7e3b0fc388be9d36273f66210aed83be975df3a9adfffa4c734033f498f362cd',
  // InboundTransferLimitUpdated(uint16 indexed chainId, uint256 oldLimit,
  // uint256 newLimit) — the peer chain is topic1, the limits are in data.
  inboundLimitUpdated: '0x739ed886fd81a3ddc9f4b327ab69152e513cd45b26fda0c73660eaca8e119301',
  // A transfer the manager's own rate limiter is holding for the refill window.
  // OutboundTransferQueued(uint64 queueSequence) names the manager's outbound
  // queue slot; InboundTransferQueued(bytes32 digest) names the message. Neither
  // carries the amount — the queue entry itself holds it, and reading it back
  // needs a chain call the ledger deliberately does not make.
  outboundTransferQueued: '0x69add1952a6a6b9cb86f04d05f0cb605cbb469a50ae916139d34495a9991481f',
  inboundTransferQueued: '0x7f63c9251d82a933210c2b6d0b0f116252c3c116788120e64e8e8215df6f3162',
} as const

const TRANSCEIVER_PREFIX = '9945ff10'
const NATIVE_TOKEN_TRANSFER_PREFIX = '994e5454'

export interface NativeTokenTransfer {
  trimmedAmount: bigint
  trimmedDecimals: number
  sourceToken: string
  recipient: string
  toChain: number
}

export interface NttTransceiverMessage {
  sourceManager: string
  recipientManager: string
  messageId: string
  sender: string
  transfer: NativeTokenTransfer
  // The encoded NttManagerMessage exactly as it sits on the wire. Every NTT
  // implementation keys its rate-limiter queue and its replay set by a digest
  // over these bytes, so they are carried through rather than re-encoded.
  managerMessage: string
}

export interface LogMessagePublished {
  emitter: string
  sequence: bigint
  nonce: number
  consistencyLevel: number
  payload: string
}

// The core bridge log's non-indexed words are (sequence, nonce, payload offset,
// consistencyLevel) followed by the length-prefixed payload.
export function parseLogMessagePublished(topics: readonly string[], data: string): LogMessagePublished | null {
  if (topics[0]?.toLowerCase() !== TOPIC.logMessagePublished || topics.length < 2) return null
  const emitter = decodeAddress(topics[1])
  const bytes = hexToBytes(data)
  if (emitter == null || bytes.length < 160) return null
  const sequence = bigintAt(bytes, 0, 32)
  const nonce = Number(bigintAt(bytes, 32, 32))
  const offset = Number(bigintAt(bytes, 64, 32))
  const consistencyLevel = Number(bigintAt(bytes, 96, 32))
  if (!Number.isSafeInteger(offset) || offset + 32 > bytes.length) return null
  const length = Number(bigintAt(bytes, offset, 32))
  if (!Number.isSafeInteger(length) || offset + 32 + length > bytes.length) return null
  return { emitter, sequence, nonce, consistencyLevel, payload: bytesToHex(bytes.subarray(offset + 32, offset + 32 + length)) }
}

// TransceiverMessage: prefix(4) ‖ sourceNttManager(32) ‖ recipientNttManager(32)
// ‖ u16 len ‖ NttManagerMessage ‖ u16 len ‖ transceiverPayload.
// NttManagerMessage: id(32) ‖ sender(32) ‖ u16 len ‖ NativeTokenTransfer.
// NativeTokenTransfer: prefix(4) ‖ decimals(1) ‖ u64 amount ‖ sourceToken(32)
// ‖ recipient(32) ‖ u16 toChain.
export function parseNttTransceiverMessage(payload: string): NttTransceiverMessage | null {
  const b = hexToBytes(payload)
  if (b.length < 4 || bytesToHex(b.subarray(0, 4)).slice(2) !== TRANSCEIVER_PREFIX) return null
  let o = 4
  const read = (n: number): Uint8Array | null => {
    if (o + n > b.length) return null
    const slice = b.subarray(o, o + n)
    o += n
    return slice
  }
  const sourceManager = read(32)
  const recipientManager = read(32)
  if (!sourceManager || !recipientManager) return null
  if (o + 2 > b.length) return null
  o += 2 // NttManagerMessage length; the fields below are self-describing
  const managerMessageStart = o
  const messageId = read(32)
  const sender = read(32)
  if (!messageId || !sender || o + 2 > b.length) return null
  const transferLength = (b[o] << 8) | b[o + 1]
  o += 2
  const body = read(transferLength)
  if (!body || body.length < 79) return null
  if (bytesToHex(body.subarray(0, 4)).slice(2) !== NATIVE_TOKEN_TRANSFER_PREFIX) return null
  return {
    sourceManager: bytesToHex(sourceManager),
    recipientManager: bytesToHex(recipientManager),
    messageId: bytesToHex(messageId),
    sender: bytesToHex(sender),
    managerMessage: bytesToHex(b.subarray(managerMessageStart, o)),
    transfer: {
      trimmedDecimals: body[4],
      trimmedAmount: bigintAt(body, 5, 8),
      sourceToken: bytesToHex(body.subarray(13, 45)),
      recipient: bytesToHex(body.subarray(45, 77)),
      toChain: (body[77] << 8) | body[78],
    },
  }
}

export interface ReceivedMessage { digest: string; emitterChainId: number; emitterAddress: string; sequence: bigint }

// Every field of ReceivedMessage is non-indexed, so the whole record is in `data`.
export function parseReceivedMessage(topics: readonly string[], data: string): ReceivedMessage | null {
  if (topics[0]?.toLowerCase() !== TOPIC.receivedMessage) return null
  const b = hexToBytes(data)
  if (b.length < 128) return null
  return {
    digest: bytesToHex(b.subarray(0, 32)),
    emitterChainId: Number(bigintAt(b, 32, 32)),
    emitterAddress: bytesToHex(b.subarray(64, 96)),
    sequence: bigintAt(b, 96, 32),
  }
}

// The identity a redemption is keyed by on both sides of the check: the VAA's
// (emitter chain, emitter address, sequence). Wormholescan and our own
// ReceivedMessage rows must agree on it byte for byte.
export function vaaKey(emitterChainId: number, emitterAddress: string, sequence: bigint | string): string {
  return `${emitterChainId}:${stripHex(emitterAddress).padStart(64, '0')}:${sequence.toString()}`
}

// ─────────────────────── rate-limiter queue ───────────────────────

// The NTT message digest: keccak256 over the source chain id as a big-endian
// uint16 followed by the encoded NttManagerMessage. It is the identity every
// receiving implementation keys by — the EVM manager's inbound queue map and
// the Solana program's InboxItem account both — and it is derived from the
// bytes the sending chain published, so it can be computed from our own
// indexed logs without asking the origin chain anything.
export function nttDigest(sourceChainId: number, managerMessage: string): string {
  const body = stripHex(managerMessage)
  if (!body.length || body.length % 2 !== 0) return ''
  return keccakAsHex('0x' + (sourceChainId & 0xffff).toString(16).padStart(4, '0') + body)
}

// NTT packs a trimmed amount into a single uint72: the uint64 value in the high
// bits, the decimals it is expressed at in the low byte.
export interface TrimmedAmount { amount: bigint; decimals: number }
export function unpackTrimmedAmount(packed: bigint): TrimmedAmount {
  return { amount: packed >> 8n, decimals: Number(packed & 0xffn) }
}

export interface InboundQueuedTransfer {
  amount: bigint
  trimmedDecimals: number
  txTimestampSec: number
  recipient: string
}

// getInboundQueuedTransfer returns a static tuple, so its three fields are three
// inline words. A zeroed struct means the digest is not queued — either it never
// was, or it has been released, which is permanent. An unreadable answer is
// null, so a failed call is retried rather than cached as settled.
export function decodeInboundQueuedTransfer(result: string | null | undefined): InboundQueuedTransfer | null {
  if (typeof result !== 'string') return null
  const body = stripHex(result)
  if (body.length < 192 || /[^0-9a-f]/.test(body.slice(0, 192))) return null
  const { amount, decimals } = unpackTrimmedAmount(BigInt('0x' + body.slice(0, 64)))
  return {
    amount,
    trimmedDecimals: decimals,
    txTimestampSec: Number(BigInt('0x' + body.slice(64, 128))),
    recipient: '0x' + body.slice(152, 192),
  }
}

// ─────────────────────── rate-limiter fuses ───────────────────────

// Every NTT leg on every chain runs the same limiter: a linear refill of the
// whole limit over `rateLimitDuration`. A transfer larger than the headroom is
// HELD — for a flat duration, and only if the sender asked to queue on the
// outbound side — rather than consuming what is left, so a queued transfer
// never draws down capacity. A send also BACKFILLS the opposite direction, so
// the two legs of one manager move together.
export const RATE_LIMIT_REFILL_SEC = 86_400

export interface RateLimitParams {
  limit: bigint            // trimmed amount, at `limitDecimals`
  limitDecimals: number
  capacityAtLastTx: bigint // trimmed amount at the same decimals
  lastTxSec: number
}

// getOutboundLimitParams()/getInboundLimitParams(uint16) return a static struct,
// so its three fields are three inline words: two packed TrimmedAmounts and the
// uint64 timestamp of the last transfer that moved this leg.
export function decodeRateLimitParams(result: string | null | undefined): RateLimitParams | null {
  if (typeof result !== 'string') return null
  const body = stripHex(result)
  if (body.length < 192 || /[^0-9a-f]/.test(body.slice(0, 192))) return null
  const limit = unpackTrimmedAmount(BigInt('0x' + body.slice(0, 64)))
  const capacity = unpackTrimmedAmount(BigInt('0x' + body.slice(64, 128)))
  // A leg that was never configured packs a null TrimmedAmount (0 decimals and
  // 0 amount); reporting it as a zero-capacity fuse would read as fully spent.
  if (limit.decimals === 0 && limit.amount === 0n) return null
  return {
    limit: limit.amount,
    limitDecimals: limit.decimals,
    capacityAtLastTx: capacity.amount,
    lastTxSec: Number(BigInt('0x' + body.slice(128, 192))),
  }
}

// The limiter's own capacity formula. Solana and Sui expose only the stored
// capacity-at-last-transfer, so the live figure has to be recomputed the way the
// contract does: refill linearly since the last transfer, never past the limit,
// and never below the stored value (a clock behind the chain's must not read as
// a spent fuse).
export function liveCapacity(input: {
  capacityAtLastTx: bigint
  limit: bigint
  lastTxSec: number
  nowSec: number
  durationSec: number
}): bigint {
  if (input.durationSec <= 0) return input.limit
  const elapsed = BigInt(Math.max(0, Math.floor(input.nowSec) - Math.floor(input.lastTxSec)))
  const refilled = input.capacityAtLastTx + (input.limit * elapsed) / BigInt(Math.floor(input.durationSec))
  return refilled > input.limit ? input.limit : refilled
}

// A fuse stated at the Hydration asset's precision. `limitRaw` and `capacityRaw`
// arrive at whatever precision their chain keeps them in — an EVM trimmed limit
// untrimmed to the origin token's decimals, a Solana account's native mint
// units, a Sui object's native units — and are rescaled once, here.
export function buildFuse(input: {
  limitRaw: bigint | null
  capacityRaw: bigint | null
  sourceDecimals: number
  assetDecimals: number
  durationSec: number
  lastConsumedSec: number | null
}): WormholeFuse | null {
  if (input.limitRaw == null || input.capacityRaw == null || input.limitRaw <= 0n) return null
  const limit = rescaleAmount(input.limitRaw, input.sourceDecimals, input.assetDecimals)
  const capacity = rescaleAmount(input.capacityRaw, input.sourceDecimals, input.assetDecimals)
  if (limit <= 0n) return null
  const consumedBp = Number(((input.limitRaw - input.capacityRaw) * 1_000_000n) / input.limitRaw) / 10_000
  return {
    limit: limit.toString(),
    capacity: capacity.toString(),
    utilizationPct: Math.min(100, Math.max(0, consumedBp)),
    durationSec: input.durationSec,
    lastConsumedAt: input.lastConsumedSec != null && input.lastConsumedSec > 0
      ? new Date(Math.floor(input.lastConsumedSec) * 1000).toISOString()
      : null,
  }
}

// ─────────────────── Solana rate-limit accounts ───────────────────

// Two tiny accounts per manager program, found by their Anchor discriminators
// rather than a derived address. The outbox one is the program's own outbound
// leg; there is exactly one inbox one because every manager registers exactly
// one peer — Hydration.
export const SOLANA_OUTBOX_RATE_LIMIT_DISCRIMINATOR = '5a3600482fba1b58' // account:OutboxRateLimit
export const SOLANA_OUTBOX_RATE_LIMIT_LENGTH = 32                        // disc ‖ RateLimitState
export const SOLANA_INBOX_RATE_LIMIT_DISCRIMINATOR = 'efd0e8ca4a07ebfc'  // account:InboxRateLimit
export const SOLANA_INBOX_RATE_LIMIT_LENGTH = 33                         // disc ‖ bump ‖ RateLimitState

export interface NttRateLimitState { limit: bigint; capacityAtLastTx: bigint; lastTxSec: number }

// RateLimitState is three little-endian 64-bit fields — limit, capacity at the
// last transfer, and the last transfer's UNIX time in SECONDS — in native mint
// units. `offset` is where the state starts: straight after the discriminator
// for the outbox account, one byte later for the inbox one's bump.
export function parseNttRateLimitState(bytes: Uint8Array, offset: number): NttRateLimitState | null {
  if (bytes.length < offset + 24) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    limit: view.getBigUint64(offset, true),
    capacityAtLastTx: view.getBigUint64(offset + 8, true),
    lastTxSec: Number(view.getBigInt64(offset + 16, true)),
  }
}

// ─────────────────────── Sui rate limit ───────────────────────

// Sui keeps the same three fields as decimal strings and stamps the timestamp in
// MILLISECONDS — its window is 86,400,000 ms, the same 24 hours every other leg
// refills over. The outbound leg sits inline on the manager's state object; the
// inbound one lives on the peer entry for Hydration in the state's peers table.
export function parseSuiRateLimit(json: unknown): NttRateLimitState | null {
  const raw = json as { limit?: unknown; capacity_at_last_tx?: unknown; last_tx_timestamp?: unknown } | null
  if (!raw || typeof raw !== 'object') return null
  const num = (v: unknown): bigint | null => {
    if (typeof v !== 'string' && typeof v !== 'number') return null
    try { return BigInt(v) } catch { return null }
  }
  const limit = num(raw.limit)
  const capacity = num(raw.capacity_at_last_tx)
  const lastMs = num(raw.last_tx_timestamp)
  if (limit == null || capacity == null) return null
  return { limit, capacityAtLastTx: capacity, lastTxSec: lastMs == null ? 0 : Number(lastMs / 1000n) }
}

// The peer entry Hydration is registered under, out of the peers table's
// dynamic fields. The field name is the peer's Wormhole chain id.
export interface SuiPeerEntry { tokenDecimals: number | null; inboundRateLimit: NttRateLimitState | null }

export function parseSuiPeerEntry(nodes: unknown, chainId: number): SuiPeerEntry | null {
  if (!Array.isArray(nodes)) return null
  for (const node of nodes) {
    const entry = node as { name?: { json?: unknown }; value?: { json?: unknown } } | null
    if (Number(entry?.name?.json) !== chainId) continue
    const value = entry?.value?.json as { token_decimals?: unknown; inbound_rate_limit?: unknown } | null
    if (!value || typeof value !== 'object') return null
    return {
      tokenDecimals: Number.isSafeInteger(Number(value.token_decimals)) ? Number(value.token_decimals) : null,
      inboundRateLimit: parseSuiRateLimit(value.inbound_rate_limit),
    }
  }
  return null
}

// One entry of the Sui manager's inbox: a message it has accepted. The dynamic
// field's KEY carries the NttManagerMessage id (base64 32 bytes) and the source
// chain, which is the identity our own indexed sends already carry — so an entry
// attributes back to a send without any amount or recipient matching. The value
// says whether the tokens have actually left custody yet.
export interface SuiInboxEntry { sourceChainId: number; messageId: string; released: boolean }

export function parseSuiInboxEntries(nodes: unknown): SuiInboxEntry[] {
  if (!Array.isArray(nodes)) return []
  const out: SuiInboxEntry[] = []
  for (const node of nodes) {
    const entry = node as {
      name?: { json?: { chain_id?: unknown; message?: { id?: { data?: unknown } } } }
      value?: { json?: { release_status?: { '@variant'?: unknown } } }
    } | null
    const data = entry?.name?.json?.message?.id?.data
    const sourceChainId = Number(entry?.name?.json?.chain_id)
    if (typeof data !== 'string' || !Number.isSafeInteger(sourceChainId)) continue
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length !== 32) continue
    out.push({
      sourceChainId,
      messageId: bytesToHex(new Uint8Array(bytes)),
      released: entry?.value?.json?.release_status?.['@variant'] === 'Released',
    })
  }
  return out
}

// ─────────────────── manager governance events ───────────────────

// A pause flip on a manager. Both events carry the resulting flag in data, but
// the topic already says which way it went, so the flag is only a cross-check.
export function parseNttPauseEvent(topics: readonly string[]): boolean | null {
  const topic = topics[0]?.toLowerCase()
  if (topic === TOPIC.paused) return true
  if (topic === TOPIC.notPaused) return false
  return null
}

export interface NttLimitUpdate {
  direction: 'outbound' | 'inbound'
  /** The peer the limit applies to, on the inbound event only. */
  peerChainId: number | null
  oldLimit: bigint
  newLimit: bigint
}

// Both limits are emitted UNTRIMMED, at the manager's own token decimals.
export function parseNttLimitUpdate(topics: readonly string[], data: string): NttLimitUpdate | null {
  const topic = topics[0]?.toLowerCase()
  const outbound = topic === TOPIC.outboundLimitUpdated
  if (!outbound && topic !== TOPIC.inboundLimitUpdated) return null
  const body = stripHex(data)
  if (body.length < 128 || /[^0-9a-f]/.test(body.slice(0, 128))) return null
  const peer = outbound ? null : decodeUint(topics[1])
  return {
    direction: outbound ? 'outbound' : 'inbound',
    peerChainId: peer == null ? null : Number(peer),
    oldLimit: BigInt('0x' + body.slice(0, 64)),
    newLimit: BigInt('0x' + body.slice(64, 128)),
  }
}

/** A transfer a manager's rate limiter has taken out of the flow. */
export interface NttQueuedTransfer {
  direction: 'outbound' | 'inbound'
  /** Outbound: the manager's own queue slot. Null on the inbound event. */
  sequence: bigint | null
  /** Inbound: the queued message's digest. Null on the outbound event. */
  digest: string | null
}

// Hydration's own managers are uncapped (limits at the u64 trimmed ceiling), so
// these logs do not exist here today. They are decoded anyway because the day a
// limit is set is exactly the day a held transfer must reach the ledger, and a
// silent parser is indistinguishable from a limiter that never engaged.
export function parseNttQueuedTransfer(topics: readonly string[], data: string): NttQueuedTransfer | null {
  const topic = topics[0]?.toLowerCase()
  const outbound = topic === TOPIC.outboundTransferQueued
  if (!outbound && topic !== TOPIC.inboundTransferQueued) return null
  const body = stripHex(data)
  if (body.length < 64 || /[^0-9a-f]/.test(body.slice(0, 64))) return null
  const word = body.slice(0, 64)
  return outbound
    ? { direction: 'outbound', sequence: BigInt('0x' + word), digest: null }
    : { direction: 'inbound', sequence: null, digest: '0x' + word }
}

// ─────────────────────── de-trim arithmetic ───────────────────────

const pow10 = (n: number): bigint => 10n ** BigInt(n)

// NTT trims every payload amount to min(8, localDecimals, peerDecimals) so the
// same integer survives a hop between chains of different precision.
export function trimmedDecimalsFor(localDecimals: number, peerDecimals: number | null): number {
  return Math.min(8, localDecimals, peerDecimals ?? localDecimals)
}

// Restore a trimmed payload amount to the asset's own precision. Trimming only
// ever removes low-order digits, so widening is exact.
export function deTrim(trimmedAmount: bigint, trimmedDecimals: number, assetDecimals: number): bigint {
  return rescaleAmount(trimmedAmount, trimmedDecimals, assetDecimals)
}

// Move a raw integer between two decimal scales. Widening is exact; narrowing
// truncates, which only happens when an origin token carries more precision than
// the Hydration asset — the direction that cannot invent backing.
export function rescaleAmount(raw: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals === fromDecimals) return raw
  if (toDecimals > fromDecimals) return raw * pow10(toDecimals - fromDecimals)
  return raw / pow10(fromDecimals - toDecimals)
}

// ─────────────────────── backing classification ───────────────────────

// The band inside which a difference is noise rather than a finding: 100 units
// of the payload's trimmed precision, at least the raw equivalent of one dollar,
// and never zero.
export function backingTolerance(decimals: number, priceUsd: number | null): bigint {
  let tol = 100n * pow10(Math.max(0, decimals - 8))
  if (priceUsd != null && Number.isFinite(priceUsd) && priceUsd > 0) {
    const priceMicros = BigInt(Math.max(1, Math.round(priceUsd * 1_000_000)))
    const dollar = (pow10(decimals) * 1_000_000n) / priceMicros
    if (dollar > tol) tol = dollar
  }
  return tol > 0n ? tol : 1n
}

const MINOR_DEFICIT_USD = 100
const MINOR_DEFICIT_PERMILLE_OF_ISSUANCE = 1n // 0.1% expressed as 1/1000

export interface BackingInput {
  locked: bigint | null
  issuance: bigint | null
  // Supply sent to the dead address (0x…dEaD) to close a gap. `Tokens.TotalIssuance`
  // and `totalSupply()` both still count it, but no key exists for that account, so
  // it can never be bridged back and needs no custody behind it. Subtracting it is
  // what makes the parity equation state CIRCULATING supply. Null (unread) is not
  // zero: it leaves the equation on gross issuance, which under-states the residual
  // and can only make a row look worse, never better.
  //
  // NOT the same thing as `flows.burnedOut`, which is supply burned by an OUTBOUND
  // bridge transfer and does have custody behind it. Every sentence about this term
  // says "burned at the dead address" for exactly that reason.
  burned: bigint | null
  inflightIn: bigint | null
  inflightOut: bigint | null
  // Redeemed at the peer but still held by its inbound rate limiter. Unknown
  // (null) counts as nothing queued, which under-subtracts and therefore only
  // widens a surplus — it can never manufacture a deficit.
  queued: bigint | null
  decimals: number
  /** Ticker, so a verdict that names an amount reads as an amount of something. */
  symbol: string
  priceUsd: number | null
  originConfigured: boolean
  // Whether `locked` was read from the origin chain on THIS cycle. A chain that
  // failed to answer keeps its last balance rather than blanking the row, which
  // is the right call for the surplus side and not for the shortfall side — see
  // the guard in `classifyBacking`.
  custodyFresh: boolean
  scanEnabled: boolean
  lookbackDays: number
  // Whether a shortfall has been read on two consecutive cycles. Every input to
  // this equation is sampled from a different place — issuance from chain state,
  // redemptions from the indexed logs, custody from the origin chain — and a
  // sample skew of seconds shows up as a shortfall the size of one transfer. A
  // real shortfall persists; a skew does not, so a single-cycle reading is
  // reported as unconfirmed rather than as a finding. Upgrades are immediate:
  // only the downgrade waits.
  downgradeConfirmed: boolean
}

export interface BackingVerdict {
  status: WormholeStatus
  residual: bigint | null
  detail: string
}

// A raw amount for a sentence, at the precision its magnitude deserves — the
// same rule the Security ledger's amounts follow.
function humanAmount(raw: bigint, decimals: number): string {
  const value = Number(raw) / 10 ** decimals
  return value.toLocaleString('en-US', { maximumFractionDigits: value >= 1000 ? 0 : value >= 1 ? 2 : 6 })
}

const rawToUsd = (raw: bigint, decimals: number, priceUsd: number | null): number | null => {
  if (priceUsd == null || !Number.isFinite(priceUsd)) return null
  const amount = Number(raw) / 10 ** decimals
  return Number.isFinite(amount) ? amount * priceUsd : null
}

// The one place a backing verdict is decided. Unknown inputs never become zero:
// an unread custody balance is 'unconfigured', not a total deficit.
export function classifyBacking(input: BackingInput): BackingVerdict {
  const { locked, issuance, inflightIn, inflightOut, decimals, priceUsd, originConfigured, scanEnabled } = input
  if (!originConfigured) {
    return { status: 'unconfigured', residual: null, detail: 'The origin chain is not configured on this deployment, so custody could not be read.' }
  }
  if (locked == null || issuance == null) {
    return { status: 'unconfigured', residual: null, detail: 'Custody or issuance could not be read this cycle, so backing is unknown rather than balanced.' }
  }
  const tol = backingTolerance(decimals, priceUsd)
  // Queued and outbound in-flight have identical sign logic: the supply is
  // already burned here while the custody backing it has not left the origin.
  const queued = input.queued ?? 0n
  // What the equation is actually about: supply that could still come back for
  // its custody. Tokens at the burn address cannot.
  const burnedAtDead = input.burned ?? 0n
  const circulating = issuance - burnedAtDead
  // Stated wherever a verdict is, because it is the difference between the
  // supply figure the page shows and the one the equation used. Always spelled
  // out in full: a bare "burned" would read as an outbound bridge burn.
  const burnedNote = burnedAtDead > 0n
    ? ` ${humanAmount(burnedAtDead, decimals)} ${input.symbol} burned at the dead address are excluded.`
    : ''

  if (!scanEnabled || inflightIn == null || inflightOut == null) {
    const gap = locked - circulating - queued
    if (gap > tol) {
      return { status: 'surplus', residual: gap, detail: `Custody exceeds minted supply, which is the safe direction; in-flight transfers are not being checked on this deployment.${burnedNote}` }
    }
    if (gap < -tol) {
      return { status: 'unverified', residual: gap, detail: `Minted supply exceeds custody, but in-flight transfers are not being checked, so this may simply be a transfer that has not settled yet.${burnedNote}` }
    }
    return { status: 'ok', residual: gap, detail: `Custody matches minted supply; in-flight transfers are not being checked on this deployment.${burnedNote}` }
  }

  const unconfirmed = 'A shortfall was read once and has not been confirmed by a second reading yet, so it is more likely a transfer caught mid-settlement than a gap in backing.'

  const residual = locked - circulating - inflightIn - inflightOut - queued
  // A transfer older than the lookback is invisible in BOTH directions, and both
  // blind directions push the residual up, so an aged stuck transfer degrades to
  // a visible surplus and can never mask a deficit.
  const window = `Transfers are followed for ${input.lookbackDays} days; anything older shows up as surplus, never as a shortfall.${burnedNote}`
  if (residual > tol) {
    return { status: 'surplus', residual, detail: `Custody exceeds what the minted supply and in-flight transfers require. ${window}` }
  }
  if (residual >= -tol) {
    return { status: 'ok', residual, detail: `Custody covers the minted supply and every transfer still in flight. ${window}` }
  }
  // A shortfall measured against a balance this cycle could not read is not a
  // finding. The carried-over custody figure and the freshly read supply state
  // different moments, and the read that failed is the same one that says which
  // transfers the origin has already unlocked — so the two halves of the
  // equation degrade in opposite directions and the gap between them looks
  // exactly like missing backing.
  if (!input.custodyFresh) {
    return {
      status: 'unverified',
      residual,
      detail: `Custody could not be read this cycle, so this shortfall stands against the last balance the origin chain reported rather than a current one.${burnedNote}`,
    }
  }
  // One cycle is not a finding: hold the row on the safe side of the line and
  // say why, rather than raising a shortfall the next cycle may erase.
  if (!input.downgradeConfirmed) return { status: 'ok', residual, detail: `${unconfirmed}${burnedNote}` }
  const shortfall = -residual
  const shortfallUsd = rawToUsd(shortfall, decimals, priceUsd)
  const minorByValue = shortfallUsd != null && shortfallUsd < MINOR_DEFICIT_USD
  // Measured against CIRCULATING supply, the same quantity the residual is:
  // supply sitting at the dead address would otherwise make a shortfall read as
  // a smaller share of the asset than it is.
  const minorByShare = circulating > 0n && shortfall * 1000n < circulating * MINOR_DEFICIT_PERMILLE_OF_ISSUANCE
  if (minorByValue && minorByShare) {
    return { status: 'attention', residual, detail: `Minted supply exceeds custody by a small amount. ${window}` }
  }
  return { status: 'deficit', residual, detail: `Minted supply exceeds custody, so part of the supply is not backed. ${window}` }
}

const STATUS_SEVERITY: Record<WormholeStatus, number> = {
  deficit: 5,
  attention: 4,
  unverified: 3,
  unconfigured: 2,
  surplus: 1,
  ok: 0,
}

export function worstStatus(statuses: readonly WormholeStatus[]): WormholeStatus {
  let worst: WormholeStatus = 'ok'
  for (const s of statuses) if (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst]) worst = s
  return worst
}

// ─────────────────────── Solana NTT config ───────────────────────

// The manager program's single config account, found by its Anchor
// discriminator rather than a derived address, so no PDA derivation is needed.
export const SOLANA_NTT_CONFIG_DISCRIMINATOR = '9b0caae01efacc82'
export const SOLANA_NTT_CONFIG_LENGTH = 192

export interface SolanaNttConfig {
  mint: string
  mode: number
  chainId: number
  paused: boolean
  custody: string
}

// Fixed byte layout of the config account: [42..74] mint, [106] mode
// (0 = LOCKING), [107..109] chain id u16 BE, [127] paused, [128..160] custody
// token account.
export function parseSolanaNttConfig(bytes: Uint8Array): SolanaNttConfig | null {
  if (bytes.length < 160) return null
  return {
    mint: base58Encode(bytes.subarray(42, 74)),
    mode: bytes[106],
    chainId: (bytes[107] << 8) | bytes[108],
    paused: bytes[127] !== 0,
    custody: base58Encode(bytes.subarray(128, 160)),
  }
}

// The manager program's per-transfer inbox record, one account per redeemed
// inbound message. Both discriminators are the Anchor default — the first eight
// bytes of sha256("account:<TypeName>") — so they identify the account type
// without an IDL and without deriving any PDA.
export const SOLANA_NTT_INBOX_ITEM_DISCRIMINATOR = 'ed8dcc67bb7a395c' // account:InboxItem
export const SOLANA_NTT_INBOX_ITEM_LENGTH = 75

// Anchor lays the account out in declaration order:
//   [0..8] discriminator, [8] init, [9] bump, [10..18] amount u64 LE (in the
//   ORIGIN mint's decimals), [18..50] recipient pubkey, [50..66] transceiver
//   vote bitmap, [66] release status, [67..75] the ReleaseAfter timestamp.
// Status 1 (ReleaseAfter) carries that timestamp; status 2 (Released) does not,
// and Borsh leaves the previous value in the tail rather than zeroing it, so the
// timestamp is only meaningful while the item is still queued.
export const SOLANA_RELEASE_STATUS = { notApproved: 0, releaseAfter: 1, released: 2 } as const

export interface SolanaNttInboxItem {
  bump: number
  amount: bigint
  recipient: string
  status: number
  releaseAfterSec: number | null
}

export function parseSolanaInboxItem(bytes: Uint8Array): SolanaNttInboxItem | null {
  if (bytes.length < SOLANA_NTT_INBOX_ITEM_LENGTH) return null
  if (bytesToHex(bytes.subarray(0, 8)).slice(2) !== SOLANA_NTT_INBOX_ITEM_DISCRIMINATOR) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const status = bytes[66]
  return {
    bump: bytes[9],
    amount: view.getBigUint64(10, true),
    recipient: base58Encode(bytes.subarray(18, 50)),
    status,
    releaseAfterSec: status === SOLANA_RELEASE_STATUS.releaseAfter ? Number(view.getBigInt64(67, true)) : null,
  }
}

// ─────────────────────── Sui NTT state ───────────────────────

export interface SuiNttState {
  balance: bigint
  paused: boolean | null
  mode: string | null
  chainId: number | null
  inboxSize: number | null
  /** The manager's own outbound rate limiter, inline on the state object. */
  outboundRateLimit: NttRateLimitState | null
  /** Object id of the peers table; the inbound limiter lives on its entries. */
  peersTableId: string | null
  /** Object id of the inbox table; its entries are the messages accepted. */
  inboxTableId: string | null
}

export function parseSuiNttState(json: unknown): SuiNttState | null {
  const state = json as {
    balance?: unknown; paused?: unknown; mode?: unknown; chain_id?: unknown
    inbox?: unknown; outbox?: unknown; peers?: unknown
  } | null
  if (!state || typeof state !== 'object') return null
  const balance = typeof state.balance === 'string' || typeof state.balance === 'number' ? BigInt(state.balance) : null
  if (balance == null) return null
  const mode = state.mode as { '@variant'?: unknown } | null
  const inbox = state.inbox as { entries?: { size?: unknown; id?: unknown } } | null
  const inboxSize = Number(inbox?.entries?.size)
  const outbox = state.outbox as { rate_limit?: unknown } | null
  const peers = state.peers as { id?: unknown } | null
  const objectId = (v: unknown): string | null => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? v : null)
  return {
    balance,
    paused: typeof state.paused === 'boolean' ? state.paused : null,
    mode: typeof mode?.['@variant'] === 'string' ? mode['@variant'] : null,
    chainId: Number.isSafeInteger(Number(state.chain_id)) ? Number(state.chain_id) : null,
    inboxSize: Number.isSafeInteger(inboxSize) ? inboxSize : null,
    outboundRateLimit: parseSuiRateLimit(outbox?.rate_limit),
    peersTableId: objectId(peers?.id),
    inboxTableId: objectId(inbox?.entries?.id),
  }
}

// ─────────────────────── Wormholescan normalizer ───────────────────────

export interface NormalizedScanOp {
  id: string
  emitterChain: number
  emitterAddress: string
  sequence: string
  fromChain: number
  toChain: number
  sourceManager: string | null
  recipientManager: string | null
  trimmedAmount: bigint | null
  trimmedDecimals: number | null
  sentAt: string | null
  sourceTx: string | null
  redeemedByScan: boolean
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null)
const asChain = (v: unknown): number => (Number.isSafeInteger(Number(v)) ? Number(v) : 0)

// Wormholescan returns one row per operation STATE, so the same operation
// arrives several times; a row that carries `targetChain` is the redeemed view
// of it. Dedupe by id and let any redeemed row win, or a redeemed transfer looks
// pending purely because a stale row sorted last.
export function normalizeScanOperations(rows: readonly unknown[]): NormalizedScanOp[] {
  const byId = new Map<string, NormalizedScanOp>()
  for (const row of rows) {
    const op = row as {
      id?: unknown
      emitterChain?: unknown
      emitterAddress?: { hex?: unknown }
      sequence?: unknown
      targetChain?: unknown
      sourceChain?: { timestamp?: unknown; transaction?: { txHash?: unknown } }
      content?: {
        payload?: {
          transceiverMessage?: { sourceNttManager?: unknown; recipientNttManager?: unknown }
          nttMessage?: { trimmedAmount?: { amount?: unknown; decimals?: unknown } }
        }
        standarizedProperties?: { fromChain?: unknown; toChain?: unknown }
      }
    } | null
    const id = asString(op?.id)
    if (!id) continue
    const payload = op?.content?.payload
    const trimmed = payload?.nttMessage?.trimmedAmount
    const amountRaw = trimmed?.amount
    let trimmedAmount: bigint | null = null
    try { trimmedAmount = typeof amountRaw === 'string' || typeof amountRaw === 'number' ? BigInt(amountRaw) : null } catch { trimmedAmount = null }
    // "standarized" is Wormholescan's own spelling; do not correct it.
    const props = op?.content?.standarizedProperties
    const next: NormalizedScanOp = {
      id,
      emitterChain: asChain(op?.emitterChain),
      emitterAddress: stripHex(asString(op?.emitterAddress?.hex) ?? '').padStart(64, '0'),
      sequence: String(op?.sequence ?? ''),
      fromChain: asChain(props?.fromChain),
      toChain: asChain(props?.toChain),
      sourceManager: asString(payload?.transceiverMessage?.sourceNttManager),
      recipientManager: asString(payload?.transceiverMessage?.recipientNttManager),
      trimmedAmount,
      trimmedDecimals: Number.isSafeInteger(Number(trimmed?.decimals)) ? Number(trimmed?.decimals) : null,
      sentAt: asString(op?.sourceChain?.timestamp),
      sourceTx: asString(op?.sourceChain?.transaction?.txHash),
      redeemedByScan: op?.targetChain != null && typeof op.targetChain === 'object',
    }
    const prev = byId.get(id)
    if (!prev) { byId.set(id, next); continue }
    byId.set(id, {
      id,
      emitterChain: prev.emitterChain || next.emitterChain,
      emitterAddress: /[^0]/.test(prev.emitterAddress) ? prev.emitterAddress : next.emitterAddress,
      sequence: prev.sequence || next.sequence,
      fromChain: prev.fromChain || next.fromChain,
      toChain: prev.toChain || next.toChain,
      sourceManager: prev.sourceManager ?? next.sourceManager,
      recipientManager: prev.recipientManager ?? next.recipientManager,
      trimmedAmount: prev.trimmedAmount ?? next.trimmedAmount,
      trimmedDecimals: prev.trimmedDecimals ?? next.trimmedDecimals,
      sentAt: prev.sentAt ?? next.sentAt,
      sourceTx: prev.sourceTx ?? next.sourceTx,
      redeemedByScan: prev.redeemedByScan || next.redeemedByScan,
    })
  }
  return [...byId.values()]
}

// ─────────────────────── in-flight determination ───────────────────────

export interface ManagerFacts {
  assetId: number
  symbol: string
  decimals: number
  manager: string
  originChainId: number
  peerDecimals: number | null
}

export interface OutboundSend {
  sequence: string
  emitterAddress: string
  toChain: number
  assetId: number
  amount: bigint
  sentAtMs: number
  blockHeight: number
  txRef: string | null
  /** The NTT message identity the receiving chain records against. */
  digest: string
}

export interface InflightContext {
  hydrationChainId: number
  // 32-byte lowercase hex (0x-prefixed) of a manager on either side → the asset
  // it belongs to. Both the Hydration manager and the origin peer are keyed, so
  // an operation resolves whichever end Wormholescan names.
  assetByManager: Map<string, ManagerFacts>
  redeemedInbound: Set<string>
  outboundSends: readonly OutboundSend[]
  // Per target chain, the digests that chain's own manager says it has executed,
  // read in the same pass as its custody balance. This is the authority wherever
  // it is present: custody and redemption then move together, so the window in
  // which an unlock has reduced custody while the transfer still counts as in
  // flight — which reads as a deficit the size of that transfer — cannot open.
  // A chain absent from this map falls back to the counts below, then the scan.
  //
  // It carries only the digests THIS cycle asked about; one already resolved is
  // never asked again, so it is not a complete statement on its own.
  executedOutboundByChain?: Map<number, ReadonlySet<string>>
  // Every digest a target chain has confirmed executed, on this cycle or any
  // earlier one. An execution is permanent, so this outranks both the per-chain
  // sets and the scan: a chain that fails to answer must not un-resolve a
  // redemption already witnessed, or its unlock — which has already left the
  // custody balance the cycle carries over — is subtracted a second time as a
  // transfer still in flight.
  executedOutbound?: ReadonlySet<string>
  // Per target chain, how many of OUR sends that chain's own state says are
  // still unredeemed. Present only for chains Wormholescan cannot resolve (Sui);
  // absent means "trust the scan".
  unresolvedOutboundByChain?: Map<number, number>
  // VAA keys of our sends the origin's rate limiter is already holding. They are
  // redeemed, so they are not in flight, and the queued term already subtracts
  // them — counting them twice would subtract the same amount twice and raise a
  // deficit that does not exist.
  queuedOutbound?: ReadonlySet<string>
  nowMs: number
  lookbackMs: number
}

const managerKey = (value: string): string => '0x' + stripHex(value).padStart(64, '0')

// An operation Wormholescan cannot resolve is treated as REDEEMED, never as
// in flight: an over-counted in-flight amount subtracts from the residual and
// would raise a deficit that does not exist, while an under-counted one only
// widens the surplus.
export function decideInflight(ops: readonly NormalizedScanOp[], ctx: InflightContext): WormholeInflightOp[] {
  const out: WormholeInflightOp[] = []
  const cutoff = ctx.nowMs - ctx.lookbackMs

  for (const op of ops) {
    if (op.toChain !== ctx.hydrationChainId) continue
    const sentMs = op.sentAt ? Date.parse(op.sentAt) : NaN
    if (Number.isFinite(sentMs) && sentMs < cutoff) continue
    if (ctx.redeemedInbound.has(vaaKey(op.emitterChain, op.emitterAddress, op.sequence))) continue
    const facts = (op.recipientManager ? ctx.assetByManager.get(managerKey(op.recipientManager)) : null)
      ?? (op.sourceManager ? ctx.assetByManager.get(managerKey(op.sourceManager)) : null)
      ?? null
    const amount = facts && op.trimmedAmount != null && op.trimmedDecimals != null
      ? deTrim(op.trimmedAmount, op.trimmedDecimals, facts.decimals)
      : null
    out.push({
      id: op.id,
      direction: 'in',
      assetId: facts ? String(facts.assetId) : null,
      symbol: facts ? facts.symbol : null,
      amount: amount != null ? amount.toString() : null,
      amountUsd: null,
      fromChainId: op.fromChain || op.emitterChain,
      toChainId: op.toChain,
      sequence: op.sequence,
      sentAt: op.sentAt,
      sourceTx: op.sourceTx,
    })
  }

  const scanByKey = new Map<string, NormalizedScanOp>()
  for (const op of ops) scanByKey.set(vaaKey(op.emitterChain, op.emitterAddress, op.sequence), op)

  // Sends the target chain's own state says are still pending, newest first: the
  // chain reports a count, not identities, so the newest unmatched sends are the
  // ones still in flight.
  const pendingBudget = new Map<number, number>()
  for (const [chainId, count] of ctx.unresolvedOutboundByChain ?? []) pendingBudget.set(chainId, Math.max(0, count))

  const sends = [...ctx.outboundSends].sort((a, b) => b.sentAtMs - a.sentAtMs || Number(BigInt(b.sequence) - BigInt(a.sequence)))
  for (const send of sends) {
    if (send.sentAtMs < cutoff) continue
    const key = vaaKey(ctx.hydrationChainId, send.emitterAddress, send.sequence)
    if (ctx.queuedOutbound?.has(key)) continue
    if (ctx.executedOutbound?.has(send.digest)) continue
    const scanOp = scanByKey.get(key)
    let pending: boolean
    const executed = ctx.executedOutboundByChain?.get(send.toChain)
    if (executed) {
      pending = !executed.has(send.digest)
    } else if (ctx.unresolvedOutboundByChain?.has(send.toChain)) {
      const budget = pendingBudget.get(send.toChain) ?? 0
      pending = budget > 0
      if (pending) pendingBudget.set(send.toChain, budget - 1)
    } else {
      pending = scanOp != null && !scanOp.redeemedByScan
    }
    if (!pending) continue
    const facts = [...ctx.assetByManager.values()].find(f => f.assetId === send.assetId) ?? null
    out.push({
      id: scanOp?.id ?? `${ctx.hydrationChainId}/${stripHex(send.emitterAddress).padStart(64, '0')}/${send.sequence}`,
      direction: 'out',
      assetId: String(send.assetId),
      symbol: facts?.symbol ?? null,
      amount: send.amount.toString(),
      amountUsd: null,
      fromChainId: ctx.hydrationChainId,
      toChainId: send.toChain,
      sequence: send.sequence,
      sentAt: new Date(send.sentAtMs).toISOString(),
      sourceTx: send.txRef,
    })
  }

  out.sort((a, b) => (Date.parse(b.sentAt ?? '') || 0) - (Date.parse(a.sentAt ?? '') || 0))
  return out
}

// ─────────────────────── inbound mint matching ───────────────────────

export interface DepositCandidate { eventIndex: number; assetId: number; who: string; amount: bigint }

// An inbound redemption mints straight to the recipient with no marker of its
// own, and the same extrinsic can carry unrelated deposits of the SAME asset —
// the relayer's gas refund and the treasury's fee cut, both in WETH. The
// discriminator is the wire format: an NTT amount is a trimmed payload value
// widened back out, so it is always a whole multiple of the trim step, which a
// fee never is. Where several rows still qualify, the mint is the earliest.
export function matchInboundDeposit(
  candidates: readonly DepositCandidate[],
  assetId: number,
  assetDecimals: number,
  trimmedDecimals: number,
): DepositCandidate | null {
  const step = pow10(Math.max(0, assetDecimals - trimmedDecimals))
  const sameAsset = candidates.filter(c => c.assetId === assetId).sort((a, b) => a.eventIndex - b.eventIndex)
  const onStep = sameAsset.filter(c => c.amount > 0n && c.amount % step === 0n)
  return onStep[0] ?? sameAsset[0] ?? null
}

// ─────────────────────── environment ───────────────────────

// Optional JSON map of Wormhole chain id → endpoint. An absent or malformed
// value disables origin custody reads for the affected chains; it never fails
// startup, and no URL is ever logged.
export function parseOriginRpcUrls(raw: string | undefined): Map<number, string> {
  const out = new Map<number, string>()
  const value = raw?.trim()
  if (!value) return out
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    console.error('[wormhole] WORMHOLE_ORIGIN_RPC_URLS is not valid JSON; origin custody reads are disabled')
    return out
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[wormhole] WORMHOLE_ORIGIN_RPC_URLS must be a JSON object keyed by Wormhole chain id; origin custody reads are disabled')
    return out
  }
  for (const [key, url] of Object.entries(parsed as Record<string, unknown>)) {
    const chainId = Number(key)
    if (!Number.isSafeInteger(chainId) || chainId <= 0) continue
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) continue
    out.set(chainId, url.trim())
  }
  return out
}

// ─────────────────────── summary ───────────────────────

export function summarizeWormhole(detail: WormholeBridgeDetail | null): WormholeSummary | null {
  if (!detail) return null
  // The queue was read only where at least one asset came back with a figure;
  // otherwise "nothing queued" would be a claim nothing measured.
  const queuedKnown = detail.assets.some(a => a.queued != null)
  let queuedUsd: number | null = queuedKnown ? 0 : null
  if (queuedKnown) for (const q of detail.queued) if (q.amountUsd != null) queuedUsd = (queuedUsd ?? 0) + q.amountUsd
  return {
    assets: detail.assets.length,
    lockedUsd: detail.totals.lockedUsd,
    issuanceUsd: detail.totals.issuanceUsd,
    inflightCount: detail.scan.configured ? detail.inflight.length : null,
    inflightUsd: detail.totals.inflightUsd,
    queuedCount: queuedKnown ? detail.queued.length : null,
    queuedUsd,
    worstStatus: worstStatus(detail.assets.map(a => a.status)),
    deficitUsd: detail.totals.deficitUsd,
    surplusUsd: detail.totals.surplusUsd,
    asOf: detail.asOf,
  }
}
