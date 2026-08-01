import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { enumeratedActivityKey } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const body = (name: string): string => {
  const at = explorerService.indexOf(name)
  expect(at, name).toBeGreaterThan(-1)
  // `\n}\n` rather than `\n}`: a nested object literal's closing brace is indented.
  const end = explorerService.indexOf('\n}\n', at)
  expect(end, name).toBeGreaterThan(at)
  return explorerService.slice(at, end)
}
const sites = (pattern: RegExp): number => (explorerService.match(pattern) ?? []).length

// The enumerated sources are read UNFILTERED and in full, which on the account holding
// 101k cross-chain rows is 6.2s of an 8.6s cold page — three quarters of it. One snapshot
// of that read supplies both halves of the exact plan: the per-block counts the total is
// summed from and the rows the page renders. Everything below protects that identity while
// the snapshot is held long enough to be worth warming.
describe('the enumerated activity snapshot is one shared read', () => {
  const accounts = ['0xaa', '0xbb']

  // The builders take no type argument, so which sources are read is the only thing a
  // type changes. Keying on the type instead of the source set read the same history twice
  // for `all` and `transfer` — 6.1% of activity requests — under two names.
  it('keys on the source set, so types reading the same sources share one entry', () => {
    expect(enumeratedActivityKey(accounts, 'all')).toBe(enumeratedActivityKey(accounts, 'transfer'))
    expect(enumeratedActivityKey(accounts, 'liquidity')).toBe(enumeratedActivityKey(accounts, 'mm'))

    // And the types whose source sets genuinely differ stay apart: the nine countable
    // types collapse to seven entries and no further. Any future type that silently joined
    // one of these groups would have to justify itself here.
    const countable = ['all', 'transfer', 'trade', 'liquidity', 'mm', 'xcm', 'vote', 'staking', 'otc']
    expect(new Set(countable.map(type => enumeratedActivityKey(accounts, type))).size).toBe(7)
    expect(enumeratedActivityKey(accounts, 'all')).toContain(':otc+dcaFailures+rewards+staking+votes+xcm+ntt:')
  })

  // The account set is a set, not a list: two callers resolving the same related accounts
  // in a different order must not read the same history twice.
  it('is independent of account order and separates date bounds', () => {
    expect(enumeratedActivityKey(['0xbb', '0xaa'], 'all')).toBe(enumeratedActivityKey(accounts, 'all'))
    expect(enumeratedActivityKey(accounts, 'all', undefined, '2026-07-24'))
      .not.toBe(enumeratedActivityKey(accounts, 'all'))
  })

  // A filter must NOT be in the key. These rows are the suppression context every other
  // family's rows are judged against, so narrowing the read would let a filtered-out trade
  // stop owning its transfer legs; keying on the filter would also re-read the whole
  // history for every chip the user tries.
  it('never splits the entry per filter', () => {
    expect(body('export function enumeratedActivityKey')).not.toContain('filterKey')
    expect(sites(/explorer:exact-small:/g)).toBe(1)
  })

  // Both halves of the plan must be the same array. planExactActivity awaits the snapshot
  // once, counts it per block, and hands that same object to the page pass rather than
  // letting it read the sources again at a different depth.
  it('reads the snapshot once per plan and hands that array to the page', () => {
    expect(sites(/await enumeratedActivityRows\(/g)).toBe(1)
    expect(body('async function planExactActivity')).toContain('const enumerated = await enumeratedActivityRows(accounts, type, from, to)')
    expect(body('async function planExactActivity')).toContain('return { arms, enumerated }')
    // The page pass takes it from the plan; the located page is the only place it enters.
    expect(sites(/enumerated: plan\.enumerated/g)).toBe(1)
    // One read per enumerated source, all six out of the plan's array — a source the page
    // pass read for itself instead would be counted from one set and rendered from another.
    expect(sites(/exact\.enumerated\.(otc|dcaFailures|rewards|staking|votes|xcm)\b/g)).toBe(6)
    // Only the cache load and the background refresh may run the read itself.
    expect(sites(/enumeratedActivityRowsUncached\(/g)).toBe(3)
  })
})

describe('the snapshot is refreshed behind the reader, not in front of it', () => {
  // Stale-while-revalidate is what makes holding it worth anything: past the fresh window
  // a reader gets the previous snapshot immediately instead of waiting on the re-read.
  it('serves the previous snapshot while re-reading', () => {
    expect(body('async function enumeratedActivityRows')).toContain(
      'cachedSwr(enumeratedActivityKey(accounts, type, from, to),\n    ENUMERATED_SOURCE_CACHE_MS, ENUMERATED_SOURCE_STALE_MS')
    expect(sites(/cachedSwr\(enumeratedActivityKey\(/g)).toBe(1)
  })

  // The staleness a warmed value can reach must not exceed what the same page already
  // publishes. The pager's own total is served stale for LIST_TOTAL_STALE_MS, so the rows
  // under it may age exactly that far and no further.
  it('holds it no longer than the list total on the same page', () => {
    const value = (name: string): number => {
      const match = explorerService.match(new RegExp(`const ${name} = ([0-9_]+)`))
      expect(match, name).not.toBeNull()
      return Number((match as RegExpMatchArray)[1].replaceAll('_', ''))
    }
    expect(value('ENUMERATED_SOURCE_STALE_MS')).toBe(value('LIST_TOTAL_STALE_MS'))
    expect(value('ENUMERATED_SOURCE_CACHE_MS')).toBeLessThan(value('ENUMERATED_SOURCE_STALE_MS'))
  })

  // A pass that owns a key must recompute, or it is not a refresh — cachedSwr would hand
  // it the very value it exists to replace and the entry would lapse anyway.
  it('cannot be satisfied by the value it exists to refresh', async () => {
    vi.resetModules()
    const { cachedSwr, cacheRefresh, cacheExpiry } = await import('../src/services/cache.ts')
    const key = enumeratedActivityKey(['0xaa'], 'all')
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second')

    await expect(cachedSwr(key, 60_000, 900_000, load)).resolves.toBe('first')
    // A reader inside the fresh window is served without a read...
    await expect(cachedSwr(key, 60_000, 900_000, load)).resolves.toBe('first')
    expect(load).toHaveBeenCalledTimes(1)
    // ...and the owning pass reads anyway, then installs the result under the same key.
    await expect(cacheRefresh(key, 60_000, 900_000, load)).resolves.toBe('second')
    await expect(cachedSwr(key, 60_000, 900_000, load)).resolves.toBe('second')
    expect(load).toHaveBeenCalledTimes(2)
    expect(cacheExpiry(key)).toBeGreaterThan(Date.now())
    expect(cacheExpiry('never-stored')).toBeNull()
  })

  it('refreshes the key the reader reads', () => {
    expect(sites(/cacheRefresh\(enumeratedActivityKey\(/g)).toBe(1)
    const refresh = body('function refreshEnumeratedActivitySnapshot')
    expect(refresh).toContain("enumeratedActivityKey(accounts, 'all')")
    expect(refresh).toContain('ENUMERATED_SOURCE_CACHE_MS, ENUMERATED_SOURCE_STALE_MS')
    expect(refresh).toContain("enumeratedActivityRowsUncached(accounts, 'all')")
  })
})

describe('the prewarm is bounded by demand as well as by time', () => {
  // Interest is a READER'S interest. The directory's activity ranking counts pool members
  // through the same list-total endpoints, and letting that register as interest would fill
  // the set with 250 whole-history accounts — the load fd61c1d removed.
  it('records only what a feed endpoint was asked for', () => {
    expect(sites(/noteHotActivityScope\(/g)).toBe(2)   // definition + one call
    expect(body('async function getScopedAccountActivity')).toContain('noteHotActivityScope(cacheScope, accounts)')
    for (const name of ['async function scopedListTotal', 'async function activityLeaderboardTotal',
      'export async function getAddressListTotal', 'export async function getTagListTotal']) {
      expect(body(name), name).not.toContain('noteHotActivityScope')
    }
  })

  it('bounds the set, and forgets a scope nothing has read for an hour', () => {
    expect(body('function noteHotActivityScope')).toContain('hotActivityScopes.size <= HOT_ACTIVITY_SCOPES')
    const pass = body('async function prewarmHotActivitySnapshots')
    expect(pass).toContain('startedAt - scope.requestedAt > HOT_ACTIVITY_SCOPE_IDLE_MS')
    expect(pass).toContain('hotActivityScopes.delete(cacheScope)')
  })

  // Re-reading every cycle would be two wasted reads in three, since the snapshot outlives
  // three cycles — and the request path refuses an over-large account list before it ever
  // reads, so warming one would be pure waste.
  it('re-reads only what is about to lapse, and only what a request would read', () => {
    const pass = body('async function prewarmHotActivitySnapshots')
    expect(pass).toContain('const expiry = cacheExpiry(key)')
    expect(pass).toContain('expiry - startedAt > ENUMERATED_PREWARM_LEAD_MS')
    expect(pass).toContain('MAX_EXACT_ACCOUNT_LIST_BYTES')
    // Sequential and budgeted: each read is awaited, and the pass stops at the deadline.
    expect(pass).toContain('await refreshEnumeratedActivitySnapshot(scope.accounts)')
    expect(pass).toContain('Date.now() >= deadline')
  })

  // It rides the five-minute directory prewarm rather than a timer of its own, and runs
  // after the pages so they are never held behind it.
  it('runs on the existing directory refresher, last', () => {
    expect(sites(/prewarmHotActivitySnapshots\(\)/g)).toBe(2)   // definition + one call
    const prewarm = body('async function prewarmAccountDirectoryUncached')
    expect(prewarm).toContain('await prewarmHotActivitySnapshots()')
    expect(prewarm.indexOf('prewarmHotActivitySnapshots')).toBeGreaterThan(prewarm.indexOf('refreshAccountsPage(50, 50'))
    expect(explorerService).toContain('accountsPrewarmTimer = setInterval(() => { void prewarmAccountDirectory().catch(() => {}) }, 5 * 60_000)')
  })
})
