import type { ClickHouseClient } from '../db/client.ts'

// Wall-clock ↔ block-height index, shared by every history reconstruction.
//
// History is bucketed on wall-clock marks (see bucketLadder), but the source
// tables are keyed by block, and two of them carry no timestamp at all. So each
// bucket boundary needs the height it corresponds to. That mapping is a property
// of the CHAIN, not of any account, which is what makes it cheap: one index
// serves every request instead of the per-account boundary lookup the block-
// bucketed reconstruction used to run.
//
// Granularity is one hour because every ladder step is a whole number of hours,
// so every boundary lands on an hour mark this index already holds. ~39k rows
// for the chain's life, built in ~15ms.

const HOUR = 3_600

export interface BlockClock {
  /** Hour marks (unix seconds), ascending. */
  hours: number[]
  /**
   * heights[i] = the greatest block height in the hour STARTING at hours[i], i.e. up
   * to an hour after the mark itself (see heightAtOrBefore).
   */
  heights: number[]
  /**
   * atMark[i] = the greatest block height timestamped exactly at hours[i], 0 when no
   * block landed on the mark. With heights[i - 1] it gives the true height at or
   * before the mark (heightAtOrBeforeExact). Optional so hand-built clocks stay valid;
   * a clock without it resolves a mark to the last block strictly before it.
   */
  atMark?: number[]
  /**
   * Unix seconds of the newest block the clock has seen. Every hour mark at or
   * before it resolves to its final at-or-before height (clockCoveredSec). Optional
   * so hand-built clocks stay valid; without it the newest mark is the bound.
   */
  lastTime?: number
  builtAt: number
}

let clock: BlockClock | null = null
let inFlight: Promise<BlockClock> | null = null

/** Rebuild no more often than this; the head only adds hours. */
const REFRESH_MS = 60_000
/**
 * A caller that needs a mark the clock has not reached yet (blockClockCovering)
 * may force an incremental refresh, but no more often than this: when the blocks
 * table itself is behind, every such request would otherwise re-read the newest
 * hour, and the caller clamps to the coverage it gets instead.
 */
const FORCED_REFRESH_MS = 2_000

async function load(client: ClickHouseClient, from: BlockClock | null): Promise<BlockClock> {
  // Incremental past the newest hour already held: the chain only appends, and
  // the newest hour is re-read because it was still filling when it was cached.
  // Re-read from its mark INCLUSIVE: the blocks stamped exactly on the mark are
  // that hour's atMark, and a strict bound would drop them from the re-read row.
  const since = from && from.hours.length ? from.hours[from.hours.length - 1] : null
  const rows = await client.query({
    query: `SELECT toUInt32(toUnixTimestamp(toStartOfHour(block_timestamp))) AS h,
                   max(block_height) AS top,
                   maxIf(block_height, block_timestamp = toStartOfHour(block_timestamp)) AS at_mark,
                   toUInt32(toUnixTimestamp(max(block_timestamp))) AS top_ts
            FROM price_data.blocks
            WHERE block_timestamp >= toDateTime({since:UInt32})
            GROUP BY h ORDER BY h`,
    // Genesis carries a zero timestamp in this table; anything before the chain
    // existed would put a bogus first mark decades before the first block.
    query_params: { since: since ?? Date.parse('2020-01-01T00:00:00Z') / 1000 },
    format: 'JSONEachRow',
  })
  const fresh = await rows.json<{ h: number; top: number; at_mark?: number; top_ts?: number }>()

  const keep = from ? Math.max(0, from.hours.length - 1) : 0
  const hours = from ? from.hours.slice(0, keep) : []
  const heights = from ? from.heights.slice(0, keep) : []
  const atMark = from ? (from.atMark ?? new Array<number>(from.hours.length).fill(0)).slice(0, keep) : []
  let lastTime = from?.lastTime
  for (const row of fresh) {
    hours.push(Number(row.h))
    heights.push(Number(row.top))
    atMark.push(Number(row.at_mark ?? 0) || 0)
    const t = Number(row.top_ts ?? 0) || 0
    if (t > 0) lastTime = Math.max(lastTime ?? 0, t)
  }
  return { hours, heights, atMark, ...(lastTime != null ? { lastTime } : {}), builtAt: Date.now() }
}

/** The shared clock, built on first use and refreshed at the head. */
export async function blockClock(client: ClickHouseClient): Promise<BlockClock> {
  if (clock && Date.now() - clock.builtAt < REFRESH_MS) return clock
  return refresh(client)
}

/**
 * The newest instant the clock resolves exactly: every hour mark at or before it
 * has its final heightAtOrBeforeExact (the blocks table is appended in height
 * order, so once a block at or after a mark is in, every block before it is too).
 * Null for an empty clock.
 */
export function clockCoveredSec(c: BlockClock): number | null {
  if (!c.hours.length) return null
  return Math.max(c.hours[c.hours.length - 1], c.lastTime ?? 0)
}

/**
 * The shared clock, refreshed now (incrementally, rate-limited) when it does not
 * yet cover `sec`. A cached clock can be up to REFRESH_MS behind the head, and a
 * mark past its coverage resolves to a height the chain has since moved beyond,
 * so a caller that states a bucket end as exact must either get a covering clock
 * or clamp to clockCoveredSec of the one returned — the blocks table can lag.
 */
export async function blockClockCovering(client: ClickHouseClient, sec: number): Promise<BlockClock> {
  const current = await blockClock(client)
  const covered = clockCoveredSec(current)
  if (covered != null && covered >= sec) return current
  if (Date.now() - current.builtAt < FORCED_REFRESH_MS) return current
  return refresh(client)
}

function refresh(client: ClickHouseClient): Promise<BlockClock> {
  if (inFlight) return inFlight
  const prev = clock
  inFlight = load(client, prev)
    .then(next => { clock = next; return next })
    // A refresh failure must not take out a working index; keep serving the
    // previous one and try again on the next call.
    .catch(err => { if (prev) return prev; throw err })
    .finally(() => { inFlight = null })
  return inFlight
}

/** Index of the newest hour mark at or before `mark`, or -1. */
function hourIndex(c: BlockClock, mark: number): number {
  if (!c.hours.length || mark < c.hours[0]) return -1
  let lo = 0
  let hi = c.hours.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (c.hours[mid] <= mark) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The height the explorer's value-history chart dates a bucket boundary by, or
 * null when the instant predates the first indexed block. Binary search over the
 * hour marks; any instant in an hour — the mark itself included — resolves to
 * that hour's LAST block.
 *
 * Despite the name this is not "at or before" on a mark: a boundary at exactly
 * 00:00 resolves to the block closing 00:59:54, up to an hour after the instant
 * (measured on price_data.blocks: 2026-09-21 00:00:00 → 14,847,647 at 00:59:54,
 * where the true at-or-before height is 14,846,068). The chart's height-keyed
 * sources (position state, farm intervals, total-share steps, money-market
 * snapshots) are bucketed through it, so correcting it here would move every
 * existing chart; it is kept for that chart only. Anything that PUBLISHES a
 * bucket's block height, or must not see a state from after the bucket end, uses
 * heightAtOrBeforeExact.
 */
export function heightAtOrBefore(c: BlockClock, tsSec: number): number | null {
  const i = hourIndex(c, Math.floor(tsSec / HOUR) * HOUR)
  return i < 0 ? null : c.heights[i]
}

/**
 * The greatest block height whose timestamp is at or before `tsSec`, or null when
 * the instant predates the first indexed block.
 *
 * Exact on an hour mark — every ladder boundary is one: the blocks stamped exactly
 * on the mark (atMark) if any, else the last block of an earlier hour. Inside an
 * hour the hourly index cannot see where the instant falls, so it answers the
 * mark's height (at or before, possibly up to an hour stale) — except in the
 * newest hour, which the chain has not finished, where the newest height is at or
 * before any instant at the head.
 */
export function heightAtOrBeforeExact(c: BlockClock, tsSec: number): number | null {
  const mark = Math.floor(tsSec / HOUR) * HOUR
  const i = hourIndex(c, mark)
  if (i < 0) return null
  if (c.hours[i] < mark) return c.heights[i] // no block in the mark's hour at all
  if (tsSec > mark && i === c.hours.length - 1) return c.heights[i]
  const onMark = c.atMark?.[i] ?? 0
  if (onMark > 0) return onMark
  return i > 0 ? c.heights[i - 1] : null
}

/**
 * An instant no earlier than block `height`'s own time: the end of the first
 * clock hour whose greatest height reaches it. Null when the clock has not seen
 * the block yet. Conservative by construction — the block lies inside that hour —
 * so a finality check on it can only close a window late, never early.
 */
export function timeUpperBoundOfHeight(c: BlockClock, height: number): number | null {
  let lo = 0
  let hi = c.heights.length - 1
  if (hi < 0 || c.heights[hi] < height) return null
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (c.heights[mid] >= height) hi = mid
    else lo = mid + 1
  }
  return c.hours[lo] + HOUR
}

/**
 * Heights for a list of wall-clock boundaries, in the same order. A boundary
 * before the chain's first block falls back to `floorHeight` so a window that
 * opens before the account existed still has a lower bound to carry in from.
 */
export function heightsForBoundaries(c: BlockClock, boundariesSec: number[], floorHeight: number): number[] {
  return boundariesSec.map(t => heightAtOrBefore(c, t) ?? floorHeight)
}
