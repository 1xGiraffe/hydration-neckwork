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
const MAX_PENDING = 30
const WALKBACK_LIMIT = 12

export interface PendingEventRow {
  eventIndex: number
  extrinsicIndex: number | null
  name: string
  args: unknown
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
let timer: NodeJS.Timeout | null = null
let ticking = false
const byHeight = new Map<number, PendingBlock>()
let finalizedFloor = 0

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
    events.push({ eventIndex: i, extrinsicIndex, name, args: record.event.data.toHuman() })
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
    })
    .catch(error => {
      // The explorer works without the pending layer — feeds simply start at
      // the finalized head, exactly as before this layer existed.
      console.error('[pending] disabled — RPC connection failed:', error instanceof Error ? error.message : error)
    })
}

export function stopPendingHeadService(): void {
  if (timer) { clearInterval(timer); timer = null }
  byHeight.clear()
  const a = api
  api = null
  if (a) void a.disconnect().catch(() => { /* closing */ })
}
