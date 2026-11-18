import { describe, expect, it } from 'vitest'
import { backoffMs, CircuitOpenError, retryAfterMs, SubsquareClient, USER_AGENT } from '../../src/governance/subsquare/client.js'

function fakeClock() {
  let t = 1_000_000
  return { now: () => t, sleep: async (ms: number) => { t += ms }, advance: (ms: number) => { t += ms } }
}

describe('polite Subsquare client', () => {
  it('keeps one request in flight, at most one start per second, with a generic User-Agent', async () => {
    const clock = fakeClock()
    let inFlight = 0, maxInFlight = 0
    const starts: number[] = []
    const agents = new Set<string>()
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      starts.push(clock.now())
      agents.add((init.headers as Record<string, string>)['User-Agent'])
      await new Promise(r => setTimeout(r, 1))
      clock.advance(300)
      inFlight--
      return new Response('{"ok":1}', { status: 200 })
    }) as typeof fetch
    const client = new SubsquareClient({ baseUrl: 'https://x', rps: 5, fetchImpl, now: clock.now, sleep: clock.sleep })
    await Promise.all([client.get('/a'), client.get('/b'), client.get('/c'), client.get('/d')])
    expect(maxInFlight).toBe(1)
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1000) // rps is capped at 1
    expect([...agents]).toEqual([USER_AGENT])
    expect(USER_AGENT).not.toMatch(/@|https?:/)
  })

  it('backs off on 429/5xx honouring Retry-After, and opens the breaker after 5 consecutive failures', async () => {
    const clock = fakeClock()
    const waits: number[] = []
    let calls = 0
    const fetchImpl = (async () => { calls++; return new Response('busy', { status: calls === 1 ? 429 : 503, headers: calls === 1 ? { 'retry-after': '7' } : {} }) }) as typeof fetch
    const client = new SubsquareClient({ baseUrl: 'https://x', fetchImpl, now: clock.now, sleep: async ms => { waits.push(ms); await clock.sleep(ms) }, maxRetries: 10 })
    await expect(client.get('/a')).rejects.toBeInstanceOf(CircuitOpenError)
    expect(calls).toBe(5)
    expect(waits).toContain(7000)
    expect(waits).toContain(backoffMs(1))
    await expect(client.get('/b')).rejects.toBeInstanceOf(CircuitOpenError) // stays open: the cycle is aborted
    expect(calls).toBe(5)
  })

  it('returns 404 as an answer, not a failure', async () => {
    const clock = fakeClock()
    const client = new SubsquareClient({ baseUrl: 'https://x', fetchImpl: (async () => new Response('{"message":"Post not found"}', { status: 404 })) as typeof fetch, now: clock.now, sleep: clock.sleep })
    expect(await client.get('/posts/1')).toEqual({ status: 404, body: { message: 'Post not found' } })
    expect(client.failuresInRow).toBe(0)
  })

  it('parses Retry-After seconds and dates, capped', () => {
    expect(retryAfterMs('3', 0)).toBe(3000)
    expect(retryAfterMs('9999', 0)).toBe(120_000)
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000)
    expect(retryAfterMs(null, 0)).toBeNull()
  })
})
