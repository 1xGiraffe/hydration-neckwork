// Remote-side context for XCM rows. Hydration's own chain data cannot see past
// its own hop: inbound programs open with ClearOrigin (no sending account,
// only origin chain + message topic id), and outbound junctions name only the
// first hop (a Wormhole transfer to Solana looks like a Moonbeam transfer to
// the forwarding contract). The Ocelloids crosschain API (the open-source
// indexer behind xcscan.io) indexes the other chains too and links whole
// journeys: inbound rows are matched by the message topic id its instructions
// carry, outbound rows by our own extrinsic hash (= the journey's origin tx).
//
// Strictly best-effort: explorer requests read only the in-memory cache and
// ClickHouse. Cache misses schedule a bounded, deduplicated background fetch;
// rows keep their local-data hop display until enrichment has been indexed.
//
// Inbound resolutions (message topic id → source account + origin chain) are
// persisted to price_data.xcm_journey_sources as they are learned. Lookups
// check the bounded in-memory window first, then use one batch ClickHouse query.
// Ocelloids is never awaited by an explorer request.

import type { ClickHouseClient } from '../db/client.ts'

const OCELLOIDS_URL = process.env.EXPLORER_OCELLOIDS_URL?.trim() || 'https://api.ocelloids.net'
// XCM source enrichment is opt-in via EXPLORER_OCELLOIDS_TOKEN. When it is
// unset, every call site short-circuits and rows keep their local hop display.
const OCELLOIDS_TOKEN = process.env.EXPLORER_OCELLOIDS_TOKEN?.trim()
const URN_HYDRATION = 'urn:ocn:polkadot:2034'
const PAGE_LIMIT = 100
// Recent refreshes and historical lookups have separate hard page limits. They
// run only in the background and persist every resolution they learn.
const MAX_PAGES = 20
const MAX_HISTORICAL_WINDOWS = 3
const MAX_BACKGROUND_KEYS = 300
const REFRESH_MS = 5 * 60_000
const FAIL_BACKOFF_MS = 60_000
const CACHE_MAX_ENTRIES = 30_000
const XCM_JOURNEY_SOURCES_TABLE = 'price_data.xcm_journey_sources'

let client: ClickHouseClient | undefined

export function initXcmJourneyService(c: ClickHouseClient): void {
  client = c
  if (!OCELLOIDS_TOKEN) {
    console.log('[Explorer] XCM source enrichment disabled: no EXPLORER_OCELLOIDS_TOKEN')
  }
}

export interface XcmJourneySource {
  from: string               // raw source account (0x 32- or 20-byte hex)
  to: string                 // raw destination account (may be empty for remote-exec)
  origin: string             // journey origin chain URN (urn:ocn:<consensus>:<chainId>) —
                             // either end may differ from the hop our chain saw
                             // (e.g. Solana → Wormhole → Moonbeam → Hydration)
  destination: string        // journey destination chain URN
  originTx: string | null    // extrinsic hash on the origin chain
  correlationId: string      // xcscan journey id
}

interface JourneyItem {
  correlationId?: string
  from?: string
  to?: string
  origin?: string
  destination?: string
  originTxPrimary?: string | null
  sentAt?: number
  recvAt?: number
  stops?: unknown
}

const ACCOUNT_HEX_RE = /^0x([0-9a-f]{64}|[0-9a-f]{40})$/

// Entries accumulate across refreshes so a row that was enriched once stays
// enrichable while the process lives.
// message topic id → journey (inbound rows).
const journeyByMessageId = new Map<string, XcmJourneySource>()
// Hydration extrinsic hash → journeys it started (outbound rows; an extrinsic
// batching several transfers maps to several journeys).
const journeysByOriginTx = new Map<string, XcmJourneySource[]>()
let oldestFetchedMs = Number.MAX_SAFE_INTEGER
let lastFetchAt = 0
let lastFailAt = 0
let inflight: Promise<void> | null = null
let backgroundInflight: Promise<void> | null = null
let pendingOldestMs = Number.MAX_SAFE_INTEGER
const pendingHistoricalKeys = new Map<string, number>()

function collectMessageIds(stops: unknown, out: Set<string>): void {
  const parsed = typeof stops === 'string' ? safeParse(stops) : stops
  if (!Array.isArray(parsed)) return
  for (const stop of parsed) {
    // The topic sits directly on the stop for hrmp-shaped journeys
    // (messageId/messageHash) and under instructions[] for others — collect
    // both, or inbound source resolution silently misses whole classes.
    for (const key of ['messageId', 'messageHash'] as const) {
      const v = (stop as Record<string, unknown>)?.[key]
      if (typeof v === 'string' && v.startsWith('0x')) out.add(v.toLowerCase())
    }
    const instructions = (stop as { instructions?: unknown })?.instructions
    if (!Array.isArray(instructions)) continue
    for (const instr of instructions) {
      const id = (instr as { messageId?: unknown })?.messageId
      if (typeof id === 'string' && id.startsWith('0x')) out.add(id.toLowerCase())
    }
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

// Fire-and-forget persist of newly-learned inbound source resolutions.
// ReplacingMergeTree collapses re-inserts of an already-known message_id, so
// callers don't need to check what's already stored — only dedupe within
// this batch to avoid sending the same message_id twice in one insert.
function persistJourneySources(rows: { message_id: string; from_hex: string; origin_urn: string; origin_tx: string }[]): void {
  if (!client || !rows.length) return
  client.insert({ table: XCM_JOURNEY_SOURCES_TABLE, values: rows, format: 'JSONEachRow' })
    .catch(err => console.error('[Explorer] XCM journey source persist failed:', err instanceof Error ? err.message : err))
}

function indexJourneys(items: JourneyItem[]): void {
  if (journeyByMessageId.size + journeysByOriginTx.size > CACHE_MAX_ENTRIES) {
    journeyByMessageId.clear()
    journeysByOriginTx.clear()
    oldestFetchedMs = Number.MAX_SAFE_INTEGER
  }
  const toPersist = new Map<string, { message_id: string; from_hex: string; origin_urn: string; origin_tx: string }>()
  for (const j of items) {
    const ts = j.recvAt ?? j.sentAt
    if (typeof ts === 'number') oldestFetchedMs = Math.min(oldestFetchedMs, ts)
    if (!j.correlationId || typeof j.origin !== 'string' || typeof j.destination !== 'string') continue
    const from = typeof j.from === 'string' ? j.from.toLowerCase() : ''
    const to = typeof j.to === 'string' ? j.to.toLowerCase() : ''
    const src: XcmJourneySource = {
      from: ACCOUNT_HEX_RE.test(from) ? from : '',
      to: ACCOUNT_HEX_RE.test(to) ? to : '',
      origin: j.origin,
      destination: j.destination,
      originTx: j.originTxPrimary ?? null,
      correlationId: j.correlationId,
    }
    if (src.from) {
      const ids = new Set<string>()
      collectMessageIds(j.stops, ids)
      for (const id of ids) {
        journeyByMessageId.set(id, src)
        toPersist.set(id, { message_id: id, from_hex: src.from, origin_urn: src.origin, origin_tx: src.originTx ?? '' })
      }
    }
    if (j.origin === URN_HYDRATION && typeof src.originTx === 'string' && src.originTx.startsWith('0x')) {
      const key = src.originTx.toLowerCase()
      const list = journeysByOriginTx.get(key) ?? []
      if (!list.some(x => x.correlationId === src.correlationId)) list.push(src)
      journeysByOriginTx.set(key, list)
    }
  }
  persistJourneySources([...toPersist.values()])
}

async function queryJourneysPage(cursor?: string): Promise<{ items: JourneyItem[]; endCursor?: string; hasNextPage?: boolean }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch(`${OCELLOIDS_URL}/query/crosschain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OCELLOIDS_TOKEN}` },
      body: JSON.stringify({
        args: { op: 'journeys.list', criteria: { networks: [URN_HYDRATION] } },
        pagination: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`ocelloids journeys.list: HTTP ${res.status}`)
    const body = await res.json() as { items?: JourneyItem[]; pageInfo?: { endCursor?: string; hasNextPage?: boolean } }
    return { items: body.items ?? [], endCursor: body.pageInfo?.endCursor, hasNextPage: body.pageInfo?.hasNextPage }
  } finally {
    clearTimeout(t)
  }
}

// Walk journey pages newest-first until the window covers `oldestNeededMs` (or
// MAX_PAGES). This is called only by the background refresh scheduler.
async function ensureJourneys(oldestNeededMs: number): Promise<void> {
  const fresh = Date.now() - lastFetchAt < REFRESH_MS
  if (fresh && oldestFetchedMs <= oldestNeededMs) return
  if (Date.now() - lastFailAt < FAIL_BACKOFF_MS) return
  inflight ??= (async () => {
    try {
      let cursor: string | undefined
      let pageOldest = Number.MAX_SAFE_INTEGER
      for (let page = 0; page < MAX_PAGES; page++) {
        const { items, endCursor, hasNextPage } = await queryJourneysPage(cursor)
        indexJourneys(items)
        for (const j of items) {
          const ts = j.recvAt ?? j.sentAt
          if (typeof ts === 'number') pageOldest = Math.min(pageOldest, ts)
        }
        if (!items.length || !hasNextPage || !endCursor || pageOldest <= oldestNeededMs) break
        cursor = endCursor
      }
      lastFetchAt = Date.now()
    } catch (err) {
      lastFailAt = Date.now()
      console.error('[Explorer] XCM journey source fetch failed:', err instanceof Error ? err.message : err)
    }
  })().finally(() => { inflight = null })
  await inflight
}

// Batch fallback for message ids the in-memory map doesn't (or no longer)
// cover — either this process hasn't walked deep enough yet this run, or the
// resolution was learned by an earlier process incarnation entirely. A
// persisted row only carries the two fields the inbound-source display needs
// (from_hex, origin_urn); the rest of XcmJourneySource is left empty since
// applyXcmInSources (the only caller) never reads them for inbound rows.
// argMax(…, updated_at) picks the latest version per message_id without a
// (costly at scale) FINAL read.
async function fetchPersistedSources(messageIds: string[]): Promise<Map<string, XcmJourneySource>> {
  const out = new Map<string, XcmJourneySource>()
  if (!client || !messageIds.length) return out
  try {
    const res = await client.query({
      query: `
        SELECT message_id, argMax(from_hex, updated_at) AS from_hex, argMax(origin_urn, updated_at) AS origin_urn, argMax(origin_tx, updated_at) AS origin_tx
        FROM ${XCM_JOURNEY_SOURCES_TABLE}
        WHERE message_id IN ({ids:Array(String)})
        GROUP BY message_id
      `,
      query_params: { ids: messageIds },
      format: 'JSONEachRow',
    })
    for (const row of await res.json<{ message_id: string; from_hex: string; origin_urn: string; origin_tx: string }>()) {
      if (!row.from_hex || !row.origin_urn) continue
      out.set(row.message_id, { from: row.from_hex, to: '', origin: row.origin_urn, destination: '', originTx: row.origin_tx || null, correlationId: '' })
    }
  } catch (err) {
    console.error('[Explorer] XCM journey source persisted lookup failed:', err instanceof Error ? err.message : err)
  }
  return out
}

// The list API's keyset cursor is base64("<epochMs>|<rowId>"). Crafting one
// starts the bounded background walk near an unresolved historical row.
export function historicalCursorAt(tsMs: number): string {
  return Buffer.from(`${tsMs}|999999999`).toString('base64')
}

// Walk a small window around a historical timestamp and persist matches.
async function walkWindowAt(tsMs: number): Promise<void> {
  let cursor: string | undefined = historicalCursorAt(tsMs + 120_000)
  for (let page = 0; page < 3; page++) {
    const { items, endCursor, hasNextPage } = await queryJourneysPage(cursor)
    indexJourneys(items)
    let pageOldest = Number.MAX_SAFE_INTEGER
    for (const j of items) {
      const ts = j.recvAt ?? j.sentAt
      if (typeof ts === 'number') pageOldest = Math.min(pageOldest, ts)
    }
    if (!items.length || !hasNextPage || !endCursor || pageOldest <= tsMs - 120_000) break
    cursor = endCursor
  }
}

function queueBackgroundRefresh(
  keys: { id: string; timestampMs: number }[],
  includeHistorical: boolean,
): void {
  if (!OCELLOIDS_TOKEN || Date.now() - lastFailAt < FAIL_BACKOFF_MS) return
  for (const key of keys) {
    if (!Number.isFinite(key.timestampMs) || key.timestampMs <= 0) continue
    pendingOldestMs = Math.min(pendingOldestMs, key.timestampMs)
    if (includeHistorical && pendingHistoricalKeys.size < MAX_BACKGROUND_KEYS) {
      pendingHistoricalKeys.set(key.id.toLowerCase(), key.timestampMs)
    }
  }
  if (pendingOldestMs === Number.MAX_SAFE_INTEGER || backgroundInflight) return

  backgroundInflight = Promise.resolve()
    .then(async () => {
      const oldestNeededMs = pendingOldestMs
      const historicalKeys = [...pendingHistoricalKeys]
      pendingOldestMs = Number.MAX_SAFE_INTEGER
      pendingHistoricalKeys.clear()

      await ensureJourneys(oldestNeededMs)

      const unresolved = historicalKeys
        .filter(([messageId]) => !journeyByMessageId.has(messageId))
        .map(([, timestampMs]) => timestampMs)
        .sort((a, b) => b - a)
      const windows: number[] = []
      for (const timestampMs of unresolved) {
        if (!windows.some(window => Math.abs(window - timestampMs) < 2 * 3_600_000)) {
          windows.push(timestampMs)
        }
        if (windows.length >= MAX_HISTORICAL_WINDOWS) break
      }
      for (const window of windows) {
        try {
          await walkWindowAt(window)
        } catch (err) {
          lastFailAt = Date.now()
          console.error('[Explorer] XCM historical journey walk failed:', err instanceof Error ? err.message : err)
          break
        }
      }
    })
    .catch(err => {
      lastFailAt = Date.now()
      console.error('[Explorer] XCM background refresh failed:', err instanceof Error ? err.message : err)
    })
    .finally(() => {
      backgroundInflight = null
      if (pendingOldestMs !== Number.MAX_SAFE_INTEGER) {
        queueBackgroundRefresh([], pendingHistoricalKeys.size > 0)
      }
    })
}

// Resolve inbound journeys from memory and ClickHouse. Misses remain
// unenriched for this response and schedule background discovery for later
// requests.
export async function xcmJourneySourcesFor(keys: { messageId: string; timestampMs: number }[]): Promise<Map<string, XcmJourneySource>> {
  const out = new Map<string, XcmJourneySource>()
  if (!keys.length) return out
  for (const key of keys) {
    const hit = journeyByMessageId.get(key.messageId.toLowerCase())
    if (hit) out.set(key.messageId, hit)
  }
  const missing = keys.filter(k => !out.has(k.messageId))
  if (missing.length) {
    const persisted = await fetchPersistedSources(missing.map(k => k.messageId.toLowerCase()))
    for (const k of missing) {
      const hit = persisted.get(k.messageId.toLowerCase())
      if (hit) out.set(k.messageId, hit)
    }
  }
  const unresolved = keys.filter(k => !out.has(k.messageId) && k.timestampMs > 0)
  queueBackgroundRefresh(
    unresolved.map(key => ({ id: key.messageId, timestampMs: key.timestampMs })),
    true,
  )
  return out
}

// Resolve outbound journeys from memory. Misses schedule the shared background
// recent-window refresh and remain unenriched for this response.
export async function xcmJourneysByOriginTx(keys: { txHash: string; timestampMs: number }[]): Promise<Map<string, XcmJourneySource[]>> {
  const out = new Map<string, XcmJourneySource[]>()
  if (!OCELLOIDS_TOKEN || !keys.length) return out
  for (const k of keys) {
    const hit = journeysByOriginTx.get(k.txHash.toLowerCase())
    if (hit) out.set(k.txHash, hit)
  }
  queueBackgroundRefresh(
    keys.filter(key => !out.has(key.txHash)).map(key => ({ id: key.txHash, timestampMs: key.timestampMs })),
    false,
  )
  return out
}
