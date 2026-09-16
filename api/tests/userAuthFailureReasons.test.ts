import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import {
  cryptoWaitReady, sr25519PairFromSeed, sr25519Sign, ed25519PairFromSeed, ed25519Sign,
  encodeAddress, randomAsU8a, blake2AsU8a,
} from '@polkadot/util-crypto'
import { u8aToHex, u8aWrapBytes, u8aConcat, stringToU8a } from '@polkadot/util'
import { userRoutes } from '../src/routes/user.ts'
import {
  initUserAuthService, resetUserAuthForTests, createChallenge, verifyChallenge, NONCE_TTL_MS,
  buildLoginMessage, verifySignedLogin,
} from '../src/services/userAuthService.ts'
import { initUserListService, loadUserLists } from '../src/services/userListService.ts'
import { fakeClient } from './helpers/userFakes.ts'

beforeAll(async () => { await cryptoWaitReady() })

function wallet() {
  const pair = sr25519PairFromSeed(randomAsU8a(32))
  return { pair, address: encodeAddress(pair.publicKey, 0) }
}
const sign = (pair: ReturnType<typeof wallet>['pair'], message: string) => u8aToHex(sr25519Sign(u8aWrapBytes(message), pair))

// A Ledger running the Polkadot app does not sign a long payload as-is: the
// Substrate signing convention every Ledger app implements is that anything
// over 256 bytes is blake2-256 hashed first and the 32-byte DIGEST is what the
// device signs. Our login statement is ~353 bytes once the extension has
// wrapped it in <Bytes>…</Bytes>, so through Talisman + Ledger + the Polkadot
// app the signature is always over the digest — a preimage the verifier never
// tried, which is why every hardware login failed. Ledger is ed25519 and the
// signature comes back as a 65-byte MultiSignature (0x00 prefix + 64 bytes).
const LEDGER_HASH_OVER_BYTES = 256
function ledger(seed = randomAsU8a(32)) {
  const pair = ed25519PairFromSeed(seed)
  return {
    address: encodeAddress(pair.publicKey, 0),
    sign(message: string, opts: { multiSignaturePrefix?: boolean } = {}) {
      const wrapped = u8aWrapBytes(message)
      const payload = wrapped.length > LEDGER_HASH_OVER_BYTES ? blake2AsU8a(wrapped, 256) : wrapped
      const sig = ed25519Sign(payload, pair)
      return u8aToHex(opts.multiSignaturePrefix === false ? sig : u8aConcat(new Uint8Array([0]), sig))
    },
  }
}
const REAL_LOGIN_MESSAGE = buildLoginMessage(
  'hydration-explorer.neckwork.net',
  '5DvUjH6Awi3tKCn3YaxM76jHLCCgDSMzNmPHCUhwrhH44eRv',
  '12rmscMEoVKMkjnZWE1MFFZSBpCKujv8TG7mMmhJQnJaFGMA',
  'a'.repeat(32),
  '2026-09-16T10:17:12.345Z',
)

describe('a hardware wallet signs the digest of a long login statement', () => {
  it('the real login statement is over the 256-byte threshold, so this path is always taken', () => {
    // Pins the premise. If the statement ever shrinks below the threshold a
    // Ledger signs it verbatim instead — still accepted below, but this test
    // is what says which branch production is actually on.
    expect(stringToU8a(REAL_LOGIN_MESSAGE).length).toBeGreaterThan(LEDGER_HASH_OVER_BYTES)
    expect(u8aWrapBytes(REAL_LOGIN_MESSAGE).length).toBeGreaterThan(LEDGER_HASH_OVER_BYTES)
  })

  it('accepts a Ledger signature over the blake2-256 digest of the wrapped statement', () => {
    const l = ledger()
    const msg = buildLoginMessage('hydration-explorer.neckwork.net', l.address, l.address, 'b'.repeat(32), '2026-09-16T10:17:12.345Z')
    expect(verifySignedLogin(msg, l.address, l.sign(msg))).toBe(true)
  })

  it('accepts it without the MultiSignature prefix too', () => {
    const l = ledger()
    const msg = buildLoginMessage('hydration-explorer.neckwork.net', l.address, l.address, 'c'.repeat(32), '2026-09-16T10:17:12.345Z')
    expect(verifySignedLogin(msg, l.address, l.sign(msg, { multiSignaturePrefix: false }))).toBe(true)
  })

  it('still rejects a digest signature from a DIFFERENT key', () => {
    const l = ledger()
    const other = ledger()
    const msg = buildLoginMessage('hydration-explorer.neckwork.net', l.address, l.address, 'd'.repeat(32), '2026-09-16T10:17:12.345Z')
    expect(verifySignedLogin(msg, l.address, other.sign(msg))).toBe(false)
  })

  it('still rejects a digest signature over a DIFFERENT statement', () => {
    const l = ledger()
    const msg = buildLoginMessage('hydration-explorer.neckwork.net', l.address, l.address, 'e'.repeat(32), '2026-09-16T10:17:12.345Z')
    const otherMsg = buildLoginMessage('hydration-explorer.neckwork.net', l.address, l.address, 'f'.repeat(32), '2026-09-16T10:17:12.345Z')
    expect(verifySignedLogin(msg, l.address, l.sign(otherMsg))).toBe(false)
  })

  it('a software wallet signing the statement verbatim still verifies', () => {
    const w = wallet()
    const msg = buildLoginMessage('hydration-explorer.neckwork.net', w.address, w.address, 'g'.repeat(32), '2026-09-16T10:17:12.345Z')
    expect(verifySignedLogin(msg, w.address, sign(w.pair, msg))).toBe(true)
  })
})

async function build() {
  const f = Fastify()
  await f.register(userRoutes)
  return f
}

// A login that fails is reported to the person with ONE sentence, so that
// sentence has to be true. Four different things end a login here — the
// challenge was never issued (or the api restarted and lost it), it aged out,
// the address changed under it, or the signature really is wrong — and only
// the last one is a signature problem. Saying "Signature verification failed"
// for the other three sends the person to debug their wallet over a server
// event, which is exactly what happened on 2026-09-16.
describe('verifyChallenge tells the four failures apart', () => {
  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(fakeClient())
    initUserListService(fakeClient())
    await loadUserLists()
  })
  afterEach(() => { vi.useRealTimers() })

  it('reports a nonce it has never seen as a lost challenge, not a bad signature', () => {
    const w = wallet()
    const r = verifyChallenge('f'.repeat(32), w.address, '0x' + '00'.repeat(64))
    expect(r).toEqual({ ok: false, reason: 'no-challenge' })
  })

  it('reports an aged-out challenge as expired', () => {
    vi.useFakeTimers()
    const w = wallet()
    const c = createChallenge('h', w.address)!
    vi.advanceTimersByTime(NONCE_TTL_MS + 1000)
    expect(verifyChallenge(c.nonce, w.address, sign(w.pair, c.message))).toEqual({ ok: false, reason: 'expired' })
  })

  it('reports a challenge redeemed for a different address as a mismatch', () => {
    const a = wallet()
    const b = wallet()
    const c = createChallenge('h', a.address)!
    expect(verifyChallenge(c.nonce, b.address, sign(a.pair, c.message))).toEqual({ ok: false, reason: 'address-mismatch' })
  })

  it('reports a signature from the wrong key as a bad signature', () => {
    const a = wallet()
    const other = wallet()
    const c = createChallenge('h', a.address)!
    expect(verifyChallenge(c.nonce, a.address, sign(other.pair, c.message))).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('still accepts the real thing', () => {
    const w = wallet()
    const c = createChallenge('h', w.address)!
    const r = verifyChallenge(c.nonce, w.address, sign(w.pair, c.message))
    expect(r.ok).toBe(true)
    expect(r.ok && r.accountId).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('stays single-use: a challenge is burned whether or not it verified', () => {
    const w = wallet()
    const ok = createChallenge('h', w.address)!
    expect(verifyChallenge(ok.nonce, w.address, sign(w.pair, ok.message)).ok).toBe(true)
    expect(verifyChallenge(ok.nonce, w.address, sign(w.pair, ok.message))).toEqual({ ok: false, reason: 'no-challenge' })
    // Burned before verifying, so a rejected attempt cannot be hammered either.
    const bad = createChallenge('h', w.address)!
    expect(verifyChallenge(bad.nonce, w.address, '0x' + '00'.repeat(64))).toEqual({ ok: false, reason: 'bad-signature' })
    expect(verifyChallenge(bad.nonce, w.address, sign(w.pair, bad.message))).toEqual({ ok: false, reason: 'no-challenge' })
  })
})

describe('/user/auth/verify surfaces the reason', () => {
  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(fakeClient())
    initUserListService(fakeClient())
    await loadUserLists()
  })

  it('does not blame the signature for a challenge the server no longer has', async () => {
    const f = await build()
    const w = wallet()
    const r = await f.inject({
      method: 'POST', url: '/user/auth/verify',
      payload: { address: w.address, nonce: 'f'.repeat(32), signature: '0x' + '00'.repeat(64) },
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().error).not.toMatch(/signature/i)
    expect(r.json().error).toMatch(/again/i)
  })

  it('still says signature verification failed when the signature is the problem', async () => {
    const f = await build()
    const w = wallet()
    const other = wallet()
    const ch = await f.inject({ method: 'POST', url: '/user/auth/challenge', payload: { address: w.address } })
    const { nonce, message } = ch.json()
    const r = await f.inject({
      method: 'POST', url: '/user/auth/verify',
      payload: { address: w.address, nonce, signature: sign(other.pair, message) },
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().error).toBe('Signature verification failed')
  })
})
