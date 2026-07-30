import type { Runtime } from '@subsquid/substrate-runtime'
import type { IdentityChain } from './identityChains.js'

// Decoding and resolution for the Identity pallet, shared by every configured
// chain. The pallet ships in two shapes and both are live:
//
//   v1 (Hydration)      info = { additional, display, legal, web, riot, email, … }
//                       IdentityOf = Registration
//   v2 (People chains)  info = { display, legal, web, matrix, email, image,
//                                twitter, github, discord }
//                       IdentityOf = Registration, or [Registration, Option<Username>]
//                       on the runtimes that carried the username inline
//
// Only display/email/web/twitter are read, and those four exist in both shapes,
// so one decoder covers every chain — including any chain added later.

export interface IdentityRegistration {
  display: string
  verified: boolean
  email: string
  web: string
  twitter: string
}

export interface SubIdentity {
  parent: string
  name: string
}

// One chain's Identity storage, read at a single anchor block.
export interface ChainIdentityState {
  registrations: Map<string, IdentityRegistration>  // Identity.IdentityOf
  subs: Map<string, SubIdentity>                    // Identity.SuperOf
  usernames: Map<string, string>                    // Identity.UsernameOf
}

export interface AccountIdentityRow {
  chain: string
  account_id: string
  display: string
  verified: number
  email: string
  web: string
  twitter: string
  priority: number
  updated_at: string
}

// AccountId32 storage keys decode to a 0x-hex string or raw bytes depending on the
// runtime type; normalise to lowercase 0x + 64 hex (the account_id form used by the
// rest of the pipeline).
export function toAccountId(key: unknown): string | null {
  const raw = Array.isArray(key) ? key[0] : key
  let hex: string | null = null
  if (raw instanceof Uint8Array) hex = Buffer.from(raw).toString('hex')
  else if (typeof raw === 'string') hex = raw.startsWith('0x') ? raw.slice(2) : raw
  if (hex == null || !/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return `0x${hex.toLowerCase()}`
}

export function bytesToUtf8(value: unknown): string {
  let bytes: Uint8Array | null = null
  if (value instanceof Uint8Array) bytes = value
  else if (typeof value === 'string') {
    if (!value.startsWith('0x')) return value.replace(/\0+$/, '').trim()
    try { bytes = Uint8Array.from(Buffer.from(value.slice(2), 'hex')) } catch { return '' }
  }
  if (bytes == null) return ''
  try { return Buffer.from(bytes).toString('utf8').replace(/\0+$/, '').trim() } catch { return '' }
}

// Identity `Data` enum -> string. Human-readable variants are None and Raw/RawN
// (inline bytes); hashed variants (Sha256, Keccak256, …) aren't display text.
export function dataToString(data: unknown): string {
  if (data == null) return ''
  if (typeof data === 'string') return data.startsWith('0x') ? bytesToUtf8(data) : data
  if (data instanceof Uint8Array) return bytesToUtf8(data)
  const d = data as { __kind?: string; value?: unknown }
  const kind = d.__kind
  if (!kind || kind === 'None') return ''
  if (kind === 'Raw' || /^Raw\d+$/.test(kind)) return bytesToUtf8(d.value)
  return ''
}

// Registration value may be `Registration` or, on identity v2, `[Registration, Option<Username>]`.
function registrationOf(value: unknown): { info?: Record<string, unknown>; judgements?: unknown[] } | null {
  const reg = Array.isArray(value) ? value[0] : value
  if (reg == null || typeof reg !== 'object') return null
  return reg as { info?: Record<string, unknown>; judgements?: unknown[] }
}

// A registrar's judgement is the only thing that makes an identity "verified".
// A username is an allocation, not a judgement, so it never sets this flag.
export function isVerified(judgements: unknown): boolean {
  if (!Array.isArray(judgements)) return false
  for (const entry of judgements) {
    // Each entry is [registrarIndex, Judgement]; Judgement is a {__kind} enum.
    const judgement = Array.isArray(entry) ? entry[1] : entry
    const kind = (judgement as { __kind?: string } | null)?.__kind
    if (kind === 'KnownGood' || kind === 'Reasonable') return true
  }
  return false
}

export function registrationFrom(value: unknown): IdentityRegistration | null {
  const reg = registrationOf(value)
  const info = reg?.info
  if (info == null) return null
  return {
    display: dataToString(info.display),
    verified: isVerified(reg?.judgements),
    email: dataToString(info.email),
    web: dataToString(info.web),
    twitter: dataToString(info.twitter),
  }
}

// Identity.SuperOf value is [parentAccountId, Data] — the parent and the sub's own
// name suffix.
export function subIdentityFrom(value: unknown): SubIdentity | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const parent = toAccountId(value[0])
  const name = dataToString(value[1])
  return parent && name ? { parent, name } : null
}

// Identity.UsernameOf value is the primary username's raw bytes (e.g. "alice.dot").
export function usernameFrom(value: unknown): string {
  return bytesToUtf8(typeof value === 'string' || value instanceof Uint8Array ? value : null)
}

// One display name per account, per chain, in falling order of authority:
//
//   1. the account's own registration display name
//   2. "Parent/Sub" for a sub-identity, inheriting the parent's verified flag
//   3. its primary username
//
// Contact fields come only from the account's own registration. A sub-identity
// and a username carry none: the parent's email/web belong to the parent, and
// presenting them as the sub's own would be a plausible-looking guess.
//
// A sub whose parent has no display name is skipped — a bare "Validator2" with no
// parent to qualify it says nothing about whose validator it is.
export function resolveIdentityRows(state: ChainIdentityState, chain: IdentityChain, updatedAt: string): AccountIdentityRow[] {
  const rows: AccountIdentityRow[] = []
  const accounts = new Set([...state.registrations.keys(), ...state.subs.keys(), ...state.usernames.keys()])

  for (const accountId of accounts) {
    const own = state.registrations.get(accountId)
    if (own && own.display) {
      rows.push(row(chain, accountId, own.display, own.verified, own, updatedAt))
      continue
    }

    const sub = state.subs.get(accountId)
    // One hop only. An account can be its own super (it happens on Hydration),
    // and rule 1 already claimed it if it had a display name of its own.
    const parent = sub && sub.parent !== accountId ? state.registrations.get(sub.parent) : undefined
    if (sub && parent?.display) {
      rows.push(row(chain, accountId, `${parent.display}/${sub.name}`, parent.verified, null, updatedAt))
      continue
    }

    const username = state.usernames.get(accountId)
    if (username) rows.push(row(chain, accountId, username, false, null, updatedAt))
  }

  return rows
}

function row(
  chain: IdentityChain,
  accountId: string,
  display: string,
  verified: boolean,
  contacts: IdentityRegistration | null,
  updatedAt: string,
): AccountIdentityRow {
  return {
    chain: chain.key,
    account_id: accountId,
    display,
    verified: verified ? 1 : 0,
    email: contacts?.email ?? '',
    web: contacts?.web ?? '',
    twitter: contacts?.twitter ?? '',
    priority: chain.priority,
    updated_at: updatedAt,
  }
}

// An empty display is how an account's identity is retired: the API only reads
// rows with a display name, so a tombstone both replaces the stale row and hides
// it, without mutating the table.
export function tombstoneRow(chain: IdentityChain, accountId: string, updatedAt: string): AccountIdentityRow {
  return row(chain, accountId, '', false, null, updatedAt)
}

// Page one storage map at a fixed anchor. A chain that does not carry the item —
// SuperOf and UsernameOf are absent from older runtimes — yields nothing instead
// of failing the chain, so the identities it does have still land.
export async function readStorageMap<T>(
  runtime: Runtime,
  hash: string,
  item: string,
  pageSize: number,
  decode: (value: unknown) => T | null,
): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  try {
    for await (const page of runtime.getStoragePairsPaged(pageSize, hash, item)) {
      for (const [key, value] of page) {
        const accountId = toAccountId(key)
        if (accountId == null) continue
        const decoded = decode(value)
        if (decoded != null) out.set(accountId, decoded)
      }
    }
  } catch (error) {
    console.log(JSON.stringify({ type: 'identity_storage_unavailable', item, reason: (error as Error).message }))
  }
  return out
}
