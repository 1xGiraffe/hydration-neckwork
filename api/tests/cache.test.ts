import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('cached', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('shares concurrent cache misses for the same key', async () => {
    const { cached } = await import('../src/services/cache.ts')
    const load = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return { ok: true }
    })

    const [a, b] = await Promise.all([
      cached('same', 1000, load),
      cached('same', 1000, load),
    ])

    expect(a).toBe(b)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('expires stale entries before returning a cached value', async () => {
    vi.useFakeTimers()
    const { cached } = await import('../src/services/cache.ts')
    const load = vi.fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second')

    await expect(cached('ttl', 1000, load)).resolves.toBe('first')
    vi.advanceTimersByTime(1001)
    await expect(cached('ttl', 1000, load)).resolves.toBe('second')

    expect(load).toHaveBeenCalledTimes(2)
  })

  it('evicts the least recently used entry when the cache is full', async () => {
    vi.stubEnv('API_CACHE_MAX_ENTRIES', '2')
    const { cached } = await import('../src/services/cache.ts')
    const load = vi.fn(async (value: string) => value)

    await cached('a', 1000, () => load('a1'))
    await cached('b', 1000, () => load('b1'))
    await cached('a', 1000, () => load('a2'))
    await cached('c', 1000, () => load('c1'))

    await expect(cached('a', 1000, () => load('a3'))).resolves.toBe('a1')
    await expect(cached('b', 1000, () => load('b2'))).resolves.toBe('b2')
    expect(load.mock.calls.map(([value]) => value)).toEqual(['a1', 'b1', 'c1', 'b2'])
  })

  it('serves stale data while sharing one background refresh', async () => {
    vi.useFakeTimers()
    const { cachedSwr } = await import('../src/services/cache.ts')
    let finishRefresh!: (value: string) => void
    const refresh = new Promise<string>(resolve => { finishRefresh = resolve })
    const load = vi.fn()
      .mockResolvedValueOnce('first')
      .mockReturnValueOnce(refresh)

    await expect(cachedSwr('swr', 100, 1000, load)).resolves.toBe('first')
    vi.advanceTimersByTime(101)
    await expect(cachedSwr('swr', 100, 1000, load)).resolves.toBe('first')
    await expect(cachedSwr('swr', 100, 1000, load)).resolves.toBe('first')
    expect(load).toHaveBeenCalledTimes(2)

    finishRefresh('second')
    await refresh
    await Promise.resolve()
    await expect(cachedSwr('swr', 100, 1000, load)).resolves.toBe('second')
  })

  // Every lookup addressed by block coordinates or a hash can be asked for
  // something the finalized index does not hold YET (raw-live trails the chain
  // by 35-65s). Storing that answer is what made a fresh /swap link 404 for a
  // full minute after its rows had landed.
  it('never stores a negative answer, so a miss re-asks instead of expiring', async () => {
    const { cachedFound } = await import('../src/services/cache.ts')
    const load = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 1 })
      .mockResolvedValueOnce({ id: 2 })

    await expect(cachedFound('miss', 60_000, load)).resolves.toBeNull()
    await expect(cachedFound('miss', 60_000, load)).resolves.toEqual({ id: 1 })
    // The hit caches normally — a third call inside the TTL must not re-read.
    await expect(cachedFound('miss', 60_000, load)).resolves.toEqual({ id: 1 })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('treats an empty list as negative too (an activity lookup answers with rows)', async () => {
    const { cachedFound } = await import('../src/services/cache.ts')
    const load = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ row: 1 }])

    await expect(cachedFound('rows', 60_000, load)).resolves.toEqual([])
    await expect(cachedFound('rows', 60_000, load)).resolves.toEqual([{ row: 1 }])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('still collapses concurrent misses onto one read', async () => {
    const { cachedFound } = await import('../src/services/cache.ts')
    const load = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return null
    })

    await Promise.all([cachedFound('single-flight', 1000, load), cachedFound('single-flight', 1000, load)])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid cache lifetimes', async () => {
    const { cached, cachedSwr } = await import('../src/services/cache.ts')
    const load = vi.fn(async () => 'value')

    await expect(cached('negative', -1, load)).rejects.toThrow(RangeError)
    await expect(cached('infinite', Number.POSITIVE_INFINITY, load)).rejects.toThrow(RangeError)
    await expect(cachedSwr('reversed', 1000, 100, load)).rejects.toThrow(/staleMs/)
    expect(load).not.toHaveBeenCalled()
  })
})

// A live feed's window is head-keyed so it can never silently stop gaining rows.
// Doing that with the head in the KEY means a new block leaves nothing to serve,
// so the next reader blocks on the whole rebuild. Passing the head as the entry's
// GENERATION keeps the same guarantee — a new head still forces the rebuild, and
// it is noticed on the next read rather than when a TTL happens to lapse — while
// the reader is served the previous head's value instead of waiting for it.
describe('cachedSwr generation', () => {
  beforeEach(() => { vi.resetModules() })

  it('serves the superseded value and rebuilds it in the background', async () => {
    const { cachedSwr } = await import('../src/services/cache.ts')
    let built = 0
    const build = async (): Promise<string> => {
      built += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return `head-${built}`
    }

    expect(await cachedSwr('k', 60_000, 60_000, build, 100)).toBe('head-1')

    // A new head supersedes the entry: the reader is NOT blocked on the rebuild.
    const started = Date.now()
    expect(await cachedSwr('k', 60_000, 60_000, build, 101)).toBe('head-1')
    expect(Date.now() - started).toBeLessThan(5)

    // …but the rebuild was started, and the next reader sees the new head's value.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(built).toBe(2)
    expect(await cachedSwr('k', 60_000, 60_000, build, 101)).toBe('head-2')
  })

  it('blocks only when there is nothing to serve at all', async () => {
    const { cached } = await import('../src/services/cache.ts')
    let built = 0
    const build = async (): Promise<string> => { built += 1; return `v${built}` }

    // The head-in-the-key shape: a new head is a new key, so there is no previous
    // value to serve and the reader pays the build. This is what a forward-only
    // reader must keep — a page incomplete when read loses rows permanently.
    expect(await cached('w:h1', 60_000, build)).toBe('v1')
    expect(await cached('w:h2', 60_000, build)).toBe('v2')
    expect(built).toBe(2)
  })
})
