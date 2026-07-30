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

  it('rejects invalid cache lifetimes', async () => {
    const { cached, cachedSwr } = await import('../src/services/cache.ts')
    const load = vi.fn(async () => 'value')

    await expect(cached('negative', -1, load)).rejects.toThrow(RangeError)
    await expect(cached('infinite', Number.POSITIVE_INFINITY, load)).rejects.toThrow(RangeError)
    await expect(cachedSwr('reversed', 1000, 100, load)).rejects.toThrow(/staleMs/)
    expect(load).not.toHaveBeenCalled()
  })
})
