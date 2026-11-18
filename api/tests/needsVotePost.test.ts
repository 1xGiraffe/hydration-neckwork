import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { governanceRoutes } from '../src/routes/governance.ts'

// A reader's accounts travel in a POST body, never in a URL that access logs keep
// beside the IP; the answer is never cached. Validation runs before anything is read.

describe('needs-vote by POST', () => {
  it('takes the accounts as a JSON body, refuses a bad list, and is never cached', async () => {
    const app = Fastify()
    await app.register(governanceRoutes)
    for (const body of [{}, { accounts: [] }, { accounts: 'a,b' }, { accounts: Array.from({ length: 21 }, (_, i) => `acct${i}`) }, { accounts: ['x'.repeat(129)] }]) {
      const res = await app.inject({ method: 'POST', url: '/explorer/governance/needs-vote', payload: body })
      expect(res.statusCode).toBe(400)
      expect(res.headers['cache-control']).toBe('no-store')
    }
    // A valid list reaches the snapshot check (not loaded in this test: 503 not-ready).
    const ok = await app.inject({ method: 'POST', url: '/explorer/governance/needs-vote', payload: { accounts: ['15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV'] } })
    expect(ok.statusCode).toBe(503)
    expect(ok.headers['cache-control']).toBe('no-store')
  })
})
