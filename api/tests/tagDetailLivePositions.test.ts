import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

function body(fn: string): string {
  const at = src.indexOf(fn)
  expect(at, fn).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('\n}\n', at))
}

// A tag's resting orders are ~6 ms to read; the rest of its detail is a ~4 s
// rebuild reading GiB (the portfolio walk), which is what its 30 s TTL protects.
// Caching both together meant a DCA the owner had just started waited out a TTL
// that exists for the chart's sake — measured worst case ~57 s to appear.
describe('tag detail serves resting orders live', () => {
  it('overlays them outside the cached blob, not inside it', () => {
    const fn = body('async function buildTagDetailForMembers(')
    // The heavy build is still cached exactly as before.
    expect(fn).toContain('const detail = await cached(opts.cacheKey, opts.ttlMs ?? 30_000')
    // …and the cheap reads happen after it, per request — the resting orders and
    // the members' unclaimed farm rewards (which accrue every relay block and so
    // must not be frozen into the cached/persisted blob either).
    const overlay = fn.slice(fn.indexOf('const detail = await cached('))
    expect(overlay).toMatch(/const \[activeDcas, openLimitOrders, rewards\] = await Promise\.all\(\[\s*getActiveDcas\(members\), getOpenLimitOrders\(members\), getUnclaimedRewards\(members, rewardH160s, detail\.liquidityPositions \?\? \[\]\),\s*\]\)/)
    expect(overlay).toContain('...detail, activeDcas, openLimitOrders,')
    // The rewards enter the value in the overlay, once — the cached/persisted
    // build never holds them, so a snapshot can neither freeze nor double them.
    expect(overlay).toContain('}, rewards)')
    const build = fn.slice(fn.indexOf('const detail = await cached('), fn.indexOf('if (opts.snapshot && !summary) await persistTagDetailSnapshot'))
    expect(build).not.toContain('getFarmRewards')
    expect(build).not.toContain('getUnclaimedRewards')
  })

  // The hover card renders no positions and no resting orders, so it pays for
  // neither — but it prints the value, so it takes the rewards the value holds.
  it('gives a summary response the rewards in its value and nothing else', () => {
    const fn = body('async function buildTagDetailForMembers(')
    const summaryArm = fn.slice(fn.indexOf('if (summary) {'), fn.indexOf('const [activeDcas, openLimitOrders, rewards]'))
    expect(summaryArm).toContain('return withUnclaimedRewardsInValue(detail, rewards)')
    expect(summaryArm).not.toContain('getActiveDcas')
  })

  // Head-keyed beats a short TTL on both axes: it refreshes exactly when the
  // chain moved, and not at all when it did not.
  it('keys both readers on the indexed head', () => {
    expect(src).toContain('`explorer:dca-active:${await liveHeadTag()}:${[...accounts].sort().join(\',\')}`')
    expect(src).toContain('`explorer:limit-orders:${await liveHeadTag()}:${[...accounts].sort().join(\',\')}`')
  })

  // A head-keyed entry is dead the moment the head moves, so it takes the short
  // shared TTL rather than a long one that would squat LRU slots.
  it('gives the head-keyed entries the shared live TTL', () => {
    for (const m of src.matchAll(/cached\(`explorer:(dca-active|limit-orders):\$\{await liveHeadTag\(\)\}[^`]*`, ([A-Z_]+|\d+)/g)) {
      expect(m[2], m[1]).toBe('LIVE_CACHE_MS')
    }
  })
})
