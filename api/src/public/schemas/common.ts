import { z } from 'zod'

// Shared zod building blocks for the public API's wire conventions
// (docs/superpowers/specs/2026-08-12-public-rest-api-design.md, "Wire
// conventions"). Every /v1 route composes its request/response schemas from
// these, so the contract stays uniform and OpenAPI documents it once.

// Addresses are hex public keys — 20 bytes (H160) or 32 bytes (substrate),
// lowercase. SS58 is never accepted or emitted on this surface.
export const HEX_ADDRESS_RE = /^0x[0-9a-f]{40}([0-9a-f]{24})?$/

// `.toLowerCase()` is a zod string *overwrite* check, not a `.transform()`: it
// normalizes case while leaving the schema a plain string. That matters twice —
// the JSON schema keeps its `pattern` (so OpenAPI documents the real format),
// and the same schema is usable in responses. A `.transform()` is
// unidirectional, and fastify-type-provider-zod v7 serializes responses by
// encoding, which throws "Encountered unidirectional transform during encode"
// the first time such a schema appears in a response body.
export const zHexAddress = z.string().toLowerCase().regex(HEX_ADDRESS_RE, 'expected a 0x-prefixed 20- or 32-byte lowercase hex address')

// Asset ids travel as the on-chain registry id in decimal string form ("5",
// "1000765") — never a number, so a consumer cannot lose precision or reformat it.
// The registry id is a UInt32 on chain, and the bound is enforced here rather than at
// each query: an id past it overflows the Array(UInt32) parameter a filter binds it
// into, which would surface as a 500 instead of the caller's 400.
const MAX_ASSET_ID = 4_294_967_295
export const zAssetId = z.string()
  .regex(/^\d+$/, 'expected a decimal asset id')
  .refine(value => value.length <= 10 && Number(value) <= MAX_ASSET_ID, `asset id must be at most ${MAX_ASSET_ID}`)

// Timestamps are ISO-8601 UTC with milliseconds, in requests and responses.
export const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const zIsoTimestamp = z.string().regex(ISO_TIMESTAMP_RE, 'expected an ISO-8601 UTC timestamp')

// The single conversion into the wire format. ClickHouse hands DateTime columns
// back as 'YYYY-MM-DD hh:mm:ss' in the session timezone, which the public
// service asserts is UTC at boot (src/public/server.ts) — that assertion is what
// makes appending 'Z' correct here rather than a guess.
export function iso(d: Date | string | number): string {
  if (d instanceof Date) return assertValid(d, d)
  if (typeof d === 'number') return assertValid(new Date(d), d)
  const trimmed = d.trim()
  // Already carries a zone (…Z or ±hh:mm) — let Date parse it as-is.
  const zoned = /[Zz]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)
  return assertValid(new Date(zoned ? trimmed : `${trimmed.replace(' ', 'T')}Z`), d)
}

function assertValid(parsed: Date, input: Date | string | number): string {
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`not a timestamp: ${JSON.stringify(input)}`)
  return parsed.toISOString()
}

// Enums are lowercase and unwrapped everywhere on the wire.
export const zPeriod = z.enum(['1h', '24h', '7d', '30d', '1y', 'all'])
export const zBucket = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'])

// Pagination is uniform: ?limit=&offset= in, { items, totalCount } out. Both
// bounds are hard — an out-of-range offset is a 400, never a silent page 1, so a
// paging bug in a consumer surfaces instead of quietly re-serving the first page.
export const zLimitOffset = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
})

export function zPage<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    // Rows matching the request before limit/offset, so a client can size its pager.
    totalCount: z.number().int().nonnegative(),
  })
}

// The one error shape on this surface, matching the HTTP status.
export function errorEnvelope(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } }
}

// Comma-separated list parameters (assets=5,10 / status=created,completed).
// Blank entries are dropped, so a trailing comma is not an empty filter value.
export function csv(param: string | null | undefined): string[] {
  if (param == null) return []
  return param.split(',').map(part => part.trim()).filter(part => part.length > 0)
}
