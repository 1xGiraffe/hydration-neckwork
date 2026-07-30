import { describe, expect, it } from 'vitest'
import {
  activityCutoffFromDate,
  activitySourceCoversCutoff,
  activitySourceSeedSize,
  activitySourcesNeedingMore,
  activityWindowDepth,
  compareActivityRowsNewestFirst,
  completeActivityPageCutoff,
  type ActivityRow,
} from '../src/services/explorerService.ts'

// The merged feed's paging rests on one claim: a block covered by every source
// classifies exactly as it would with the whole history in hand. Stated over pages
// that means TWO WINDOWS BUILT AT ANY TWO DEPTHS AGREE ON THEIR COMMON PREFIX — a
// deeper window may know more rows, but it must not reorder or drop one a shallower
// window already published. Row COUNTS cannot check this: the failure shows matching
// counts with different content.
//
// `buildActivityWindow` itself is not exported and needs twelve ClickHouse sources,
// but its DECISIONS are four exported pure functions and the ordering is a function of
// exactly those. The simulation below runs them in the builder's own sequence over
// frozen rows, which is where the invariant can be pinned deterministically.
//
// The simulation also makes the scheme's PRECONDITION visible. The loop merges and
// cuts by (blockHeight, eventIndex) but bounds each widened source re-read by the
// cutoff row's calendar DAY (activityCutoffFromDate). Those are two different
// orderings, and the proof that a narrowed bound only ever discards rows from below
// the cutoff holds only while calendar day is monotone along the block-descending
// merge. Every merged-feed source selects its own block's `block_timestamp`, so it
// holds today — and the second fixture below shows precisely what breaks if it stops.

const MAX_SOURCE_ROWS = 90_000
// Any monotone block -> time map will do; the point is that ONE map serves every
// source, exactly as `block_timestamp` does on chain.
const BLOCKS_PER_DAY = 7_200
const BASE_BLOCK = 13_000_000

function dayOfBlock(blockHeight: number): string {
  const index = Math.floor((blockHeight - BASE_BLOCK) / BLOCKS_PER_DAY)
  const date = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000)
  return date.toISOString().slice(0, 10)
}
const chainTimestamp = (blockHeight: number): string => `${dayOfBlock(blockHeight)} 12:00:00`

interface FrozenSource {
  key: string
  /** Newest-first, exactly as every source reader returns its rows. */
  rows: ActivityRow[]
}

const row = (blockHeight: number, eventIndex: number, type: ActivityRow['type'], timestamp = chainTimestamp(blockHeight)): ActivityRow => ({
  type,
  blockHeight,
  timestamp,
  eventIndex,
  extrinsicIndex: eventIndex,
  who: null,
  to: null,
  asset: null,
  assetIn: null,
  assetOut: null,
  amount: null,
  amountIn: null,
  amountOut: null,
  valueUsd: 1_000_000,
} as ActivityRow)

const oldestOf = (rows: ActivityRow[]): { blockHeight: number; eventIndex: number } | null => {
  let oldest: { blockHeight: number; eventIndex: number } | null = null
  for (const r of rows) {
    const candidate = { blockHeight: r.blockHeight, eventIndex: r.eventIndex ?? -1 }
    if (oldest == null || candidate.blockHeight < oldest.blockHeight ||
      (candidate.blockHeight === oldest.blockHeight && candidate.eventIndex < oldest.eventIndex)) oldest = candidate
  }
  return oldest
}

// A source read: the newest `limit` rows that fall inside [sourceFrom, to]. Day
// granular, because source readers take day bounds.
const readSource = (source: FrozenSource, limit: number, sourceFrom: string | undefined): ActivityRow[] =>
  source.rows.filter(r => sourceFrom == null || r.timestamp.slice(0, 10) >= sourceFrom).slice(0, limit)

interface BuildResult {
  rows: ActivityRow[]
  /** Days each source's surviving rows were actually read under, by iteration order. */
  bounds: (string | undefined)[]
  /** True when the loop finished with no cutoff while a source bound was still narrowed. */
  finishedUnproven: boolean
}

/**
 * `buildActivityWindow`'s classified branch reduced to its decisions: seed every
 * source, merge, sort, take the cutoff, ask which sources have not proven it, widen
 * those and narrow their date bound to the cutoff's day, repeat.
 */
function buildWindow(sources: FrozenSource[], want: number, from?: string): BuildResult {
  const limits = new Map(sources.map(s => [s.key, activitySourceSeedSize(want)]))
  const cache = new Map<string, ActivityRow[]>()
  const loadedFrom = new Map<string, string | undefined>()
  let exactSourceFrom = from

  for (;;) {
    const pages = sources.map(source => {
      if (!cache.has(source.key)) {
        cache.set(source.key, readSource(source, limits.get(source.key)!, exactSourceFrom))
        loadedFrom.set(source.key, exactSourceFrom)
      }
      const rows = cache.get(source.key)!
      return { key: source.key, rawSize: rows.length, fetchSize: limits.get(source.key)!, rows, oldest: oldestOf(rows) }
    })

    const visible = pages.flatMap(page => page.rows).sort(compareActivityRowsNewestFirst)
    const cutoff = completeActivityPageCutoff(visible, want)
    const incomplete = activitySourcesNeedingMore(pages, cutoff, false)
    const bounds = sources.map(s => loadedFrom.get(s.key))

    if (!incomplete.length) {
      return { rows: visible, bounds, finishedUnproven: !cutoff && bounds.some(bound => bound !== from) }
    }

    exactSourceFrom = cutoff ? activityCutoffFromDate(from, visible, want) : from
    for (const source of incomplete) {
      if (source.fetchSize >= MAX_SOURCE_ROWS) return { rows: visible, bounds, finishedUnproven: false }
      limits.set(source.key, Math.min(source.fetchSize * 4, MAX_SOURCE_ROWS))
      cache.delete(source.key)
    }
  }
}

const identity = (r: ActivityRow): string => `${r.blockHeight}:${r.eventIndex ?? -1}:${r.type}`

/** First index at which two windows' common prefix disagrees, or -1. */
function firstDivergence(left: string[], right: string[]): number {
  const common = Math.min(left.length, right.length)
  for (let i = 0; i < common; i++) if (left[i] !== right[i]) return i
  return -1
}

// Two opposite shapes, which is what makes a date-narrowed widening round discard
// rows a previous round had already contributed: `dense` supplies most of the recent
// feed, `backloaded` starts well below the tip so it is thin recently and thick in
// older history, and `sparse` reaches furthest back per row.
function frozenSources(timestampOf: (blockHeight: number) => string): FrozenSource[] {
  const make = (key: string, type: ActivityRow['type'], count: number, top: number, step: number, eventIndex: number): FrozenSource => ({
    key,
    rows: Array.from({ length: count }, (_, i) => {
      const blockHeight = top - i * step
      return row(blockHeight, eventIndex, type, timestampOf(blockHeight))
    }),
  })
  return [
    make('dense', 'trade', 400, 14_000_000, 300, 5),
    make('backloaded', 'vote', 400, 14_000_000 - 60_000, 300, 7),
    make('sparse', 'liquidity', 60, 14_000_000 - 1_000, 4_000, 9),
  ]
}

// Every depth in the source comment's measured set, plus a dense sweep across the
// range where the recorded divergence sat.
const DEPTHS = [...new Set([25, 32, 50, 64, 75, 100, 128, ...Array.from({ length: 60 }, (_, i) => 45 + i)])]
  .sort((a, b) => a - b)

describe('merged-feed windows agree on their common prefix at every depth', () => {
  const sources = frozenSources(chainTimestamp)

  it('sweeps enough depths, including unquantised ones, for the pairing to mean something', () => {
    // Pinned so a depth list that shrank fails here rather than making every
    // comparison below vacuous.
    expect(DEPTHS).toHaveLength(63)
    expect(DEPTHS).toContain(75)
    expect(DEPTHS.filter(d => activityWindowDepth(d) !== d)).toHaveLength(60)
    for (const depth of DEPTHS) {
      expect(buildWindow(sources, depth).rows.length, `depth ${depth}`).toBeGreaterThanOrEqual(depth)
    }
  })

  it('agrees on the common prefix for every pair of depths', () => {
    const windows = new Map(DEPTHS.map(depth => [depth, buildWindow(sources, depth).rows.slice(0, depth).map(identity)]))

    let compared = 0
    const divergences: string[] = []
    for (const a of DEPTHS) {
      for (const b of DEPTHS) {
        if (a >= b) continue
        const at = firstDivergence(windows.get(a)!, windows.get(b)!)
        if (at !== -1) divergences.push(`depth ${a} vs ${b} diverge at index ${at}`)
        compared += 1
      }
    }
    expect(divergences).toEqual([])
    // 63 depths -> 63*62/2 ordered pairs, all of them checked.
    expect(compared).toBe(1953)
  })

  it('never finishes a window whose cutoff was lost while a source bound was narrowed', () => {
    expect(DEPTHS.filter(depth => buildWindow(sources, depth).finishedUnproven)).toEqual([])
  })

  it('narrows a source bound only to a day at or before the cutoff it must cover', () => {
    let checked = 0
    for (const depth of DEPTHS) {
      const built = buildWindow(sources, depth)
      const oldestPublished = built.rows[depth - 1]
      for (const bound of built.bounds) {
        // A bound NEWER than the oldest published row would mean that source was
        // never read over part of the region the window claims to have proven.
        if (bound != null) expect(bound <= oldestPublished.timestamp.slice(0, 10), `depth ${depth} bound ${bound}`).toBe(true)
        checked += 1
      }
    }
    expect(checked).toBe(DEPTHS.length * 3)
  })
})

// Why the invariant above holds, stated as the thing that would break it. The loop
// orders rows by block but bounds re-reads by day, so it needs those two to agree.
// This fixture keeps identical block heights and only perturbs the timestamps, which
// is exactly what a row builder does if it takes `timestamp` from anything other than
// its own block — and it reproduces the recorded symptom: ONE depth disagreeing with
// every other inside the region it claims to have proven.
describe('the cutoff proof depends on calendar day agreeing with block order', () => {
  // Same blocks, timestamps scrambled within a bounded window so day order no longer
  // follows block order.
  const scrambled = (blockHeight: number): string =>
    `${dayOfBlock(blockHeight + ((blockHeight * 7919) % 23) * BLOCKS_PER_DAY)} 12:00:00`

  it('is a real precondition: breaking it makes a depth diverge from all the others', () => {
    const sources = frozenSources(scrambled)
    const windows = new Map(DEPTHS.map(depth => [depth, buildWindow(sources, depth).rows.slice(0, depth).map(identity)]))

    const divergent = DEPTHS.filter(a => DEPTHS.some(b => a !== b && firstDivergence(windows.get(a)!, windows.get(b)!) !== -1))
    // Not an assertion about which depths — only that mixing the two orderings is
    // what turns a depth-independent ordering into a depth-dependent one.
    expect(divergent.length).toBeGreaterThan(0)
  })

  it('holds for every merged-feed row today, which is why the feed is ordered', () => {
    // Guarded here rather than in prose: a source whose timestamp is its own block's
    // is monotone by construction, so the merge order and the bound agree.
    const sources = frozenSources(chainTimestamp)
    let checked = 0
    for (const source of sources) {
      for (let i = 1; i < source.rows.length; i++) {
        const newer = source.rows[i - 1], older = source.rows[i]
        expect(newer.blockHeight).toBeGreaterThan(older.blockHeight)
        expect(newer.timestamp >= older.timestamp, `${source.key} ${i}`).toBe(true)
        checked += 1
      }
    }
    expect(checked).toBe(399 + 399 + 59)
  })
})

// The quantiser is the only reason an unproven depth is unreachable from the API, and
// that is a cache-key decision rather than an ordering argument. Pin the masking so
// changing it is a deliberate act.
describe('the window quantiser is what keeps unproven depths unreachable', () => {
  it('collapses the recorded depths onto three buckets', () => {
    expect([25, 32, 50, 64, 75, 100, 128].map(activityWindowDepth)).toEqual([32, 32, 64, 64, 128, 128, 128])
    // 75 and 100 land on ONE window, which is why `?limit=75` and `?limit=100` return
    // byte-identical first 75 rows: no window of depth 75 is ever built.
    expect(activityWindowDepth(75)).toBe(activityWindowDepth(100))
    expect(new Set([25, 32, 50, 64, 75, 100, 128].map(activityWindowDepth)).size).toBe(3)
  })

  it('quantises every requested depth, so no page can ask for an unproven one', () => {
    const wants = Array.from({ length: 512 }, (_, i) => i + 1)
    expect(wants.filter(want => activityWindowDepth(want) !== 2 ** Math.ceil(Math.log2(want)))).toEqual([])
    expect(wants).toHaveLength(512)
  })
})

// A source is judged to have proven the cutoff two ways, and only one of them is a
// statement about the cutoff. `oldest` vs `cutoff` is; "it returned fewer rows than
// its limit" is a claim that the source is EXHAUSTED — true only over the range it
// was actually read. Once activityCutoffFromDate has raised a source's `from`, the
// predicate cannot tell the two apart, because the bound is not one of its arguments.
describe('exhaustion is only ever proven relative to the bound a source was read under', () => {
  const cutoff = { blockHeight: 100, eventIndex: 20 }

  it('accepts a short read as complete without consulting the cutoff at all', () => {
    expect(activitySourceCoversCutoff(24, 25, { blockHeight: 9_000_000, eventIndex: 0 }, cutoff)).toBe(true)
    expect(activitySourceCoversCutoff(24, 25, null, cutoff)).toBe(true)
  })

  it('requires the oldest-row proof once the read filled its limit', () => {
    expect(activitySourceCoversCutoff(25, 25, { blockHeight: 101, eventIndex: 1 }, cutoff)).toBe(false)
    expect(activitySourceCoversCutoff(25, 25, { blockHeight: 99, eventIndex: 99 }, cutoff)).toBe(true)
  })

  it('reports a narrowed short read complete with no cutoff to justify the narrowing', () => {
    // The boundary the invariant above rests on: this source was read over
    // [cutoffDay, to] and came back short, so it is reported complete — nothing here
    // knows it was never read over [from, cutoffDay). It is sound only because a
    // narrowed bound is always a day at or before the cutoff it has to cover, which
    // is the property `narrows a source bound only to a day at or before the cutoff`
    // pins. Any change that lets a bound outrun its cutoff has to make this
    // predicate bound-aware.
    const narrowedShortRead = [{ key: 'reward', rawSize: 374, fetchSize: 512, oldest: { blockHeight: 13_054_501, eventIndex: 8 } }]
    expect(activitySourcesNeedingMore(narrowedShortRead, null, false)).toEqual([])
  })

  it('rounds a cutoff down to its whole UTC day, so a bound never cuts inside one', () => {
    const rows = [{ timestamp: '2026-07-16 10:00:00' }, { timestamp: '2026-07-15 23:59:59' }]
    expect(activityCutoffFromDate(undefined, rows, 2)).toBe('2026-07-15')
    // A caller's own later bound always wins, so narrowing can only move forward.
    expect(activityCutoffFromDate('2026-07-16', rows, 2)).toBe('2026-07-16')
  })
})
