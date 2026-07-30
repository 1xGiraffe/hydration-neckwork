import { createHash, randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { signatureVerify, keccakAsU8a, secp256k1Recover, ethereumEncode, cryptoWaitReady } from '@polkadot/util-crypto'
import { hexToU8a, u8aConcat, stringToU8a } from '@polkadot/util'
import type { ClickHouseClient } from '../db/client.ts'
import { normalizeAddress } from './addressIdentity.ts'

// Wallet login: the user proves control of an address by signing a plain-text
// statement (no transaction, no fee). Substrate extensions sign via signRaw
// (wrapping the payload in <Bytes>…</Bytes> — signatureVerify tries both forms);
// EVM wallets sign via personal_sign (EIP-191 prefix + keccak + secp256k1).

export interface LoginChallenge { nonce: string; message: string }

export function buildLoginMessage(host: string, address: string, ss58Polkadot: string, nonce: string, issuedAt: string): string {
  return [
    `${host} wants you to sign in`,
    '',
    'This signature only proves account ownership — no transaction is sent and no fee is paid.',
    '',
    `Address: ${address}`,
    `Account: ${ss58Polkadot}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
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

// One verifier for both worlds, keyed on the address SHAPE the wallet reported.
export function verifySignedLogin(message: string, address: string, signature: string): boolean {
  if (EVM_ADDR_RE.test(address)) {
    return evmRecoverAddress(message, signature) === address.toLowerCase()
  }
  try {
    return signatureVerify(message, signature, address).isValid
  } catch { return false }
}

// ---- nonce challenges (in-memory only: a lost nonce just means re-requesting
// a challenge, so a restart mid-login is a retry, not a failure mode) ----
interface PendingChallenge { accountId: string; address: string; message: string; expiresAt: number }
const NONCE_TTL_MS = 5 * 60_000
const pendingChallenges = new Map<string, PendingChallenge>()

// ---- sessions: raw token only ever exists client-side; the map and the table
// hold its sha256. 90-day sliding expiry, persisted at most hourly. Each
// session doubles as a "device" on the devices list: label/createdVia say what
// logged in and how ('wallet' signature or a scanned 'qr' handoff), so the
// owner can recognize and revoke it. ----
interface Session {
  accountId: string
  expiresAtMs: number
  lastPersistedMs: number
  label: string
  createdVia: string
  createdAtMs: number
  lastSeenMs: number
}
const SESSION_TTL_MS = 90 * 24 * 3600_000
const SESSION_PERSIST_EVERY_MS = 3600_000
const sessionsByHash = new Map<string, Session>()

let client: ClickHouseClient

export async function initUserAuthService(c: ClickHouseClient): Promise<void> {
  client = c
  await cryptoWaitReady()   // sr25519 verification is wasm-backed
}

export function resetUserAuthForTests(): void { pendingChallenges.clear(); sessionsByHash.clear() }
export function __sessionCountForTests(): number { return sessionsByHash.size }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const chDateTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

export function createChallenge(host: string, address: string): LoginChallenge | null {
  const n = normalizeAddress(address)
  if (!n) return null
  const nonce = randomBytes(16).toString('hex')
  const message = buildLoginMessage(host, address.trim(), n.ss58Polkadot ?? n.accountId, nonce, new Date().toISOString())
  // Cap the pending set so an unauthenticated client cannot grow it unboundedly
  // between sweeps (rate limiting bounds the rate; this bounds the total).
  if (pendingChallenges.size > 10_000) {
    const now = Date.now()
    for (const [k, v] of pendingChallenges) if (v.expiresAt < now) pendingChallenges.delete(k)
    if (pendingChallenges.size > 10_000) return null
  }
  pendingChallenges.set(nonce, { accountId: n.accountId, address: address.trim(), message, expiresAt: Date.now() + NONCE_TTL_MS })
  return { nonce, message }
}

export function verifyChallenge(nonce: string, address: string, signature: string): string | null {
  const pending = pendingChallenges.get(nonce)
  if (!pending) return null
  pendingChallenges.delete(nonce)   // single-use, burn before verifying
  if (pending.expiresAt < Date.now()) return null
  if (pending.address !== address.trim()) return null
  if (!verifySignedLogin(pending.message, pending.address, signature)) return null
  return pending.accountId
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
            WHERE deleted = 0 AND expires_at > now()`,
    format: 'JSONEachRow',
  })
  sessionsByHash.clear()
  const now = Date.now()
  const ms = (dt: string | undefined) => (dt ? Date.parse(`${dt.replace(' ', 'T')}Z`) : NaN)
  for (const r of await res.json<{ token_hash: string; account_id: string; expires_at: string; label?: string; created_via?: string; created_at?: string; last_seen?: string }>()) {
    // ClickHouse DateTime comes back as 'YYYY-MM-DD HH:MM:SS' (UTC); the WHERE
    // clause already excludes expired rows server-side, but re-check locally
    // too so a clock-skewed or stubbed source can never resurrect a dead session.
    const expiresAtMs = ms(r.expires_at)
    if (expiresAtMs > now) {
      sessionsByHash.set(r.token_hash, {
        accountId: r.account_id, expiresAtMs, lastPersistedMs: now,
        label: r.label ?? '', createdVia: r.created_via || 'wallet',
        createdAtMs: ms(r.created_at) || now, lastSeenMs: ms(r.last_seen) || now,
      })
    }
  }
}

async function persistSession(hash: string, s: Session, deleted = 0): Promise<void> {
  await client.insert({
    table: 'price_data.user_sessions',
    values: [{
      token_hash: hash, account_id: s.accountId, expires_at: chDateTime(s.expiresAtMs),
      // created_at is written explicitly: ReplacingMergeTree keeps the whole
      // newest row, so relying on the column DEFAULT would reset the creation
      // time on every hourly refresh.
      label: s.label, created_via: s.createdVia, created_at: chDateTime(s.createdAtMs),
      last_seen: chDateTime(s.lastSeenMs), deleted,
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
  if (!s) return null
  const now = Date.now()
  if (s.expiresAtMs < now) { sessionsByHash.delete(hash); return null }
  // Sliding expiry: refresh the window, persist at most hourly (fire-and-forget:
  // an unpersisted slide only costs an earlier re-login after a restart).
  s.expiresAtMs = now + SESSION_TTL_MS
  s.lastSeenMs = now
  if (now - s.lastPersistedMs > SESSION_PERSIST_EVERY_MS) {
    s.lastPersistedMs = now
    void persistSession(hash, s).catch(() => {})
  }
  return s.accountId
}

export async function revokeSession(token: string): Promise<void> {
  const hash = sha256(token)
  const s = sessionsByHash.get(hash)
  sessionsByHash.delete(hash)
  if (s) await persistSession(hash, s, 1)
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
    if (s.accountId !== accountId || s.expiresAtMs < now) continue
    out.push({
      id: hash, label: s.label, createdVia: s.createdVia,
      createdAt: chDateTime(s.createdAtMs), lastSeen: chDateTime(s.lastSeenMs),
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
  sessionsByHash.delete(hash)
  await persistSession(hash, s, 1)
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

// Route guard: resolves the bearer token or answers 401 itself. Callers bail on null.
export function requireUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const auth = req.headers.authorization
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  const accountId = token ? sessionAccount(token) : null
  if (!accountId) { void reply.status(401).send({ error: 'Not logged in' }) }
  return accountId
}
