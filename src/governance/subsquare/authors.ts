import { decodeAddress } from '@polkadot/util-crypto'
import { u8aToHex } from '@polkadot/util'
import type { SsAuthor } from './parse.js'

// An imported author → our identity key: the canonical lower-case AccountId32 hex
// (0x + 64), the join key every other table uses. The same forms as the api's
// `normalizeAddress` (api/src/services/addressIdentity.ts): an EVM H160 is the
// runtime's truncated form `0x45544800 ‖ h160 ‖ 0×8`, a pallet/sovereign H160
// (modl/sibl/para prefix) its real account, padded with zeros.

const EVM_MARKER = '45544800'
const ZERO16 = '0000000000000000'
const RESERVED_H160_PREFIXES = ['6d6f646c', '7369626c', '70617261']

export function evmAccountId(h160NoPrefix: string): string {
  const h = h160NoPrefix.toLowerCase()
  if (RESERVED_H160_PREFIXES.some(p => h.startsWith(p))) return '0x' + h + '000000000000000000000000'
  return '0x' + EVM_MARKER + h + ZERO16
}

/** Any address form Subsquare writes (SS58 of any prefix, 0x AccountId32, 0x H160) → account id, or null. */
export function accountIdOfAddress(address: string): string | null {
  const a = address.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return evmAccountId(a.slice(2))
  if (/^0x[0-9a-fA-F]{64}$/.test(a)) return a.toLowerCase()
  try {
    const bytes = decodeAddress(a)
    if (bytes.length === 32) return u8aToHex(bytes).toLowerCase()
    if (bytes.length === 20) return evmAccountId(u8aToHex(bytes).slice(2))
  } catch { /* not an address */ }
  return null
}

export type AuthorKey =
  | { ok: true; accountId: string; legacyName: string }
  | { ok: false; reason: 'address-mismatch' | 'unresolvable' }

/**
 * `publicKey` decides; `address` is a cross-check only — when the two disagree the
 * item is not imported (a warning names the reason, never the author). An author with
 * neither is a legacy (email-only) user, named by username alone. A SIMA item carries
 * no author object, only the signing `proposer` address.
 */
export function authorKey(author: SsAuthor | null, proposer: string | null = null): AuthorKey {
  if (!author) {
    if (!proposer) return { ok: true, accountId: '', legacyName: '' }
    const id = accountIdOfAddress(proposer)
    return id ? { ok: true, accountId: id, legacyName: '' } : { ok: false, reason: 'unresolvable' }
  }
  let fromKey: string | null = null
  if (author.publicKey) {
    // Hex only: a 64-character key is an AccountId32, a 40-character one an H160;
    // anything else (or any non-hex character) is not a key.
    const k = author.publicKey.toLowerCase().replace(/^0x/, '')
    fromKey = /^[0-9a-f]{64}$/.test(k) ? '0x' + k : /^[0-9a-f]{40}$/.test(k) ? evmAccountId(k) : null
    if (!fromKey) return { ok: false, reason: 'unresolvable' }
  }
  const fromAddress = author.address ? accountIdOfAddress(author.address) : null
  if (author.address && !fromAddress) return { ok: false, reason: 'unresolvable' }
  if (fromKey && fromAddress && fromKey !== fromAddress) return { ok: false, reason: 'address-mismatch' }
  const id = fromKey ?? fromAddress
  if (id) return { ok: true, accountId: id, legacyName: '' }
  // Address-less: a legacy email/password account. Its username is shown as-is, unlinked.
  return author.username ? { ok: true, accountId: '', legacyName: author.username } : { ok: false, reason: 'unresolvable' }
}

/** A poll voter's id (`legacy:<name>` for an address-less account), or null when it cannot be stated. */
export function voterActor(user: SsAuthor | null): string | null {
  const key = authorKey(user)
  if (!key.ok) return null
  if (key.accountId) return key.accountId
  return key.legacyName ? `legacy:${key.legacyName}` : null
}
