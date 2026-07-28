import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import Fastify from 'fastify'
import { cryptoWaitReady, sr25519PairFromSeed, sr25519Sign, encodeAddress, randomAsU8a } from '@polkadot/util-crypto'
import { u8aToHex, u8aWrapBytes } from '@polkadot/util'
import { userRoutes } from '../src/routes/user.ts'
import { initUserAuthService, resetUserAuthForTests } from '../src/services/userAuthService.ts'
import { fakeClient } from './helpers/userFakes.ts'

beforeAll(async () => { await cryptoWaitReady() })

async function build() {
  const f = Fastify()
  await f.register(userRoutes)
  return f
}

function wallet() {
  const pair = sr25519PairFromSeed(randomAsU8a(32))
  return { pair, address: encodeAddress(pair.publicKey, 0) }
}

async function login(f: Awaited<ReturnType<typeof build>>, w = wallet()) {
  const ch = await f.inject({ method: 'POST', url: '/user/auth/challenge', payload: { address: w.address } })
  const { nonce, message } = ch.json()
  const signature = u8aToHex(sr25519Sign(u8aWrapBytes(message), w.pair))
  const v = await f.inject({ method: 'POST', url: '/user/auth/verify', payload: { address: w.address, nonce, signature } })
  return { w, v }
}

describe('/user/auth', () => {
  beforeEach(async () => { resetUserAuthForTests(); await initUserAuthService(fakeClient()) })

  it('challenge → sign → verify returns a bearer token and no-store', async () => {
    const f = await build()
    const { v } = await login(f)
    expect(v.statusCode).toBe(200)
    expect(v.headers['cache-control']).toBe('no-store')
    const body = v.json()
    expect(body.token).toMatch(/^[0-9a-f]{64}$/)
    expect(body.me.account.accountId).toMatch(/^0x[0-9a-f]{64}$/)
    // the token works
    const me = await f.inject({ method: 'GET', url: '/user/me', headers: { authorization: `Bearer ${body.token}` } })
    expect(me.statusCode).toBe(200)
    expect(me.headers['cache-control']).toBe('no-store')
  })

  it('rejects a bad signature with 401 and a bad address with 400', async () => {
    const f = await build()
    const w = wallet()
    const ch = await f.inject({ method: 'POST', url: '/user/auth/challenge', payload: { address: w.address } })
    const { nonce } = ch.json()
    const bad = await f.inject({ method: 'POST', url: '/user/auth/verify', payload: { address: w.address, nonce, signature: '0x' + '00'.repeat(64) } })
    expect(bad.statusCode).toBe(401)
    const badAddr = await f.inject({ method: 'POST', url: '/user/auth/challenge', payload: { address: '!!' } })
    expect(badAddr.statusCode).toBe(400)
  })

  it('logout revokes the session', async () => {
    const f = await build()
    const { v } = await login(f)
    const token = v.json().token
    const out = await f.inject({ method: 'POST', url: '/user/auth/logout', headers: { authorization: `Bearer ${token}` } })
    expect(out.statusCode).toBe(200)
    const me = await f.inject({ method: 'GET', url: '/user/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.statusCode).toBe(401)
  })

  it('rate-limits challenge requests', async () => {
    const f = await build()
    const w = wallet()
    let limited = false
    for (let i = 0; i < 12; i++) {
      const r = await f.inject({ method: 'POST', url: '/user/auth/challenge', payload: { address: w.address }, remoteAddress: '10.0.0.9' })
      if (r.statusCode === 429) limited = true
    }
    expect(limited).toBe(true)
  })
})
