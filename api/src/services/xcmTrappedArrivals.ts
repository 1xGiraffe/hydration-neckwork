// Inbound XCM messages that FAILED here and left their assets in pallet_xcm's asset
// trap — a transfer that left its source chain and was never credited to anyone.
//
// The chain records only the trap: PolkadotXcm.AssetsTrapped (origin + assets) and a
// MessageQueue.Processed with success=false. Neither names the beneficiary, and the
// credit walk that builds inbound rows finds nothing to walk, so such a transfer was
// invisible: on no account, in no feed. The message itself is not lost, though — it
// travelled in the set_validation_data inherent of the block that enqueued it
// (horizontalMessages for a sibling, downwardMessages for the relay), so decoding it
// with the runtime's own types names the beneficiary and the fee asset it tried to
// buy execution with. That fee asset is the usual cause: a message whose BuyExecution
// offers an asset Hydration no longer accepts for fees (MultiTransactionPayment
// .AcceptedCurrencies — 36 were removed on 2026-10-16) stops there, and the whole
// holding register is trapped.
//
// Trapped assets can be claimed only by an XCM program from the SAME origin (the
// sending chain itself) carrying ClaimAsset — never by the beneficiary here.
//
// Rare (~1.3k since the MessageQueue migration) and immutable once ingested, so the
// whole set lives in memory, extended past a block watermark; the trap scan reads one
// event name off a 330 MiB table, the inherents a handful of primary-key blocks each.

import type { ClickHouseClient } from '../db/client.ts'
import { blake2AsHex } from '@polkadot/util-crypto'
import { hexToU8a } from '@polkadot/util'
import { pendingNodeApi } from './pendingHeadService.ts'

// MessageQueue era: the barrier names the origin and the message id. (Older barriers
// name neither, so their traps could not be tied to a message.)
const MESSAGE_QUEUE_MIGRATION_BLOCK = 5_433_625
// A message is serviced from the queue within a few blocks of the inherent that
// enqueued it; search that far back for it.
const ENQUEUE_SEARCH_BLOCKS = 10
const REFRESH_MS = 60_000

export interface TrappedAsset {
  /** Registry asset at the trapped location, null when none is registered there. */
  assetId: number | null
  amount: string
}
export interface TrappedArrival {
  blockHeight: number
  ts: string
  /** The AssetsTrapped event — the arrival's own (block, event) id. */
  eventIndex: number
  barrierEventIndex: number
  messageId: string | null
  originKind: 'Sibling' | 'Parent' | 'Other'
  originParaId: number | null
  assets: TrappedAsset[]
  /** Raw 32-byte account id the message deposited to (AccountKey20 → ETH-prefixed); null when undecoded. */
  beneficiary: string | null
  /** The asset its BuyExecution offered for fees, when the message was decoded. */
  feeAssetId: number | null
  /** Whether that asset was an accepted fee currency in the block before the failure. */
  feeAssetAccepted: boolean | null
}

// sqd's event JSON (`{__kind: 'X1', value: [...]}`) → the shape polkadot.js codecs take
// (`{x1: [...]}`): the same tree with enum variants as lower-camel keys.
export function sqdToCodecJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sqdToCodecJson)
  if (!v || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  if (typeof o.__kind === 'string') {
    const key = o.__kind.charAt(0).toLowerCase() + o.__kind.slice(1)
    if ('value' in o) return { [key]: sqdToCodecJson(o.value) }
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== '__kind').map(([k, x]) => [k, sqdToCodecJson(x)]))
    return { [key]: Object.keys(rest).length ? rest : null }
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, sqdToCodecJson(x)]))
}

// A location in the shape the registry's key takes: v3's single junction is an
// object, every later version's an array.
function normalizeLocation(loc: unknown): unknown {
  if (!loc || typeof loc !== 'object') return loc
  const l = loc as { parents?: unknown; interior?: Record<string, unknown> | string }
  if (l.interior && typeof l.interior === 'object' && 'x1' in l.interior && !Array.isArray(l.interior.x1)) {
    return { parents: l.parents, interior: { x1: [l.interior.x1] } }
  }
  return loc
}

// An asset's location from either era's id: v3 wraps it as {concrete: location}.
function assetIdLocation(id: unknown): unknown {
  if (id && typeof id === 'object' && 'concrete' in id) return (id as { concrete: unknown }).concrete
  return id
}

// Hydration's own assets as other chains name them: by GeneralIndex, either from
// here (`0, X1(GeneralIndex id)`) or from the relay (`1, X2(Parachain 2034,
// GeneralIndex id)`). The registry maps only FOREIGN locations, so native HDX (0)
// sent back from Bifrost had no asset at all.
const HYDRATION_PARA_ID = 2034
export function localAssetId(loc: unknown): number | null {
  const l = loc as { parents?: number; interior?: Record<string, unknown> } | null
  if (!l?.interior || typeof l.interior !== 'object') return null
  const junctions = (Object.values(l.interior)[0] ?? []) as unknown
  const list = (Array.isArray(junctions) ? junctions : [junctions]) as Record<string, unknown>[]
  const index = (j: Record<string, unknown> | undefined): number | null => {
    const v = j?.generalIndex
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
    return Number.isSafeInteger(n) ? n : null
  }
  if (l.parents === 0 && list.length === 1) return index(list[0])
  if (l.parents === 1 && list.length === 2 && Number(list[0]?.parachain) === HYDRATION_PARA_ID) return index(list[1])
  return null
}

type Instruction = Record<string, unknown>
/** What a decoded program says about its delivery: the beneficiary and the fee asset's location. */
export function programFacts(instructions: readonly Instruction[]): { beneficiary: string | null; feeLocation: unknown } {
  let beneficiary: string | null = null
  let feeLocation: unknown = null
  for (const ins of instructions) {
    // BuyExecution until v4; v5 programs may pay with PayFees instead.
    const buy = ins.buyExecution as { fees?: { id?: unknown } } | undefined
    const pay = ins.payFees as { asset?: { id?: unknown } } | undefined
    if (feeLocation == null && (buy || pay)) feeLocation = normalizeLocation(assetIdLocation(buy ? buy.fees?.id : pay?.asset?.id))
    const dep = ins.depositAsset as { beneficiary?: { parents?: number; interior?: Record<string, unknown> } } | undefined
    if (dep && beneficiary == null && dep.beneficiary?.parents === 0) {
      const x1 = dep.beneficiary.interior?.x1
      const j = (Array.isArray(x1) ? x1[0] : x1) as { accountId32?: { id?: string }; accountKey20?: { key?: string } } | undefined
      if (j?.accountId32?.id) beneficiary = j.accountId32.id.toLowerCase()
      else if (j?.accountKey20?.key) beneficiary = '0x45544800' + j.accountKey20.key.toLowerCase().slice(2) + '0'.repeat(16)
    }
  }
  return { beneficiary, feeLocation }
}

interface TrapRow { block_height: number; ts: string; event_index: number; args_json: string }
interface BarrierRow { block_height: number; event_index: number; success: number; message_id: string; origin_kind: string; origin_value: number }
interface InherentRow { block_height: number; hm: string; dm: string }

let arrivals: TrappedArrival[] = []
let watermark = MESSAGE_QUEUE_MIGRATION_BLOCK - 1
let lastRefresh = 0
let inflight: Promise<void> | null = null
const assetByLocation = new Map<string, number | null>()

async function rowsOf<T>(client: ClickHouseClient, query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await client.query({ query, query_params: params, format: 'JSONEachRow' })
  return res.json<T>()
}

async function refresh(client: ClickHouseClient): Promise<void> {
  const api = pendingNodeApi()
  if (!api) return // no decoder yet: try again on a later request
  await api.isReady
  const traps = await rowsOf<TrapRow>(client, `
    SELECT block_height, toString(block_timestamp) AS ts, event_index, any(args_json) AS args_json
    FROM price_data.raw_xcm_activity
    WHERE name = 'PolkadotXcm.AssetsTrapped' AND extrinsic_index IS NULL AND block_height > {wm:UInt32}
    GROUP BY block_height, ts, event_index
    ORDER BY block_height, event_index`, { wm: watermark })
  if (!traps.length) return
  const blocks = [...new Set(traps.map(t => t.block_height))]
  const barriers = await rowsOf<BarrierRow>(client, `
    SELECT block_height, event_index,
           toUInt8(JSONExtractBool(any(args_json), 'success')) AS success,
           JSONExtractString(any(args_json), 'id') AS message_id,
           JSONExtractString(any(args_json), 'origin', '__kind') AS origin_kind,
           JSONExtractUInt(any(args_json), 'origin', 'value') AS origin_value
    FROM price_data.raw_xcm_activity
    WHERE block_height IN ({blocks:Array(UInt32)}) AND name = 'MessageQueue.Processed' AND extrinsic_index IS NULL
    GROUP BY block_height, event_index`, { blocks })
  const barriersByBlock = new Map<number, BarrierRow[]>()
  for (const b of barriers) barriersByBlock.set(b.block_height, [...(barriersByBlock.get(b.block_height) ?? []), b])
  for (const list of barriersByBlock.values()) list.sort((a, b) => a.event_index - b.event_index)

  // A trap belongs to the first barrier after it; only a FAILED message lost its
  // transfer (a successful one traps at most an undeliverable fee remainder).
  const failed: { trap: TrapRow; barrier: BarrierRow }[] = []
  for (const t of traps) {
    const barrier = (barriersByBlock.get(t.block_height) ?? []).find(b => b.event_index > t.event_index)
    if (barrier && !barrier.success) failed.push({ trap: t, barrier })
  }

  const inherentBlocks = [...new Set(failed.flatMap(f =>
    Array.from({ length: ENQUEUE_SEARCH_BLOCKS + 1 }, (_, i) => f.trap.block_height - i)))]
  const inherents = new Map<number, unknown>()
  for (let i = 0; i < inherentBlocks.length; i += 2_000) {
    // Only the message lists, extracted in SQL: the rest of the inherent (relay
    // proofs, headers) is ~45 KB a block and none of what is decoded here.
    for (const r of await rowsOf<InherentRow>(client, `
      SELECT block_height,
             JSONExtractRaw(call_args_json, 'data', 'horizontalMessages') AS hm,
             JSONExtractRaw(call_args_json, 'data', 'downwardMessages') AS dm
      FROM price_data.raw_extrinsics
      WHERE block_height IN ({blocks:Array(UInt32)}) AND call_name = 'ParachainSystem.set_validation_data'`,
    { blocks: inherentBlocks.slice(i, i + 2_000) })) {
      try {
        inherents.set(r.block_height, { horizontalMessages: r.hm ? JSON.parse(r.hm) : [], downwardMessages: r.dm ? JSON.parse(r.dm) : [] })
      } catch { /* unreadable: undecoded */ }
    }
  }

  // A lookup that FAILED (node unreachable mid-build) is not "unregistered": it is
  // never cached, and the arrival it belongs to is rebuilt on a later refresh.
  const failedBlocks = new Set<number>()
  const assetIdAt = async (loc: unknown, block: number): Promise<number | null> => {
    const local = localAssetId(loc)
    if (local != null) return local
    const key = JSON.stringify(loc)
    if (assetByLocation.has(key)) return assetByLocation.get(key)!
    try {
      const v = (await api.query.assetRegistry.locationAssets(loc as never)).toJSON()
      const id = typeof v === 'number' ? v : null
      assetByLocation.set(key, id)
      return id
    } catch {
      failedBlocks.add(block)
      return null
    }
  }
  const blockHashes = new Map((await rowsOf<{ block_height: number; block_hash: string }>(client, `
    SELECT block_height, any(block_hash) AS block_hash FROM price_data.raw_blocks
    WHERE block_height IN ({blocks:Array(UInt32)}) GROUP BY block_height`,
  { blocks: failed.map(f => f.trap.block_height - 1) })).map(r => [r.block_height, r.block_hash]))

  const out: TrappedArrival[] = []
  for (const { trap, barrier } of failed) {
    const messageId = barrier.message_id.startsWith('0x') ? barrier.message_id.toLowerCase() : null
    const originKind = barrier.origin_kind === 'Sibling' ? 'Sibling' : barrier.origin_kind === 'Parent' ? 'Parent' : 'Other'
    const originParaId = originKind === 'Sibling' ? Number(barrier.origin_value) : null
    let trapArgs: { assets?: { value?: { id?: unknown; fun?: { value?: unknown } }[] } } = {}
    try { trapArgs = JSON.parse(trap.args_json) } catch { /* keep empty */ }
    const assets: TrappedAsset[] = []
    for (const a of trapArgs.assets?.value ?? []) {
      const amount = a.fun?.value
      if (typeof amount !== 'string' && typeof amount !== 'number') continue
      assets.push({ assetId: await assetIdAt(normalizeLocation(assetIdLocation(sqdToCodecJson(a.id))), trap.block_height), amount: String(amount) })
    }
    const program = messageId ? findProgram(api, inherents, trap.block_height, originKind, originParaId, messageId) : null
    const facts = program ? programFacts(program) : { beneficiary: null, feeLocation: null }
    const feeAssetId = facts.feeLocation != null ? await assetIdAt(facts.feeLocation, trap.block_height) : null
    out.push({
      blockHeight: trap.block_height, ts: trap.ts, eventIndex: trap.event_index, barrierEventIndex: barrier.event_index,
      messageId, originKind, originParaId, assets, beneficiary: facts.beneficiary, feeAssetId,
      // The native asset is always accepted; any other is read below.
      feeAssetAccepted: feeAssetId === 0 ? true : null,
    })
  }
  // Was the fee asset accepted in the block before the failure? An archive read per
  // arrival, a few at a time (the first build reads every one since the migration).
  const toCheck = out.filter(a => a.feeAssetId != null && a.feeAssetId !== 0 && blockHashes.has(a.blockHeight - 1))
  for (let i = 0; i < toCheck.length; i += 16) {
    await Promise.all(toCheck.slice(i, i + 16).map(async a => {
      try {
        const raw = await api.rpc.state.getStorage(api.query.multiTransactionPayment.acceptedCurrencies.key(a.feeAssetId!), blockHashes.get(a.blockHeight - 1)!)
        a.feeAssetAccepted = (raw as unknown as { toHex(): string }).toHex() !== '0x'
      } catch { failedBlocks.add(a.blockHeight) }
    }))
  }
  // Keep everything below the first block with a failed lookup; that block and the
  // rest are read again next time (the watermark stops just short of it).
  const firstFailed = failedBlocks.size ? Math.min(...failedBlocks) : null
  arrivals = [...arrivals, ...(firstFailed == null ? out : out.filter(a => a.blockHeight < firstFailed))]
  watermark = firstFailed == null ? traps[traps.length - 1].block_height : firstFailed - 1
  if (firstFailed != null) console.warn(`[xcm-trapped] node lookups failed from block ${firstFailed}; those arrivals are retried on the next refresh`)
}

// The decoded program of the message `messageId` from that origin, looked up in the
// inherents of the blocks up to `height`. MessageQueue's id is the program's SetTopic
// when it carries one, else blake2-256 of the message bytes; either matches.
function findProgram(
  api: NonNullable<ReturnType<typeof pendingNodeApi>>, inherents: Map<number, unknown>, height: number,
  originKind: TrappedArrival['originKind'], originParaId: number | null, messageId: string,
): Instruction[] | null {
  for (let h = height; h >= height - ENQUEUE_SEARCH_BLOCKS; h--) {
    const data = inherents.get(h) as { horizontalMessages?: [number, { data?: string }[]][]; downwardMessages?: { msg?: string }[] } | undefined
    if (!data) continue
    const blobs: { bytes: Uint8Array; concatenated: boolean }[] = []
    if (originKind === 'Sibling') {
      for (const [para, msgs] of data.horizontalMessages ?? []) {
        if (para !== originParaId) continue
        for (const m of msgs) if (typeof m.data === 'string') blobs.push({ bytes: hexToU8a(m.data), concatenated: true })
      }
    } else if (originKind === 'Parent') {
      for (const m of data.downwardMessages ?? []) if (typeof m.msg === 'string') blobs.push({ bytes: hexToU8a(m.msg), concatenated: false })
    }
    for (const { bytes, concatenated } of blobs) {
      // An XCMP page: one format byte (0 = concatenated versioned XCM), then programs.
      if (concatenated && bytes[0] !== 0) continue
      let off = concatenated ? 1 : 0
      while (off < bytes.length) {
        let program: { encodedLength: number; toJSON(): unknown }
        try { program = api.createType('XcmVersionedXcm', bytes.subarray(off)) as never } catch { break }
        if (!program.encodedLength) break
        const encoded = bytes.subarray(off, off + program.encodedLength)
        off += program.encodedLength
        const versioned = program.toJSON() as Record<string, Instruction[]>
        const instructions = Object.values(versioned)[0] ?? []
        const topic = instructions.find(i => 'setTopic' in i)?.setTopic
        if ((typeof topic === 'string' && topic.toLowerCase() === messageId) || blake2AsHex(encoded, 256) === messageId) return instructions
      }
    }
  }
  return null
}

/** Every trapped inbound arrival known so far, oldest first; extends itself in the background. */
export async function trappedArrivals(client: ClickHouseClient): Promise<readonly TrappedArrival[]> {
  if (Date.now() - lastRefresh > REFRESH_MS && !inflight) {
    lastRefresh = Date.now()
    inflight = refresh(client)
      .catch(err => { console.warn('[xcm-trapped] refresh failed:', err instanceof Error ? err.message : err); lastRefresh = 0 })
      .finally(() => { inflight = null })
    // The first build is awaited, so a cold process does not answer "nothing trapped".
    if (watermark < MESSAGE_QUEUE_MIGRATION_BLOCK) await inflight
  }
  return arrivals
}
