import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userApi } from '../src/api/explorer'
import { setSession } from '../src/session'

// The seven Data-API control-plane calls: each must hit its exact method +
// path with the session bearer attached — the api routes are owner-scoped on
// that header, so a drifted URL or a missing token turns into a silent 401,
// not a type error. Same fetch-stub idiom as authed-json-session.test.ts.

function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  }
}

const SESSION = { token: 't'.repeat(64), accountId: '0x' + 'aa'.repeat(32), address: '15Someone' }

let calls: { url: string; method: string; auth: string | undefined; body: unknown }[]

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  setSession(SESSION)
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: headers.authorization,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => vi.unstubAllGlobals())

const TOKEN_HASH = 'ab'.repeat(32)
const ACCOUNT = '0x' + 'cd'.repeat(32)

describe('userApi Data-API token calls', () => {
  it('lists, creates and revokes the session account’s tokens', async () => {
    await userApi.apiTokens()
    await userApi.createApiToken('my bot')
    await userApi.revokeApiToken(TOKEN_HASH)
    expect(calls.map(c => [c.method, c.url])).toEqual([
      ['GET', '/api/user/api-tokens'],
      ['POST', '/api/user/api-tokens'],
      ['DELETE', `/api/user/api-tokens/${TOKEN_HASH}`],
    ])
    expect(calls[1].body).toEqual({ label: 'my bot' })
    for (const call of calls) expect(call.auth).toBe(`Bearer ${SESSION.token}`)
  })

  it('drives the admin surface with the account id in the path', async () => {
    await userApi.apiUsers()
    await userApi.setApiUserLimits(ACCOUNT, { perMinute: 120, perDay: 500000, note: 'quant desk' })
    await userApi.clearApiUserLimits(ACCOUNT)
    await userApi.adminRevokeApiToken(TOKEN_HASH)
    expect(calls.map(c => [c.method, c.url])).toEqual([
      ['GET', '/api/user/admin/api-users'],
      ['PUT', `/api/user/admin/api-users/${ACCOUNT}/limits`],
      ['DELETE', `/api/user/admin/api-users/${ACCOUNT}/limits`],
      ['DELETE', `/api/user/admin/api-tokens/${TOKEN_HASH}`],
    ])
    expect(calls[1].body).toEqual({ perMinute: 120, perDay: 500000, note: 'quant desk' })
  })
})
