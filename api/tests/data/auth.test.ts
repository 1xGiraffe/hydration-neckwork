import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  AUTH, TEST_ACCOUNT, TEST_TOKEN, fakeDataClient, freshDataApp, sha256Hex, type FakeDataClient,
} from './helpers.ts'
import { flushUsage, recordUsage, resetDataAuthForTests, resolveToken } from '../../src/data/services/auth.ts'

// The auth hook, the per-user limiter and the usage metering — the whole
// data-plane half of the control plane (concept § 3).

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
  vi.useRealTimers()
})

describe('authentication', () => {
  it('serves the three exempt surfaces without a token', async () => {
    app = await freshDataApp(fakeDataClient())
    expect((await app.inject('/v1/status')).statusCode).toBe(200)
    expect((await app.inject('/openapi.json')).statusCode).toBe(200)
    expect((await app.inject('/docs')).statusCode).toBeLessThan(400)
  })

  it('rejects a missing token with the docs pointers in context', async () => {
    app = await freshDataApp(fakeDataClient())
    const res = await app.inject('/v1/blocks')
    expect(res.statusCode).toBe(401)
    const { error } = res.json()
    expect(error.code).toBe('unauthorized')
    expect(error.context.docs).toMatch(/\/docs$/)
    expect(error.context.createToken).toMatch(/api-tokens$/)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('rejects a malformed and an unknown token differently', async () => {
    app = await freshDataApp(fakeDataClient())
    const malformed = await app.inject({ url: '/v1/blocks', headers: { authorization: 'Bearer not-a-token' } })
    expect(malformed.statusCode).toBe(401)
    expect(malformed.json().error.message).toMatch(/malformed/)

    const unknown = await app.inject({ url: '/v1/blocks', headers: { authorization: `Bearer hdd_${'ff'.repeat(32)}` } })
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json().error.message).toMatch(/unknown or revoked/)
  })

  it('negative-caches an unknown token so a stuffing loop costs one read', async () => {
    const client = fakeDataClient()
    app = await freshDataApp(client)
    const headers = { authorization: `Bearer hdd_${'ee'.repeat(32)}` }
    await app.inject({ url: '/v1/blocks', headers })
    await app.inject({ url: '/v1/blocks', headers })
    const tokenReads = client.seen.filter(s => s.query.includes('FROM price_data.user_api_tokens'))
    expect(tokenReads).toHaveLength(1)
  })

  it('authenticates a valid token, stamps rate headers, and answers privately cacheable', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:blocks:feed') ? [] : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/blocks', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-ratelimit-limit-minute']).toBe('30')
    expect(Number(res.headers['x-ratelimit-remaining-minute'])).toBe(29)
    expect(res.headers['x-ratelimit-limit-day']).toBe('20000')
    expect(res.headers['cache-control']).toBe('private, max-age=3')
  })

  it('persists last_used_at through the self-guarding INSERT…SELECT', async () => {
    const client = fakeDataClient()
    app = await freshDataApp(client)
    await app.inject({ url: '/v1/status', headers: AUTH }) // exempt: no resolve
    expect(client.command).not.toHaveBeenCalled()
    const res = await app.inject({ url: '/v1/blocks', headers: AUTH })
    expect(res.statusCode).not.toBe(401)
    expect(client.command).toHaveBeenCalledTimes(1)
    const call = client.command.mock.calls[0][0] as { query: string; query_params: Record<string, unknown> }
    expect(call.query).toMatch(/INSERT INTO price_data.user_api_tokens/)
    expect(call.query).toMatch(/deleted = 0/)
    expect(call.query_params.hash).toBe(sha256Hex(TEST_TOKEN))
  })

  it('re-verifies a token after its cache TTL, so a revoke lands within 30s', async () => {
    vi.useFakeTimers()
    let revoked = false
    const client = fakeDataClient(
      (query, params) => {
        if (!query.includes('FROM price_data.user_api_tokens')) return undefined
        if (revoked) return []
        return params.hash === sha256Hex(TEST_TOKEN) ? [{ account_id: TEST_ACCOUNT }] : []
      },
      query => (query.includes('-- data:blocks:feed') ? [] : undefined),
    )
    app = await freshDataApp(client)
    expect((await app.inject({ url: '/v1/blocks', headers: AUTH })).statusCode).toBe(200)
    revoked = true
    // Inside the positive TTL the cached identity still answers.
    expect((await app.inject({ url: '/v1/blocks?limit=25', headers: AUTH })).statusCode).toBe(200)
    await vi.advanceTimersByTimeAsync(31_000)
    expect((await app.inject({ url: '/v1/blocks?limit=26', headers: AUTH })).statusCode).toBe(401)
  })

  it('brakes unauthenticated requests per IP', async () => {
    app = await freshDataApp(fakeDataClient())
    const headers = { 'x-forwarded-for': '203.0.113.7' }
    let last = 0
    for (let i = 0; i < 61; i++) {
      last = (await app.inject({ url: '/v1/blocks', headers })).statusCode
    }
    expect(last).toBe(429)
    // A different address is unaffected.
    expect((await app.inject({ url: '/v1/blocks', headers: { 'x-forwarded-for': '203.0.113.8' } })).statusCode).toBe(401)
  })
})

describe('rate limiting', () => {
  function limitedClient(perMinute: number, perDay: number): FakeDataClient {
    return fakeDataClient(
      query => (query.includes('FROM price_data.user_api_limits')
        ? [{ per_minute: perMinute, per_day: perDay }]
        : undefined),
      query => (query.includes('-- data:blocks:feed') ? [] : undefined),
    )
  }

  it('enforces the per-minute override and reports usage in the 429 context', async () => {
    app = await freshDataApp(limitedClient(2, 1000))
    expect((await app.inject({ url: '/v1/blocks', headers: AUTH })).statusCode).toBe(200)
    expect((await app.inject({ url: '/v1/blocks', headers: AUTH })).statusCode).toBe(200)
    const res = await app.inject({ url: '/v1/blocks', headers: AUTH })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toMatch(/^\d+$/)
    const { error } = res.json()
    expect(error.code).toBe('rate_limited')
    expect(error.context).toMatchObject({ perMinute: 2, perDay: 1000, usedMinute: 2 })
    expect(error.context.retryAfterSeconds).toBeGreaterThan(0)
    expect(res.headers['x-ratelimit-remaining-minute']).toBe('0')
  })

  it('rolls the minute window over', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T12:00:30Z'))
    app = await freshDataApp(limitedClient(1, 1000))
    expect((await app.inject({ url: '/v1/blocks', headers: AUTH })).statusCode).toBe(200)
    expect((await app.inject({ url: '/v1/blocks', headers: AUTH })).statusCode).toBe(429)
    await vi.advanceTimersByTimeAsync(31_000) // crosses the fixed-minute boundary
    expect((await app.inject({ url: '/v1/blocks', headers: AUTH })).statusCode).toBe(200)
  })

  it('counts every token of one account against the same budget', async () => {
    const secondToken = `hdd_${'cd'.repeat(32)}`
    const client = fakeDataClient(
      (query, params) => {
        if (!query.includes('FROM price_data.user_api_tokens')) return undefined
        return params.hash === sha256Hex(TEST_TOKEN) || params.hash === sha256Hex(secondToken)
          ? [{ account_id: TEST_ACCOUNT }]
          : []
      },
      query => (query.includes('FROM price_data.user_api_limits') ? [{ per_minute: 1, per_day: 1000 }] : undefined),
      query => (query.includes('-- data:blocks:feed') ? [] : undefined),
    )
    app = await freshDataApp(client)
    expect((await app.inject({ url: '/v1/blocks', headers: AUTH })).statusCode).toBe(200)
    const viaSecond = await app.inject({ url: '/v1/blocks', headers: { authorization: `Bearer ${secondToken}` } })
    expect(viaSecond.statusCode).toBe(429)
  })
})

describe('usage metering', () => {
  it('flushes running totals seeded from the stored row, idempotently', async () => {
    const client = fakeDataClient(query => {
      if (!query.includes('FROM price_data.user_api_usage')) return undefined
      return [{ account_id: TEST_ACCOUNT, hour_epoch: Math.floor(Date.now() / 3600_000) * 3600, requests: '100', rejected: '5' }]
    })
    resetDataAuthForTests()
    const { initDataAuth } = await import('../../src/data/services/auth.ts')
    initDataAuth(client as never)
    recordUsage(TEST_ACCOUNT, false)
    recordUsage(TEST_ACCOUNT, false)
    recordUsage(TEST_ACCOUNT, true)
    await flushUsage()
    expect(client.inserted).toHaveLength(1)
    expect(client.inserted[0].values[0]).toMatchObject({ account_id: TEST_ACCOUNT, requests: 103, rejected: 6 })

    // A second flush re-writes the same running total (replace, never add) and
    // does not re-seed from storage.
    await flushUsage()
    expect(client.inserted).toHaveLength(2)
    expect(client.inserted[1].values[0]).toMatchObject({ requests: 103, rejected: 6 })
    const usageReads = client.seen.filter(s => s.query.includes('FROM price_data.user_api_usage'))
    expect(usageReads).toHaveLength(1)
  })

  it('meters rejected requests too', async () => {
    const client = fakeDataClient(
      query => (query.includes('FROM price_data.user_api_limits') ? [{ per_minute: 1, per_day: 1000 }] : undefined),
      query => (query.includes('-- data:blocks:feed') ? [] : undefined),
    )
    app = await freshDataApp(client)
    await app.inject({ url: '/v1/blocks', headers: AUTH })
    await app.inject({ url: '/v1/blocks', headers: AUTH }) // 429
    await flushUsage()
    const written = client.inserted.at(-1)!.values[0]
    expect(written).toMatchObject({ requests: 2, rejected: 1 })
  })
})

describe('token shapes', () => {
  it('resolves only well-formed hdd_ tokens', async () => {
    resetDataAuthForTests()
    const { initDataAuth } = await import('../../src/data/services/auth.ts')
    initDataAuth(fakeDataClient() as never)
    expect(await resolveToken('')).toBeNull()
    expect(await resolveToken('hdd_short')).toBeNull()
    expect(await resolveToken(TEST_TOKEN.toUpperCase())).toBeNull()
    expect(await resolveToken(TEST_TOKEN)).toBe(TEST_ACCOUNT)
  })
})
