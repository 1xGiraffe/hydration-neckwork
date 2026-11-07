import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The backing monitor names a NEAR peer (Wormhole carries it as sha256 of the
// manager account) through `nearManagerNames`. On 2026-11-07 a restarted api
// asked FastNear to discover the managers, got 429s, and read NEAR as
// unreadable; these pin that the known managers never depend on FastNear and
// that a rate-limited FastNear is left alone until it says it is ready.

// The peer handles the live ZEC and wNEAR assets register for NEAR.
const ZEC_PEER = 'ca4092420316d55cfbb9a479ca23fdf0f5a0864a80c755b46e071c834fbf3976'
const WNEAR_PEER = 'd473056b88c2062503ea1425bdea8e87609e3d499b3b4d1809e440df2d7cb9e3'

const tooMany = (retryAfter?: string) => new Response('rate limited', {
  status: 429,
  headers: retryAfter ? { 'retry-after': retryAfter } : {},
})

// Module state (the manager index, the backoff) is per process, so every case
// starts from a fresh import, the way a restarted api does.
async function freshBridge() {
  vi.resetModules()
  return await import('../src/services/nearBridge.ts')
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('nearManagerNames without FastNear', () => {
  it('names the pinned ZEC and wNEAR managers in a fresh process whose discovery is rate-limited', async () => {
    const fetch = vi.fn(async () => tooMany())
    vi.stubGlobal('fetch', fetch)
    const { nearManagerNames } = await freshBridge()
    const names = await nearManagerNames()
    expect(names.get(ZEC_PEER)).toBe('ntt-zec.hydration-whm.near')
    expect(names.get(WNEAR_PEER)).toBe('ntt-near.hydration-whm.near')
    expect(fetch).toHaveBeenCalled()
  })
})

describe('FastNear backoff', () => {
  it('sends nothing to FastNear again until its Retry-After has passed', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-07T13:24:00Z') })
    const fetch = vi.fn(async () => tooMany('120'))
    vi.stubGlobal('fetch', fetch)
    const { nearManagerNames } = await freshBridge()
    await nearManagerNames()
    const afterFirst = fetch.mock.calls.length
    expect(afterFirst).toBe(1)

    // Every backing cycle asks again; none of them may reach FastNear inside the window.
    vi.setSystemTime(Date.parse('2026-11-07T13:25:59Z'))
    await nearManagerNames()
    expect(fetch.mock.calls.length).toBe(afterFirst)

    vi.setSystemTime(Date.parse('2026-11-07T13:26:01Z'))
    await nearManagerNames()
    expect(fetch.mock.calls.length).toBe(afterFirst + 1)
  })

  it('backs off on its own when a 429 names no Retry-After, longer each time', async () => {
    const start = Date.parse('2026-11-07T13:24:00Z')
    vi.useFakeTimers({ now: start })
    const fetch = vi.fn(async () => tooMany())
    vi.stubGlobal('fetch', fetch)
    const { nearManagerNames } = await freshBridge()
    await nearManagerNames()
    expect(fetch.mock.calls.length).toBe(1)

    // Inside the first window: nothing sent.
    vi.setSystemTime(start + 29_000)
    await nearManagerNames()
    expect(fetch.mock.calls.length).toBe(1)

    // After it: one more try, which is refused again and doubles the wait.
    vi.setSystemTime(start + 31_000)
    await nearManagerNames()
    expect(fetch.mock.calls.length).toBe(2)
    vi.setSystemTime(start + 31_000 + 59_000)
    await nearManagerNames()
    expect(fetch.mock.calls.length).toBe(2)
    vi.setSystemTime(start + 31_000 + 61_000)
    await nearManagerNames()
    expect(fetch.mock.calls.length).toBe(3)
  })
})
