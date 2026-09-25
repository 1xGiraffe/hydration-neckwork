import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearSnakewatchEmojiSourceForTest, ensureSnakewatchEmojiSourceLoaded } from '../src/services/omniwatchIdentity.ts'

// Every /candles request awaits the emoji-source load, so an upstream that never
// answers must not hold a request past the load's budget.
describe('ensureSnakewatchEmojiSourceLoaded', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    clearSnakewatchEmojiSourceForTest()
  })

  it('settles within its budget when the upstream never answers, and aborts the fetch', async () => {
    vi.useFakeTimers()
    let aborted = false
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      init?.signal?.addEventListener('abort', () => { aborted = true })
      return new Promise(() => {}) // never settles, not even on abort
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let settled = false
    const load = ensureSnakewatchEmojiSourceLoaded().then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await load
    expect(settled).toBe(true)
    expect(aborted).toBe(true)
  })
})
