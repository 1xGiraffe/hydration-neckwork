import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const FRESH_MS = 60_000
const STALE_MS = 30 * 60_000

// The account-value generation advances every five minutes (money-market account
// values, Omnipool claims, the pinned price map). It used to sit inside the
// account-directory cache KEY, which made a generation change turn the cached page
// ABSENT rather than stale: stale-while-revalidate could never find the previous
// page, so every cycle cost one blocking multi-second rebuild. It is now passed to
// the cache as a generation instead, which marks the entry stale — served while the
// next generation computes.
describe('a generation change makes a directory page stale, not absent', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.useRealTimers() })

  it('serves the previous generation immediately and rebuilds in the background', async () => {
    const { cachedSwr } = await import('../src/services/cache.ts')
    let finishRebuild!: (value: string) => void
    const rebuild = new Promise<string>(resolve => { finishRebuild = resolve })
    const build = vi.fn()
      .mockResolvedValueOnce('generation-1')
      .mockReturnValueOnce(rebuild)

    await expect(cachedSwr('dir', FRESH_MS, STALE_MS, build, 1)).resolves.toBe('generation-1')

    // Well inside the 60s fresh window: only the generation moved.
    await expect(cachedSwr('dir', FRESH_MS, STALE_MS, build, 2)).resolves.toBe('generation-1')
    expect(build).toHaveBeenCalledTimes(2)
    // ...and it keeps being served, from one rebuild, until that rebuild lands.
    await expect(cachedSwr('dir', FRESH_MS, STALE_MS, build, 2)).resolves.toBe('generation-1')
    expect(build).toHaveBeenCalledTimes(2)

    finishRebuild('generation-2')
    await rebuild
    await Promise.resolve()
    await expect(cachedSwr('dir', FRESH_MS, STALE_MS, build, 2)).resolves.toBe('generation-2')
  })

  // The behaviour the change replaces, pinned so it cannot come back by putting the
  // generation into the key again: with nothing under the new key there is no
  // previous value, and the caller waits out the whole rebuild.
  it('a generation in the key would instead block the caller on the rebuild', async () => {
    const { cachedSwr } = await import('../src/services/cache.ts')
    let finishRebuild!: (value: string) => void
    const rebuild = new Promise<string>(resolve => { finishRebuild = resolve })

    await expect(cachedSwr('dir:1', FRESH_MS, STALE_MS, async () => 'generation-1')).resolves.toBe('generation-1')

    const pending = cachedSwr('dir:2', FRESH_MS, STALE_MS, () => rebuild)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    finishRebuild('generation-2')
    await expect(pending).resolves.toBe('generation-2')
  })

  // A persisted page is one whole generation. Serving it while the next one computes
  // must hand back that page and nothing else — never a row, column or sparkline
  // spliced from two generations — and the replacement must be wholesale.
  it('serves one whole generation, never a mix of two', async () => {
    const { cachedSwr } = await import('../src/services/cache.ts')
    const first = { rows: [{ account: 'a', valueUsd: 1, sparkline: [1, 1] }], total: 1 }
    const second = { rows: [{ account: 'a', valueUsd: 2, sparkline: [2, 2] }], total: 2 }
    let finishRebuild!: (value: typeof first) => void
    const rebuild = new Promise<typeof first>(resolve => { finishRebuild = resolve })
    const build = vi.fn()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(rebuild)

    expect(await cachedSwr('page', FRESH_MS, STALE_MS, build, 1)).toBe(first)
    expect(await cachedSwr('page', FRESH_MS, STALE_MS, build, 2)).toBe(first)

    finishRebuild(second)
    await rebuild
    await Promise.resolve()
    expect(await cachedSwr('page', FRESH_MS, STALE_MS, build, 2)).toBe(second)
  })

  // Staleness is a reason to refresh, never a reason to keep serving for longer:
  // an entry past its stale window is gone whatever the generation says.
  it('does not let a generation change extend the stale window', async () => {
    vi.useFakeTimers()
    const { cachedSwr } = await import('../src/services/cache.ts')
    const build = vi.fn()
      .mockResolvedValueOnce('generation-1')
      .mockResolvedValueOnce('generation-2')

    await expect(cachedSwr('expiry', FRESH_MS, STALE_MS, build, 1)).resolves.toBe('generation-1')
    vi.advanceTimersByTime(STALE_MS + 1)
    await expect(cachedSwr('expiry', FRESH_MS, STALE_MS, build, 2)).resolves.toBe('generation-2')
    expect(build).toHaveBeenCalledTimes(2)
  })
})

// A restarted process has an empty cache but not an empty snapshot table. The
// persisted page is adopted as the stale value so the first request serves it and
// rebuilds behind it, rather than paying the cold rebuild the table exists to avoid.
describe('a persisted page seeds the cache as the stale value', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.useRealTimers() })

  it('serves the seeded page immediately and starts one rebuild', async () => {
    const { cachedSwr, seedStale } = await import('../src/services/cache.ts')
    const persisted = vi.fn(async () => ({ value: 'persisted', staleMs: 120_000 }))
    const rebuild = new Promise<string>(() => { /* never lands during this test */ })
    const build = vi.fn(() => rebuild)

    await expect(seedStale('seeded', persisted)).resolves.toBe(true)
    await expect(cachedSwr('seeded', FRESH_MS, STALE_MS, build, 7)).resolves.toBe('persisted')
    expect(build).toHaveBeenCalledTimes(1)

    // A key that already holds a value is never overwritten by an older persisted
    // one, and a warm key never pays for the read.
    await expect(seedStale('seeded', persisted)).resolves.toBe(false)
    expect(persisted).toHaveBeenCalledTimes(1)
  })

  it('cannot outlive the freshness the persisted page was published under', async () => {
    vi.useFakeTimers()
    const { cachedSwr, seedStale } = await import('../src/services/cache.ts')

    await expect(seedStale('budget', async () => ({ value: 'persisted', staleMs: 1_000 }))).resolves.toBe(true)
    vi.advanceTimersByTime(1_001)
    await expect(cachedSwr('budget', FRESH_MS, STALE_MS, async () => 'rebuilt', 1)).resolves.toBe('rebuilt')

    // Nothing left to seed from either: an expired persisted budget is not a value.
    await expect(seedStale('exhausted', async () => ({ value: 'persisted', staleMs: 0 }))).resolves.toBe(false)
  })
})

// The prewarm owns the directory's refresh. It must not be satisfied by the page it
// exists to replace, and it must not duplicate a rebuild a reader already started.
describe('the prewarm refreshes without racing a readers revalidation', () => {
  beforeEach(() => { vi.resetModules() })

  it('rebuilds past a fresh entry', async () => {
    const { cacheRefresh, cachedSwr } = await import('../src/services/cache.ts')

    await expect(cachedSwr('warm', FRESH_MS, STALE_MS, async () => 'generation-1', 1)).resolves.toBe('generation-1')
    await expect(cacheRefresh('warm', FRESH_MS, STALE_MS, async () => 'generation-2', 2)).resolves.toBe('generation-2')

    const unused = vi.fn(async () => 'generation-3')
    await expect(cachedSwr('warm', FRESH_MS, STALE_MS, unused, 2)).resolves.toBe('generation-2')
    expect(unused).not.toHaveBeenCalled()
  })

  it('collapses a prewarm and a concurrent read into one rebuild', async () => {
    const { cacheRefresh, cachedSwr } = await import('../src/services/cache.ts')
    let finishRebuild!: (value: string) => void
    const rebuild = new Promise<string>(resolve => { finishRebuild = resolve })

    await expect(cachedSwr('shared', FRESH_MS, STALE_MS, async () => 'generation-1', 1)).resolves.toBe('generation-1')

    const prewarm = cacheRefresh('shared', FRESH_MS, STALE_MS, () => rebuild, 2)
    const readerBuild = vi.fn(async () => 'duplicate rebuild')
    await expect(cachedSwr('shared', FRESH_MS, STALE_MS, readerBuild, 2)).resolves.toBe('generation-1')
    expect(readerBuild).not.toHaveBeenCalled()

    finishRebuild('generation-2')
    await expect(prewarm).resolves.toBe('generation-2')
  })
})

// Guards on the wiring itself. Each pins how many sites it matched, so a rename or a
// deletion fails the test instead of quietly leaving it asserting nothing.
describe('the directory wiring keeps the generation out of its keys', () => {
  const generationKeys = [...explorerService.matchAll(/`(explorer:[^`]*\$\{accountValueGenerationEpoch\}[^`]*)`/g)]
    .map(match => match[1])

  it('leaves the generation only in the keys that want invalidation', () => {
    // Eight keys once carried it. The two whole-directory pages that are SERVED —
    // `explorer:accounts` — dropped it, because they want the previous generation
    // served while the next computes. `explorer:accounts-total` keeps it: it is
    // embedded in a page payload rather than served on its own, and it is only ever
    // computed inside a rebuild that is already running in the background.
    // `explorer:account-history` dropped it too (accountHistoryShared.test.ts owns
    // that): the reconstruction is valued at closed historical candles and never
    // reads the pinned price map, so the generation invalidated work it could not
    // change. The five that remain are 8-15s detail reads whose whole payload IS
    // valued at the pinned map.
    expect(generationKeys).toEqual([
      'explorer:address:${accountValueGenerationEpoch}:${norm.accountId}${summary ? \':summary\' : \'\'}',
      'explorer:mm-positions:${accountValueGenerationEpoch}:${h160.toLowerCase()}',
      'explorer:mm-reserves:${accountValueGenerationEpoch}:${h160.toLowerCase()}',
      'explorer:lp-recon:${accountValueGenerationEpoch}:${accs.sort().join(\',\')}',
      'explorer:accounts-total:${accountValueGenerationEpoch}:${modelVersion}',
      'explorer:tag:${accountValueGenerationEpoch}:${tagId}${summary ? \':summary\' : refresh ? \':refresh\' : \'\'}',
    ])
    expect(generationKeys.filter(key => key.startsWith('explorer:accounts:'))).toHaveLength(0)
  })

  it('builds the directory cache key in exactly one place, without the generation', () => {
    const sites = [...explorerService.matchAll(/`explorer:accounts:[^`]*`/g)].map(match => match[0])
    expect(sites).toEqual(['`explorer:accounts:${modelVersion}:${sort}:${offset}:${limit}`'])
  })

  it('passes the generation to the cache instead, on both the read and the refresh', () => {
    const at = explorerService.indexOf('async function accountsPage(')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))

    expect(body).toContain('const generation = accountValueGenerationEpoch')
    const passed = [...body.matchAll(/(cacheRefresh|cachedSwr)\(key, ACCOUNTS_FRESH_MS, ACCOUNTS_STALE_MS, build, generation\)/g)]
    expect(passed.map(match => match[1])).toEqual(['cacheRefresh', 'cachedSwr'])
  })

  it('refreshes the prewarmed pages rather than reading them from the cache', () => {
    const at = explorerService.indexOf('async function prewarmAccountDirectoryUncached')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))

    expect([...body.matchAll(/refreshAccountsPage\(/g)]).toHaveLength(2)
    expect(body).not.toContain('getAccounts(')
  })

  // The total is the one number on the page that is computed separately, so the only
  // safe place to ask for it is inside the rebuild that assembles the page.
  it('reads the row total only from inside the page rebuild', () => {
    expect([...explorerService.matchAll(/(?<!function )\bgetAccountsTotal\(\)/g)]).toHaveLength(1)
    const at = explorerService.indexOf('async function accountsPage(')
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(body).toContain('getAccountsTotal()')
  })
})

// Freshness of the persisted page is the declared tolerance plus the model version in
// its key — not "at least as new as the newest published generation", which rejects a
// perfectly serveable page at exactly the moment a request needs one.
describe('the persisted snapshot reads separate serving from refreshing', () => {
  it('asks for the current generation only when refreshing', () => {
    const at = explorerService.indexOf('async function loadAccountDirectorySnapshot')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))

    expect(body).toContain('const coversCurrentGeneration = currentGenerationOnly')
    expect(body).toContain(`ACCOUNT_DIRECTORY_SNAPSHOT_MAX_AGE_SECONDS`)

    const calls = [...explorerService.matchAll(/loadAccountDirectorySnapshot\(snapshotKey, (true|false)\)/g)]
      .map(match => match[1])
    // Exactly two callers: the rebuild (current generation only) and the stale seed.
    expect(calls).toEqual(['true', 'false'])
  })

  // The tag snapshot has no model version in its key, so the model belongs in the
  // identity the loader already compares — not in a freshness clause. See
  // tagDetailPrewarm.test.ts for the shared derivation the prewarm relies on.
  it('identifies a tag payload by its model as well as its members', () => {
    expect(explorerService).toContain('return `${accountDirectoryModelVersion()}|${tagMembershipList(members)}`')
    const at = explorerService.indexOf('export async function getTag(')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, at + 1600)
    expect(body).toContain('const membershipKey = tagDetailMembershipKey(tag.members)')
  })

  it('no longer rejects a serveable page for being one generation behind', () => {
    expect(explorerService).not.toContain('covers_claims')
    expect(explorerService).not.toContain('covers_money_market')
  })
})
