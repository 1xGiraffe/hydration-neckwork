import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  activityExactValueFiltered,
  activityPagesInMemory,
  activitySourceSeedSize,
  activityWindowDepth,
  activityWindowPlan,
} from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const PAGE = 25
const plan = (offset: number, extra: Partial<{ limit: number; type: string; from: string; to: string; min: number; unit: 'usd' | 'token'; token: string; action: string }> = {}) =>
  activityWindowPlan(
    extra.limit ?? PAGE, offset, extra.type ?? 'all', extra.from, extra.to,
    { token: extra.token, min: extra.min, unit: extra.unit }, extra.action,
  )

// A page of the merged, trade, transfer, liquidity, money-market or cross-chain feed
// is a slice of a classified window: the request assembles, values, classifies and
// de-duplicates the whole ordering down to offset+limit rows and then takes the last
// `limit` of them. Keying that on the page made an expensive result reusable only by
// an identical request — paging a $95k floor cost the full assembly per click, and the
// same page again seconds later cost it a third time.
describe('the classified window cache key', () => {
  it('does not embed the offset, so adjacent pages share one window', () => {
    // Deep paging: 2300 / 2325 / 2350 measured 8.79 / 8.99 / 9.42 s, each of them a
    // fresh assembly of the same ordering.
    expect(plan(2_300)?.key).toBe(plan(2_325)?.key)
    expect(plan(2_300)?.key).toBe(plan(2_350)?.key)
    expect(plan(0)?.key).toBe(plan(7)?.key)
    // The depth is what the key names, however the request splits it into a page.
    expect(plan(39)?.key).toBe(plan(25, { limit: 39 })?.key)
    for (const key of [plan(0)!.key, plan(2_300)!.key]) {
      expect(key).not.toMatch(/:0:|:2300:|:2325:/)
    }
  })

  it('does not embed the page size either: 3x25 and 1x75 want the same window', () => {
    expect(plan(50)?.key).toBe(plan(0, { limit: 75 })?.key)
  })

  // Sharing is the whole point, so pin how much of it there is: a guard that
  // collapses to "every offset has its own key" would still pass an equality check
  // against itself.
  it('collapses the 101 pages of the merged feed onto 8 windows', () => {
    const keys = new Set<string>()
    for (let offset = 0; offset <= 2_500; offset += PAGE) keys.add(plan(offset)!.key)

    expect(keys.size).toBe(8)
  })

  // Rounding up is a widening round per source, and at min=2000000 rounding a
  // 25-row page to 64 cost 246 s -> 653 s. The quantum is the next power of two,
  // which rounds that page to 32 instead.
  it('rounds every page up to the next power of two and no further', () => {
    expect(plan(0)!.depth).toBe(32)
    expect(plan(0, { limit: 100 })!.depth).toBe(128)
    expect(plan(PAGE)!.depth).toBe(64)
    expect(plan(2_300)!.depth).toBe(4_096)
    expect(plan(0, { limit: 64 })!.depth).toBe(64)
  })

  it('never serves a window shallower than the page needs', () => {
    let checked = 0
    for (const limit of [1, 10, 25, 40, 100]) {
      for (let offset = 0; offset <= 2_500; offset += 7) {
        const window = plan(offset, { limit })!
        expect(window.depth).toBeGreaterThanOrEqual(offset + limit)
        checked++
      }
    }

    expect(checked).toBe(1_790)
  })

  it('gives a deeper bucket its own key, so the depth cannot be borrowed', () => {
    // want 64 is the last page of this bucket; want 65 opens the next.
    expect(plan(39)!.depth).toBe(64)
    expect(plan(40)!.depth).toBe(128)
    expect(plan(39)!.key).not.toBe(plan(40)!.key)
    expect(plan(0)!.key).not.toBe(plan(PAGE)!.key)
  })

  it('separates every filter the window is assembled under', () => {
    const variants = [
      plan(PAGE, { type: 'transfer' }), plan(PAGE, { type: 'liquidity' }),
      plan(PAGE, { action: 'Supply', type: 'mm' }),
      plan(PAGE, { token: 'HDX' }), plan(PAGE, { min: 10 }), plan(PAGE, { min: 1_000 }),
      plan(PAGE, { min: 10, unit: 'token' }),
      plan(PAGE, { from: '2024-01-01' }), plan(PAGE, { to: '2024-01-01' }),
    ].map(entry => entry!.key)

    expect(new Set([...variants, plan(PAGE)!.key]).size).toBe(variants.length + 1)
  })

  it('treats dca as the trade category it is filed under, not a window of its own', () => {
    expect(plan(PAGE, { type: 'dca' })?.key).toBe(plan(PAGE, { type: 'trade' })?.key)
  })

  it('has no shared window where the offset is applied in SQL', () => {
    for (const shape of [
      { type: 'vote' }, { type: 'stake' }, { type: 'otc' },
      { type: 'trade', action: 'dca-failed' }, { type: 'trade', action: 'otc-fill' },
    ]) {
      expect(plan(PAGE, shape), JSON.stringify(shape)).toBeNull()
    }
  })
})

// The head of a live feed is what a reader watches for their own transaction, so it
// keeps the feed's TTL instead of a minute-old window. Deep pages and a sparse value
// floor are not live data.
describe('window freshness', () => {
  it('keeps the live head on the feed TTL, including the page default $10 floor', () => {
    expect(plan(0)!.live).toBe(true)
    expect(plan(0, { min: 10 })!.live).toBe(true)
    expect(plan(0, { min: 999 })!.live).toBe(true)
    expect(plan(0, { min: 95_000, unit: 'token' })!.live).toBe(true)
    expect(plan(0, { type: 'transfer' })!.live).toBe(true)
    // Same bucket as offset 0, so a page inside it is a slice of the same equally
    // fresh window.
    expect(plan(7)!.live).toBe(true)
  })

  it('takes deeper, dated and exact-value windows off the live TTL', () => {
    expect(plan(PAGE)!.live).toBe(false)
    expect(plan(2_300)!.live).toBe(false)
    expect(plan(0, { to: '2024-01-01' })!.live).toBe(false)
    expect(plan(0, { min: 1_000 })!.live).toBe(false)
    expect(plan(0, { min: 95_000 })!.live).toBe(false)
  })

  it('spends the live TTL on the live branch and the window TTL on the rest', () => {
    const live = explorerService.match(/\? cached\(key, LIVE_CACHE_MS, build\)/g) ?? []
    const windowed = explorerService.match(/: cachedSwr\(key, ACTIVITY_WINDOW_FRESH_MS, ACTIVITY_WINDOW_STALE_MS, build\)/g) ?? []

    expect(live).toHaveLength(1)
    expect(windowed).toHaveLength(1)
    expect(explorerService).toMatch(/const ACTIVITY_WINDOW_FRESH_MS = 60_000\b/)
    expect(explorerService).toMatch(/const LIVE_CACHE_MS = 5_000\b/)
  })
})

// The depth a window proves is quantised so adjacent pages land on one key. The
// quantum is the next power of two: enough to collapse a pager onto logarithmically
// many windows, without rounding a sparse filter's page as far as the source-seed
// bucket would (measured 246 s -> 653 s at min=2000000 for 25 rounded to 64).
describe('activityWindowDepth', () => {
  it('quantises to the next power of two', () => {
    for (const [want, depth] of [[1, 1], [25, 32], [32, 32], [33, 64], [64, 64], [65, 128],
      [1_000, 1_024], [2_325, 4_096], [20_000, 32_768]] as const) {
      expect(activityWindowDepth(want), `want ${want}`).toBe(depth)
    }
    // A bucket never straddles a source-seed change, so every page in it starts its
    // exact source reads at the same per-source limit.
    for (const want of [1, 25, 50, 64, 65, 128, 129, 1_000, 2_325]) {
      expect(activitySourceSeedSize(activityWindowDepth(want)), `seed ${want}`)
        .toBe(activitySourceSeedSize(want))
    }
  })

  it('never quantises below the depth asked for and never goes backwards', () => {
    let previous = 0
    for (let want = 1; want <= 5_000; want++) {
      const depth = activityWindowDepth(want)
      expect(depth, `want ${want}`).toBeGreaterThanOrEqual(want)
      expect(depth, `want ${want}`).toBeGreaterThanOrEqual(previous)
      previous = depth
    }

    expect(activityWindowDepth(2_325)).toBe(4_096)
  })

  // 101 pages of the merged feed, and a 25-row pager reaches the deepest bucket it
  // can at offset 2,500; a linear quantum would have made this the page count.
  it('needs only as many windows as the feed has octaves', () => {
    const depths = new Set<number>()
    for (let offset = 0; offset <= 2_500; offset += PAGE) depths.add(activityWindowDepth(offset + PAGE))

    expect([...depths].sort((a, b) => a - b)).toEqual([32, 64, 128, 256, 512, 1_024, 2_048, 4_096])
  })
})

// The window may only be shared across offsets where the builder pages by slicing
// rows it holds. One predicate decides both, so they cannot drift into slicing a
// page at an offset SQL already applied.
describe('activityPagesInMemory', () => {
  it('agrees with the builder about which pages are slices', () => {
    const inMemory = ['all', 'trade', 'dca', 'transfer', 'liquidity', 'mm', 'xcm']
    const sqlPaged = ['vote', 'stake', 'otc']
    for (const type of inMemory) expect(activityPagesInMemory(type), type).toBe(true)
    for (const type of sqlPaged) expect(activityPagesInMemory(type), type).toBe(false)
    // An action filter is decided on built rows, so it puts any category on the
    // in-memory path — except the exact event families that page themselves.
    for (const type of [...inMemory, ...sqlPaged]) expect(activityPagesInMemory(type, 'Supply'), type).toBe(true)
    expect(activityPagesInMemory('trade', 'dca-failed')).toBe(false)
    expect(activityPagesInMemory('trade', 'otc-fill')).toBe(false)
    expect(activityPagesInMemory('trade', 'dca')).toBe(true)
    expect(activityPagesInMemory('mm', 'dca-failed')).toBe(true)
  })

  it('leaves the builder exactly one decision about where its page starts', () => {
    const declarations = explorerService.match(/const locallyPaged = activityPagesInMemory\(type, action\)/g) ?? []
    const reassignments = explorerService.match(/^\s*locallyPaged = /gm) ?? []

    expect(declarations).toHaveLength(1)
    expect(reassignments).toEqual([])
  })
})

// The $1,000 line is the builder's own: below it a window is one cheap recent probe,
// at and above it every source applies its exact event-time predicate and widens.
// The window cache reads freshness off the same line, so they must be one function.
describe('activityExactValueFiltered', () => {
  it('is the line the builder switches its source reads on', () => {
    expect(activityExactValueFiltered('all', { min: 999 })).toBe(false)
    expect(activityExactValueFiltered('all', { min: 1_000 })).toBe(true)
    expect(activityExactValueFiltered('all', {})).toBe(false)
    // A token-denominated floor pushes into SQL, so it is never the exact-USD path.
    expect(activityExactValueFiltered('all', { min: 95_000, unit: 'token' })).toBe(false)
    // A token-keyed swap read applies the USD predicate before its own LIMIT.
    expect(activityExactValueFiltered('trade', { min: 95_000, token: 'HDX' })).toBe(false)
    expect(activityExactValueFiltered('all', { min: 95_000, token: 'HDX' })).toBe(true)
  })

  it('is used by both the builder and the window plan, and defined once', () => {
    const uses = explorerService.match(/activityExactValueFiltered\(/g) ?? []

    expect(uses).toHaveLength(3)   // the declaration, the builder, the window plan
    expect(explorerService).toMatch(/const directExactValueFilter = activityExactValueFiltered\(type, filters\)/)
  })
})
