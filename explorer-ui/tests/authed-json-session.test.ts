import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userApi } from '../src/api/explorer'
import { getSession, setSession } from '../src/session'

// jsdom/happy-dom aren't project dependencies — stand in a minimal Storage the
// same way session.test.ts does.
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

function stub401() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })))
}

const EXISTING = { token: 't'.repeat(64), accountId: '0x' + 'aa'.repeat(32), address: '15Existing' }

describe('authedJson only clears the session a 401 actually belongs to', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); setSession(EXISTING) })
  afterEach(() => vi.unstubAllGlobals())

  it('a 401 from /user/auth/verify (e.g. a bad signature during an account switch) does not clear the still-valid existing session', async () => {
    stub401()
    await expect(userApi.verify('15NewSigner', 'nonce', '0xbadsig')).rejects.toMatchObject({ status: 401 })
    expect(getSession()).toEqual(EXISTING)
  })

  it('a 401 from /user/auth/challenge does not clear the existing session either', async () => {
    stub401()
    await expect(userApi.challenge('15NewSigner')).rejects.toMatchObject({ status: 401 })
    expect(getSession()).toEqual(EXISTING)
  })

  it('a 401 from an authenticated endpoint (/user/me) clears the session', async () => {
    stub401()
    await expect(userApi.me()).rejects.toMatchObject({ status: 401 })
    expect(getSession()).toBeNull()
  })

  it('a 401 with no session token attached is a no-op either way', async () => {
    setSession(null)
    stub401()
    await expect(userApi.me()).rejects.toMatchObject({ status: 401 })
    expect(getSession()).toBeNull()
  })
})
