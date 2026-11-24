import { describe, expect, it } from 'vitest'
import { CircuitOpenError, ISOLATED_FAILURES_TO_OPEN, ItemRequestError, SubsquareClient } from '../../src/governance/subsquare/client.js'
import { Quarantine } from '../../src/governance/subsquare/quarantine.js'

// One item Subsquare cannot serve must not stall the import: an isolated request that
// fails every attempt skips only that item, while a run of different failures (an
// outage) still opens the breaker and aborts the cycle.

function fakeClock() {
  let t = 1_000_000
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

function client(failing: (path: string) => boolean) {
  const clock = fakeClock()
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    const path = new URL(url).pathname
    calls.push(path)
    return failing(path) ? new Response('down', { status: 503 }) : new Response('{"items":[],"total":0}', { status: 200 })
  }) as unknown as typeof fetch
  return { c: new SubsquareClient({ baseUrl: 'https://x', fetchImpl, now: clock.now, sleep: clock.sleep }), calls }
}

describe('isolated requests', () => {
  it('a poisoned item fails on its own (3 attempts) without opening the breaker; the next request goes through', async () => {
    const { c, calls } = client(p => p === '/posts/13')
    await expect(c.get('/posts/13', { isolated: true })).rejects.toBeInstanceOf(ItemRequestError)
    expect(calls.filter(p => p === '/posts/13')).toHaveLength(3)
    expect(c.failuresInRow).toBe(0)
    await expect(c.get('/posts/14', { isolated: true })).resolves.toMatchObject({ status: 200 })
    expect(c.isolatedFailuresInRow).toBe(0)
  })

  it('the same item failing again in a later cycle is still only an item failure', async () => {
    const { c } = client(p => p === '/posts/13')
    for (let cycle = 0; cycle < 4; cycle++) {
      c.resetBreaker()
      await expect(c.get('/posts/13', { isolated: true })).rejects.toBeInstanceOf(ItemRequestError)
      await expect(c.get('/posts/14', { isolated: true })).resolves.toMatchObject({ status: 200 })
    }
  })

  it(`an outage (${ISOLATED_FAILURES_TO_OPEN} different isolated requests failing in a row) opens the breaker`, async () => {
    const { c } = client(() => true)
    await expect(c.get('/posts/1', { isolated: true })).rejects.toBeInstanceOf(ItemRequestError)
    await expect(c.get('/posts/2', { isolated: true })).rejects.toBeInstanceOf(ItemRequestError)
    await expect(c.get('/posts/3', { isolated: true })).rejects.toBeInstanceOf(CircuitOpenError)
    await expect(c.get('/posts/4', { isolated: true })).rejects.toBeInstanceOf(CircuitOpenError) // stays open for the cycle
    c.resetBreaker()
    expect(c.failuresInRow).toBe(0)
  })

  it('a plain request keeps the five-attempt breaker', async () => {
    const { c, calls } = client(() => true)
    await expect(c.get('/gov2/referendums')).rejects.toBeInstanceOf(CircuitOpenError)
    expect(calls).toHaveLength(5)
  })
})

describe('the quarantine', () => {
  it('sets an item aside after three failing cycles, clears it on success, and lets it back after the hold', () => {
    const q = new Quarantine(3, 6 * 3600_000)
    const t0 = 1_000_000
    expect(q.failed('s13', t0)).toBe(false)
    expect(q.failed('s13', t0 + 600_000)).toBe(false)
    expect(q.held('s13', t0 + 600_000)).toBe(false)
    expect(q.failed('s13', t0 + 1_200_000)).toBe(true)
    expect(q.held('s13', t0 + 1_800_000)).toBe(true)
    expect(q.size(t0 + 1_800_000)).toBe(1)
    expect(q.held('s13', t0 + 1_200_000 + 6 * 3600_000 + 1)).toBe(false)
    q.ok('s13')
    expect(q.failed('s13', t0 + 9 * 3600_000)).toBe(false) // a fresh count after a success
  })
})
