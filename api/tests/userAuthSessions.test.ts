import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { cryptoWaitReady, sr25519PairFromSeed, sr25519Sign, encodeAddress, randomAsU8a } from '@polkadot/util-crypto'
import { u8aToHex, u8aWrapBytes } from '@polkadot/util'
import { normalizeAddress } from '../src/services/addressIdentity.ts'
import {
  initUserAuthService, resetUserAuthForTests, createChallenge, verifyChallenge,
  loadUserSessions, issueSession, sessionAccount, revokeSession,
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
    expect(verifyChallenge(ch.nonce, address, sig)).toBe(accountId)
    // single-use: the same nonce cannot log in twice
    expect(verifyChallenge(ch.nonce, address, sig)).toBeNull()
  })

  it('rejects an unknown nonce, a wrong address, and a bad signature', () => {
    const { pair, address } = pairAndAddress()
    const other = pairAndAddress()
    const ch = createChallenge('h', address)!
    const sig = u8aToHex(sr25519Sign(u8aWrapBytes(ch.message), pair))
    expect(verifyChallenge('f'.repeat(32), address, sig)).toBeNull()
    expect(verifyChallenge(ch.nonce, other.address, sig)).toBeNull()
    const ch2 = createChallenge('h', address)!
    expect(verifyChallenge(ch2.nonce, address, u8aToHex(sr25519Sign(u8aWrapBytes('tampered'), pair)))).toBeNull()
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
