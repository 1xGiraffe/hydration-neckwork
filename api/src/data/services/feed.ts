import { badRequest } from '../schemas/common.ts'

// The feed mechanics every Data API list endpoint is built from, in one place:
// the window quartet, the (block, index) keyset cursor, replay dedup, and the
// read pattern that keeps a page a key-range read. A feed that needs one of
// these imports it from here rather than restating it.

export type Order = 'asc' | 'desc'

// Over-fetch past the page so that replayed rows (a ReplacingMergeTree holds
// two versions of a row between an insert and its merge) can be collapsed in
// TS without shortening the page.
export const DEDUP_SLACK = 100

// ---------------------------------------------------------------------------
// Window quartet
// ---------------------------------------------------------------------------

export interface WindowFilters {
  fromBlock?: number
  toBlock?: number
  fromTime?: number // epoch seconds
  toTime?: number
}

// A selective filter over a column the sort key cannot prune (call= on the
// global extrinsic feed, name= on the global event feed) must be windowed or it
// is a whole-table scan. 90 days matches the public hash-lookup cap; the block
// form is sized generously for the 2 s cadence migration (90 d ≈ 3.9 M blocks).
export const MAX_FILTER_WINDOW_DAYS = 90
export const MAX_FILTER_WINDOW_BLOCKS = 4_000_000

// Enforces the bounded-window rule (concept § 4 "Conventions"): the caller must
// pin BOTH ends of a window, by block or by time, and the span must fit.
export function requireBoundedWindow(filters: WindowFilters, filterName: string): void {
  const blockSpanOk = filters.fromBlock != null && filters.toBlock != null
    && filters.toBlock - filters.fromBlock <= MAX_FILTER_WINDOW_BLOCKS
  const timeSpanOk = filters.fromTime != null && filters.toTime != null
    && filters.toTime - filters.fromTime <= MAX_FILTER_WINDOW_DAYS * 86_400
  if (blockSpanOk || timeSpanOk) return
  throw Object.assign(
    badRequest(`the ${filterName} filter scans outside the sort key, so it requires a bounded window: pass fromTime and toTime at most ${MAX_FILTER_WINDOW_DAYS} days apart, or fromBlock and toBlock at most ${MAX_FILTER_WINDOW_BLOCKS} blocks apart`),
    { context: { maxWindowDays: MAX_FILTER_WINDOW_DAYS, maxWindowBlocks: MAX_FILTER_WINDOW_BLOCKS } },
  )
}

// The quartet as SQL, binding whichever bounds are present. Both ends are
// inclusive; an inverted window is simply empty.
export function windowSql(filters: WindowFilters, params: Record<string, unknown>, timeColumn = 'block_timestamp'): string {
  const clauses: string[] = []
  if (filters.fromBlock != null) { clauses.push('block_height >= {fromBlock:UInt32}'); params.fromBlock = filters.fromBlock }
  if (filters.toBlock != null) { clauses.push('block_height <= {toBlock:UInt32}'); params.toBlock = filters.toBlock }
  if (filters.fromTime != null) { clauses.push(`${timeColumn} >= toDateTime({fromTime:UInt32})`); params.fromTime = filters.fromTime }
  if (filters.toTime != null) { clauses.push(`${timeColumn} <= toDateTime({toTime:UInt32})`); params.toTime = filters.toTime }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
}

// ---------------------------------------------------------------------------
// Keyset cursor over (block_height, <index column>)
// ---------------------------------------------------------------------------

export interface PositionCursor { b: number; i: number }

// The keyset predicate for the last served (block, index): strictly past it in
// the feed's direction. `cb`/`ci` are the bound parameter names.
export function positionCursorSql(order: Order, indexColumn: string, params: Record<string, unknown>, cursor: PositionCursor | null): string {
  if (!cursor) return ''
  params.cb = cursor.b
  params.ci = cursor.i
  const cmp = order === 'desc' ? '<' : '>'
  return ` AND (block_height ${cmp} {cb:UInt32} OR (block_height = {cb:UInt32} AND ${indexColumn} ${cmp} {ci:UInt32}))`
}

// A single-column block cursor (block-grid histories, the block feed).
export function blockCursorSql(order: Order, params: Record<string, unknown>, cursorBlock: number | null): string {
  if (cursorBlock == null) return ''
  params.cb = cursorBlock
  return ` AND block_height ${order === 'desc' ? '<' : '>'} {cb:UInt32}`
}

export function orderSql(order: Order, indexColumn: string): string {
  const dir = order === 'desc' ? 'DESC' : 'ASC'
  return `block_height ${dir}, ${indexColumn} ${dir}`
}

// ---------------------------------------------------------------------------
// Replay dedup and the version tie-break
// ---------------------------------------------------------------------------

// Collapse a replay identity keeping the FIRST occurrence in the rows' order,
// then cut the page. Combined with versionedPageSql the first occurrence is
// the newest version; on the by-account twins (whose replayed rows are
// byte-identical) any occurrence is the same row.
export function dedupPage<T>(rows: T[], identity: (row: T) => string, limit: number): { page: T[]; hasMore: boolean } {
  const seen = new Set<string>()
  const deduped: T[] = []
  for (const row of rows) {
    const key = identity(row)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }
  return { page: deduped.slice(0, limit), hasMore: deduped.length > limit }
}

// ClickHouse reads a key-prefixed feed in sort-key order and stops at LIMIT
// only while the ORDER BY is a prefix of the sort key. Appending the
// replacement version (`ingested_at DESC`) as a tie-break silently turns the
// read into a full range scan plus sort — measured live on one account's
// extrinsics page: 1.36 M rows / 103 MiB against 280 k / 20 MiB without it,
// and 4.3 M against 190 k rows on a contract's log page. So the tie-break is
// applied OUTSIDE the bounded read: `pageSelect` pages in key order and
// LIMITs (it must select `ingested_at`), and this wrapper orders those ≤bound
// rows with the version last, so dedupPage's first-wins picks the newest
// version of a replayed identity. The inner LIMIT cutting between two versions
// of one identity can only affect the last, slack-covered row, never the page.
export function versionedPageSql(pageSelect: string, orderBy: string): string {
  return `SELECT * FROM (${pageSelect}) ORDER BY ${orderBy}, ingested_at DESC`
}
