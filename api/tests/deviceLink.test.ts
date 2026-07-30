import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { cryptoWaitReady, sr25519PairFromSeed, sr25519Sign, encodeAddress, randomAsU8a } from '@polkadot/util-crypto'
import { u8aToHex, u8aWrapBytes } from '@polkadot/util'
import { userRoutes } from '../src/routes/user.ts'
import {
  initUserAuthService, resetUserAuthForTests, issueSession, sessionAccount,
  listSessions, revokeSessionByHash, deviceLabelFromUserAgent,
} from '../src/services/userAuthService.ts'
import { createDeviceLink, claimDeviceLink, deviceLinkStatus, resetDeviceLinksForTests } from '../src/services/deviceLinkService.ts'
import { initUserListService, loadUserLists } from '../src/services/userListService.ts'
import { fakeClient, insertedRows } from './helpers/userFakes.ts'

beforeAll(async () => { await cryptoWaitReady() })

const ACCOUNT = '0x' + 'ab'.repeat(32)

describe('device-link codes', () => {
  beforeEach(async () => {
    resetUserAuthForTests(); resetDeviceLinksForTests()
    await initUserAuthService(fakeClient())
  })
  afterEach(() => { vi.useRealTimers() })

  it('claims a code exactly once', () => {
    const link = createDeviceLink(ACCOUNT)!
    expect(link.code).toMatch(/^[0-9a-f]{64}$/)
    expect(deviceLinkStatus(link.linkId, ACCOUNT)).toBe('pending')
    expect(claimDeviceLink(link.code)).toBe(ACCOUNT)
    expect(deviceLinkStatus(link.linkId, ACCOUNT)).toBe('claimed')
    // single-use: a replayed QR/screenshot is rejected
    expect(claimDeviceLink(link.code)).toBeNull()
  })

  it('rejects an unknown code and an expired code', () => {
    expect(claimDeviceLink('0'.repeat(64))).toBeNull()
    vi.useFakeTimers()
    const link = createDeviceLink(ACCOUNT)!
    vi.setSystemTime(Date.now() + 3 * 60_000 + 1)
    expect(claimDeviceLink(link.code)).toBeNull()
    expect(deviceLinkStatus(link.linkId, ACCOUNT)).toBe('expired')
  })

  it('only the issuing account can observe a link', () => {
    const link = createDeviceLink(ACCOUNT)!
    expect(deviceLinkStatus(link.linkId, '0x' + 'cd'.repeat(32))).toBe('expired')
    expect(deviceLinkStatus('not-a-link-id', ACCOUNT)).toBe('expired')
  })
})

describe('session listing and revocation', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => {
    client = fakeClient(); resetUserAuthForTests()
    await initUserAuthService(client)
  })

  it('lists sessions with device metadata and marks the caller current', async () => {
    const desktop = await issueSession(ACCOUNT, { label: 'Chrome on Linux', via: 'wallet' })
    const phone = await issueSession(ACCOUNT, { label: 'Chrome on Android', via: 'qr' })
    await issueSession('0x' + 'cd'.repeat(32), { label: 'someone else', via: 'wallet' })
    const sessions = listSessions(ACCOUNT, desktop)
    expect(sessions).toHaveLength(2)
    expect(sessions[0].current).toBe(true)
    expect(sessions[0].label).toBe('Chrome on Linux')
    const other = sessions.find(s => !s.current)!
    expect(other.createdVia).toBe('qr')
    expect(other.id).not.toContain(phone)   // token hash, never the raw token
  })

  it('revokes only own sessions, and only by a known hash', async () => {
    const desktop = await issueSession(ACCOUNT, { label: '', via: 'wallet' })
    const phone = await issueSession(ACCOUNT, { label: '', via: 'qr' })
    const phoneHash = listSessions(ACCOUNT, desktop).find(s => !s.current)!.id
    expect(await revokeSessionByHash('0x' + 'cd'.repeat(32), phoneHash)).toBe(false)
    expect(sessionAccount(phone)).toBe(ACCOUNT)
    expect(await revokeSessionByHash(ACCOUNT, phoneHash)).toBe(true)
    expect(sessionAccount(phone)).toBeNull()
    expect(await revokeSessionByHash(ACCOUNT, phoneHash)).toBe(false)
    const tombstone = insertedRows(client, 'user_sessions').at(-1)!
    expect(tombstone.deleted).toBe(1)
    expect(tombstone.created_via).toBe('qr')
  })
})

describe('device-link routes', () => {
  beforeEach(async () => {
    resetUserAuthForTests(); resetDeviceLinksForTests()
    await initUserAuthService(fakeClient())
    initUserListService(fakeClient())
    await loadUserLists()
  })

  async function build() {
    const f = Fastify()
    await f.register(userRoutes)
    return f
  }

  async function login(f: Awaited<ReturnType<typeof build>>) {
    const pair = sr25519PairFromSeed(randomAsU8a(32))
    const address = encodeAddress(pair.publicKey, 0)
    const ch = await f.inject({ method: 'POST', url: '/user/auth/challenge', payload: { address } })
    const { nonce, message } = ch.json()
    const signature = u8aToHex(sr25519Sign(u8aWrapBytes(message), pair))
    const v = await f.inject({ method: 'POST', url: '/user/auth/verify', payload: { address, nonce, signature } })
    return v.json() as { token: string; me: { account: { accountId: string } } }
  }

  it('hands a login to a second device and shows it on the devices list', async () => {
    const f = await build()
    const { token, me } = await login(f)

    const issue = await f.inject({ method: 'POST', url: '/user/auth/device-link', headers: { authorization: `Bearer ${token}` } })
    expect(issue.statusCode).toBe(200)
    const { code, linkId } = issue.json()

    const pending = await f.inject({ method: 'GET', url: `/user/auth/device-link/${linkId}`, headers: { authorization: `Bearer ${token}` } })
    expect(pending.json().status).toBe('pending')

    // the "phone": no auth header, only the code
    const claim = await f.inject({ method: 'POST', url: '/user/auth/device-link/claim', payload: { code }, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 15) Chrome/126.0 Mobile Safari/537.36' } })
    expect(claim.statusCode).toBe(200)
    const phone = claim.json()
    expect(phone.me.account.accountId).toBe(me.account.accountId)
    expect(phone.token).not.toBe(token)

    const claimed = await f.inject({ method: 'GET', url: `/user/auth/device-link/${linkId}`, headers: { authorization: `Bearer ${token}` } })
    expect(claimed.json().status).toBe('claimed')

    // replay is rejected without touching the phone's fresh session
    const replay = await f.inject({ method: 'POST', url: '/user/auth/device-link/claim', payload: { code } })
    expect(replay.statusCode).toBe(401)

    const sessions = (await f.inject({ method: 'GET', url: '/user/sessions', headers: { authorization: `Bearer ${token}` } })).json().sessions
    expect(sessions).toHaveLength(2)
    const phoneRow = sessions.find((s: { current: boolean }) => !s.current)
    expect(phoneRow.createdVia).toBe('qr')
    expect(phoneRow.label).toBe('Chrome on Android')

    // revoke the phone from the desktop: its token stops working
    const del = await f.inject({ method: 'DELETE', url: `/user/sessions/${phoneRow.id}`, headers: { authorization: `Bearer ${token}` } })
    expect(del.statusCode).toBe(200)
    const dead = await f.inject({ method: 'GET', url: '/user/me', headers: { authorization: `Bearer ${phone.token}` } })
    expect(dead.statusCode).toBe(401)
  })

  it('requires auth to issue, validates the claim body, and 404s foreign hashes', async () => {
    const f = await build()
    const anon = await f.inject({ method: 'POST', url: '/user/auth/device-link' })
    expect(anon.statusCode).toBe(401)
    const bad = await f.inject({ method: 'POST', url: '/user/auth/device-link/claim', payload: { code: 'nope' } })
    expect(bad.statusCode).toBe(400)
    const { token } = await login(f)
    const foreign = await f.inject({ method: 'DELETE', url: '/user/sessions/deadbeef', headers: { authorization: `Bearer ${token}` } })
    expect(foreign.statusCode).toBe(404)
  })
})

describe('deviceLabelFromUserAgent', () => {
  it('names common browser/OS pairs and degrades to empty', () => {
    expect(deviceLabelFromUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36')).toBe('Chrome on Android')
    expect(deviceLabelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone')
    expect(deviceLabelFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0')).toBe('Edge on Windows')
    expect(deviceLabelFromUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0')).toBe('Firefox on Linux')
    expect(deviceLabelFromUserAgent(undefined)).toBe('')
    expect(deviceLabelFromUserAgent('curl/8.5.0')).toBe('')
  })
})
