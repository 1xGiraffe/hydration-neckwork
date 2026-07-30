import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getSession, setSession, SESSION_STORAGE_KEY } from '../src/session'

// jsdom/happy-dom aren't project dependencies, so there is no ambient
// `localStorage` under the default Node test environment. Stand one in with
// the same Storage surface session.ts reads/writes, backed by a plain Map —
// mirrors the existing `vi.stubGlobal('fetch', …)` pattern used elsewhere for
// browser globals the Node environment doesn't provide.
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

describe('session store', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); setSession(null) })

  it('persists and restores a session', () => {
    setSession({ token: 't'.repeat(64), accountId: '0x' + 'ab'.repeat(32), address: '15Da…' })
    expect(getSession()?.accountId).toBe('0x' + 'ab'.repeat(32))
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!).token).toBe('t'.repeat(64))
    setSession(null)
    expect(getSession()).toBeNull()
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })

  it('ignores malformed persisted values', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, '{broken')
    // module reads defensively — a fresh get must not throw
    expect(() => getSession()).not.toThrow()
  })
})
