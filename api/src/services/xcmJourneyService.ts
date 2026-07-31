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
const XCM_JOURNEY_MISSES_TABLE = 'price_data.xcm_journey_misses'

// How far back a window walk reaches around an unresolved row.
//
// The list is ordered by the journey's OWN send time, so the window has to span the
// gap between a message landing here and its journey having started elsewhere.
// Measured on the live index: plain XCM arrives in seconds (p90 0.8 min), while
// Snowbridge trails ~18-20 min behind its Ethereum transaction (beacon finality) and
// Wormhole's tail runs to hours. A window sized for XCM therefore cannot contain a
// bridged journey at all, which is why bridge arrivals went unresolved while
// same-consensus hops resolved fine.
const WINDOW_MS_LOCAL = 5 * 60_000
const WINDOW_MS_BRIDGE = 90 * 60_000
// Pages per window. A wide window covers more journeys, so it needs more of them.
const WINDOW_PAGES_LOCAL = 3
const WINDOW_PAGES_BRIDGE = 8

// Retry schedule for a topic id the index does not have yet, by attempt count. A
// bridged journey is typically absent on the first look and present on a later one,
// so giving up after one attempt is what left rows permanently unenriched; retrying
// every request instead would spend the whole budget on the same few ids. Capped:
// past the last step a miss is left alone.
const MISS_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000]

// How far the feed may fall behind before it is worth a warning, and how often to
// check. Bridge latency alone puts tens of minutes between a journey being sent and
// our seeing it, so the tolerance has to sit above that to avoid crying wolf.
const SOURCE_LAG_TOLERANCE_MS = 30 * 60_000
const SOURCE_PROBE_TTL_MS = 10 * 60_000

let client: ClickHouseClient | undefined

export function initXcmJourneyService(c: ClickHouseClient): void {
  client = c
  if (!OCELLOIDS_TOKEN) {
    console.log('[Explorer] XCM source enrichment disabled: no EXPLORER_OCELLOIDS_TOKEN')
  }
}

export interface XcmJourneySource {
  from: string               // raw source account (0x 32- or 20-byte hex), '' if none
  to: string                 // raw destination account (may be empty for remote-exec)
  // The API's own rendering of each account, in the encoding its chain uses — base58
  // for Solana, hex for EVM, SS58 for substrate. Preferred over re-encoding `from`/`to`
  // here: it is the only way an address on a chain we do not model reads correctly.
  fromFormatted: string
  toFormatted: string
  origin: string             // journey origin chain URN (urn:ocn:<consensus>:<chainId>) —
                             // either end may differ from the hop our chain saw
                             // (e.g. Solana → Wormhole → Moonbeam → Hydration)
  destination: string        // journey destination chain URN
  originTx: string | null    // extrinsic hash on the origin chain
  destTx: string | null      // transaction on the destination chain, once it lands
  correlationId: string      // xcscan journey id
  // How the journey travelled at each end, in the API's own vocabulary: 'snowbridge',
  // 'wh_portal', 'basejump', 'hyperbridge' or 'xcm'. A bridge shows up on the side it
  // acts: inbound on origin, outbound on destination.
  originProtocol: string
  destProtocol: string
}

interface JourneyItem {
  correlationId?: string
  from?: string
  to?: string
  fromFormatted?: string | null
  toFormatted?: string | null
  origin?: string
  destination?: string
  originProtocol?: string
  destinationProtocol?: string
  originTxPrimary?: string | null
  destinationTxPrimary?: string | null
  sentAt?: number
  recvAt?: number
  stops?: unknown
}

// Bridges the API distinguishes, mapped to the words a reader knows them by. A
// journey that merely crossed consensus systems by XCM is not "bridged" in this
// sense and gets no label. Unlisted protocols fall back to their raw name rather
// than being dropped, so a bridge added upstream still surfaces (and shows up in the
// log line below) instead of silently reading as a plain hop.
const BRIDGE_LABELS: Record<string, string> = {
  snowbridge: 'Snowbridge',
  // Wormhole reaches Hydration two ways and a reader knows both as Wormhole: the
  // Portal token bridge (via Moonbeam, the old MRL route) and Native Token Transfers,
  // which burns and mints directly with no intermediary parachain.
  wh_portal: 'Wormhole',
  wh_ntt: 'Wormhole',
  basejump: 'Basejump',
  hyperbridge: 'Hyperbridge',
}
export function bridgeLabel(originProtocol: string, destinationProtocol?: string): string | null {
  for (const p of [originProtocol, destinationProtocol]) {
    if (!p || p === 'xcm') continue
    return BRIDGE_LABELS[p] ?? p
  }
  return null
}

const ACCOUNT_HEX_RE = /^0x([0-9a-f]{64}|[0-9a-f]{40})$/

// How far back a journey reaches, for the "have I walked past this yet" tests below.
//
// A journey still in flight reports recvAt: 0, not null — and `??` only falls back
// on null/undefined, so reading `recvAt ?? sentAt` takes the zero and every walk
// then believes it has reached the epoch. That is not an edge case: a sixth of a
// live page is `waiting` (a bridge leg can sit unreceived for hours), so one such
// row pins oldestFetchedMs at 0 for the life of the process, after which
// ensureJourneys considers all history covered, and both page loops break after
// their first page instead of the twenty and three they are written for.
function journeyReachMs(j: JourneyItem): number {
  const recv = typeof j.recvAt === 'number' ? j.recvAt : 0
  const sent = typeof j.sentAt === 'number' ? j.sentAt : 0
  return Math.max(recv, sent)
}

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
const pendingHistoricalKeys = new Map<string, { timestampMs: number; bridge: boolean }>()

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
// Both ends of a journey as one row, keyed by the topic id of the hop we saw.
interface JourneyRow {
  message_id: string
  from_hex: string; origin_urn: string; origin_tx: string; origin_protocol: string; from_formatted: string
  to_hex: string; dest_urn: string; dest_tx: string; dest_protocol: string; to_formatted: string
}
function journeyRow(messageId: string, src: XcmJourneySource): JourneyRow {
  return {
    message_id: messageId,
    from_hex: src.from, origin_urn: src.origin, origin_tx: src.originTx ?? '',
    origin_protocol: src.originProtocol, from_formatted: src.fromFormatted,
    to_hex: src.to, dest_urn: src.destination, dest_tx: src.destTx ?? '',
    dest_protocol: src.destProtocol, to_formatted: src.toFormatted,
  }
}

function persistJourneySources(rows: JourneyRow[]): void {
  if (!client || !rows.length) return
  client.insert({ table: XCM_JOURNEY_SOURCES_TABLE, values: rows, format: 'JSONEachRow' })
    .catch(err => console.error('[Explorer] XCM journey source persist failed:', err instanceof Error ? err.message : err))
}

// Record that a topic id was looked for and not found, so the retry schedule can
// space the next attempt out. Written after a walk that failed to resolve it, and
// superseded by the resolution once one is learned (the reader checks sources first).
function persistJourneyMisses(rows: { message_id: string; attempts: number; first_seen_ms: number }[]): void {
  if (!client || !rows.length) return
  client.insert({ table: XCM_JOURNEY_MISSES_TABLE, values: rows, format: 'JSONEachRow' })
    .catch(err => console.error('[Explorer] XCM journey miss persist failed:', err instanceof Error ? err.message : err))
}

// Attempts already made per topic id, for the backoff. A miss row for an id that
// has since resolved is harmless: xcmJourneySourcesFor only consults this for ids
// that missed BOTH the memory map and the persisted resolutions.
async function fetchJourneyMisses(messageIds: string[]): Promise<Map<string, { attempts: number; lastAttemptMs: number; firstSeenMs: number }>> {
  const out = new Map<string, { attempts: number; lastAttemptMs: number; firstSeenMs: number }>()
  if (!client || !messageIds.length) return out
  try {
    const res = await client.query({
      query: `
        SELECT message_id, max(attempts) AS attempts,
               toUnixTimestamp(max(last_attempt_at)) AS last_attempt_s,
               max(first_seen_ms) AS first_seen_ms
        FROM ${XCM_JOURNEY_MISSES_TABLE}
        WHERE message_id IN ({ids:Array(String)})
        GROUP BY message_id
      `,
      query_params: { ids: messageIds }, format: 'JSONEachRow',
    })
    for (const row of await res.json<{ message_id: string; attempts: string; last_attempt_s: string; first_seen_ms: string }>()) {
      out.set(row.message_id, {
        attempts: Number(row.attempts) || 0,
        lastAttemptMs: (Number(row.last_attempt_s) || 0) * 1000,
        firstSeenMs: Number(row.first_seen_ms) || 0,
      })
    }
  } catch (err) {
    console.error('[Explorer] XCM journey miss lookup failed:', err instanceof Error ? err.message : err)
  }
  return out
}

// Whether a miss is due for another look. An id never seen before is always due.
function missIsDue(miss: { attempts: number; lastAttemptMs: number } | undefined, nowMs: number): boolean {
  if (!miss) return true
  if (miss.attempts >= MISS_BACKOFF_MS.length) return false
  return nowMs - miss.lastAttemptMs >= MISS_BACKOFF_MS[Math.max(0, miss.attempts - 1)]
}

function indexJourneys(items: JourneyItem[]): void {
  if (journeyByMessageId.size + journeysByOriginTx.size > CACHE_MAX_ENTRIES) {
    journeyByMessageId.clear()
    journeysByOriginTx.clear()
    oldestFetchedMs = Number.MAX_SAFE_INTEGER
  }
  const toPersist = new Map<string, JourneyRow>()
  for (const j of items) {
    const ts = journeyReachMs(j)
    if (ts > 0) oldestFetchedMs = Math.min(oldestFetchedMs, ts)
    if (!j.correlationId || typeof j.origin !== 'string' || typeof j.destination !== 'string') continue
    const from = typeof j.from === 'string' ? j.from.toLowerCase() : ''
    const to = typeof j.to === 'string' ? j.to.toLowerCase() : ''
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const src: XcmJourneySource = {
      from: ACCOUNT_HEX_RE.test(from) ? from : '',
      to: ACCOUNT_HEX_RE.test(to) ? to : '',
      fromFormatted: str(j.fromFormatted),
      toFormatted: str(j.toFormatted),
      origin: j.origin,
      destination: j.destination,
      originTx: j.originTxPrimary ?? null,
      destTx: j.destinationTxPrimary ?? null,
      correlationId: j.correlationId,
      originProtocol: str(j.originProtocol),
      destProtocol: str(j.destinationProtocol),
    }
    // Index by topic id whatever else the journey has. Gating this on a usable source
    // account (as it once was) silently excluded every OUTBOUND journey, because those
    // report `from` as the origin CHAIN's urn rather than an account — which is exactly
    // the set whose far destination we most want, since half of them carry no origin
    // extrinsic hash to be found by either.
    const ids = new Set<string>()
    collectMessageIds(j.stops, ids)
    for (const id of ids) {
      journeyByMessageId.set(id, src)
      toPersist.set(id, journeyRow(id, src))
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

async function postJourneysList(criteria: Record<string, unknown>, limit: number, cursor?: string): Promise<{ items: JourneyItem[]; endCursor?: string; hasNextPage?: boolean }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch(`${OCELLOIDS_URL}/query/crosschain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OCELLOIDS_TOKEN}` },
      body: JSON.stringify({
        args: { op: 'journeys.list', criteria },
        pagination: { limit, ...(cursor ? { cursor } : {}) },
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

// Whether the feed the walks read is actually keeping up, measured rather than
// assumed — and reported, because nothing else here can tell.
//
// The `networks` filter is the only usable source: it returns just the journeys that
// touch us, which is what makes a page worth walking. But it has been observed
// serving a slice HOURS behind the API's unfiltered feed, and since an unrecognised
// criteria key is ignored rather than rejected, a stale filtered page is
// indistinguishable from a healthy one. Walking unfiltered instead is not a fix: at
// the head only ~1 journey per 100 touches Hydration, and one page of that feed spans
// almost a day of send times, so a walk that steers by time coverage declares itself
// finished having learned nothing. Fixing this needs the upstream filter to be live;
// all this can do is say so, loudly and at most once per TTL, instead of quietly
// enriching nothing.
let lastLagProbeAt = 0

async function newestJourneyMs(criteria: Record<string, unknown>): Promise<number> {
  try {
    const { items } = await postJourneysList(criteria, 1)
    return items.length ? journeyReachMs(items[0]) : 0
  } catch { return 0 }
}

async function reportFeedLag(): Promise<void> {
  if (Date.now() - lastLagProbeAt < SOURCE_PROBE_TTL_MS) return
  lastLagProbeAt = Date.now()
  const [filteredMs, unfilteredMs] = await Promise.all([
    newestJourneyMs({ networks: [URN_HYDRATION] }),
    newestJourneyMs({}),
  ])
  const lagMs = unfilteredMs - filteredMs
  if (filteredMs > 0 && unfilteredMs > 0 && lagMs > SOURCE_LAG_TOLERANCE_MS) {
    console.warn(`[Explorer] Ocelloids networks filter is ${Math.round(lagMs / 60_000)} min behind its unfiltered feed — recent XCM rows cannot be enriched until this clears`)
  }
}

// One page of Hydration's journeys. `rawCount` and `oldestMs` describe the page as
// returned, and the walks below steer on those rather than recomputing the same
// minimum at each call site.
async function queryJourneysPage(cursor?: string): Promise<{
  items: JourneyItem[]; rawCount: number; oldestMs: number; endCursor?: string; hasNextPage?: boolean
}> {
  const page = await postJourneysList({ networks: [URN_HYDRATION] }, PAGE_LIMIT, cursor)
  let oldestMs = Number.MAX_SAFE_INTEGER
  for (const j of page.items) {
    const ts = journeyReachMs(j)
    if (ts > 0) oldestMs = Math.min(oldestMs, ts)
  }
  return { items: page.items, rawCount: page.items.length, oldestMs, endCursor: page.endCursor, hasNextPage: page.hasNextPage }
}

// Walk journey pages newest-first until the window covers `oldestNeededMs` (or
// MAX_PAGES). This is called only by the background refresh scheduler.
async function ensureJourneys(oldestNeededMs: number): Promise<void> {
  const fresh = Date.now() - lastFetchAt < REFRESH_MS
  if (fresh && oldestFetchedMs <= oldestNeededMs) return
  if (Date.now() - lastFailAt < FAIL_BACKOFF_MS) return
  inflight ??= (async () => {
    try {
      // Cheap, throttled, and the only signal that the feed has gone stale.
      await reportFeedLag()
      let cursor: string | undefined
      let pageOldest = Number.MAX_SAFE_INTEGER
      for (let page = 0; page < MAX_PAGES; page++) {
        const { items, rawCount, oldestMs, endCursor, hasNextPage } = await queryJourneysPage(cursor)
        indexJourneys(items)
        pageOldest = Math.min(pageOldest, oldestMs)
        if (!rawCount || !hasNextPage || !endCursor || pageOldest <= oldestNeededMs) break
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
        SELECT message_id,
               argMax(from_hex, updated_at) AS from_hex, argMax(origin_urn, updated_at) AS origin_urn,
               argMax(origin_tx, updated_at) AS origin_tx, argMax(origin_protocol, updated_at) AS origin_protocol,
               argMax(from_formatted, updated_at) AS from_formatted,
               argMax(to_hex, updated_at) AS to_hex, argMax(dest_urn, updated_at) AS dest_urn,
               argMax(dest_tx, updated_at) AS dest_tx, argMax(dest_protocol, updated_at) AS dest_protocol,
               argMax(to_formatted, updated_at) AS to_formatted
        FROM ${XCM_JOURNEY_SOURCES_TABLE}
        WHERE message_id IN ({ids:Array(String)})
        GROUP BY message_id
      `,
      query_params: { ids: messageIds },
      format: 'JSONEachRow',
    })
    for (const row of await res.json<JourneyRow>()) {
      // A row is useful if EITHER end is known: an inbound lookup needs the origin, an
      // outbound one the destination, and an outbound journey never has a source
      // account at all. Requiring from_hex (as it once did) threw away every
      // destination this table holds.
      if (!row.origin_urn && !row.dest_urn) continue
      out.set(row.message_id, {
        from: row.from_hex || '', to: row.to_hex || '',
        fromFormatted: row.from_formatted || '', toFormatted: row.to_formatted || '',
        origin: row.origin_urn || '', destination: row.dest_urn || '',
        originTx: row.origin_tx || null, destTx: row.dest_tx || null,
        correlationId: '',
        originProtocol: row.origin_protocol || '', destProtocol: row.dest_protocol || '',
      })
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

// Walk the window around one unresolved row's timestamp and persist what it learns.
//
// The window is asymmetric on purpose. The list is ordered by when a journey was
// SENT, and our timestamp is when it ARRIVED, so what has to be covered is the
// latency between the two — all of it behind us, none ahead. `bridge` widens that
// from an XCM-sized window to a bridge-sized one (see WINDOW_MS_*); a small lead is
// still kept so a journey sent moments after our block timestamp is not cut off by
// clock skew between the chains.
async function walkWindowAt(tsMs: number, bridge: boolean): Promise<void> {
  const windowMs = bridge ? WINDOW_MS_BRIDGE : WINDOW_MS_LOCAL
  const maxPages = bridge ? WINDOW_PAGES_BRIDGE : WINDOW_PAGES_LOCAL
  let cursor: string | undefined = historicalCursorAt(tsMs + 120_000)
  for (let page = 0; page < maxPages; page++) {
    const { items, rawCount, oldestMs, endCursor, hasNextPage } = await queryJourneysPage(cursor)
    indexJourneys(items)
    if (!rawCount || !hasNextPage || !endCursor || oldestMs <= tsMs - windowMs) break
    cursor = endCursor
  }
}

function queueBackgroundRefresh(
  keys: { id: string; timestampMs: number; bridge?: boolean }[],
  includeHistorical: boolean,
): void {
  if (!OCELLOIDS_TOKEN || Date.now() - lastFailAt < FAIL_BACKOFF_MS) return
  for (const key of keys) {
    if (!Number.isFinite(key.timestampMs) || key.timestampMs <= 0) continue
    pendingOldestMs = Math.min(pendingOldestMs, key.timestampMs)
    if (includeHistorical && pendingHistoricalKeys.size < MAX_BACKGROUND_KEYS) {
      pendingHistoricalKeys.set(key.id.toLowerCase(), { timestampMs: key.timestampMs, bridge: !!key.bridge })
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

      // Only ids the recent sweep did not already answer are worth a window walk.
      const stillMissing = historicalKeys.filter(([messageId]) => !journeyByMessageId.has(messageId))
      if (!stillMissing.length) return
      // Bridge candidates first: their journeys sit furthest from their arrival, so
      // they are the ones the recent sweep is least likely to have covered — and the
      // budget below is small enough that ordering decides what gets spent on.
      const ordered = stillMissing
        .map(([messageId, key]) => ({ messageId, ...key }))
        .sort((a, b) => (Number(b.bridge) - Number(a.bridge)) || (b.timestampMs - a.timestampMs))
      const windows: { timestampMs: number; bridge: boolean }[] = []
      for (const key of ordered) {
        // One walk covers a span, so a nearby id needs no window of its own — but
        // only a walk at least as wide as this id needs can stand in for it.
        const covered = windows.some(w => (!key.bridge || w.bridge)
          && Math.abs(w.timestampMs - key.timestampMs) < (w.bridge ? WINDOW_MS_BRIDGE : WINDOW_MS_LOCAL))
        if (!covered) windows.push({ timestampMs: key.timestampMs, bridge: key.bridge })
        if (windows.length >= MAX_HISTORICAL_WINDOWS) break
      }
      for (const window of windows) {
        try {
          await walkWindowAt(window.timestampMs, window.bridge)
        } catch (err) {
          lastFailAt = Date.now()
          console.error('[Explorer] XCM historical journey walk failed:', err instanceof Error ? err.message : err)
          break
        }
      }
      // Whatever the walks did not resolve is recorded as an attempt, so the next
      // request spaces its retry rather than repeating this immediately.
      const unresolved = ordered.filter(k => !journeyByMessageId.has(k.messageId))
      if (unresolved.length) {
        const priorMisses = await fetchJourneyMisses(unresolved.map(k => k.messageId))
        persistJourneyMisses(unresolved.map(k => {
          const prior = priorMisses.get(k.messageId)
          return {
            message_id: k.messageId,
            attempts: Math.min(0xffff, (prior?.attempts ?? 0) + 1),
            first_seen_ms: prior?.firstSeenMs || k.timestampMs,
          }
        }))
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

// Resolve inbound journeys from memory and ClickHouse. Misses remain unenriched for
// this response and schedule background discovery for later requests.
//
// `bridge` is the caller's local guess that this row is a bridge arrival — an
// Ethereum-native asset credited from a sibling, say. It only ever steers how the
// background budget is spent and how wide its walk reaches; it never becomes a
// displayed origin, because holding a bridged asset on AssetHub and forwarding it
// looks identical from here and is not the same journey.
export async function xcmJourneySourcesFor(keys: { messageId: string; timestampMs: number; bridge?: boolean }[]): Promise<Map<string, XcmJourneySource>> {
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
  if (unresolved.length && OCELLOIDS_TOKEN) {
    // A topic id already looked for and not found waits out its backoff instead of
    // being re-walked on every request. The bridge case is exactly why the schedule
    // exists rather than a single attempt: its journey often appears only later.
    const misses = await fetchJourneyMisses(unresolved.map(k => k.messageId.toLowerCase()))
    const now = Date.now()
    const due = unresolved.filter(k => missIsDue(misses.get(k.messageId.toLowerCase()), now))
    queueBackgroundRefresh(
      due.map(key => ({ id: key.messageId, timestampMs: key.timestampMs, bridge: key.bridge })),
      true,
    )
  }
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
