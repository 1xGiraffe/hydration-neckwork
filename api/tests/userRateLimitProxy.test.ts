import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { userRoutes } from '../src/routes/user.ts'
import { initUserAuthService, resetUserAuthForTests } from '../src/services/userAuthService.ts'
import { initUserLibraryService, loadUserLibraries } from '../src/services/userLibraryService.ts'
import { fakeClient } from './helpers/userFakes.ts'

// Pins server.ts:64's trustProxy config: behind the explorer-ui nginx proxy,
// every browser's request shares nginx's own container address as the TCP
// peer, with the REAL client address carried in X-Forwarded-For. Without
// trusting that private hop, @fastify/rate-limit keys its bucket on req.ip —
// which would be the one shared nginx address for every visitor, so the whole
// site would share a single 10-logins/minute budget. Built the same way
// server.ts builds the real instance (trustProxy: private ranges only).
async function build() {
  const f = Fastify({ trustProxy: ['loopback', 'linklocal', 'uniquelocal'] })
  await f.register(userRoutes)
  return f
}

// The nginx container's address on the compose network — private range, so it
// is a trusted hop and its own address is never itself treated as the client.
const PROXY_HOP = '172.18.0.5'

describe('rate limiting behind a trusted proxy', () => {
  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(fakeClient())
    initUserLibraryService(fakeClient())
    await loadUserLibraries()
  })

  it('keys the limiter per X-Forwarded-For client, not per proxy hop', async () => {
    const f = await build()
    // Client A exhausts its own 10/min challenge bucket...
    let sawLimit = false
    for (let i = 0; i < 10; i++) {
      const r = await f.inject({
        method: 'POST', url: '/user/auth/challenge', payload: { address: '0x' + 'aa'.repeat(32) },
        remoteAddress: PROXY_HOP, headers: { 'x-forwarded-for': '203.0.113.10' },
      })
      expect(r.statusCode).toBe(200)
    }
    const overLimit = await f.inject({
      method: 'POST', url: '/user/auth/challenge', payload: { address: '0x' + 'aa'.repeat(32) },
      remoteAddress: PROXY_HOP, headers: { 'x-forwarded-for': '203.0.113.10' },
    })
    if (overLimit.statusCode === 429) sawLimit = true
    expect(sawLimit).toBe(true)

    // ...while client B, through the SAME nginx hop (identical remoteAddress),
    // still has a fresh bucket because it carries a different X-Forwarded-For.
    const clientB = await f.inject({
      method: 'POST', url: '/user/auth/challenge', payload: { address: '0x' + 'bb'.repeat(32) },
      remoteAddress: PROXY_HOP, headers: { 'x-forwarded-for': '203.0.113.20' },
    })
    expect(clientB.statusCode).toBe(200)
  })
})
