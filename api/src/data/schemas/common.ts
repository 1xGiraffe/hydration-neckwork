import { z } from 'zod'

// Shared zod building blocks for the Data API's wire conventions
// (~/.g/hydraken-api-concept.md § 4 "Conventions"). Every /v1 route composes its
// request/response schemas from these so the contract stays uniform and the
// OpenAPI document describes it once.
//
// Differences from the public API's common.ts are deliberate contract choices,
// not drift: input addresses accept SS58 as well as hex (parsed in
// services/address.ts), feeds paginate by opaque cursor instead of
// limit/offset, and every error envelope may carry a `context` object.

// Timestamps are ISO-8601 UTC with milliseconds, in requests and responses.
export const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const zIsoTimestamp = z.string().regex(ISO_TIMESTAMP_RE, 'expected an ISO-8601 UTC timestamp')

// The single conversion into the wire format. ClickHouse hands DateTime columns
// back as 'YYYY-MM-DD hh:mm:ss' in the session timezone, which the data service
// asserts is UTC at boot (src/data/server.ts) — that assertion is what makes
// appending 'Z' correct here rather than a guess.
export function iso(d: Date | string | number): string {
  if (d instanceof Date) return assertValid(d, d)
  if (typeof d === 'number') return assertValid(new Date(d), d)
  const trimmed = d.trim()
  const zoned = /[Zz]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)
  return assertValid(new Date(zoned ? trimmed : `${trimmed.replace(' ', 'T')}Z`), d)
}

function assertValid(parsed: Date, input: Date | string | number): string {
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`not a timestamp: ${JSON.stringify(input)}`)
  return parsed.toISOString()
}

// A time filter accepts ISO-8601 (with or without milliseconds/zone) and is
// carried into ClickHouse as epoch seconds, so a caller's zone can never shift
// a window. Returned by zTimeFilter's transform.
export const zTimeParam = z.string().max(40)
  .refine(value => !Number.isNaN(Date.parse(value)), 'expected an ISO-8601 timestamp')
  .transform(value => Math.floor(Date.parse(value) / 1000))

// Block heights bind into ClickHouse UInt32, which wraps MOD 2^32 silently —
// the bound makes an overflow the caller's 400 instead of a wrong window.
export const MAX_BLOCK = 4_294_967_295
export const zBlock = z.coerce.number().int().min(0).max(MAX_BLOCK)

// Asset ids travel as decimal strings, exactly as on the public surface.
const MAX_ASSET_ID = 4_294_967_295
export const zAssetId = z.string()
  .regex(/^\d+$/, 'expected a decimal asset id')
  .refine(value => value.length <= 10 && Number(value) <= MAX_ASSET_ID, `asset id must be at most ${MAX_ASSET_ID}`)

// Canonical account output: SS58 (or H160 for an EVM account) plus the raw
// public-key hex, built by renderAccount in services/address.ts.
export const zAccountRef = z.object({
  address: z.string().describe('Canonical display address: Polkadot SS58 (prefix 0), or the H160 for an EVM account.'),
  accountIdHex: z.string().describe('The 0x-prefixed 32-byte public key — the join identity across every table.'),
  evmAddress: z.string().nullable().describe('The bound H160 when the account is EVM-mapped, else null.'),
})

// Address INPUT is free-form (SS58, H160, or 0x-64-hex) and parsed by
// services/address.ts; the schema only bounds it so the parser sees sane input.
export const zAddressParam = z.string().min(3).max(128)
  .describe('An account as SS58 (any prefix), H160, or 0x-prefixed 32-byte public-key hex.')

// ---------------------------------------------------------------------------
// Cursor pagination: ?limit= (1-100, default 25) and ?cursor= (opaque), with
// `order=asc|desc` (desc default). Responses are { items, nextCursor?, hasMore }.
// The cursor encodes the sort-key position of the last row served, so a page is
// O(1) at any depth and stable under live ingestion.
// ---------------------------------------------------------------------------

export const zLimit = z.coerce.number().int().min(1).max(100).default(25)
export const zOrder = z.enum(['asc', 'desc']).default('desc')
export const zCursor = z.string().max(600).optional()
  .describe('Opaque position from the previous page\'s `nextCursor`. Never construct one by hand.')

export const zFeedQuery = z.object({ limit: zLimit, cursor: zCursor, order: zOrder })

export function zFeedPage<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().optional().describe('Pass back as ?cursor= for the next page. Absent on the last page.'),
    hasMore: z.boolean(),
  })
}

export function encodeCursor(position: Record<string, number | string>): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* malformed cursor -> caller answers 400 */ }
  return null
}

// A decoded cursor field as a bounded non-negative integer, or null when the
// cursor does not carry a usable value (which the route turns into a 400 —
// silently restarting at page 1 would hide a paging bug in the consumer).
export function cursorUint(cursor: Record<string, unknown> | null, key: string, max = MAX_BLOCK): number | null {
  const value = cursor?.[key]
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null
}

// A cursor's fields as bounded non-negative integers, or null when no cursor
// was sent. A cursor that is present but unreadable is a 400 — silently
// restarting at page one would hide a paging bug in the consumer.
export function requireCursor<K extends string>(raw: string | undefined, keys: readonly K[], max = MAX_BLOCK): Record<K, number> | null {
  if (!raw) return null
  const decoded = decodeCursor(raw)
  const out = {} as Record<K, number>
  for (const key of keys) {
    const value = cursorUint(decoded, key, max)
    if (value == null) throw badRequest('unreadable cursor: pass back a nextCursor exactly as it was received')
    out[key] = value
  }
  return out
}

// The (block, index) cursor every position-keyed feed uses.
export function requirePositionCursor(raw: string | undefined): { b: number; i: number } | null {
  return requireCursor(raw, ['b', 'i'])
}

// The { items, nextCursor?, hasMore } page: the cursor names the last served
// row's position and is absent on the last page.
export function feedPage<T>(items: T[], hasMore: boolean, position: (last: T) => Record<string, number | string>): { items: T[]; hasMore: boolean; nextCursor?: string } {
  const last = items[items.length - 1]
  return { items, hasMore, ...(hasMore && last ? { nextCursor: encodeCursor(position(last)) } : {}) }
}

// The lexicographic keyset predicate for a cursor over sort columns c1..cn:
// desc -> (c1 < v1) OR (c1 = v1 AND c2 < v2) OR …; asc flips the comparators.
// Columns are SQL expressions the caller controls; values bind as parameters.
export interface KeysetColumn { sql: string; param: string }
export function keysetClause(order: 'asc' | 'desc', columns: KeysetColumn[]): string {
  const cmp = order === 'desc' ? '<' : '>'
  const alternatives = columns.map((column, i) => {
    const equalities = columns.slice(0, i).map(prev => `${prev.sql} = {${prev.param}}`)
    return [...equalities, `${column.sql} ${cmp} {${column.param}}`].join(' AND ')
  })
  return `(${alternatives.map(a => `(${a})`).join(' OR ')})`
}

// ---------------------------------------------------------------------------
// The one error shape on this surface: { error: { code, message, context? } }.
// `context` is resource-specific — the indexed head on a 404, usage numbers on
// a 429, the docs/token URLs on a 401 (concept § 6).
// ---------------------------------------------------------------------------

export type DataErrorCode = 'unauthorized' | 'rate_limited' | 'bad_request' | 'not_found' | 'internal'

export interface DataErrorEnvelope {
  error: { code: DataErrorCode; message: string; context?: Record<string, unknown> }
}

export function errorEnvelope(code: DataErrorCode, message: string, context?: Record<string, unknown>): DataErrorEnvelope {
  return { error: context ? { code, message, context } : { code, message } }
}

export const zError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    context: z.record(z.string(), z.unknown()).optional(),
  }),
})

export function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

// Comma-separated list parameters; blank entries are dropped.
export function csv(param: string | null | undefined): string[] {
  if (param == null) return []
  return param.split(',').map(part => part.trim()).filter(part => part.length > 0)
}
