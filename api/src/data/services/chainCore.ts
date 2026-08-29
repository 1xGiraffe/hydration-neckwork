import type { ClickHouseClient } from '../../db/client.ts'
import { attachExtrinsicHashes, type WithExtrinsicHash } from './extrinsicHashes.ts'
import { iso } from '../schemas/common.ts'
import { accountRefOrNull, type AccountRef, type ParsedAddress } from './address.ts'
import {
  DEDUP_SLACK, blockCursorSql, dedupPage, orderSql, positionCursorSql, requireBoundedWindow, versionedPageSql, windowSql,
  type Order, type PositionCursor, type WindowFilters,
} from './feed.ts'

// Chain-core reads for /v1/blocks, /v1/extrinsics and /v1/events. The raw
// tables are ReplacingMergeTree, so every feed over-fetches a slack past the
// page and deduplicates the replay identity in TS (the public staking-events
// idiom — LIMIT 1 BY would defeat the read-in-order early stop), and every
// point read uses FINAL, which its primary-key predicate keeps bounded. These
// are the decoder-dependent tables — a re-indexed range can carry different
// decoded content under the same identity — so their feeds take the version
// tie-break (versionedPageSql) and serve the newest version.

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export interface BlockHeader {
  height: number
  hash: string
  parentHash: string
  timestamp: string
  specVersion: number
  author: AccountRef | null
}

interface RawBlockRow {
  block_height: number
  block_hash: string
  parent_hash: string
  ts: string
  spec_version: number
  author: string | null
}

const BLOCK_COLUMNS_SQL = 'block_height, block_hash, parent_hash, toString(block_timestamp) AS ts, spec_version, author'

function blockHeader(row: RawBlockRow): BlockHeader {
  return {
    height: Number(row.block_height),
    hash: String(row.block_hash).toLowerCase(),
    parentHash: String(row.parent_hash).toLowerCase(),
    timestamp: iso(row.ts),
    specVersion: Number(row.spec_version),
    author: accountRefOrNull(row.author),
  }
}

export interface BlocksFeedOptions extends WindowFilters {
  limit: number
  order: Order
  cursorHeight: number | null
  // The indexed head, so a page can be pinned to the height range it must
  // fall in (see blocksFeed).
  head: number
}

// Block heights are contiguous (raw_blocks holds every height from 0 to the
// head — pinned live, zero gaps), so a page of `bound` blocks starting at the
// cursor (or the head) lies inside a known height range. Reading that range is
// a primary-key read (measured: 320 rows / 1 KiB); a bare `ORDER BY
// block_height DESC LIMIT n` scanned the whole live partitions instead (1.8 M
// rows / 247 MiB per page). A time window cannot be mapped to heights here, so
// it keeps the unranged read; a ranged page that comes back short (only
// possible at the chain's ends) falls back to it as well, so a gap could only
// ever cost time, never rows.
export async function blocksFeed(client: ClickHouseClient, options: BlocksFeedOptions): Promise<{ items: BlockHeader[]; hasMore: boolean }> {
  const bound = options.limit + 1 + DEDUP_SLACK
  const rangeable = options.fromTime == null && options.toTime == null
  const read = async (ranged: boolean) => {
    const params: Record<string, unknown> = { bound }
    const dir = options.order === 'desc' ? 'DESC' : 'ASC'
    let rangeSql = ''
    if (ranged) {
      if (options.order === 'desc') {
        const upper = options.cursorHeight != null ? options.cursorHeight - 1 : Math.min(options.toBlock ?? options.head, options.head)
        params.rangeFrom = Math.max(0, upper - bound + 1)
        rangeSql = ' AND block_height >= {rangeFrom:UInt32}'
      } else {
        const lower = options.cursorHeight != null ? options.cursorHeight + 1 : (options.fromBlock ?? 0)
        params.rangeTo = lower + bound - 1
        rangeSql = ' AND block_height <= {rangeTo:UInt32}'
      }
    }
    const res = await client.query({
      query: versionedPageSql(`-- data:blocks:feed
          SELECT ${BLOCK_COLUMNS_SQL}, ingested_at
          FROM price_data.raw_blocks
          WHERE 1 = 1${windowSql(options, params)}${blockCursorSql(options.order, params, options.cursorHeight)}${rangeSql}
          ORDER BY block_height ${dir}
          LIMIT {bound:UInt32}
          SETTINGS read_in_order_use_buffering = 0`, `block_height ${dir}`),
      query_params: params,
      format: 'JSONEachRow',
    })
    return dedupPage(await res.json<RawBlockRow & { ingested_at: string }>(), row => String(row.block_height), options.limit)
  }
  let result = await read(rangeable)
  if (rangeable && !result.hasMore) result = await read(false)
  return { items: result.page.map(blockHeader), hasMore: result.hasMore }
}

export async function blockByHeight(client: ClickHouseClient, height: number): Promise<BlockHeader | null> {
  const res = await client.query({
    query: `-- data:blocks:by-height
        SELECT ${BLOCK_COLUMNS_SQL}
        FROM price_data.raw_blocks FINAL
        WHERE block_height = {height:UInt32}
        LIMIT 1`,
    query_params: { height },
    format: 'JSONEachRow',
  })
  const [row] = await res.json<RawBlockRow>()
  return row ? blockHeader(row) : null
}

// Hash → height through block_hash_index, then re-read the CURRENT header by
// height and require the hash to still match: the index may hold a superseded
// hash after a replace, and that must be a 404, not another block's header.
export async function blockByHash(client: ClickHouseClient, hash: string): Promise<BlockHeader | null> {
  const res = await client.query({
    query: `-- data:blocks:by-hash
        SELECT block_height
        FROM price_data.block_hash_index FINAL
        WHERE block_hash = {hash:String}
        LIMIT 1`,
    query_params: { hash: hash.toLowerCase() },
    format: 'JSONEachRow',
  })
  const [indexRow] = await res.json<{ block_height: number }>()
  if (!indexRow) return null
  const header = await blockByHeight(client, Number(indexRow.block_height))
  return header && header.hash === hash.toLowerCase() ? header : null
}

export async function blockCounts(client: ClickHouseClient, height: number): Promise<{ extrinsicCount: number; eventCount: number }> {
  const [extRes, evRes] = await Promise.all([
    client.query({
      query: `-- data:blocks:extrinsic-count
          SELECT toString(uniqExact(extrinsic_index)) AS total FROM price_data.raw_extrinsics WHERE block_height = {height:UInt32}`,
      query_params: { height },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- data:blocks:event-count
          SELECT toString(uniqExact(event_index)) AS total FROM price_data.raw_events WHERE block_height = {height:UInt32}`,
      query_params: { height },
      format: 'JSONEachRow',
    }),
  ])
  return {
    extrinsicCount: Number((await extRes.json<{ total: string }>())[0]?.total ?? 0),
    eventCount: Number((await evRes.json<{ total: string }>())[0]?.total ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Extrinsics
// ---------------------------------------------------------------------------

export interface DispatchErrorDetail {
  kind: string
  module: string | null
  name: string | null
  docs: string | null
  raw: string
}

export interface ExtrinsicRow {
  blockHeight: number
  extrinsicIndex: number
  hash: string
  timestamp: string
  callName: string
  signer: AccountRef | null
  success: boolean
  fee: string | null
  tip: string | null
}

export interface ExtrinsicDetail extends ExtrinsicRow {
  args: unknown
  error: DispatchErrorDetail | null
}

interface RawExtrinsicRow {
  block_height: number
  extrinsic_index: number
  extrinsic_hash: string
  ts: string
  call_name: string
  signer: string | null
  success: number
  fee: string | null
  tip: string | null
  ingested_at?: string
}

const EXTRINSIC_COLUMNS_SQL = `
      block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, call_name,
      coalesce(signer, effective_signer) AS signer, success, fee, tip`

function extrinsicRow(row: RawExtrinsicRow): ExtrinsicRow {
  return {
    blockHeight: Number(row.block_height),
    extrinsicIndex: Number(row.extrinsic_index),
    hash: String(row.extrinsic_hash).toLowerCase(),
    timestamp: iso(row.ts),
    callName: String(row.call_name),
    signer: accountRefOrNull(row.signer),
    success: Number(row.success) === 1,
    fee: row.fee ?? null,
    tip: row.tip ?? null,
  }
}

// The DispatchError decoding rules are restated from the public service
// (public/services/chain.ts) rather than imported: the two surfaces are
// separately versioned contracts and the data tree is an import leaf. The two
// shapes (modern nested / 2022 flat) and the null-over-zero rules are the same.
interface ParsedDispatchError { kind: string; moduleIndex: number | null; errorIndex: number | null; raw: string }

const MAX_U8 = 255
const u8 = (value: number): number | null => (Number.isInteger(value) && value >= 0 && value <= MAX_U8 ? value : null)

function palletIndex(value: unknown): number | null {
  if (typeof value === 'number') return u8(value)
  if (typeof value !== 'string' || value.trim() === '') return null
  return u8(Number(value))
}

function errorIndexOf(value: unknown): number | null {
  if (typeof value === 'number') return u8(value)
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  if (/^0x[0-9a-fA-F]{2,}$/.test(text)) return u8(parseInt(text.slice(2, 4), 16))
  return u8(Number(text))
}

export function parseDispatchError(raw: string | null | undefined): ParsedDispatchError | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  const error = parsed as Record<string, unknown> | null
  const kind = typeof error?.__kind === 'string' ? error.__kind : null
  if (!kind) return null
  if (kind !== 'Module') return { kind, moduleIndex: null, errorIndex: null, raw }
  const nested = error?.value as { index?: unknown; error?: unknown } | undefined
  const source = palletIndex(nested?.index) != null ? nested : error
  const moduleIndex = palletIndex(source?.index)
  if (moduleIndex == null) return { kind, moduleIndex: null, errorIndex: null, raw }
  return { kind, moduleIndex, errorIndex: errorIndexOf(source?.error), raw }
}

async function nameModuleError(client: ClickHouseClient, blockHeight: number, moduleIndex: number, errorIndex: number) {
  const res = await client.query({
    query: `-- data:extrinsic:error-name
        SELECT pallet_name, error_name, docs
        FROM price_data.runtime_error_names
        WHERE spec_version = (SELECT spec_version FROM price_data.raw_blocks WHERE block_height = {height:UInt32} LIMIT 1)
          AND pallet_index = {pallet:UInt8} AND error_index = {error:UInt8}
        ORDER BY ingested_at DESC
        LIMIT 1`,
    query_params: { height: blockHeight, pallet: moduleIndex, error: errorIndex },
    format: 'JSONEachRow',
  })
  return (await res.json<{ pallet_name: string; error_name: string; docs: string }>())[0] ?? null
}

export function parseJsonColumn(raw: string | null | undefined): unknown {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

async function hydrateExtrinsicDetail(client: ClickHouseClient, row: (RawExtrinsicRow & { call_args_json: string; error_json: string | null }) | undefined): Promise<ExtrinsicDetail | null> {
  if (!row) return null
  const parsed = parseDispatchError(row.error_json)
  const named = parsed?.moduleIndex != null && parsed.errorIndex != null
    ? await nameModuleError(client, Number(row.block_height), parsed.moduleIndex, parsed.errorIndex)
    : null
  return {
    ...extrinsicRow(row),
    args: parseJsonColumn(row.call_args_json),
    error: parsed
      ? { kind: parsed.kind, module: named?.pallet_name ?? null, name: named?.error_name ?? null, docs: named?.docs || null, raw: parsed.raw }
      : null,
  }
}

export async function extrinsicAt(client: ClickHouseClient, blockHeight: number, index: number): Promise<ExtrinsicDetail | null> {
  const res = await client.query({
    query: `-- data:extrinsic:by-position
        SELECT ${EXTRINSIC_COLUMNS_SQL}, call_args_json, error_json
        FROM price_data.raw_extrinsics FINAL
        WHERE block_height = {height:UInt32} AND extrinsic_index = {index:UInt32}
        LIMIT 1`,
    query_params: { height: blockHeight, index },
    format: 'JSONEachRow',
  })
  return hydrateExtrinsicDetail(client, (await res.json<RawExtrinsicRow & { call_args_json: string; error_json: string | null }>())[0])
}

// Hash → position through extrinsic_hash_index (full history, no time bound —
// the reason the index exists), newest inclusion first for the rare
// unsigned-hash collision.
export async function extrinsicPositionByHash(client: ClickHouseClient, hash: string): Promise<{ blockHeight: number; extrinsicIndex: number } | null> {
  const res = await client.query({
    query: `-- data:extrinsic:hash-index
        SELECT block_height, extrinsic_index
        FROM price_data.extrinsic_hash_index FINAL
        WHERE extrinsic_hash = {hash:String}
        ORDER BY block_height DESC, extrinsic_index DESC
        LIMIT 1`,
    query_params: { hash: hash.toLowerCase() },
    format: 'JSONEachRow',
  })
  const [row] = await res.json<{ block_height: number; extrinsic_index: number }>()
  return row ? { blockHeight: Number(row.block_height), extrinsicIndex: Number(row.extrinsic_index) } : null
}

export interface ExtrinsicsFeedOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
  signer: ParsedAddress | null
  success?: boolean
  call?: string
}

export async function extrinsicsFeed(client: ClickHouseClient, options: ExtrinsicsFeedOptions): Promise<{ items: ExtrinsicRow[]; hasMore: boolean }> {
  if (options.signer) return signerExtrinsicsFeed(client, options, options.signer)
  // call= cannot prune the (block_height, extrinsic_index) key: bounded window
  // required (the route documents this in its schema).
  if (options.call) requireBoundedWindow(options, 'call')
  const params: Record<string, unknown> = { bound: options.limit + 1 + DEDUP_SLACK }
  const clauses: string[] = []
  if (options.call) { clauses.push('call_name = {call:String}'); params.call = options.call }
  if (options.success != null) { clauses.push('success = {success:UInt8}'); params.success = options.success ? 1 : 0 }
  const res = await client.query({
    query: versionedPageSql(`-- data:extrinsics:feed
        SELECT ${EXTRINSIC_COLUMNS_SQL}, ingested_at
        FROM price_data.raw_extrinsics
        WHERE ${clauses.length ? clauses.join(' AND ') : '1 = 1'}${windowSql(options, params)}${positionCursorSql(options.order, 'extrinsic_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'extrinsic_index')}
        LIMIT {bound:UInt32}
        SETTINGS read_in_order_use_buffering = 0`, orderSql(options.order, 'extrinsic_index')),
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(await res.json<RawExtrinsicRow>(), row => `${row.block_height}:${row.extrinsic_index}`, options.limit)
  return { items: page.map(extrinsicRow), hasMore }
}

// The signer-scoped feed reads extrinsics_by_signer — account-first, so the
// page is a reverse key-range read at any depth. The projection carries every
// column the feed row needs; `signer` echoes the canonical form of the matched
// identity (the projection indexes signer and effective_signer separately).
async function signerExtrinsicsFeed(client: ClickHouseClient, options: ExtrinsicsFeedOptions, signer: ParsedAddress): Promise<{ items: ExtrinsicRow[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: signer.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const clauses: string[] = ['account = {account:String}']
  if (options.call) { clauses.push('call_name = {call:String}'); params.call = options.call }
  if (options.success != null) { clauses.push('success = {success:UInt8}'); params.success = options.success ? 1 : 0 }
  const res = await client.query({
    query: versionedPageSql(`-- data:extrinsics:by-signer
        SELECT block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, call_name,
               account AS signer, success, fee, tip, ingested_at
        FROM price_data.extrinsics_by_signer
        WHERE ${clauses.join(' AND ')}${windowSql(options, params)}${positionCursorSql(options.order, 'extrinsic_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'extrinsic_index')}
        LIMIT {bound:UInt32}`, orderSql(options.order, 'extrinsic_index')),
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(await res.json<RawExtrinsicRow>(), row => `${row.block_height}:${row.extrinsic_index}`, options.limit)
  return { items: page.map(extrinsicRow), hasMore }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  eventName: string
  timestamp: string
  args: unknown
}

interface RawEventRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  event_name: string
  ts: string
  args_json: string
  ingested_at?: string
}

const EVENT_COLUMNS_SQL = 'block_height, event_index, extrinsic_index, event_name, toString(block_timestamp) AS ts, args_json'

function eventRow(row: RawEventRow): EventRow {
  return {
    blockHeight: Number(row.block_height),
    eventIndex: Number(row.event_index),
    extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
    eventName: String(row.event_name),
    timestamp: iso(row.ts),
    args: parseJsonColumn(row.args_json),
  }
}

export interface EventsFeedOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
  names?: string[]
}

export async function eventsFeed(client: ClickHouseClient, options: EventsFeedOptions): Promise<{ items: Array<WithExtrinsicHash<EventRow>>; hasMore: boolean }> {
  // An event-name predicate only has the set(200) skip index, which prunes
  // granules but not partitions — the bounded window is what keeps this a
  // partition-pruned read.
  if (options.names?.length) requireBoundedWindow(options, 'name')
  const params: Record<string, unknown> = { bound: options.limit + 1 + DEDUP_SLACK }
  const clauses: string[] = []
  if (options.names?.length) { clauses.push('event_name IN {names:Array(String)}'); params.names = [...options.names].sort() }
  const res = await client.query({
    query: versionedPageSql(`-- data:events:feed
        SELECT ${EVENT_COLUMNS_SQL}, ingested_at
        FROM price_data.raw_events
        WHERE ${clauses.length ? clauses.join(' AND ') : '1 = 1'}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}
        SETTINGS read_in_order_use_buffering = 0`, orderSql(options.order, 'event_index')),
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(await res.json<RawEventRow>(), row => `${row.block_height}:${row.event_index}`, options.limit)
  return { items: await attachExtrinsicHashes(client, page.map(eventRow)), hasMore }
}

export async function eventAt(client: ClickHouseClient, blockHeight: number, eventIndex: number): Promise<WithExtrinsicHash<EventRow> | null> {
  const res = await client.query({
    query: `-- data:events:by-position
        SELECT ${EVENT_COLUMNS_SQL}
        FROM price_data.raw_events FINAL
        WHERE block_height = {height:UInt32} AND event_index = {index:UInt32}
        LIMIT 1`,
    query_params: { height: blockHeight, index: eventIndex },
    format: 'JSONEachRow',
  })
  const [row] = await res.json<RawEventRow>()
  if (!row) return null
  const [item] = await attachExtrinsicHashes(client, [eventRow(row)])
  return item
}

// A block's whole extrinsic/event lists: point ranges on each table's key,
// FINAL-bounded, un-paginated (a block's contents are bounded by block weight).
export async function blockExtrinsics(client: ClickHouseClient, height: number): Promise<ExtrinsicRow[]> {
  const res = await client.query({
    query: `-- data:blocks:extrinsics
        SELECT ${EXTRINSIC_COLUMNS_SQL}
        FROM price_data.raw_extrinsics FINAL
        WHERE block_height = {height:UInt32}
        ORDER BY extrinsic_index ASC`,
    query_params: { height },
    format: 'JSONEachRow',
  })
  return (await res.json<RawExtrinsicRow>()).map(extrinsicRow)
}

export async function blockEvents(client: ClickHouseClient, height: number): Promise<Array<WithExtrinsicHash<EventRow>>> {
  const res = await client.query({
    query: `-- data:blocks:events
        SELECT ${EVENT_COLUMNS_SQL}
        FROM price_data.raw_events FINAL
        WHERE block_height = {height:UInt32}
        ORDER BY event_index ASC`,
    query_params: { height },
    format: 'JSONEachRow',
  })
  return attachExtrinsicHashes(client, (await res.json<RawEventRow>()).map(eventRow))
}

// Events of one extrinsic: a (block, extrinsic) predicate over the block's
// key-pruned range.
export async function extrinsicEvents(client: ClickHouseClient, height: number, extrinsicIndex: number): Promise<Array<WithExtrinsicHash<EventRow>>> {
  const res = await client.query({
    query: `-- data:extrinsic:events
        SELECT ${EVENT_COLUMNS_SQL}
        FROM price_data.raw_events FINAL
        WHERE block_height = {height:UInt32} AND extrinsic_index = {index:UInt32}
        ORDER BY event_index ASC`,
    query_params: { height, index: extrinsicIndex },
    format: 'JSONEachRow',
  })
  return attachExtrinsicHashes(client, (await res.json<RawEventRow>()).map(eventRow))
}
