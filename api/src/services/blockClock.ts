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
  /** heights[i] = the greatest block height in or before hours[i]. */
  heights: number[]
  builtAt: number
}

let clock: BlockClock | null = null
let inFlight: Promise<BlockClock> | null = null

/** Rebuild no more often than this; the head only adds hours. */
const REFRESH_MS = 60_000

async function load(client: ClickHouseClient, from: BlockClock | null): Promise<BlockClock> {
  // Incremental past the newest hour already held: the chain only appends, and
  // the newest hour is re-read because it was still filling when it was cached.
  const since = from && from.hours.length ? from.hours[from.hours.length - 1] : null
  const rows = await client.query({
    query: `SELECT toUInt32(toUnixTimestamp(toStartOfHour(block_timestamp))) AS h,
                   max(block_height) AS top
            FROM price_data.blocks
            WHERE block_timestamp > toDateTime({since:UInt32})
            GROUP BY h ORDER BY h`,
    // Genesis carries a zero timestamp in this table; anything before the chain
    // existed would put a bogus first mark decades before the first block.
    query_params: { since: since ?? Date.parse('2020-01-01T00:00:00Z') / 1000 },
    format: 'JSONEachRow',
  })
  const fresh = await rows.json<{ h: number; top: number }>()

  const hours = from ? from.hours.slice(0, Math.max(0, from.hours.length - 1)) : []
  const heights = from ? from.heights.slice(0, Math.max(0, from.heights.length - 1)) : []
  for (const row of fresh) {
    hours.push(Number(row.h))
    heights.push(Number(row.top))
  }
  return { hours, heights, builtAt: Date.now() }
}

/** The shared clock, built on first use and refreshed at the head. */
export async function blockClock(client: ClickHouseClient): Promise<BlockClock> {
  if (clock && Date.now() - clock.builtAt < REFRESH_MS) return clock
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

/**
 * The greatest block height at or before `tsSec`, or null when the instant
 * predates the first indexed block. Binary search over the hour marks; an
 * instant inside an hour resolves to that hour's last block, which is the
 * height a bucket ENDING at that instant is dated by.
 */
export function heightAtOrBefore(c: BlockClock, tsSec: number): number | null {
  const mark = Math.floor(tsSec / HOUR) * HOUR
  if (!c.hours.length || mark < c.hours[0]) return null
  let lo = 0
  let hi = c.hours.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (c.hours[mid] <= mark) lo = mid
    else hi = mid - 1
  }
  return c.heights[lo]
}

/**
 * Heights for a list of wall-clock boundaries, in the same order. A boundary
 * before the chain's first block falls back to `floorHeight` so a window that
 * opens before the account existed still has a lower bound to carry in from.
 */
export function heightsForBoundaries(c: BlockClock, boundariesSec: number[], floorHeight: number): number[] {
  return boundariesSec.map(t => heightAtOrBefore(c, t) ?? floorHeight)
}
