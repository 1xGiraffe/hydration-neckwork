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
// v = 27/28; raw libraries emit 0/1 — accept both.
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
// hold its sha256. 90-day sliding expiry, persisted at most hourly. ----
interface Session { accountId: string; expiresAtMs: number; lastPersistedMs: number }
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

export async function loadUserSessions(): Promise<void> {
  const res = await client.query({
    query: `SELECT token_hash, account_id, expires_at
            FROM price_data.user_sessions FINAL
            WHERE deleted = 0 AND expires_at > now()`,
    format: 'JSONEachRow',
  })
  sessionsByHash.clear()
  const now = Date.now()
  for (const r of await res.json<{ token_hash: string; account_id: string; expires_at: string }>()) {
    // ClickHouse DateTime comes back as 'YYYY-MM-DD HH:MM:SS' (UTC); the WHERE
    // clause already excludes expired rows server-side, but re-check locally
    // too so a clock-skewed or stubbed source can never resurrect a dead session.
    const expiresAtMs = Date.parse(`${r.expires_at.replace(' ', 'T')}Z`)
    if (expiresAtMs > now) sessionsByHash.set(r.token_hash, { accountId: r.account_id, expiresAtMs, lastPersistedMs: now })
  }
}

async function persistSession(hash: string, s: Session, deleted = 0): Promise<void> {
  await client.insert({
    table: 'price_data.user_sessions',
    values: [{ token_hash: hash, account_id: s.accountId, expires_at: chDateTime(s.expiresAtMs), last_seen: chDateTime(Date.now()), deleted }],
    format: 'JSONEachRow',
  })
}

export async function issueSession(accountId: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const hash = sha256(token)
  const session: Session = { accountId, expiresAtMs: Date.now() + SESSION_TTL_MS, lastPersistedMs: Date.now() }
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

// Route guard: resolves the bearer token or answers 401 itself. Callers bail on null.
export function requireUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const auth = req.headers.authorization
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  const accountId = token ? sessionAccount(token) : null
  if (!accountId) { void reply.status(401).send({ error: 'Not logged in' }) }
  return accountId
}
