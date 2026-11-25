import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { signatureVerify, keccakAsU8a, secp256k1Recover, ethereumEncode, cryptoWaitReady, blake2AsU8a } from '@polkadot/util-crypto'
import { hexToU8a, u8aConcat, stringToU8a, u8aWrapBytes } from '@polkadot/util'
import type { ClickHouseClient } from '../db/client.ts'
import { normalizeAddress } from './addressIdentity.ts'
import { chTimestampMs } from './clickhouseTime.ts'

// Wallet login: the user proves control of an address by signing a plain-text
// statement (no transaction, no fee). Substrate extensions sign via signRaw
// (wrapping the payload in <Bytes>…</Bytes> — signatureVerify tries both forms);
// EVM wallets sign via personal_sign (EIP-191 prefix + keccak + secp256k1).

export interface LoginChallenge { nonce: string; message: string }

// The statement a wallet shows before signing. Human-readable and bound to everything
// a phishing page would want to blur: the domain the person should see in their
// address bar, what the signature is for, the exact account, a single-use nonce and
// the moment it stops being accepted.
export function buildLoginMessage(host: string, address: string, ss58Polkadot: string, nonce: string, issuedAt: string, expiresAt?: string): string {
  return [
    `${host} wants you to sign in`,
    '',
    `Purpose: sign in to the Hydration Explorer at ${host} (governance forum, lists, notifications).`,
    'This signature only proves account ownership — no transaction is sent and no fee is paid.',
    '',
    `Address: ${address}`,
    `Account: ${ss58Polkadot}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    ...(expiresAt ? [`Expires At: ${expiresAt}`] : []),
  ].join('\n')
}

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/

// personal_sign recovery: hash the EIP-191 envelope, recover the secp256k1
// pubkey from the 65-byte r||s||v signature, derive the H160. Wallets emit
// v = 27/28; a raw secp256k1 signer emits 0/1 — accept both.
//
// secp256k1Recover's `hashType` only picks the OUTPUT pubkey encoding
// (compressed 33 bytes vs. an "expanded" 64-byte X||Y with no 0x04 prefix,
// which ethereumEncode rejects); it never re-hashes `msgHash`. We already
// pass the correct final digest, so omit hashType and get the compressed
// form that ethereumEncode accepts directly.
export function evmRecoverAddress(message: string, signature: string): string | null {
  let sig: Uint8Array
  try { sig = hexToU8a(signature) } catch { return null }
  if (sig.length !== 65) return null
  const v = sig[64]
  const recovery = v >= 27 ? v - 27 : v
  if (recovery !== 0 && recovery !== 1) return null
  const msgBytes = stringToU8a(message)
  const hash = keccakAsU8a(u8aConcat(stringToU8a(`\x19Ethereum Signed Message:\n${msgBytes.length}`), msgBytes))
  try {
    const pubkey = secp256k1Recover(hash, sig.subarray(0, 64), recovery)
    return ethereumEncode(pubkey).toLowerCase()
  } catch { return null }
}

// A hardware signer does not sign a long payload as-is. The Substrate signing
// convention every Ledger app implements is: a payload longer than 256 bytes is
// blake2-256 hashed first and the 32-byte DIGEST is what the device signs — the
// same rule ExtrinsicPayload applies to transactions, extended to raw messages
// because the device cannot buffer or display more than that.
//
// Our login statement is ~353 bytes once the extension has wrapped it in
// <Bytes>…</Bytes>, so it is ALWAYS over the threshold: through Talisman (or
// any extension) with a Ledger running the Polkadot app, the signature that
// comes back is over the digest, a preimage signatureVerify never tries. Every
// hardware-wallet login therefore failed with "Signature verification failed",
// deterministically, while every software wallet worked.
//
// Accepting the digest adds no forgery surface: it is a value only computable
// from the exact statement we issued, so a signature over it proves the same
// thing a signature over the bytes does. Both the wrapped and unwrapped forms
// are offered because the wrapping is the extension's, not the device's, and a
// signer that hashes what IT was handed may have been handed either.
//
// What it does weaken is what the person SEES. A signature over the digest is
// accepted from any signer, not only a hardware one, and a digest is 32 opaque
// bytes: a page that requests a challenge for someone's address can ask their
// wallet to sign that digest directly (signRaw of a 32-byte hex payload, which
// wallets show as hex, or a device asked to sign a raw hash), and the person
// approves a blob that never names this domain, the purpose or the expiry —
// yet the signature logs that page in as them. The readable statement protects
// only people whose wallet showed it; the digest path relies on them refusing
// to sign hex they cannot read. The challenge is still single-use, bound to
// one address and expires, so a captured signature is good for one login
// within NONCE_TTL_MS.
const HARDWARE_DIGEST_OVER_BYTES = 256

function loginPayloads(message: string): Uint8Array[] {
  const raw = stringToU8a(message)
  // signatureVerify itself already retries `u8aWrapBytes(raw)`, so the plain
  // and <Bytes>-wrapped forms are both covered by the first entry.
  const payloads: Uint8Array[] = [raw]
  const wrapped = u8aWrapBytes(raw)
  if (wrapped.length > HARDWARE_DIGEST_OVER_BYTES) payloads.push(blake2AsU8a(wrapped, 256))
  if (raw.length > HARDWARE_DIGEST_OVER_BYTES) payloads.push(blake2AsU8a(raw, 256))
  return payloads
}

// One verifier for both worlds, keyed on the address SHAPE the wallet reported.
export function verifySignedLogin(message: string, address: string, signature: string): boolean {
  if (EVM_ADDR_RE.test(address)) {
    return evmRecoverAddress(message, signature) === address.toLowerCase()
  }
  return loginPayloads(message).some(payload => {
    try {
      return signatureVerify(payload, signature, address).isValid
    } catch { return false }
  })
}

// ---- nonce challenges (in-memory only: a lost nonce just means re-requesting
// a challenge, so a restart mid-login is a retry, not a failure mode — but only
// because the 'no-challenge' branch below SAYS so. If every branch read
// "Signature verification failed", an api restart would be indistinguishable
// from a broken wallet and would silently eat a login.) ----
interface PendingChallenge { accountId: string; address: string; message: string; expiresAt: number; client: string }
// Long enough to cover a hardware signer: plugging a Ledger in, unlocking it,
// opening the Polkadot app and confirming does not fit in the five minutes this
// used to allow, and overrunning it produced the same misleading
// "Signature verification failed" as a genuinely bad signature. A challenge is
// single-use and bound to one address, so the only cost of the longer window is
// a slightly larger pending set, which is capped below.
export const NONCE_TTL_MS = 15 * 60_000
// The pending set is bounded twice, and neither bound ever refuses a login:
// one client (an IPv4 address, or an IPv6 /64 — see challengeClientKey) holds at
// most MAX_PENDING_PER_CLIENT challenges, its own oldest giving way to a new
// one, and when the whole set is full the oldest challenge anyone holds gives
// way. Refusing at a full set would let a few clients that keep it full block
// every login; evicting means they can only shorten how long an unsigned
// challenge survives, and filling the set needs MAX_PENDING_CHALLENGES /
// MAX_PENDING_PER_CLIENT distinct clients. An evicted challenge reads as
// 'no-challenge' ("no longer valid — please try again").
const MAX_PENDING_CHALLENGES = 10_000
const MAX_PENDING_PER_CLIENT = 10
// Insertion order is issue order, so the first key is always the oldest.
const pendingChallenges = new Map<string, PendingChallenge>()
const pendingByClient = new Map<string, string[]>()

// ---- sessions: raw token only ever exists client-side; the map and the table
// hold its sha256. 90-day sliding expiry, persisted at most hourly, and never
// past 365 days from creation however active the session stays. Each
// session doubles as a "device" on the devices list: label/createdVia say what
// logged in and how ('wallet' signature or a scanned 'qr' handoff), so the
// owner can recognize and revoke it.
//
// A revocation is final. The table is a ReplacingMergeTree keyed on the token
// hash, so a live row written after the revocation row would bring the session
// back at the next load. Three things prevent that: a revoking session writes
// no further expiry refreshes and waits for one already in flight before its
// revocation row is written (so that row is the newest); the revocation is
// persisted BEFORE the session leaves memory, and a failed write fails the
// request instead of reporting a sign-out that a restart would undo; and the
// load skips any token hash that has a revocation row at all. ----
interface Session {
  accountId: string
  expiresAtMs: number
  lastPersistedMs: number
  label: string
  createdVia: string
  createdAtMs: number
  lastSeenMs: number
  revoked?: boolean
  persisting?: Promise<void>
}
const SESSION_TTL_MS = 90 * 24 * 3600_000
export const SESSION_MAX_LIFETIME_MS = 365 * 24 * 3600_000
const SESSION_PERSIST_EVERY_MS = 3600_000
const slidExpiry = (s: Session, now: number) => Math.min(now + SESSION_TTL_MS, s.createdAtMs + SESSION_MAX_LIFETIME_MS)
const sessionsByHash = new Map<string, Session>()

let client: ClickHouseClient

export async function initUserAuthService(c: ClickHouseClient): Promise<void> {
  client = c
  await cryptoWaitReady()   // sr25519 verification is wasm-backed
}

export function resetUserAuthForTests(): void { pendingChallenges.clear(); pendingByClient.clear(); sessionsByHash.clear() }
export function __pendingChallengeCountForTests(): number { return pendingChallenges.size }
export function __sessionCountForTests(): number { return sessionsByHash.size }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// The client a challenge is counted against: the IPv4 address, or the /64 an
// IPv6 address sits in (one subscriber line usually holds a whole /64, so
// keying on the full address would hand a single client unlimited keys). An
// IPv4-mapped IPv6 address counts as its IPv4. Also the login limiter's key.
export function challengeClientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]
  if (isIP(ip) !== 6) return ip
  const halves = ip.toLowerCase().split('%')[0].split('::')
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`
}

function dropChallenge(nonce: string): void {
  const pending = pendingChallenges.get(nonce)
  if (!pending) return
  pendingChallenges.delete(nonce)
  const queue = pendingByClient.get(pending.client)
  if (!queue) return
  const at = queue.indexOf(nonce)
  if (at >= 0) queue.splice(at, 1)
  if (!queue.length) pendingByClient.delete(pending.client)
}

export function createChallenge(host: string, address: string, client = ''): LoginChallenge | null {
  const n = normalizeAddress(address)
  if (!n) return null
  const nonce = randomBytes(16).toString('hex')
  const issued = Date.now()
  const message = buildLoginMessage(host, address.trim(), n.ss58Polkadot ?? n.accountId, nonce, new Date(issued).toISOString(), new Date(issued + NONCE_TTL_MS).toISOString())
  while ((pendingByClient.get(client)?.length ?? 0) >= MAX_PENDING_PER_CLIENT) dropChallenge(pendingByClient.get(client)![0])
  if (pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
    for (const [k, v] of pendingChallenges) if (v.expiresAt < issued) dropChallenge(k)
    while (pendingChallenges.size >= MAX_PENDING_CHALLENGES) dropChallenge(pendingChallenges.keys().next().value!)
  }
  pendingChallenges.set(nonce, { accountId: n.accountId, address: address.trim(), message, expiresAt: issued + NONCE_TTL_MS, client })
  const queue = pendingByClient.get(client)
  if (queue) queue.push(nonce)
  else pendingByClient.set(client, [nonce])
  return { nonce, message }
}

// Four different things end a login here and only ONE of them is a signature
// problem. Collapsing them into a single "Signature verification failed" sent
// people to debug their wallet over a server event (an api restart drops the
// map above; a slow hardware confirmation ages the challenge out) and left us
// with nothing to read afterwards. The reason is returned so the route can say
// something true and log which branch it took.
export type LoginFailureReason = 'no-challenge' | 'expired' | 'address-mismatch' | 'bad-signature'
export type ChallengeResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: LoginFailureReason }

export function verifyChallenge(nonce: string, address: string, signature: string): ChallengeResult {
  const pending = pendingChallenges.get(nonce)
  if (!pending) return { ok: false, reason: 'no-challenge' }
  dropChallenge(nonce)   // single-use, burn before verifying
  if (pending.expiresAt < Date.now()) return { ok: false, reason: 'expired' }
  if (pending.address !== address.trim()) return { ok: false, reason: 'address-mismatch' }
  if (!verifySignedLogin(pending.message, pending.address, signature)) return { ok: false, reason: 'bad-signature' }
  return { ok: true, accountId: pending.accountId }
}

// What the person is told, per branch. Only 'bad-signature' is about their
// signature; the other three are "ask for a fresh challenge and sign again",
// which is what the dialog's Retry already does.
export function loginFailureMessage(reason: LoginFailureReason): string {
  switch (reason) {
    case 'no-challenge': return 'This login request is no longer valid — please try again'
    case 'expired': return 'This login request expired — please try again'
    case 'address-mismatch': return 'This login request was issued for a different account — please try again'
    case 'bad-signature': return 'Signature verification failed'
  }
}

// Shape of what the wallet actually handed us, for the failure log. Nothing
// here is secret — the signature was rejected, and the address is public chain
// data — but it is the whole difference between diagnosing the next report in
// one attempt and reproducing it blind.
export function describeLoginSignature(signature: string): { sigBytes: number; sigPrefix: number | null } {
  try {
    const u8a = hexToU8a(signature)
    return { sigBytes: u8a.length, sigPrefix: u8a.length ? u8a[0] : null }
  } catch { return { sigBytes: -1, sigPrefix: null } }
}

// Same additive-column guard as ensureTagMemberPositionColumn (see its comment
// in userListService.ts): `CREATE TABLE IF NOT EXISTS` never re-runs against a
// deployed database, so the device-metadata columns added to the user_sessions
// declaration need this to reach databases created before them. Metadata-only,
// safe to run unconditionally on every start, before loadUserSessions() first
// SELECTs the columns.
export async function ensureSessionDeviceColumns(c: ClickHouseClient): Promise<void> {
  await c.command({ query: `ALTER TABLE price_data.user_sessions ADD COLUMN IF NOT EXISTS label String DEFAULT '' AFTER expires_at` })
  await c.command({ query: `ALTER TABLE price_data.user_sessions ADD COLUMN IF NOT EXISTS created_via LowCardinality(String) DEFAULT 'wallet' AFTER label` })
}

export async function loadUserSessions(): Promise<void> {
  const res = await client.query({
    query: `SELECT token_hash, account_id, expires_at, label, created_via, created_at, last_seen
            FROM price_data.user_sessions FINAL
            WHERE deleted = 0 AND expires_at > now()
              AND created_at > now() - INTERVAL ${SESSION_MAX_LIFETIME_MS / 86_400_000} DAY
              AND token_hash NOT IN (SELECT token_hash FROM price_data.user_sessions WHERE deleted = 1)`,
    format: 'JSONEachRow',
  })
  sessionsByHash.clear()
  const now = Date.now()
  const ms = (dt: string | undefined) => (dt ? Date.parse(`${dt.replace(' ', 'T')}Z`) : NaN)
  for (const r of await res.json<{ token_hash: string; account_id: string; expires_at: string; label?: string; created_via?: string; created_at?: string; last_seen?: string }>()) {
    // ClickHouse DateTime comes back as 'YYYY-MM-DD HH:MM:SS' (UTC); the WHERE
    // clause already excludes expired rows server-side, but re-check locally
    // too so a clock-skewed or stubbed source can never resurrect a dead session.
    const createdAtMs = ms(r.created_at) || now
    const expiresAtMs = Math.min(ms(r.expires_at), createdAtMs + SESSION_MAX_LIFETIME_MS)
    if (expiresAtMs > now) {
      sessionsByHash.set(r.token_hash, {
        accountId: r.account_id, expiresAtMs, lastPersistedMs: now,
        label: r.label ?? '', createdVia: r.created_via || 'wallet',
        createdAtMs, lastSeenMs: ms(r.last_seen) || now,
      })
    }
  }
}

async function persistSession(hash: string, s: Session, deleted = 0): Promise<void> {
  await client.insert({
    table: 'price_data.user_sessions',
    values: [{
      token_hash: hash, account_id: s.accountId, expires_at: chTimestampMs(s.expiresAtMs),
      // created_at is written explicitly: ReplacingMergeTree keeps the whole
      // newest row, so relying on the column DEFAULT would reset the creation
      // time on every hourly refresh.
      label: s.label, created_via: s.createdVia, created_at: chTimestampMs(s.createdAtMs),
      last_seen: chTimestampMs(s.lastSeenMs), deleted,
    }],
    format: 'JSONEachRow',
  })
}

export async function issueSession(accountId: string, meta?: { label?: string; via?: string }): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const hash = sha256(token)
  const now = Date.now()
  const session: Session = {
    accountId, expiresAtMs: now + SESSION_TTL_MS, lastPersistedMs: now,
    label: meta?.label ?? '', createdVia: meta?.via ?? 'wallet', createdAtMs: now, lastSeenMs: now,
  }
  sessionsByHash.set(hash, session)
  await persistSession(hash, session)
  return token
}

export function sessionAccount(token: string): string | null {
  const hash = sha256(token)
  const s = sessionsByHash.get(hash)
  if (!s || s.revoked) return null
  const now = Date.now()
  if (s.expiresAtMs < now) { sessionsByHash.delete(hash); return null }
  // Sliding expiry: refresh the window (capped by the absolute lifetime),
  // persist at most hourly (fire-and-forget: an unpersisted slide only costs an
  // earlier re-login after a restart). The write is remembered so a revocation
  // can wait for it.
  s.expiresAtMs = slidExpiry(s, now)
  s.lastSeenMs = now
  if (now - s.lastPersistedMs > SESSION_PERSIST_EVERY_MS) {
    s.lastPersistedMs = now
    s.persisting = persistSession(hash, s).catch(() => {})
  }
  return s.accountId
}

// Throws when the revocation could not be persisted; the session then stays
// usable, exactly as the table would bring it back after a restart.
async function revokeStoredSession(hash: string, s: Session): Promise<void> {
  s.revoked = true
  await s.persisting
  try {
    await persistSession(hash, s, 1)
  } catch (err) {
    s.revoked = false
    throw err
  }
  sessionsByHash.delete(hash)
}

export async function revokeSession(token: string): Promise<void> {
  const hash = sha256(token)
  const s = sessionsByHash.get(hash)
  if (s) await revokeStoredSession(hash, s)
}

// The devices list: every live session of this account, newest activity first.
// `id` is the token hash — irreversible, so exposing it to its own account is
// safe, and it is exactly the handle revokeSessionByHash needs back.
export interface SessionInfo { id: string; label: string; createdVia: string; createdAt: string; lastSeen: string; current: boolean }

export function listSessions(accountId: string, currentToken: string): SessionInfo[] {
  const currentHash = sha256(currentToken)
  const now = Date.now()
  const out: SessionInfo[] = []
  for (const [hash, s] of sessionsByHash) {
    if (s.accountId !== accountId || s.revoked || s.expiresAtMs < now) continue
    out.push({
      id: hash, label: s.label, createdVia: s.createdVia,
      createdAt: chTimestampMs(s.createdAtMs), lastSeen: chTimestampMs(s.lastSeenMs),
      current: hash === currentHash,
    })
  }
  return out.sort((a, b) => (a.current !== b.current ? (a.current ? -1 : 1) : b.lastSeen.localeCompare(a.lastSeen)))
}

// Revoke by token hash — the handle the devices list hands out — but only for
// a session the caller's own account holds.
export async function revokeSessionByHash(accountId: string, hash: string): Promise<boolean> {
  const s = sessionsByHash.get(hash)
  if (!s || s.accountId !== accountId) return false
  await revokeStoredSession(hash, s)
  return true
}

// A recognizable "what logged in here" for the devices list, derived once at
// session creation from the User-Agent. Best-effort: unmatched agents get ''
// and the UI shows its own placeholder.
export function deviceLabelFromUserAgent(ua: string | undefined): string {
  if (!ua) return ''
  const os = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPod/i.test(ua) ? 'iPhone'
    : /iPad/i.test(ua) ? 'iPad'
    : /Windows/i.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(ua) ? 'macOS'
    : /CrOS/i.test(ua) ? 'ChromeOS'
    : /Linux/i.test(ua) ? 'Linux' : ''
  const browser = /Firefox\/|FxiOS\//i.test(ua) ? 'Firefox'
    : /Edg(e|A|iOS)?\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /SamsungBrowser\//i.test(ua) ? 'Samsung Internet'
    : /Chrome\/|CriOS\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) ? 'Safari' : ''
  if (!browser) return os
  return os ? `${browser} on ${os}` : browser
}

// The session a request already authenticated, so the handler behind a
// plugin-wide auth hook reads it without re-hashing the bearer token or
// sliding the expiry a second time.
const requestAccounts = new WeakMap<FastifyRequest, string>()

// Route guard: resolves the bearer token or answers 401 itself. Callers bail on null.
export function requireUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const resolved = requestAccounts.get(req)
  if (resolved) return resolved
  const auth = req.headers.authorization
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  const accountId = token ? sessionAccount(token) : null
  if (!accountId) { void reply.status(401).send({ error: 'Not logged in' }) }
  else requestAccounts.set(req, accountId)
  return accountId
}

// The account the private-route hook already authenticated. An absent one means
// the hook is not registered on this plugin — a wiring bug, not a request error.
export function sessionUser(req: FastifyRequest): string {
  const accountId = requestAccounts.get(req)
  if (!accountId) throw new Error('private route reached without the session hook')
  return accountId
}
