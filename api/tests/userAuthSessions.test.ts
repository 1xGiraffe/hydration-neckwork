import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { cryptoWaitReady, sr25519PairFromSeed, sr25519Sign, encodeAddress, randomAsU8a } from '@polkadot/util-crypto'
import { u8aToHex, u8aWrapBytes } from '@polkadot/util'
import { normalizeAddress } from '../src/services/addressIdentity.ts'
import {
  initUserAuthService, resetUserAuthForTests, createChallenge, verifyChallenge,
  loadUserSessions, issueSession, sessionAccount, revokeSession, SESSION_MAX_LIFETIME_MS,
} from '../src/services/userAuthService.ts'
import { fakeClient, insertedRows } from './helpers/userFakes.ts'

beforeAll(async () => { await cryptoWaitReady() })

function pairAndAddress() {
  const pair = sr25519PairFromSeed(randomAsU8a(32))
  const address = encodeAddress(pair.publicKey, 0)
  return { pair, address, accountId: normalizeAddress(address)!.accountId }
}

describe('challenge → verify', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); resetUserAuthForTests(); await initUserAuthService(client) })

  it('logs in with a signed challenge and burns the nonce', () => {
    const { pair, address, accountId } = pairAndAddress()
    const ch = createChallenge('h', address)!
    const sig = u8aToHex(sr25519Sign(u8aWrapBytes(ch.message), pair))
    expect(verifyChallenge(ch.nonce, address, sig)).toEqual({ ok: true, accountId })
    // single-use: the same nonce cannot log in twice
    expect(verifyChallenge(ch.nonce, address, sig)).toEqual({ ok: false, reason: 'no-challenge' })
  })

  it('rejects an unknown nonce, a wrong address, and a bad signature', () => {
    const { pair, address } = pairAndAddress()
    const other = pairAndAddress()
    const ch = createChallenge('h', address)!
    const sig = u8aToHex(sr25519Sign(u8aWrapBytes(ch.message), pair))
    expect(verifyChallenge('f'.repeat(32), address, sig)).toEqual({ ok: false, reason: 'no-challenge' })
    expect(verifyChallenge(ch.nonce, other.address, sig)).toEqual({ ok: false, reason: 'address-mismatch' })
    const ch2 = createChallenge('h', address)!
    expect(verifyChallenge(ch2.nonce, address, u8aToHex(sr25519Sign(u8aWrapBytes('tampered'), pair)))).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('rejects an unparseable address at challenge time', () => {
    expect(createChallenge('h', 'not-an-address')).toBeNull()
  })
})

describe('sessions', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); resetUserAuthForTests(); await initUserAuthService(client) })

  it('issues a token, resolves it, persists only its hash, and revokes it', async () => {
    const token = await issueSession('0x' + 'ab'.repeat(32))
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(sessionAccount(token)).toBe('0x' + 'ab'.repeat(32))
    const rows = insertedRows(client, 'user_sessions')
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).not.toContain(token)   // sha256, never the raw token
    expect(rows[0].account_id).toBe('0x' + 'ab'.repeat(32))
    await revokeSession(token)
    expect(sessionAccount(token)).toBeNull()
    expect(insertedRows(client, 'user_sessions')).toHaveLength(2)
    expect(insertedRows(client, 'user_sessions')[1].deleted).toBe(1)
  })

  it('loads persisted sessions at boot and honors expiry', async () => {
    const past = '2020-01-01 00:00:00', future = '2099-01-01 00:00:00'
    const restore = fakeClient({ user_sessions: [
      { token_hash: 'live', account_id: '0x' + '11'.repeat(32), expires_at: future },
      { token_hash: 'dead', account_id: '0x' + '22'.repeat(32), expires_at: past },
    ] })
    resetUserAuthForTests(); await initUserAuthService(restore); await loadUserSessions()
    // sessionAccount takes the RAW token; poke the internal map via a raw token
    // whose hash we control is impossible — so loadUserSessions is asserted
    // through its observable: an expired row never resolves. Use the test hook:
    expect(sessionAccount('anything')).toBeNull()
    const { __sessionCountForTests } = await import('../src/services/userAuthService.ts')
    expect(__sessionCountForTests()).toBe(1)
  })
})

// A revoked session must stay revoked across a restart. user_sessions is a
// ReplacingMergeTree on the token hash, so any live row that lands after the
// revocation row would bring the session back at the next load.
describe('session revocation is final', () => {
  const ACCOUNT = '0x' + 'ab'.repeat(32)
  afterEach(() => { vi.useRealTimers() })

  // A client whose inserts can be held open or made to fail, one at a time.
  function controllableClient() {
    const rows: Record<string, unknown>[] = []
    const gates: Array<() => void> = []
    let hold = false
    let failNext = false
    const client = {
      query: async () => ({ json: async () => [] }),
      insert: async ({ values }: { values: Record<string, unknown>[] }) => {
        if (failNext) { failNext = false; throw new Error('insert failed') }
        if (hold) {
          hold = false
          await new Promise<void>(resolve => gates.push(resolve))
        }
        rows.push(...values)
      },
      close: async () => {},
    }
    return {
      client: client as unknown as Parameters<typeof initUserAuthService>[0],
      rows,
      holdNext: () => { hold = true },
      failNext: () => { failNext = true },
      release: () => gates.shift()?.(),
    }
  }

  it('keeps the session and fails when the revocation cannot be persisted', async () => {
    const c = controllableClient()
    resetUserAuthForTests(); await initUserAuthService(c.client)
    const token = await issueSession(ACCOUNT)
    c.failNext()
    await expect(revokeSession(token)).rejects.toThrow()
    expect(sessionAccount(token)).toBe(ACCOUNT)
    await revokeSession(token)
    expect(sessionAccount(token)).toBeNull()
    expect(c.rows.at(-1)!.deleted).toBe(1)
  })

  it('writes the revocation after an expiry refresh already in flight, and no refresh after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const c = controllableClient()
    resetUserAuthForTests(); await initUserAuthService(c.client)
    const token = await issueSession(ACCOUNT)
    vi.setSystemTime(Date.now() + 2 * 3600_000)
    c.holdNext()
    expect(sessionAccount(token)).toBe(ACCOUNT)   // starts the hourly refresh, held open
    const revoking = revokeSession(token)
    // Revoking: the session no longer authenticates, and no new refresh starts.
    vi.setSystemTime(Date.now() + 2 * 3600_000)
    expect(sessionAccount(token)).toBeNull()
    await Promise.resolve()
    expect(c.rows).toHaveLength(1)                // only the issue row so far
    c.release()
    await revoking
    expect(c.rows.map(r => r.deleted)).toEqual([0, 0, 1])
  })

  it('never loads a token hash that has a revocation row, even under a newer live row', async () => {
    const future = '2099-01-01 00:00:00'
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const stored = [
      { token_hash: 'revoked', account_id: ACCOUNT, expires_at: future, created_at: now, deleted: 1, updated_at: 1 },
      { token_hash: 'revoked', account_id: ACCOUNT, expires_at: future, created_at: now, deleted: 0, updated_at: 2 },
      { token_hash: 'live', account_id: ACCOUNT, expires_at: future, created_at: now, deleted: 0, updated_at: 1 },
    ]
    // FINAL keeps the newest row per hash; the revocation guard applies only if
    // the query actually carries it.
    const client = {
      query: async ({ query }: { query: string }) => ({
        json: async () => {
          const newest = new Map<string, typeof stored[number]>()
          for (const r of stored) if ((newest.get(r.token_hash)?.updated_at ?? -1) < r.updated_at) newest.set(r.token_hash, r)
          const everRevoked = new Set(stored.filter(r => r.deleted === 1).map(r => r.token_hash))
          const guarded = /token_hash NOT IN \(SELECT token_hash FROM price_data\.user_sessions WHERE deleted = 1\)/.test(query)
          return [...newest.values()].filter(r => r.deleted === 0 && !(guarded && everRevoked.has(r.token_hash)))
        },
      }),
      insert: async () => {},
      close: async () => {},
    } as unknown as Parameters<typeof initUserAuthService>[0]
    resetUserAuthForTests(); await initUserAuthService(client); await loadUserSessions()
    const { __sessionCountForTests } = await import('../src/services/userAuthService.ts')
    expect(__sessionCountForTests()).toBe(1)
  })
})

describe('absolute session lifetime', () => {
  afterEach(() => { vi.useRealTimers() })

  it('ends an active session 365 days after it was created', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    resetUserAuthForTests(); await initUserAuthService(fakeClient())
    const start = Date.now()
    const token = await issueSession('0x' + 'cd'.repeat(32))
    // Used every 30 days, the sliding window alone would never end it.
    for (let day = 30; day < 365; day += 30) {
      vi.setSystemTime(start + day * 86_400_000)
      expect(sessionAccount(token)).toBe('0x' + 'cd'.repeat(32))
    }
    vi.setSystemTime(start + SESSION_MAX_LIFETIME_MS + 1000)
    expect(sessionAccount(token)).toBeNull()
  })

  it('does not load a stored session past its lifetime, whatever its expiry says', async () => {
    const old = new Date(Date.now() - SESSION_MAX_LIFETIME_MS - 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    const restore = fakeClient({ user_sessions: [
      { token_hash: 'aged', account_id: '0x' + '11'.repeat(32), expires_at: '2099-01-01 00:00:00', created_at: old },
    ] })
    resetUserAuthForTests(); await initUserAuthService(restore); await loadUserSessions()
    const { __sessionCountForTests } = await import('../src/services/userAuthService.ts')
    expect(__sessionCountForTests()).toBe(0)
  })
})
