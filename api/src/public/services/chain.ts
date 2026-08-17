import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { iso } from '../schemas/common.ts'

// Chain lookups for GET /v1/extrinsics/*, GET /v1/otc/orders/:orderId and
// GET /v1/staking/events — the three surfaces the Hydration UI reads out of the
// archive indexer today. Public-owned: the explorer resolves the same facts, but
// this file never imports explorerService (spec: "Isolation rule"), so the rules
// that give each answer its meaning are restated here rather than shared.

// ---------------------------------------------------------------------------
// Extrinsics
// ---------------------------------------------------------------------------

/**
 * A decoded DispatchError. `kind` is the error's own variant (Module, Token,
 * Arithmetic, BadOrigin, …). `module`/`name`/`docs` are filled only for a Module
 * error whose (spec_version, pallet_index, error_index) triple the runtime
 * metadata index knows; an unknown triple reports nulls rather than a guess, and
 * `raw` always carries the undecoded JSON so a caller can decode it itself.
 */
export interface DispatchErrorDetail {
  kind: string
  module: string | null
  name: string | null
  docs: string | null
  raw: string
}

export interface ExtrinsicDetail {
  blockHeight: number
  extrinsicIndex: number
  hash: string
  timestamp: string
  signer: string | null
  success: boolean
  error: DispatchErrorDetail | null
}

/**
 * How far back the hash lookup searches, in days, and its hard cap.
 *
 * `raw_extrinsics` is ordered (block_height, extrinsic_index) and carries no
 * index over `extrinsic_hash`, so an unbounded hash lookup is a whole-table scan
 * (measured on the live table: 32.8M rows / 2.11 GiB / ~200 ms per miss). This
 * endpoint is polled every 10 s per pending toast and every poll is a fresh hash,
 * so a scan per lookup is not affordable. `block_timestamp` is the partition-key
 * expression, so a time bound prunes whole partitions: measured, 7 days reads
 * 5 MiB and 90 days 189 MiB. The window is therefore part of the contract, and an
 * older extrinsic is addressed by (blockHeight, index) instead.
 */
export const DEFAULT_HASH_LOOKUP_DAYS = 7
export const MAX_HASH_LOOKUP_DAYS = 90

interface RawExtrinsicRow {
  block_height: number
  extrinsic_index: number
  extrinsic_hash: string
  ts: string
  signer: string | null
  success: number
  error_json: string | null
}

const EXTRINSIC_COLUMNS_SQL = `
      block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts,
      coalesce(signer, effective_signer) AS signer, success, error_json`

/**
 * The parsed shape of a DispatchError before its Module indices are named.
 *
 * A Module error carries its pallet and error indices in one of TWO shapes, and
 * both are live in this table:
 *
 *  * MODERN (blocks 1,476,029 →, 362,080 rows): `{__kind, value: {index, error}}`,
 *    where `error` is a 4-byte little-endian array rendered as hex and only its
 *    FIRST byte is the error index inside the pallet.
 *  * FLAT (blocks 692,900 … 1,475,949, 2022-07-06 … 2022-11-29, 601 rows):
 *    `{__kind, index, error}` with both at the top level and `error` a plain
 *    integer — no byte array to slice.
 *
 * Reading only the modern shape left all 601 flat rows unnamed even though
 * `runtime_error_names` can name every one of them (verified: 601 of 601), and
 * the by-position route is age-unlimited by contract, so that era is reachable.
 * The nested shape is tried first so it stays authoritative wherever it exists.
 *
 * Every non-Module variant carries no indices, so they stay null instead of
 * defaulting to 0, which is a real pallet/error index — as does a Module error in
 * neither shape.
 */
export interface ParsedDispatchError {
  kind: string
  moduleIndex: number | null
  errorIndex: number | null
  raw: string
}

/**
 * Both indices are `u8` on chain, and `nameModuleError` binds them as ClickHouse
 * `UInt8`, which THROWS on an out-of-range value rather than truncating — so a
 * malformed row carrying 300 would be a 500 where every other unreadable field
 * here is a null. Bounding both readers at the wire type makes that structurally
 * unreachable instead of merely improbable. (Live census: pallet indices run
 * 0…203 and error indices 0…30, so nothing real is near the bound.)
 */
const MAX_U8 = 255

/** A `u8` index, or null. Shared by both readers so neither can outrun the bind. */
function u8(value: number): number | null {
  return Number.isInteger(value) && value >= 0 && value <= MAX_U8 ? value : null
}

/**
 * A pallet index, from either shape's `index`. Anything that is not a `u8` is
 * absent, never 0 — 0 is System, a real pallet.
 */
function palletIndex(value: unknown): number | null {
  if (typeof value === 'number') return u8(value)
  if (typeof value !== 'string' || value.trim() === '') return null
  return u8(Number(value))
}

/**
 * An error index, from either shape's `error`: the low byte of the modern hex
 * array, or the flat shape's integer as it stands.
 *
 * A blank or whitespace-only string is ABSENT, not 0. `Number('')` and
 * `Number('   ')` are both 0, so reading them as a value would fabricate the
 * pallet's FIRST error — the same wrong-but-valid triple the old
 * `parseInt(hex.slice(2, 4) || '0', 16)` produced for a missing field, reached by
 * a different route. Not live-reachable (no nested row lacks the field or carries
 * it blank), so this is a guard rather than a repair.
 */
function errorIndexOf(value: unknown): number | null {
  if (typeof value === 'number') return u8(value)
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  // The low byte of a little-endian hex array; the remaining bytes are padding.
  if (/^0x[0-9a-fA-F]{2,}$/.test(text)) return u8(parseInt(text.slice(2, 4), 16))
  return u8(Number(text))
}

export function parseDispatchError(raw: string | null | undefined): ParsedDispatchError | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const error = parsed as Record<string, unknown> | null
  const kind = typeof error?.__kind === 'string' ? error.__kind : null
  if (!kind) return null
  if (kind !== 'Module') return { kind, moduleIndex: null, errorIndex: null, raw }
  const nested = error?.value as { index?: unknown; error?: unknown } | undefined
  // The nested shape wins where it exists; the flat one is the 2022 fallback.
  const source = palletIndex(nested?.index) != null ? nested : error
  const moduleIndex = palletIndex(source?.index)
  if (moduleIndex == null) return { kind, moduleIndex: null, errorIndex: null, raw }
  return { kind, moduleIndex, errorIndex: errorIndexOf(source?.error), raw }
}

/**
 * Name a Module error for the runtime that raised it. `runtime_error_names` is
 * keyed (spec_version, pallet_index, error_index) and the block's spec version is
 * a primary-key point read on `blocks`, so this is two key lookups on small
 * tables and it runs only for a failed extrinsic.
 */
async function nameModuleError(
  client: ClickHouseClient,
  blockHeight: number,
  moduleIndex: number,
  errorIndex: number,
): Promise<{ pallet_name: string; error_name: string; docs: string } | null> {
  const res = await client.query({
    query: `-- pub:extrinsic:error-name
        SELECT pallet_name, error_name, docs
        FROM price_data.runtime_error_names
        WHERE spec_version = (SELECT spec_version FROM price_data.blocks WHERE block_height = {height:UInt32} LIMIT 1)
          AND pallet_index = {pallet:UInt8} AND error_index = {error:UInt8}
        ORDER BY ingested_at DESC
        LIMIT 1`,
    query_params: { height: blockHeight, pallet: moduleIndex, error: errorIndex },
    format: 'JSONEachRow',
  })
  return (await res.json<{ pallet_name: string; error_name: string; docs: string }>())[0] ?? null
}

/** A 32-byte substrate account id (an EVM signer is stored in its ETH-prefixed form). */
const ACCOUNT_RE = /^0x[0-9a-f]{64}$/

async function hydrateExtrinsic(client: ClickHouseClient, row: RawExtrinsicRow | undefined): Promise<ExtrinsicDetail | null> {
  if (!row) return null
  const blockHeight = Number(row.block_height)
  const parsed = parseDispatchError(row.error_json)
  const named = parsed?.moduleIndex != null && parsed.errorIndex != null
    ? await nameModuleError(client, blockHeight, parsed.moduleIndex, parsed.errorIndex)
    : null
  const signer = (row.signer ?? '').toLowerCase()
  return {
    blockHeight,
    extrinsicIndex: Number(row.extrinsic_index),
    hash: String(row.extrinsic_hash).toLowerCase(),
    timestamp: iso(row.ts),
    signer: ACCOUNT_RE.test(signer) ? signer : null,
    success: Number(row.success) === 1,
    error: parsed
      ? { kind: parsed.kind, module: named?.pallet_name ?? null, name: named?.error_name ?? null, docs: named?.docs || null, raw: parsed.raw }
      : null,
  }
}

/**
 * Resolve an extrinsic by hash inside the documented time window.
 *
 * Ordered newest-block-first so a hash that somehow appears twice reports its
 * most recent inclusion, then newest ingest so a replayed row (the table is a
 * ReplacingMergeTree on `ingested_at`) resolves to the same values FINAL would —
 * without paying for FINAL on a predicate the primary key cannot bound.
 */
export async function getExtrinsicByHash(client: ClickHouseClient, hash: string, withinDays: number): Promise<ExtrinsicDetail | null> {
  const res = await client.query({
    query: `-- pub:extrinsic:by-hash
        SELECT ${EXTRINSIC_COLUMNS_SQL}
        FROM price_data.raw_extrinsics
        WHERE block_timestamp >= now() - toIntervalDay({days:UInt16})
          AND extrinsic_hash = {hash:String}
        ORDER BY block_height DESC, extrinsic_index DESC, ingested_at DESC
        LIMIT 1`,
    query_params: { hash: hash.toLowerCase(), days: withinDays },
    format: 'JSONEachRow',
  })
  return hydrateExtrinsic(client, (await res.json<RawExtrinsicRow>())[0])
}

/** Resolve an extrinsic by its canonical (blockHeight, index) identity — a primary-key read. */
export async function getExtrinsicAt(client: ClickHouseClient, blockHeight: number, index: number): Promise<ExtrinsicDetail | null> {
  const res = await client.query({
    query: `-- pub:extrinsic:by-position
        SELECT ${EXTRINSIC_COLUMNS_SQL}
        FROM price_data.raw_extrinsics
        WHERE block_height = {blockHeight:UInt32} AND extrinsic_index = {index:UInt32}
        ORDER BY ingested_at DESC
        LIMIT 1`,
    query_params: { blockHeight, index },
    format: 'JSONEachRow',
  })
  return hydrateExtrinsic(client, (await res.json<RawExtrinsicRow>())[0])
}

// ---------------------------------------------------------------------------
// OTC orders
// ---------------------------------------------------------------------------

export type OtcOrderStatus = 'open' | 'filled' | 'cancelled'
export type OtcEventType = 'placed' | 'filled' | 'partiallyFilled' | 'cancelled'

export interface OtcOrderEvent {
  type: OtcEventType
  blockHeight: number
  eventIndex: number
  timestamp: string
  /** The order's size on `placed`, and the fill's size on `filled`/`partiallyFilled`. */
  amountIn: string | null
  amountOut: string | null
  /** The filling account — carried only by the two fill events. */
  filler: string | null
}

export interface OtcOrder {
  orderId: number
  /**
   * Always null. OTC.Placed does not carry the order's owner and no indexed model
   * records it, so reporting the placing extrinsic's signatory here would be wrong
   * for a proxied or batched placement. The field exists so a later owner model can
   * fill it without a /v2.
   */
  owner: string | null
  assetIn: string
  assetOut: string
  amountIn: string
  amountOut: string
  partiallyFillable: boolean
  status: OtcOrderStatus
  filledAmountIn: string
  filledAmountOut: string
  events: OtcOrderEvent[]
}

export interface OtcEventRow {
  event_name: string
  asset_in: number
  asset_out: number
  amount_in: string
  amount_out: string
  partially_fillable: number
  filler: string
  block_height: number
  event_index: number
  ts: string
}

const OTC_EVENT_TYPES: Record<string, OtcEventType> = {
  Placed: 'placed',
  Filled: 'filled',
  PartiallyFilled: 'partiallyFilled',
  Cancelled: 'cancelled',
}

/** Raw on-chain amounts stay integer strings end to end; anything else is absent. */
function rawAmount(value: unknown): string | null {
  const input = String(value ?? '').trim()
  return /^\d+$/.test(input) ? input : null
}

/**
 * Fold an order's event rows into its current state.
 *
 * The pair, the order size and `partiallyFillable` are read from the Placed row
 * ONLY: `otc_order_events` defaults an absent field to 0 on a fill or cancel row,
 * and 0 is also HDX's real registry id, so taking the pair off any other row
 * would silently report HDX/HDX. An order whose Placed event is not indexed has
 * no knowable pair, so it folds to null rather than to a fabricated one.
 *
 * Status is the LAST terminal event in block order — Filled and Cancelled are
 * both terminal, and partial fills never end an order.
 */
export function foldOtcOrder(orderId: number, rows: OtcEventRow[]): OtcOrder | null {
  const ordered = [...rows].sort((a, b) => Number(a.block_height) - Number(b.block_height) || Number(a.event_index) - Number(b.event_index))
  const placed = ordered.find(row => row.event_name === 'Placed')
  if (!placed) return null

  let status: OtcOrderStatus = 'open'
  let filledIn = 0n
  let filledOut = 0n
  const events: OtcOrderEvent[] = []
  for (const row of ordered) {
    const type = OTC_EVENT_TYPES[row.event_name]
    if (!type) continue
    if (type === 'filled') status = 'filled'
    if (type === 'cancelled') status = 'cancelled'
    const amountIn = rawAmount(row.amount_in)
    const amountOut = rawAmount(row.amount_out)
    if (type === 'filled' || type === 'partiallyFilled') {
      filledIn += BigInt(amountIn ?? '0')
      filledOut += BigInt(amountOut ?? '0')
    }
    events.push({
      type,
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(row.ts),
      amountIn,
      amountOut,
      filler: ACCOUNT_RE.test(String(row.filler ?? '').toLowerCase()) ? String(row.filler).toLowerCase() : null,
    })
  }

  return {
    orderId,
    owner: null,
    assetIn: String(placed.asset_in),
    assetOut: String(placed.asset_out),
    amountIn: rawAmount(placed.amount_in) ?? '0',
    amountOut: rawAmount(placed.amount_out) ?? '0',
    partiallyFillable: Number(placed.partially_fillable) === 1,
    status,
    filledAmountIn: filledIn.toString(),
    filledAmountOut: filledOut.toString(),
    events,
  }
}

/** One order's full event history. `order_id` leads the table's key, so this is a key-range read. */
export async function getOtcOrder(client: ClickHouseClient, orderId: number): Promise<OtcOrder | null> {
  const res = await client.query({
    // FINAL is bounded by the order_id predicate, which is the leading key
    // column, so replay deduplication costs one order's rows.
    query: `-- pub:otc:order
        SELECT event_name, asset_in, asset_out, amount_in, amount_out, partially_fillable, filler,
               block_height, event_index, toString(block_timestamp) AS ts
        FROM price_data.otc_order_events FINAL
        WHERE order_id = {orderId:UInt32}
        ORDER BY block_height, event_index`,
    query_params: { orderId },
    format: 'JSONEachRow',
  })
  return foldOtcOrder(orderId, await res.json<OtcEventRow>())
}

// ---------------------------------------------------------------------------
// Staking events
// ---------------------------------------------------------------------------

/** The two staking event streams the staking dashboard reads, by their unqualified names. */
export const STAKING_EVENT_TYPES = ['AccumulatedRpsUpdated', 'StakingInitialized'] as const
export type StakingEventType = (typeof STAKING_EVENT_TYPES)[number]

export interface StakingEvent {
  type: StakingEventType
  blockHeight: number
  eventIndex: number
  timestamp: string
  /** AccumulatedRpsUpdated: reward-per-share accumulator, raw integer. */
  accumulatedRps: string | null
  /** AccumulatedRpsUpdated: total staked HDX at the update, raw integer. */
  totalStake: string | null
  /** StakingInitialized: the pot's non-dustable balance, raw integer. */
  nonDustableBalance: string | null
}

export interface StakingArgs {
  accumulatedRps: string | null
  totalStake: string | null
  nonDustableBalance: string | null
}

/**
 * The typed fields of each stream's args. Values stay integer strings — the RPS
 * accumulator and the total stake both exceed 2^53 — and a missing or non-integer
 * field reports null rather than 0, which would read as a real accumulator value.
 */
export function parseStakingEventArgs(type: StakingEventType, argsJson: string): StakingArgs {
  let parsed: Record<string, unknown> = {}
  try {
    const value = JSON.parse(argsJson)
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>
  } catch {
    parsed = {}
  }
  if (type === 'StakingInitialized') {
    return { accumulatedRps: null, totalStake: null, nonDustableBalance: rawAmount(parsed.nonDustableBalance) }
  }
  return {
    accumulatedRps: rawAmount(parsed.accumulatedRps),
    totalStake: rawAmount(parsed.totalStake),
    nonDustableBalance: null,
  }
}

export interface StakingEventsOptions {
  types: StakingEventType[]
  fromBlock: number | null
  toBlock: number | null
  limit: number
  offset: number
}

/** Extra rows read past the page so replay duplicates cannot shorten it. */
const DEDUP_SLACK = 100

interface RawStakingRow {
  event_name: string
  block_height: number
  event_index: number
  ts: string
  args_json: string
}

/**
 * Staking events oldest first, which is the order the APR reconstruction needs:
 * it differences each accumulator against the previous one.
 *
 * `raw_events` is ordered (block_height, event_index), so an ascending page with
 * an optional `fromBlock` reads in key order and stops early. Deduplication of
 * the ReplacingMergeTree key happens in TS over an over-fetched window rather
 * than through LIMIT 1 BY, which would defeat that early stop.
 */
export async function queryStakingEvents(client: ClickHouseClient, options: StakingEventsOptions): Promise<{ items: StakingEvent[]; totalCount: number }> {
  const names = options.types.map(type => `Staking.${type}`).sort()
  const filter = [
    'event_name IN {names:Array(String)}',
    options.fromBlock == null ? '' : 'AND block_height >= {fromBlock:UInt32}',
    options.toBlock == null ? '' : 'AND block_height <= {toBlock:UInt32}',
  ].filter(Boolean).join(' ')
  const params: Record<string, unknown> = { names }
  if (options.fromBlock != null) params.fromBlock = options.fromBlock
  if (options.toBlock != null) params.toBlock = options.toBlock

  const [rows, totalCount] = await Promise.all([
    (async () => {
      const res = await client.query({
        // `read_in_order_use_buffering = 0` is load-bearing, not a tuning knob.
        // These events are ~1 per 1,200 blocks, so every granule the scan touches
        // yields at most one row and the LIMIT is what must stop the read. With
        // read-in-order buffering on, ClickHouse pre-reads far past the point the
        // page is complete: measured on the live table, the default first page
        // read 136M rows / 850 MiB, and with buffering off the same page reads
        // 9.5M rows / 199 MiB. `args_json` is the column that makes the
        // difference expensive.
        query: `-- pub:staking:events
            SELECT event_name, block_height, event_index, toString(block_timestamp) AS ts, args_json
            FROM price_data.raw_events
            WHERE ${filter}
            ORDER BY block_height ASC, event_index ASC
            LIMIT {bound:UInt32}
            SETTINGS read_in_order_use_buffering = 0`,
        query_params: { ...params, bound: options.limit + options.offset + DEDUP_SLACK },
        format: 'JSONEachRow',
      })
      const seen = new Set<string>()
      const deduped: RawStakingRow[] = []
      for (const row of await res.json<RawStakingRow>()) {
        const key = `${row.block_height}:${row.event_index}`
        if (seen.has(key)) continue
        seen.add(key)
        deduped.push(row)
      }
      return deduped.slice(options.offset, options.offset + options.limit)
    })(),
    // One count per filter, shared by every page of it. Unbounded it spans the
    // whole event stream (measured: 754 MiB) and the answer moves once per reward
    // accrual — roughly every two hours — so it is held far longer than a page.
    cached(`pub:staking-events-count:${names.join(',')}:${options.fromBlock ?? ''}:${options.toBlock ?? ''}`, 300_000, async () => {
      const res = await client.query({
        // uniqExact over the replacement key, not count(): a replayed row must not
        // inflate the total the pager sizes itself on.
        query: `-- pub:staking:events-count
            SELECT toString(uniqExact((block_height, event_index))) AS total
            FROM price_data.raw_events
            WHERE ${filter}`,
        query_params: params,
        format: 'JSONEachRow',
      })
      return Number((await res.json<{ total: string }>())[0]?.total ?? 0)
    }),
  ])

  const items = rows.map(row => {
    const type = row.event_name.split('.')[1] as StakingEventType
    return {
      type,
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(row.ts),
      ...parseStakingEventArgs(type, row.args_json),
    }
  })
  return { items, totalCount }
}
