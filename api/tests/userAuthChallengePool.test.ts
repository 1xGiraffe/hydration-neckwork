import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import Fastify from 'fastify'
import { cryptoWaitReady, sr25519PairFromSeed, sr25519Sign, encodeAddress, randomAsU8a } from '@polkadot/util-crypto'
import { u8aToHex, u8aWrapBytes } from '@polkadot/util'
import { userRoutes } from '../src/routes/user.ts'
import {
  initUserAuthService, resetUserAuthForTests, createChallenge, verifyChallenge, challengeClientKey,
  __pendingChallengeCountForTests,
} from '../src/services/userAuthService.ts'
import { initUserListService, loadUserLists } from '../src/services/userListService.ts'
import { fakeClient } from './helpers/userFakes.ts'

// The pending login challenges are unauthenticated state, so their bounds must
// never turn into "nobody can log in": a client's own oldest challenge gives
// way to its newest, and a full set gives way oldest-first instead of refusing.

beforeAll(async () => { await cryptoWaitReady() })

function wallet() {
  const pair = sr25519PairFromSeed(randomAsU8a(32))
  return { pair, address: encodeAddress(pair.publicKey, 0) }
}
const sign = (pair: ReturnType<typeof wallet>['pair'], message: string) => u8aToHex(sr25519Sign(u8aWrapBytes(message), pair))

beforeEach(async () => {
  resetUserAuthForTests()
  await initUserAuthService(fakeClient())
  initUserListService(fakeClient())
  await loadUserLists()
})

describe('challengeClientKey', () => {
  it('keys IPv4 by address and IPv6 by its /64', () => {
    expect(challengeClientKey('203.0.113.10')).toBe('203.0.113.10')
    expect(challengeClientKey('::ffff:203.0.113.10')).toBe('203.0.113.10')
    expect(challengeClientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(challengeClientKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64')
    expect(challengeClientKey('2001:0db8:0001:0002::7')).toBe('2001:db8:1:2::/64')
    expect(challengeClientKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(challengeClientKey('2001:db8:1:3::1')).not.toBe(challengeClientKey('2001:db8:1:2::1'))
  })
})

describe('pending challenge bounds', () => {
  it('lets one client hold only a few challenges, its oldest giving way', () => {
    const w = wallet()
    const first = createChallenge('h', w.address, 'client-a')!
    for (let i = 0; i < 10; i++) createChallenge('h', w.address, 'client-a')
    expect(verifyChallenge(first.nonce, w.address, sign(w.pair, first.message))).toEqual({ ok: false, reason: 'no-challenge' })
    // Another client's challenge is untouched by client-a's churn.
    const other = createChallenge('h', w.address, 'client-b')!
    for (let i = 0; i < 20; i++) createChallenge('h', w.address, 'client-a')
    expect(verifyChallenge(other.nonce, w.address, sign(w.pair, other.message)).ok).toBe(true)
  })

  it('never refuses a challenge when the set is full; the oldest gives way', () => {
    const w = wallet()
    const oldest = createChallenge('h', w.address, 'client-0')!
    for (let i = 1; i < 10_000; i++) createChallenge('h', w.address, `client-${i}`)
    expect(__pendingChallengeCountForTests()).toBe(10_000)
    const fresh = createChallenge('h', w.address, 'late-client')
    expect(fresh).not.toBeNull()
    expect(__pendingChallengeCountForTests()).toBe(10_000)
    expect(verifyChallenge(oldest.nonce, w.address, sign(w.pair, oldest.message))).toEqual({ ok: false, reason: 'no-challenge' })
    expect(verifyChallenge(fresh!.nonce, w.address, sign(w.pair, fresh!.message)).ok).toBe(true)
  })
})

describe('/user/auth/challenge limiter', () => {
  it('shares one budget across an IPv6 /64', async () => {
    const f = Fastify({ trustProxy: ['loopback', 'linklocal', 'uniquelocal'] })
    await f.register(userRoutes)
    const w = wallet()
    const ask = (ip: string) => f.inject({
      method: 'POST', url: '/user/auth/challenge', payload: { address: w.address },
      remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': ip },
    })
    for (let i = 0; i < 10; i++) expect((await ask(`2001:db8:1:2::${i + 1}`)).statusCode).toBe(200)
    expect((await ask('2001:db8:1:2:dead::beef')).statusCode).toBe(429)
    expect((await ask('2001:db8:1:3::1')).statusCode).toBe(200)
  })
})
