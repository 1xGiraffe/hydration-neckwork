// formatQueryParams is the client's own serializer but not re-exported by
// @clickhouse/client, so client-common is a direct dependency. Both are pinned to
// the same EXACT version in package.json (@clickhouse/client itself depends on an
// exact client-common), so one copy is installed — a caret on the client would let
// a fresh install float it to a release depending on a different client-common and
// install a second copy beside this pin. Bump the two together; `npm ls
// @clickhouse/client-common` must show one version, deduped.
import { formatQueryParams } from '@clickhouse/client-common'

// Bound query parameters travel in the request URL as `param_<name>=<value>`, and
// ClickHouse refuses any one of them longer than `http_max_field_value_size`
// (131,072 bytes by default) with "Field value too long" — measured on the
// URL-ENCODED value, so an Array(UInt32) of 8-digit blocks costs 11 bytes per
// element (`%2C` separators) and runs out at ~11.9k elements, and an
// Array(String) of 64-hex accounts costs 72 (`%27…%27%2C`) and runs out at ~1.8k.
// A list sized by chain data (a pool's swap blocks, a tag's members, a page's
// account forms) grows past that silently; the query fails only once it does.
export const HTTP_FIELD_VALUE_LIMIT = 131_072

// What one chunk of a bound list may cost. Half the server ceiling leaves room
// for the other `param_` entries and for an element longer than the ones measured.
export const QUERY_PARAM_BYTE_BUDGET = 64 * 1024

/** The bytes ClickHouse measures for one bound parameter: its formatted, URL-encoded value. */
export function encodedParamBytes(value: unknown): number {
  return new URLSearchParams([['v', formatQueryParams({ value })]]).toString().length - 2
}

/**
 * Splits a list bound as one `Array(...)` parameter into chunks whose encoded
 * size stays under `budget` (and, when given, at most `maxItems` long). Order is
 * kept; an empty list yields no chunks. A single element over the budget still
 * gets a chunk of its own — the guard below then names it rather than this
 * splitter looping.
 */
export function chunkByParamBytes<T>(items: readonly T[], budget = QUERY_PARAM_BYTE_BUDGET, maxItems = Infinity): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const item of items) {
    // `[` and `]` encode to 3 bytes each, every separator to `%2C`.
    const cost = encodedParamBytes([item]) - 6
    if (current.length && (6 + bytes + 3 + cost > budget || current.length >= maxItems)) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    bytes += (current.length ? 3 : 0) + cost
    current.push(item)
  }
  if (current.length) chunks.push(current)
  return chunks
}

/**
 * Runs `run` over byte-bounded chunks of `items`, `concurrency` at a time, and
 * returns the results in chunk order (callers concatenate them).
 */
export async function mapParamChunks<T, R>(
  items: readonly T[],
  run: (chunk: T[]) => Promise<R>,
  { concurrency = 4, budget = QUERY_PARAM_BYTE_BUDGET, maxItems = Infinity }: { concurrency?: number; budget?: number; maxItems?: number } = {},
): Promise<R[]> {
  const chunks = chunkByParamBytes(items, budget, maxItems)
  const out = new Array<R>(chunks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < chunks.length) { const index = next++; out[index] = await run(chunks[index]) }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker))
  return out
}

/** Error for a bound parameter the server would refuse. Names the parameter and its size, never its value. */
export class QueryParamTooLargeError extends Error {
  constructor(readonly param: string, readonly bytes: number) {
    super(`query parameter "${param}" is ${bytes} encoded bytes, over the ${HTTP_FIELD_VALUE_LIMIT}-byte http_max_field_value_size; chunk the list (mapParamChunks) or inline it`)
    this.name = 'QueryParamTooLargeError'
  }
}

/** The most URL-encoded bytes one UTF-16 code unit of a bound string can cost. */
export const MAX_ENCODED_BYTES_PER_UNIT = 9

/**
 * Throws before the request is sent when any bound parameter would exceed the
 * server's field ceiling. The failure is the same one ClickHouse would return,
 * but named — which parameter, how large — and catchable in a unit test with a
 * stub client, so an unbounded list is found by the test suite rather than by a
 * production list growing past it.
 */
export function assertQueryParamsFit(params: Record<string, unknown> | undefined): void {
  if (!params) return
  for (const [key, value] of Object.entries(params)) {
    // Only a bounded scalar is skipped: every container the client serializes — an
    // Array, a Map, a plain object (bound as a Map or Tuple) — and every string is
    // measured, so a Map(String, …) sized by chain data cannot slip past the guard.
    if (value == null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' || value instanceof Date) continue
    // Fast path only where it is provably safe: one UTF-16 code unit encodes to at
    // most 9 URL bytes (a 3-byte UTF-8 character such as 漢 is %E6%BC%A2; a
    // surrogate pair is 4 bytes = 12 encoded over 2 units; an escaped backslash or
    // quote is 2 × 3), so a string under a ninth of the ceiling cannot reach it.
    // Anything longer is measured exactly.
    if (typeof value === 'string' && value.length * MAX_ENCODED_BYTES_PER_UNIT < HTTP_FIELD_VALUE_LIMIT) continue
    const bytes = encodedParamBytes(value)
    if (bytes > HTTP_FIELD_VALUE_LIMIT) throw new QueryParamTooLargeError(key, bytes)
  }
}

/**
 * `expr IN <list>` for a list bound as parameters, split into byte-bounded
 * `Array(type)` chunks (`<name>_0`, `<name>_1`, …) OR-ed together, so a list that
 * grows with chain data (custody accounts, tag members) never runs one parameter
 * past the server's field ceiling. An empty list is `0` (matches nothing). The
 * whole request line is still bounded by the server's `max_uri_size` (1 MiB),
 * which is ~14k 64-hex accounts — the caller's list must stay well inside it.
 */
export function inChunkedSql(
  expr: string, name: string, items: readonly string[], type = 'String', budget = QUERY_PARAM_BYTE_BUDGET,
): { sql: string; params: Record<string, string[]> } {
  const chunks = chunkByParamBytes(items, budget)
  if (!chunks.length) return { sql: '0', params: {} }
  const params: Record<string, string[]> = {}
  const parts = chunks.map((chunk, i) => {
    params[`${name}_${i}`] = chunk
    return `${expr} IN {${name}_${i}:Array(${type})}`
  })
  return { sql: parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`, params }
}
