import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// Minting reads the account's USD value (apiTokenMintGate.ts); the value — or
// the failure — it returns is set per test. The forum's gate facts are mocked
// too, only to prove identity, votes and HDX standing no longer open the gate.
const gate = vi.hoisted(() => ({
  valueUsd: 50 as number | Error,
  facts: { hdx: 0n, identity: false, voted: false, firstSeenMs: null as number | null },
}))
vi.mock('../src/services/apiTokenMintGate.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/apiTokenMintGate.ts')>(),
  mintHoldingsUsd: vi.fn(async () => {
    if (gate.valueUsd instanceof Error) throw gate.valueUsd
    return gate.valueUsd
  }),
}))
vi.mock('../src/services/forumWrite.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/forumWrite.ts')>(),
  gateFacts: vi.fn(async () => gate.facts),
}))

import { cryptoWaitReady } from '@polkadot/util-crypto'
import type { ClickHouseClient } from '../src/db/client.ts'
import { apiTokenRoutes } from '../src/routes/apiTokens.ts'
import { initUserAuthService, issueSession, resetUserAuthForTests } from '../src/services/userAuthService.ts'
import { initUserApiTokenService, MAX_ACTIVE_TOKENS, createApiToken, parseAdminAccountIds } from '../src/services/userApiTokenService.ts'
import { initExplorerService, loadEvmBindings } from '../src/services/explorerService.ts'
import { fakeClient as userFakeClient } from './helpers/userFakes.ts'
import { MintValuationUnavailable, mintHoldingsUsd, netAccountValueUsd, parseMinMintUsd } from '../src/services/apiTokenMintGate.ts'

// The Data API's control plane: token CRUD on the explorer api, and the admin
// surface. The fake below reproduces ReplacingMergeTree upsert semantics for
// the three user_api_* tables (newest row per key wins, deleted is a
// tombstone), because that is exactly what the service leans on.

const OWNER = `0x${'11'.repeat(32)}`
const OTHER = `0x${'22'.repeat(32)}`
const ADMIN = `0x${'ad'.repeat(32)}`

type Row = Record<string, unknown>

function apiTablesFake() {
  const tokens = new Map<string, Row>()
  const limits = new Map<string, Row>()
  const usage: Row[] = []
  const client = {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => ({
      json: async () => {
        const params = query_params ?? {}
        if (query.includes('price_data.user_api_tokens')) {
          let rows = [...tokens.values()].filter(row => Number(row.deleted) === 0)
          if (params.account) rows = rows.filter(row => row.account_id === params.account)
          if (params.hash) rows = rows.filter(row => row.token_hash === params.hash)
          if (query.includes('GROUP BY account_id')) {
            const grouped = new Map<string, Row[]>()
            for (const row of rows) {
              const list = grouped.get(String(row.account_id)) ?? []
              list.push(row)
              grouped.set(String(row.account_id), list)
            }
            return [...grouped.entries()].map(([account_id, list]) => ({
              account_id,
              tokens: list.length,
              labels: list.map(row => row.label),
              last_used: list.map(row => String(row.last_used_at)).sort().at(-1),
            }))
          }
          return rows
        }
        if (query.includes('price_data.user_api_limits')) {
          return [...limits.values()].filter(row => Number(row.deleted) === 0)
        }
        if (query.includes('price_data.user_api_usage')) return usage
        return []
      },
    }),
    insert: async ({ table, values }: { table: string; values: Row[] }) => {
      for (const row of values) {
        if (table.includes('user_api_tokens')) tokens.set(String(row.token_hash), row)
        else if (table.includes('user_api_limits')) limits.set(String(row.account_id), row)
        else usage.push(row)
      }
    },
    close: async () => {},
  } as unknown as ClickHouseClient
  return { client, tokens, limits, usage }
}

let app: FastifyInstance
let fake: ReturnType<typeof apiTablesFake>
let ownerToken: string
let adminToken: string

beforeAll(async () => { await cryptoWaitReady() })

beforeEach(async () => {
  resetUserAuthForTests()
  await initUserAuthService(userFakeClient())
  fake = apiTablesFake()
  gate.valueUsd = 50
  gate.facts = { hdx: 0n, identity: false, voted: false, firstSeenMs: null }
  vi.mocked(mintHoldingsUsd).mockClear()
  process.env.ADMIN_ACCOUNT_IDS = ADMIN
  initUserApiTokenService(fake.client)
  app = Fastify({ logger: false })
  await app.register(apiTokenRoutes)
  ownerToken = await issueSession(OWNER)
  adminToken = await issueSession(ADMIN)
})

afterEach(async () => {
  delete process.env.ADMIN_ACCOUNT_IDS
  delete process.env.DATA_API_MIN_MINT_USD
  await app.close()
})

const asOwner = () => ({ authorization: `Bearer ${ownerToken}` })
const asAdmin = () => ({ authorization: `Bearer ${adminToken}` })

describe('token CRUD', () => {
  it('mints a token, shows the raw secret exactly once, and lists only safe fields', async () => {
    const created = await app.inject({ method: 'POST', url: '/user/api-tokens', headers: asOwner(), payload: { label: 'my bot' } })
    expect(created.statusCode).toBe(200)
    const body = created.json()
    expect(body.token).toMatch(/^hdd_[0-9a-f]{64}$/)
    expect(body.tokenPrefix).toBe(body.token.slice(0, 12))
    expect(body.label).toBe('my bot')

    const listed = await app.inject({ url: '/user/api-tokens', headers: asOwner() })
    expect(listed.statusCode).toBe(200)
    const { tokens } = listed.json()
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ id: body.id, label: 'my bot', tokenPrefix: body.tokenPrefix, lastUsedAt: null })
    // The raw secret never appears in a listing.
    expect(JSON.stringify(tokens)).not.toContain(body.token)
  })

  it('caps active tokens per account and frees a slot on revoke', async () => {
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      const res = await app.inject({ method: 'POST', url: '/user/api-tokens', headers: asOwner(), payload: { label: `t${i}` } })
      expect(res.statusCode).toBe(200)
    }
    const over = await app.inject({ method: 'POST', url: '/user/api-tokens', headers: asOwner(), payload: {} })
    expect(over.statusCode).toBe(422)

    const first = (await app.inject({ url: '/user/api-tokens', headers: asOwner() })).json().tokens[0]
    expect((await app.inject({ method: 'DELETE', url: `/user/api-tokens/${first.id}`, headers: asOwner() })).statusCode).toBe(200)
    const again = await app.inject({ method: 'POST', url: '/user/api-tokens', headers: asOwner(), payload: {} })
    expect(again.statusCode).toBe(200)
  })

  it('tombstones on revoke and 404s a re-revoke, a foreign token, and a bad id', async () => {
    const created = (await app.inject({ method: 'POST', url: '/user/api-tokens', headers: asOwner(), payload: {} })).json()
    expect((await app.inject({ method: 'DELETE', url: `/user/api-tokens/${created.id}`, headers: asOwner() })).statusCode).toBe(200)
    expect(fake.tokens.get(created.id)).toMatchObject({ deleted: 1 })
    expect((await app.inject({ method: 'DELETE', url: `/user/api-tokens/${created.id}`, headers: asOwner() })).statusCode).toBe(404)

    const mine = (await app.inject({ method: 'POST', url: '/user/api-tokens', headers: asOwner(), payload: {} })).json()
    const otherSession = await issueSession(OTHER)
    const foreign = await app.inject({ method: 'DELETE', url: `/user/api-tokens/${mine.id}`, headers: { authorization: `Bearer ${otherSession}` } })
    expect(foreign.statusCode).toBe(404)

    expect((await app.inject({ method: 'DELETE', url: '/user/api-tokens/nope', headers: asOwner() })).statusCode).toBe(400)
  })

  it('requires a session', async () => {
    expect((await app.inject('/user/api-tokens')).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/user/api-tokens', payload: {} })).statusCode).toBe(401)
  })

  const mint = (headers = asOwner()) => app.inject({ method: 'POST', url: '/user/api-tokens', headers, payload: {} })

  it('mints for an account holding more than the minimum USD value', async () => {
    gate.valueUsd = 1.01
    expect((await mint()).statusCode).toBe(200)
    expect(vi.mocked(mintHoldingsUsd)).toHaveBeenCalledWith(OWNER)
    expect(fake.tokens.size).toBe(1)
  })

  it('refuses an account at or below the minimum, with its own reason code', async () => {
    for (const value of [1, 0.99, 0, -5]) {
      gate.valueUsd = value
      const refused = await mint()
      expect(refused.statusCode).toBe(403)
      expect(refused.json()).toEqual({
        error: 'Creating an API token needs an account holding more than $1 in total, counting every asset at current prices.',
        reason: 'insufficient-balance',
      })
    }
    expect(fake.tokens.size).toBe(0)
  })

  it('no longer counts an identity, a vote or HDX standing without value', async () => {
    gate.valueUsd = 0
    gate.facts = { hdx: 1_000n * 10n ** 12n, identity: true, voted: true, firstSeenMs: 0 }
    const refused = await mint()
    expect(refused.statusCode).toBe(403)
    expect(refused.json().reason).toBe('insufficient-balance')
    expect(fake.tokens.size).toBe(0)
  })

  it('exempts admins without reading their value', async () => {
    gate.valueUsd = 0
    expect((await mint(asAdmin())).statusCode).toBe(200)
    gate.valueUsd = new MintValuationUnavailable('prices are stale')
    expect((await mint(asAdmin())).statusCode).toBe(200)
    expect(vi.mocked(mintHoldingsUsd)).not.toHaveBeenCalled()
  })

  it('refuses, retryably, when the value cannot be computed', async () => {
    for (const failure of [new MintValuationUnavailable('prices are stale'), new Error('clickhouse down')]) {
      gate.valueUsd = failure
      const refused = await mint()
      expect(refused.statusCode).toBe(503)
      expect(refused.headers['retry-after']).toBe('30')
      expect(refused.json().reason).toBe('valuation-unavailable')
      // Nothing internal leaks into the answer.
      expect(JSON.stringify(refused.json())).not.toMatch(/clickhouse|stale/)
    }
    expect(fake.tokens.size).toBe(0)
  })

  it('reads the minimum from DATA_API_MIN_MINT_USD', async () => {
    process.env.DATA_API_MIN_MINT_USD = '25'
    initUserApiTokenService(fake.client)
    gate.valueUsd = 25
    const refused = await mint()
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error).toMatch(/more than \$25 in total/)
    gate.valueUsd = 25.5
    expect((await mint()).statusCode).toBe(200)
  })

  it('never lets parallel mints pass the cap', async () => {
    const results = await Promise.allSettled(Array.from({ length: MAX_ACTIVE_TOKENS + 5 }, () => createApiToken(OWNER, '')))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(MAX_ACTIVE_TOKENS)
    expect([...fake.tokens.values()].filter(row => row.account_id === OWNER && Number(row.deleted) === 0)).toHaveLength(MAX_ACTIVE_TOKENS)
  })
})

describe('mint gate valuation', () => {
  it('parses DATA_API_MIN_MINT_USD fail-closed', () => {
    expect(parseMinMintUsd(undefined)).toBe(1)
    expect(parseMinMintUsd(' ')).toBe(1)
    expect(parseMinMintUsd('2.5')).toBe(2.5)
    expect(parseMinMintUsd('0')).toBe(0)
    for (const bad of ['-1', 'one', '1e3', 'NaN', 'Infinity', '$1']) expect(() => parseMinMintUsd(bad)).toThrow(/DATA_API_MIN_MINT_USD/)
    process.env.DATA_API_MIN_MINT_USD = 'abc'
    expect(() => initUserApiTokenService(fake.client)).toThrow(/DATA_API_MIN_MINT_USD/)
  })

  it('nets money-market debt out of the gross value, as the account page does, except a custody position', () => {
    const market = (debtUsd: number, custody = false) => ({ totalDebtBase: String(Math.round(debtUsd * 1e8)), ...(custody ? { custody } : {}) })
    const detail = (portfolioUsd: number, markets: ReturnType<typeof market>[]) =>
      ({ portfolioUsd, moneyMarket: markets }) as unknown as Parameters<typeof netAccountValueUsd>[0]
    expect(netAccountValueUsd(detail(3, []))).toBe(3)
    expect(netAccountValueUsd(detail(1000, [market(600), market(399.5)]))).toBeCloseTo(0.5, 8)
    expect(netAccountValueUsd(detail(10, [market(50, true)]))).toBe(10)
  })
})

describe('ADMIN_ACCOUNT_IDS', () => {
  it('refuses a malformed entry instead of dropping it', () => {
    expect(parseAdminAccountIds(` ${ADMIN.toUpperCase().replace('0X', '0x')} , ,${OTHER}`)).toEqual(new Set([ADMIN, OTHER]))
    expect(() => parseAdminAccountIds(`${ADMIN},0x1234`)).toThrow(/ADMIN_ACCOUNT_IDS/)
    process.env.ADMIN_ACCOUNT_IDS = `${ADMIN},not-an-account`
    expect(() => initUserApiTokenService(fake.client)).toThrow(/ADMIN_ACCOUNT_IDS/)
  })
})

describe('admin surface', () => {
  it('is invisible (404) to a non-admin session', async () => {
    expect((await app.inject({ url: '/user/admin/api-users', headers: asOwner() })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PUT', url: `/user/admin/api-users/${OWNER}/limits`, headers: asOwner(), payload: { perMinute: 60, perDay: 100000 } })).statusCode).toBe(404)
  })

  it('lists API users with usage, defaults and overrides, sorted by 24h usage', async () => {
    await app.inject({ method: 'POST', url: '/user/api-tokens', headers: asOwner(), payload: { label: 'bot' } })
    const otherSession = await issueSession(OTHER)
    await app.inject({ method: 'POST', url: '/user/api-tokens', headers: { authorization: `Bearer ${otherSession}` }, payload: {} })
    fake.usage.push(
      { account_id: OWNER, r24: '5', j24: '1', r7: '50', r30: '500', last_hour: '2026-08-28 11:00:00' },
      { account_id: OTHER, r24: '9000', j24: '0', r7: '9000', r30: '9000', last_hour: '2026-08-28 12:00:00' },
    )
    await app.inject({ method: 'PUT', url: `/user/admin/api-users/${OTHER}/limits`, headers: asAdmin(), payload: { perMinute: 120, perDay: 500000, note: 'quant desk' } })

    const res = await app.inject({ url: '/user/admin/api-users', headers: asAdmin() })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.defaults).toEqual({ perMinute: 30, perDay: 20000 })
    expect(body.users).toHaveLength(2)
    expect(body.users[0].account.address ?? body.users[0].account).toBeTruthy()
    expect(body.users[0].usage.requests24h).toBe(9000)
    expect(body.users[0].limits).toMatchObject({ perMinute: 120, perDay: 500000, override: true, note: 'quant desk' })
    expect(body.users[1].limits).toMatchObject({ perMinute: 30, perDay: 20000, override: false })
  })

  it('validates and clears limit overrides', async () => {
    expect((await app.inject({ method: 'PUT', url: `/user/admin/api-users/${OWNER}/limits`, headers: asAdmin(), payload: { perMinute: 0, perDay: 100 } })).statusCode).toBe(422)
    expect((await app.inject({ method: 'PUT', url: `/user/admin/api-users/${OWNER}/limits`, headers: asAdmin(), payload: { perMinute: 60, perDay: 100000 } })).statusCode).toBe(200)
    expect(fake.limits.get(OWNER)).toMatchObject({ per_minute: 60, per_day: 100000, updated_by: ADMIN, deleted: 0 })
    expect((await app.inject({ method: 'DELETE', url: `/user/admin/api-users/${OWNER}/limits`, headers: asAdmin() })).statusCode).toBe(200)
    expect(fake.limits.get(OWNER)).toMatchObject({ deleted: 1 })
  })

  it('stores an override under the account a login resolves to', async () => {
    const h160 = '0x' + '33'.repeat(20)
    const bound = '0x' + '44'.repeat(32)
    initExplorerService(userFakeClient({ account_alias_directory: [{ evm: h160, account_id: bound }] }))
    await loadEvmBindings()
    expect((await app.inject({ method: 'PUT', url: `/user/admin/api-users/${h160}/limits`, headers: asAdmin(), payload: { perMinute: 60, perDay: 1000 } })).statusCode).toBe(200)
    expect(fake.limits.get(bound)).toMatchObject({ per_minute: 60, deleted: 0 })
    expect((await app.inject({ method: 'DELETE', url: `/user/admin/api-users/${h160}/limits`, headers: asAdmin() })).statusCode).toBe(200)
    expect(fake.limits.get(bound)).toMatchObject({ deleted: 1 })
    initExplorerService(userFakeClient())
    await loadEvmBindings()
  })

  it('lets an admin revoke anyone’s token', async () => {
    const created = (await app.inject({ method: 'POST', url: '/user/api-tokens', headers: asOwner(), payload: {} })).json()
    expect((await app.inject({ method: 'DELETE', url: `/user/admin/api-tokens/${created.id}`, headers: asAdmin() })).statusCode).toBe(200)
    expect(fake.tokens.get(created.id)).toMatchObject({ deleted: 1 })
  })
})
