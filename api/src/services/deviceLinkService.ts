import { createHash, randomBytes, randomUUID } from 'node:crypto'

// QR device-link handoff: a logged-in device mints a short-lived, single-use
// code; scanning it on another device claims the code and gets its own session
// for the same account. Codes live in memory only, like login nonces — a lost
// code just means showing a fresh QR, so an api restart mid-handoff is a retry,
// not a failure mode. Only the code's sha256 is ever held; the raw code exists
// client-side (inside the QR) alone. The separate linkId exists so the issuing
// device can poll for "claimed" without ever re-sending the code itself.
interface DeviceLink { linkId: string; accountId: string; expiresAtMs: number; claimed: boolean }

const LINK_TTL_MS = 3 * 60_000
const linksByCodeHash = new Map<string, DeviceLink>()
const codeHashByLinkId = new Map<string, string>()

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function resetDeviceLinksForTests(): void { linksByCodeHash.clear(); codeHashByLinkId.clear() }

// Claimed entries are kept until expiry so the issuer's status poll can still
// see 'claimed'; the sweep drops everything whose window has passed.
function sweep(): void {
  const now = Date.now()
  for (const [hash, link] of linksByCodeHash) {
    if (link.expiresAtMs < now) {
      linksByCodeHash.delete(hash)
      codeHashByLinkId.delete(link.linkId)
    }
  }
}

export function createDeviceLink(accountId: string): { code: string; linkId: string; expiresAt: string } | null {
  sweep()
  // Issuing requires a session, so this cap only guards against a runaway
  // authed client; it bounds the total, rate limiting bounds the rate.
  if (linksByCodeHash.size >= 1000) return null
  const code = randomBytes(32).toString('hex')
  const linkId = randomUUID()
  const expiresAtMs = Date.now() + LINK_TTL_MS
  linksByCodeHash.set(sha256(code), { linkId, accountId, expiresAtMs, claimed: false })
  codeHashByLinkId.set(linkId, sha256(code))
  return { code, linkId, expiresAt: new Date(expiresAtMs).toISOString() }
}

// Single-use: the first valid claim flips `claimed`; every later attempt —
// replayed QR screenshot, shoulder-surfed code — is rejected.
export function claimDeviceLink(code: string): string | null {
  const link = linksByCodeHash.get(sha256(code))
  if (!link || link.claimed || link.expiresAtMs < Date.now()) return null
  link.claimed = true
  return link.accountId
}

// Only the issuing account may observe a link's progress. Unknown and expired
// collapse to 'expired' on purpose: after the sweep they are the same thing.
export function deviceLinkStatus(linkId: string, accountId: string): 'pending' | 'claimed' | 'expired' {
  const hash = codeHashByLinkId.get(linkId)
  const link = hash ? linksByCodeHash.get(hash) : undefined
  if (!link || link.accountId !== accountId || (!link.claimed && link.expiresAtMs < Date.now())) return 'expired'
  return link.claimed ? 'claimed' : 'pending'
}
