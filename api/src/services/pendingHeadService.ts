import { ApiPromise, HttpProvider } from '@polkadot/api'
import { decodeAddress } from '@polkadot/util-crypto'
import { u8aToHex } from '@polkadot/util'
import type { ClickHouseClient } from '../db/client.ts'
import { SUBSTRATE_RPC_URL } from './substrateRpc.ts'

// The pending-head layer: the last few UNFINALIZED (best-head) blocks, decoded
// straight from the node and held in memory only. Feeds and detail lookups
// merge these rows in front of the finalized ClickHouse data so incoming
// blocks/extrinsics/events are visible ~40s before finality.
//
// Unfinalized data reorgs and may disappear — that is the contract here:
//  - NOTHING in this layer is ever written to ClickHouse or any other store.
//    The map is rebuilt from the node within seconds of an api restart.
//  - Blocks are keyed by height; a fork replaces the entry wholesale (detected
//    by a parent-hash mismatch, re-fetched with a bounded walk-back), and a
//    replaced row simply vanishes from the next feed response.
//  - Every tick prunes heights at or below the finalized-ingested checkpoint —
//    once ClickHouse serves a block, the pending copy is gone. A hard cap
//    bounds the map even if ingestion stalls.
// Correct counts are explicitly NOT a goal of this layer (totals, charts and
// classified activity stay finalized-only); its one job is showing the newest
// data fast and honestly marked.

const POLL_MS = 2_000
// The pool moves between blocks, so it gets its own much faster sweep than the
// block tick: a transaction is visible within a tenth of a second of the node
// accepting it. One `author_pendingExtrinsics` per sweep against the LOCAL
// node, re-entrancy guarded — a slow round trip delays the next sweep instead
// of stacking up. Detecting a change faster does not make changes more
// frequent: the generation counter (and with it every cache key and pushed
// frame) still moves only when the pool's membership actually does.
const MEMPOOL_POLL_MS = 100
const MAX_PENDING = 30
const WALKBACK_LIMIT = 12

// Economic legs extracted at decode time (while the Codec objects are still in
// hand — the display `args` are human-formatted and unusable for amounts).
// They feed the BASIC pending activity rows: trades folded from Broadcast
// swaps and plain transfers — deliberately not the full finalized classifier.
export interface PendingSwapLeg {
  swapper: string   // hex AccountId32
  inputs: { assetId: number; amount: string }[]
  outputs: { assetId: number; amount: string }[]
}
export interface PendingTransferLeg {
  from: string
  to: string
  assetId: number
  amount: string
}
// A money-market action, decoded from the Aave log the EVM emits. The topics
// and word offsets below were derived from this chain's own indexed events, not
// from a spec: every layout was checked against `raw_money_market_events` rows
// the indexer had already extracted (12 of 12 per action).
export interface PendingMmLeg {
  action: 'Supply' | 'Withdraw' | 'Borrow' | 'Repay' | 'LiquidationCall'
  assetAddress: string     // reserve H160 (collateral, for a liquidation)
  amount: string
  who: string              // user H160
}
// An outbound cross-chain send. The amounts here NAME the legs the message
// carries; which substrate asset each is comes from pairing them with the
// extrinsic's own Withdrawn events, exactly as the finalized classifier does.
export interface PendingXcmLeg {
  amounts: string[]
  feeAmounts: string[]     // the BuyExecution leg — plumbing, never the transfer
  destParaId: number | null
}
// A withdrawal from a local account: on its own it is plumbing, but it is what
// gives an XCM send its asset and amount.
export interface PendingWithdrawLeg {
  assetId: number
  amount: string
  who: string
}
export interface PendingEventRow {
  eventIndex: number
  extrinsicIndex: number | null
  name: string
  args: unknown
  swap?: PendingSwapLeg
  transfer?: PendingTransferLeg
  mm?: PendingMmLeg
  xcm?: PendingXcmLeg
  withdrawn?: PendingWithdrawLeg
}
export interface PendingExtrinsicRow {
  index: number
  hash: string
  callName: string
  signerId: string | null   // hex AccountId32, accountRef()-ready
  success: boolean
  tip: string | null
  version: number
  callArgs: unknown
  events: PendingEventRow[]
}
export interface PendingBlock {
  height: number
  hash: string
  parentHash: string
  timestamp: string          // 'YYYY-MM-DD HH:MM:SS' UTC, same shape as ClickHouse rows
  specVersion: number
  extrinsics: PendingExtrinsicRow[]
  events: PendingEventRow[]
}

let chClient: ClickHouseClient | null = null
let api: ApiPromise | null = null

// The connected node handle, or null while the service has not started and
// after the '[pending] disabled — RPC connection failed' path below. Exposed
// only so runtimeConstants.ts can read runtime METADATA constants (they are
// resident on this object; reading one is a property access, not a round trip)
// without opening a second connection to the node. Callers must treat null as
// "the chain cannot be consulted" and never as a value.
export function pendingNodeApi(): ApiPromise | null { return api }
let timer: NodeJS.Timeout | null = null
let poolTimer: NodeJS.Timeout | null = null
let ticking = false
let syncingPool = false
const byHeight = new Map<number, PendingBlock>()
let finalizedFloor = 0

// Reading the transaction pool is OPT-IN (EXPLORER_MEMPOOL=on|1|true|yes).
// Off, nothing below runs: no pool sweep, no dry runs, and every merge sees an
// empty map, so the feeds are exactly what they were before this layer. It is a
// deployment choice because it needs a node that answers `author_pendingExtrinsics`
// and the DryRunApi, and because what it shows are projections rather than
// chain facts — an operator should say yes to that on purpose.
export function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '')
}
const MEMPOOL_ENABLED = envFlag(process.env.EXPLORER_MEMPOOL)
export function mempoolEnabled(): boolean { return MEMPOOL_ENABLED }

// The transaction pool: signed extrinsics the node holds but no block carries
// yet. Each is dry-run against CURRENT state once (DryRunApi.dryRunCall with
// the signer's origin), which yields its PROJECTED outcome and events — real
// amounts for activity rows instead of call-args intent. Projections are
// clearly speculative: state moves between the dry run and inclusion, so rows
// derived here are marked `mempool` and replaced by the pending-block (and
// then finalized) versions as the transaction progresses. Entries leave the
// map the moment a pending block carries their hash, when the node drops
// them, or after a hard age cap — nothing here is ever stored.
export interface MempoolTx {
  hash: string
  callName: string
  signerId: string | null
  tip: string | null
  version: number
  callArgs: unknown
  firstSeen: string
  firstSeenMs: number
  // Dry-run projection: null = the projection was unavailable (no DryRunApi,
  // decode hiccup); the transaction still lists, only unjudged.
  success: boolean | null
  events: PendingEventRow[]
  // false = the node no longer reports it. That usually means "just included in
  // a block we have not fetched yet", so the entry survives a grace for
  // detail-by-hash lookups — the page a submitter is watching must not flash
  // "not found" during the pool→block handoff.
  inPool: boolean
  droppedAtMs: number | null
  // true once a pending block we hold carries the hash. From that moment the
  // unfinalized row IS the transaction and the pool copy must stay out of the
  // feeds, or the same transaction would be listed twice.
  carried: boolean
  // The signer's nonce. One account can have only ONE transaction at a given
  // nonce, so a second one with the same nonce is a REPLACEMENT (a fee bump, or
  // a correction), not a second intent. Without this the pool shows both and a
  // reader sees a duplicate.
  nonce: number | null
  // Set on the superseded transaction: the hash of the one that replaced it.
  // Its row goes immediately — a replaced transaction can never be included —
  // but the entry survives the drop grace so its own page can say what
  // happened instead of 404ing on the submitter watching it.
  replacedBy: string | null
}
const MEMPOOL_MAX_AGE_MS = 5 * 60_000
const MEMPOOL_DROP_GRACE_MS = 30_000
// A transaction the node has dropped but no block of ours carries yet is still
// shown, for this long. In the ordinary path this window is never reached: the
// node prunes its pool the instant it imports the block, we fetch that block
// immediately, and the row is retired as `carried` a few hundred milliseconds
// later. It only matters when the block does NOT arrive — and the measured
// reason for that is a reorg: a transaction whose block was orphaned leaves the
// node's pool and comes back, observed here as an 18-second absence before it
// was re-included. So the window is sized to outlast that rather than to
// outlast a block, and the cost is bounded: a transaction that really was
// dropped or replaced lingers this long, visibly waiting, and then goes.
const MEMPOOL_HANDOFF_MS = 20_000
// Each new pool entry costs one dry-run round trip, so a burst must not turn
// one sweep into hundreds of calls: admit at most this many new transactions
// per sweep (in pool order — oldest first), the rest on the next one. At the
// sweep rate above that is still a fast drain, and feeds show at most a page
// of pool rows anyway.
const MEMPOOL_ADMIT_PER_SWEEP = 8
const MEMPOOL_MAX_ENTRIES = 60
const DRY_RUN_XCM_VERSION = 4
const poolByHash = new Map<string, MempoolTx>()
let poolGeneration = 0

// What the feeds show as "in the pool": everything the node still lists, plus
// the ones it has just dropped while we race to fetch their block (see
// MEMPOOL_HANDOFF_MS). Never a transaction a pending block already carries —
// that one is an unfinalized row now.
// Kept pure and exported: this one predicate is the difference between the
// feeds showing a hole at inclusion and showing the same transaction twice.
export function poolRowVisible(tx: Pick<MempoolTx, 'inPool' | 'droppedAtMs' | 'carried' | 'replacedBy'>, now: number): boolean {
  if (tx.carried) return false
  // A replacement is not a second transaction — the nonce it shares can be used
  // once. Showing both is showing a duplicate, and the superseded one is the
  // copy that will never be included, so it stops being a row at once (its
  // entry lives on only to answer its own page).
  if (tx.replacedBy) return false
  return tx.inPool || now - (tx.droppedAtMs ?? 0) < MEMPOOL_HANDOFF_MS
}
export function mempoolTxs(): MempoolTx[] {
  const now = Date.now()
  return [...poolByHash.values()]
    .filter(tx => poolRowVisible(tx, now))
    .sort((a, b) => b.firstSeenMs - a.firstSeenMs)
}
export function mempoolGeneration(): number { return poolGeneration }
export function findMempoolTx(hash: string): MempoolTx | null {
  return poolByHash.get(hash.toLowerCase()) ?? null
}

// One account, one transaction per nonce. When two live pool entries share a
// signer and a nonce, the newer one replaced the older — the node keeps whichever
// it prefers (usually the higher tip) and the loser can never be included. Mark
// the loser rather than deleting it, so its own page can explain itself while
// its row disappears. Returns whether anything changed.
function resolveReplacements(): boolean {
  const byNonce = new Map<string, MempoolTx>()
  let changed = false
  for (const tx of poolByHash.values()) {
    if (tx.carried || tx.replacedBy || tx.signerId == null || tx.nonce == null) continue
    const key = `${tx.signerId}:${tx.nonce}`
    const rival = byNonce.get(key)
    if (!rival) { byNonce.set(key, tx); continue }
    // Newest wins: it is the one the sender sent last, and the one the node
    // will have kept. Ties cannot happen — two transactions cannot be first
    // seen in the same millisecond and share a hash.
    const [loser, winner] = rival.firstSeenMs < tx.firstSeenMs ? [rival, tx] : [tx, rival]
    loser.replacedBy = winner.hash
    if (loser.droppedAtMs == null) loser.droppedAtMs = Date.now()
    byNonce.set(key, winner)
    changed = true
  }
  return changed
}

function pendingBlocksCarry(hash: string): boolean {
  for (const b of byHeight.values()) if (b.extrinsics.some(e => e.hash === hash)) return true
  return false
}

// SQD naming: pallets capitalized, calls snake_case, events UpperCamel — match
// it so pending rows read identically to their finalized versions.
export function sqdCallName(section: string, method: string): string {
  const snake = method.replace(/([A-Z])/g, '_$1').toLowerCase()
  return `${section.charAt(0).toUpperCase()}${section.slice(1)}.${snake}`
}
export function sqdEventName(section: string, method: string): string {
  return `${section.charAt(0).toUpperCase()}${section.slice(1)}.${method}`
}

export function chTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

// A Vec of { asset, amount } structs (polkadot-js Structs extend Map).
function decodeAssetAmountVec(codec: unknown): { assetId: number; amount: string }[] {
  const out: { assetId: number; amount: string }[] = []
  for (const el of codec as Iterable<unknown>) {
    const m = el as Map<string, { toString(): string } | undefined>
    const assetId = Number(m.get('asset')?.toString())
    const amount = m.get('amount')?.toString()
    if (Number.isFinite(assetId) && amount) out.push({ assetId, amount })
  }
  return out
}

// Aave's event signatures, keyed by the topic0 this chain actually emits —
// read off 250k+ indexed money-market events rather than hashed from a
// signature string, so a mismatch is impossible by construction. `acct` and
// `asset` are topic indices, `word` the 32-byte word of `data` holding the
// amount. Liquidation reports the COLLATERAL seized (word 1), which is what the
// finalized row displays; its `debtToCover` (word 0) is a different asset's
// amount and would misprice the row.
const AAVE_LOG_TOPICS: Record<string, { action: PendingMmLeg['action']; acct: number; asset: number; word: number }> = {
  '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61': { action: 'Supply', acct: 2, asset: 1, word: 1 },
  '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7': { action: 'Withdraw', acct: 2, asset: 1, word: 0 },
  '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0': { action: 'Borrow', acct: 2, asset: 1, word: 1 },
  '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051': { action: 'Repay', acct: 2, asset: 1, word: 0 },
  '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286': { action: 'LiquidationCall', acct: 3, asset: 1, word: 1 },
}
function decodeAaveLog(logJson: unknown): PendingMmLeg | undefined {
  const log = logJson as { topics?: string[]; data?: string } | null
  const topics = log?.topics
  if (!Array.isArray(topics) || typeof log?.data !== 'string') return undefined
  const spec = AAVE_LOG_TOPICS[(topics[0] ?? '').toLowerCase()]
  if (!spec || topics.length <= Math.max(spec.acct, spec.asset)) return undefined
  const body = log.data.replace(/^0x/, '')
  const word = body.slice(spec.word * 64, spec.word * 64 + 64)
  if (word.length !== 64) return undefined
  return {
    action: spec.action,
    assetAddress: '0x' + topics[spec.asset].slice(-40),
    amount: BigInt('0x' + word).toString(),
    who: '0x' + topics[spec.acct].slice(-40),
  }
}

// Amounts a cross-chain message names, and which of them only pays for its own
// execution. polkadot-js renders a large integer as a hex string and a small
// one as a number, so both are normalized to decimal here — comparing these
// against the Withdrawn legs is how an XCM row gets its asset.
function collectXcmLegs(node: unknown, out: { amounts: string[]; feeAmounts: string[]; destParaId: number | null }, inFee = false): void {
  if (Array.isArray(node)) {
    for (const el of node) collectXcmLegs(el, out, inFee)
    return
  }
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const k = key.toLowerCase()
    if (k === 'parachain' && out.destParaId == null) {
      const id = Number(value)
      if (Number.isFinite(id)) out.destParaId = id
    }
    if (k === 'fungible') {
      let amount: string | null = null
      try {
        amount = typeof value === 'string' ? BigInt(value).toString()
          : typeof value === 'number' ? BigInt(Math.round(value)).toString() : null
      } catch { amount = null }
      if (amount) (inFee ? out.feeAmounts : out.amounts).push(amount)
      continue
    }
    collectXcmLegs(value, out, inFee || k === 'buyexecution' || k === 'fee' || k === 'fees')
  }
}

// Attach the economic leg an event carries, shared by real block events and
// dry-run projections (both decode to GenericEvent with positional data).
function attachEventLeg(row: PendingEventRow, section: string, method: string, dataCodec: unknown): void {
  try {
    const data = dataCodec as unknown as Array<{ toString(): string; toJSON?(): unknown }>
    if (section === 'broadcast' && method.startsWith('Swapped')) {
      // Positional layout: swapper, filler, fillerType, operation, inputs,
      // outputs, fees, operationStack.
      row.swap = {
        swapper: u8aToHex(decodeAddress(data[0].toString())),
        inputs: decodeAssetAmountVec(data[4]),
        outputs: decodeAssetAmountVec(data[5]),
      }
    } else if (section === 'balances' && method === 'Transfer') {
      row.transfer = {
        from: u8aToHex(decodeAddress(data[0].toString())),
        to: u8aToHex(decodeAddress(data[1].toString())),
        assetId: 0,
        amount: data[2].toString(),
      }
    } else if (section === 'tokens' && method === 'Transfer') {
      row.transfer = {
        from: u8aToHex(decodeAddress(data[1].toString())),
        to: u8aToHex(decodeAddress(data[2].toString())),
        assetId: Number(data[0].toString()),
        amount: data[3].toString(),
      }
    } else if (section === 'evm' && method === 'Log') {
      row.mm = decodeAaveLog(data[0]?.toJSON?.())
    } else if (section === 'tokens' && method === 'Withdrawn') {
      // Positional: currencyId, who, amount.
      row.withdrawn = {
        assetId: Number(data[0].toString()),
        amount: data[2].toString(),
        who: u8aToHex(decodeAddress(data[1].toString())),
      }
    } else if ((section === 'xTokens' && method.startsWith('Transferred')) || (section === 'polkadotXcm' && method === 'Sent')) {
      const legs = { amounts: [] as string[], feeAmounts: [] as string[], destParaId: null as number | null }
      for (const field of data) collectXcmLegs(field.toJSON?.(), legs)
      row.xcm = legs
    }
  } catch { /* an exotic layout — the row stays a plain event */ }
}

export function pendingBestHeight(): number {
  let best = 0
  for (const h of byHeight.keys()) if (h > best) best = h
  return best
}

// Pending blocks strictly above `aboveHeight`, newest first — callers pass the
// height ClickHouse already serves so the seam never duplicates a block.
export function pendingBlocksDesc(aboveHeight: number): PendingBlock[] {
  return [...byHeight.values()].filter(b => b.height > aboveHeight).sort((a, b) => b.height - a.height)
}

export function findPendingBlock(height: number): PendingBlock | null {
  return byHeight.get(height) ?? null
}

export function findPendingExtrinsic(height: number, index: number): { block: PendingBlock; ext: PendingExtrinsicRow } | null {
  const block = byHeight.get(height)
  const ext = block?.extrinsics.find(e => e.index === index)
  return block && ext ? { block, ext } : null
}

export function findPendingExtrinsicByHash(hash: string): { block: PendingBlock; ext: PendingExtrinsicRow } | null {
  const needle = hash.toLowerCase()
  for (const block of byHeight.values()) {
    const ext = block.extrinsics.find(e => e.hash === needle)
    if (ext) return { block, ext }
  }
  return null
}

// Prune everything the finalized pipeline now covers, plus enforce the hard
// cap (oldest first) so a stalled ingester cannot grow the map unboundedly.
export function prunePending(map: Map<number, PendingBlock>, floor: number, maxSize = MAX_PENDING): void {
  for (const h of [...map.keys()]) if (h <= floor) map.delete(h)
  if (map.size > maxSize) {
    const heights = [...map.keys()].sort((a, b) => a - b)
    for (const h of heights.slice(0, map.size - maxSize)) map.delete(h)
  }
}

async function fetchPendingBlock(height: number): Promise<PendingBlock | null> {
  if (!api) return null
  const blockHash = await api.rpc.chain.getBlockHash(height)
  if (blockHash.isEmpty) return null
  const hash = blockHash.toHex()
  const [signedBlock, apiAt, runtime] = await Promise.all([
    api.rpc.chain.getBlock(hash),
    api.at(hash),
    api.rpc.state.getRuntimeVersion(hash),
  ])
  // The api is created without chain-specific type augmentation, so storage
  // reads type as bare Codec; the System.Events record shape is stable.
  interface EventRecordLike {
    phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } }
    event: { section: string; method: string; data: { toHuman(): unknown } }
  }
  const eventsRaw = (await apiAt.query.system.events()) as unknown as EventRecordLike[]

  const events: PendingEventRow[] = []
  const successByExt = new Map<number, boolean>()
  eventsRaw.forEach((record, i) => {
    const extrinsicIndex = record.phase.isApplyExtrinsic ? record.phase.asApplyExtrinsic.toNumber() : null
    const name = sqdEventName(record.event.section, record.event.method)
    if (extrinsicIndex != null) {
      if (name === 'System.ExtrinsicSuccess') successByExt.set(extrinsicIndex, true)
      if (name === 'System.ExtrinsicFailed') successByExt.set(extrinsicIndex, false)
    }
    const row: PendingEventRow = { eventIndex: i, extrinsicIndex, name, args: record.event.data.toHuman() }
    attachEventLeg(row, record.event.section, record.event.method, record.event.data)
    events.push(row)
  })

  let timestampMs = Date.now()
  const extrinsics: PendingExtrinsicRow[] = signedBlock.block.extrinsics.map((ext, index) => {
    if (ext.method.section === 'timestamp' && ext.method.method === 'set') {
      const ms = Number(ext.method.args[0]?.toString() ?? 0)
      if (Number.isFinite(ms) && ms > 0) timestampMs = ms
    }
    let signerId: string | null = null
    if (ext.isSigned) {
      try { signerId = u8aToHex(decodeAddress(ext.signer.toString())) } catch { /* exotic address — leave unattributed */ }
    }
    const human = ext.method.toHuman() as { args?: unknown } | null
    return {
      index,
      hash: ext.hash.toHex().toLowerCase(),
      callName: sqdCallName(ext.method.section, ext.method.method),
      signerId,
      success: successByExt.get(index) ?? true,
      tip: ext.isSigned ? ext.tip.toString() : null,
      version: ext.version,
      callArgs: human?.args ?? null,
      events: events.filter(e => e.extrinsicIndex === index),
    }
  })

  return {
    height,
    hash: hash.toLowerCase(),
    parentHash: signedBlock.block.header.parentHash.toHex().toLowerCase(),
    timestamp: chTimestamp(timestampMs),
    specVersion: runtime.specVersion.toNumber(),
    extrinsics,
    events,
  }
}

async function tick(): Promise<void> {
  if (ticking || !api) return
  ticking = true
  try {
    // The finalized-ingested checkpoint is the floor: ClickHouse serves
    // everything at or below it, so those pending copies retire now.
    if (chClient) {
      try {
        const res = await chClient.query({
          query: `SELECT max(last_block) AS head FROM price_data.raw_ingestion_state`,
          format: 'JSONEachRow',
        })
        const floor = Number((await res.json<{ head: number | null }>())[0]?.head ?? 0)
        if (floor > finalizedFloor) finalizedFloor = floor
      } catch { /* keep the previous floor */ }
    }

    const bestHeader = await api.rpc.chain.getHeader()
    const best = bestHeader.number.toNumber()
    const from = Math.max(finalizedFloor + 1, pendingBestHeight() + 1, best - MAX_PENDING + 1)
    for (let h = from; h <= best; h++) {
      const block = await fetchPendingBlock(h)
      if (!block) break
      byHeight.set(h, block)
      // Retire the pool copies this block carries right now: the sweep runs on
      // its own timer, and a row listed as both pooled and unfinalized for even
      // one request is a duplicate a reader would notice.
      let retired = false
      for (const e of block.extrinsics) {
        const pooled = poolByHash.get(e.hash)
        if (pooled && !pooled.carried) { pooled.carried = true; retired = true }
      }
      if (retired) poolGeneration++
      // Fork detection: our stored parent must be this block's parent. On a
      // mismatch the stored ancestor belonged to a dropped fork — re-fetch it
      // (bounded), replacing the forked rows so they disappear from feeds.
      let child = block
      for (let steps = 0; steps < WALKBACK_LIMIT; steps++) {
        const parent = byHeight.get(child.height - 1)
        if (!parent || parent.hash === child.parentHash) break
        const refetched = await fetchPendingBlock(child.height - 1)
        if (!refetched) break
        byHeight.set(refetched.height, refetched)
        child = refetched
      }
    }

    prunePending(byHeight, finalizedFloor)
  } catch { /* transient RPC failure — next tick retries; stale pending rows prune as usual */ } finally {
    ticking = false
  }
}

async function syncMempool(): Promise<void> {
  if (!MEMPOOL_ENABLED || !api || syncingPool) return
  syncingPool = true
  try {
    await sweepMempool()
  } catch { /* transient RPC failure — the next sweep retries */ } finally {
    syncingPool = false
  }
}
async function sweepMempool(): Promise<void> {
  if (!api) return
  const pool = await api.rpc.author.pendingExtrinsics()
  const seen = new Set<string>()
  const admit: { hash: string; ext: unknown }[] = []
  let changed = false
  let fetchSoon = false
  for (const ext of pool) {
    if (!ext.isSigned) continue
    const hash = ext.hash.toHex().toLowerCase()
    seen.add(hash)
    const known = poolByHash.get(hash)
    if (known) {
      // Re-broadcast after a drop (or a reorg returning it to the pool).
      if (!known.inPool) { known.inPool = true; known.droppedAtMs = null; changed = true }
      continue
    }
    if (pendingBlocksCarry(hash)) continue
    if (poolByHash.size + admit.length >= MEMPOOL_MAX_ENTRIES) break
    admit.push({ hash, ext })
    if (admit.length >= MEMPOOL_ADMIT_PER_SWEEP) break
  }
  // The dry runs are independent, so they go out together rather than one
  // round trip after another.
  const built = await Promise.all(admit.map(a => buildMempoolTx(a.hash, a.ext)))
  for (const tx of built) { poolByHash.set(tx.hash, tx); changed = true }
  if (built.length && resolveReplacements()) changed = true
  for (const [hash, tx] of poolByHash) {
    // Age alone never removes a transaction the node still lists: the row would
    // vanish from the feeds while the pool it claims to mirror still holds it —
    // the same "data disappeared" the handoff window exists to prevent. Memory
    // is bounded by MEMPOOL_MAX_ENTRIES instead, and a long wait is worth
    // showing: the row says how long it has been waiting. (Measured dwell over
    // 35 transactions: median 3.1s, max 33.8s — so this backstop only ever
    // fires for something genuinely stuck.)
    if (!tx.inPool && Date.now() - tx.firstSeenMs > MEMPOOL_MAX_AGE_MS) {
      poolByHash.delete(hash)
      changed = true
      continue
    }
    // Included in a pending block, or simply no longer reported: either way it
    // leaves the feeds NOW (mempoolTxs filters on inPool) but stays findable by
    // hash through the grace. The pending-block and finalized rows take over
    // and are looked up first, so this copy only ever answers a gap — and the
    // gap is real: a block can be pruned at the finalized floor a moment
    // before ClickHouse serves that extrinsic.
    const carried = pendingBlocksCarry(hash)
    if (carried && !tx.carried) { tx.carried = true; changed = true }
    if (!seen.has(hash) || carried) {
      if (tx.inPool) {
        tx.inPool = false
        tx.droppedAtMs = Date.now()
        changed = true
        // The node prunes its pool when it IMPORTS the block carrying the
        // transaction, so a hash vanishing while we hold no such block means
        // that block exists at the node right now. Waiting out the block tick
        // leaves the row in neither feed for up to POLL_MS — measured at 1.2s.
        // Fetch immediately instead, so it moves pool -> unfinalized in one
        // step. tick() is re-entrancy guarded, and pool departures happen a
        // few times a block, so this costs nothing when nothing is leaving.
        if (!carried) fetchSoon = true
      } else if (Date.now() - (tx.droppedAtMs ?? 0) > MEMPOOL_DROP_GRACE_MS) {
        poolByHash.delete(hash)
        changed = true
      }
    }
  }
  if (changed) poolGeneration++
  if (fetchSoon) void tick()
}

interface PoolExtrinsicLike {
  method: { section: string; method: string; toHuman(): unknown }
  signer: { toString(): string }
  tip: { toString(): string }
  nonce: { toString(): string }
  version: number
}

async function buildMempoolTx(hash: string, extRaw: unknown): Promise<MempoolTx> {
  const ext = extRaw as PoolExtrinsicLike
  const now = Date.now()
  let signerId: string | null = null
  try { signerId = u8aToHex(decodeAddress(ext.signer.toString())) } catch { /* exotic address */ }
  const human = ext.method.toHuman() as { args?: unknown } | null
  let nonce: number | null = null
  try { nonce = Number(ext.nonce.toString()) } catch { /* exotic signature */ }
  const tx: MempoolTx = {
    hash,
    callName: sqdCallName(ext.method.section, ext.method.method),
    signerId,
    tip: ext.tip.toString(),
    version: ext.version,
    callArgs: human?.args ?? null,
    firstSeen: chTimestamp(now),
    firstSeenMs: now,
    success: null,
    events: [],
    inPool: true,
    droppedAtMs: null,
    carried: false,
    nonce: Number.isFinite(nonce) ? nonce : null,
    replacedBy: null,
  }
  if (!signerId) return tx
  try {
    // Dry-run the CALL with the signer's origin (not the signed extrinsic):
    // no nonce/fee gating, just the projected execution and its events.
    const dryRun = (api as unknown as { call: { dryRunApi?: { dryRunCall(origin: unknown, call: unknown, v: number): Promise<unknown> } } })
      .call.dryRunApi?.dryRunCall
    if (!dryRun) return tx
    const origin = api!.createType('HydradxRuntimeOriginCaller', { system: { Signed: signerId } })
    const res = await dryRun(origin, ext.method, DRY_RUN_XCM_VERSION) as {
      isOk: boolean
      asOk: {
        executionResult: { isOk: boolean }
        emittedEvents: Array<{ section: string; method: string; data: { toHuman(): unknown } }>
      }
    }
    if (res.isOk) {
      tx.success = res.asOk.executionResult.isOk
      res.asOk.emittedEvents.forEach((ev, i) => {
        const row: PendingEventRow = { eventIndex: i, extrinsicIndex: null, name: sqdEventName(ev.section, ev.method), args: ev.data.toHuman() }
        attachEventLeg(row, ev.section, ev.method, ev.data)
        tx.events.push(row)
      })
    }
  } catch { /* projection unavailable — the transaction lists unjudged */ }
  return tx
}

export function initPendingHeadService(c: ClickHouseClient): void {
  chClient = c
}

export function startPendingHeadService(): void {
  if (timer) return
  void ApiPromise.create({ provider: new HttpProvider(SUBSTRATE_RPC_URL), noInitWarn: true, throwOnConnect: false })
    .then(created => {
      api = created
      timer = setInterval(() => { void tick() }, POLL_MS)
      void tick()
      if (MEMPOOL_ENABLED) {
        poolTimer = setInterval(() => { void syncMempool() }, MEMPOOL_POLL_MS)
        void syncMempool()
      }
    })
    .catch(error => {
      // The explorer works without the pending layer — feeds simply start at
      // the finalized head, exactly as before this layer existed.
      console.error('[pending] disabled — RPC connection failed:', error instanceof Error ? error.message : error)
    })
}

export function stopPendingHeadService(): void {
  if (timer) { clearInterval(timer); timer = null }
  if (poolTimer) { clearInterval(poolTimer); poolTimer = null }
  byHeight.clear()
  poolByHash.clear()
  const a = api
  api = null
  if (a) void a.disconnect().catch(() => { /* closing */ })
}
