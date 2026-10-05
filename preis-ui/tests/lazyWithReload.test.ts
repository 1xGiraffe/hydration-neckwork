import { describe, expect, it, vi } from 'vitest'
import { createChunkReloader, isChunkLoadError } from '../src/lazyWithReload'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
    size: () => data.size,
  }
}

const chunkError = () => new TypeError('Failed to fetch dynamically imported module: https://x/assets/Account-abc.js')
const settles = async (promise: Promise<unknown>) => {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 0))
  return settled
}

describe('isChunkLoadError', () => {
  it('recognises each browser wording and ChunkLoadError', () => {
    expect(isChunkLoadError(chunkError())).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: /assets/x.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(Object.assign(new Error('Loading chunk 3 failed.'), { name: 'ChunkLoadError' }))).toBe(true)
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true)
  })

  it('leaves ordinary errors alone', () => {
    expect(isChunkLoadError(new Error('boom'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError('Failed')).toBe(false)
  })
})

describe('createChunkReloader', () => {
  it('reloads once on a chunk failure and keeps the fallback up', async () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const load = createChunkReloader({ storage: () => storage, reload })
    const pending = load(() => Promise.reject(chunkError()))
    expect(await settles(pending)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.size()).toBe(1)
  })

  it('rethrows instead of reloading again on a page booted by that reload', async () => {
    const storage = memoryStorage()
    createChunkReloader({ storage: () => storage, reload: vi.fn() })(() => Promise.reject(chunkError()))
    await Promise.resolve()

    const reload = vi.fn()
    const rebooted = createChunkReloader({ storage: () => storage, reload })
    // A sibling chunk loading fine clears the flag, yet must not re-arm this page.
    await expect(rebooted(() => Promise.resolve({ default: 'ok' }))).resolves.toEqual({ default: 'ok' })
    await expect(rebooted(() => Promise.reject(chunkError()))).rejects.toThrow('dynamically imported module')
    expect(reload).not.toHaveBeenCalled()
  })

  it('clears the flag after a successful load so a later page can reload again', async () => {
    const storage = memoryStorage({ 'chunk-load-reload': '1' })
    const load = createChunkReloader({ storage: () => storage, reload: vi.fn() })
    await load(() => Promise.resolve({ default: 'ok' }))
    expect(storage.size()).toBe(0)

    const reload = vi.fn()
    createChunkReloader({ storage: () => storage, reload })(() => Promise.reject(chunkError()))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('rethrows without reloading when storage is unavailable', async () => {
    const reload = vi.fn()
    const load = createChunkReloader({ storage: () => { throw new DOMException('denied', 'SecurityError') }, reload })
    await expect(load(() => Promise.reject(chunkError()))).rejects.toThrow('dynamically imported module')
    expect(reload).not.toHaveBeenCalled()
  })

  it('rethrows when the flag does not persist', async () => {
    const reload = vi.fn()
    const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    const load = createChunkReloader({ storage: () => storage, reload })
    await expect(load(() => Promise.reject(chunkError()))).rejects.toThrow()
    expect(reload).not.toHaveBeenCalled()
  })

  it('passes non-chunk errors straight through', async () => {
    const reload = vi.fn()
    const load = createChunkReloader({ storage: () => memoryStorage(), reload })
    await expect(load(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(reload).not.toHaveBeenCalled()
  })
})
