import { afterAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

// ADMIN_ACCOUNT_IDS is parsed once at config import, so this file sets it
// BEFORE any src module loads (dynamic imports only) — its own file so no
// other test's import order can race the env.
process.env.ADMIN_ACCOUNT_IDS = `0x${'11'.repeat(32)}`

let app: FastifyInstance | undefined

afterAll(async () => {
  await app?.close()
})

describe('admin rate-limit exemption', () => {
  it('never 429s an admin account but keeps counting its usage', async () => {
    const { AUTH, fakeDataClient, freshDataApp } = await import('./helpers.ts')
    const { flushUsage } = await import('../../src/data/services/auth.ts')
    const client = fakeDataClient(
      query => (query.includes('FROM price_data.user_api_limits') ? [{ per_minute: 1, per_day: 1 }] : undefined),
      query => (query.includes('-- data:blocks:feed') ? [] : undefined),
    )
    app = await freshDataApp(client)
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ url: '/v1/blocks', headers: AUTH })).statusCode).toBe(200)
    }
    await flushUsage()
    expect(client.inserted.at(-1)!.values[0]).toMatchObject({ requests: 5, rejected: 0 })
  })
})
