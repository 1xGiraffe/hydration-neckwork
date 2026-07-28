import type { ClickHouseClient } from '../db/client.ts'

// User profiles: a display name and an avatar the account owner sets after
// wallet login. Names live in an in-memory map (plugged into accountRef like
// identities); avatar blobs stay in ClickHouse (user_avatars) and are streamed
// by /explorer/profile-avatar/:accountId — the columnar split means the name
// map never loads image bytes, and a name rewrite never needs the blob.
export interface UserProfile { name: string; avatarVersion: number }

export class UserDataError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.name = 'UserDataError'; this.status = status }
}

export const MAX_NAME_LEN = 48
export const MAX_AVATAR_BYTES = 64 * 1024

let client: ClickHouseClient
const byAccount = new Map<string, UserProfile>()

export function initUserProfileService(c: ClickHouseClient): void { client = c; byAccount.clear() }

export async function loadUserProfiles(): Promise<void> {
  const res = await client.query({
    query: `SELECT account_id, display_name, avatar_version
            FROM price_data.user_profiles FINAL WHERE deleted = 0`,
    format: 'JSONEachRow',
  })
  byAccount.clear()
  for (const r of await res.json<{ account_id: string; display_name: string; avatar_version: number }>()) {
    byAccount.set(r.account_id.toLowerCase(), { name: r.display_name ?? '', avatarVersion: Number(r.avatar_version ?? 0) })
  }
}

export function profileForAccount(accountId: string): UserProfile | null {
  const p = byAccount.get(accountId.toLowerCase())
  return p && (p.name !== '' || p.avatarVersion > 0) ? p : null
}

async function persistProfile(accountId: string, p: UserProfile): Promise<void> {
  await client.insert({
    table: 'price_data.user_profiles',
    values: [{ account_id: accountId, display_name: p.name, avatar_version: p.avatarVersion, deleted: 0 }],
    format: 'JSONEachRow',
  })
}

export async function setProfileName(accountId: string, name: string): Promise<UserProfile> {
  const trimmed = name.trim()
  if (trimmed.length > MAX_NAME_LEN) throw new UserDataError(422, `Display name is limited to ${MAX_NAME_LEN} characters`)
  const acc = accountId.toLowerCase()
  const next: UserProfile = { name: trimmed, avatarVersion: byAccount.get(acc)?.avatarVersion ?? 0 }
  byAccount.set(acc, next)
  await persistProfile(acc, next)
  return next
}

// Magic-byte + size validation only. The client resizes/re-encodes before
// upload; the server never decodes images (no image dependency, no decoder
// attack surface) — it only ever serves them back with an image/* type and
// nosniff, to be rendered via <img>.
export function validateAvatarBytes(buf: Buffer): string | null {
  if (buf.length === 0 || buf.length > MAX_AVATAR_BYTES) return null
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  return null
}

export async function setProfileAvatar(accountId: string, base64: string): Promise<UserProfile> {
  let bytes: Buffer
  try { bytes = Buffer.from(base64, 'base64') } catch { throw new UserDataError(422, 'Avatar is not valid base64') }
  if (!validateAvatarBytes(bytes)) throw new UserDataError(422, 'Avatar must be webp, png, or jpeg and at most 64 KiB')
  const acc = accountId.toLowerCase()
  const prev = byAccount.get(acc) ?? { name: '', avatarVersion: 0 }
  const next: UserProfile = { name: prev.name, avatarVersion: prev.avatarVersion + 1 }
  await client.insert({ table: 'price_data.user_avatars', values: [{ account_id: acc, image: bytes.toString('base64'), deleted: 0 }], format: 'JSONEachRow' })
  byAccount.set(acc, next)
  await persistProfile(acc, next)
  return next
}

export async function clearProfileAvatar(accountId: string): Promise<UserProfile> {
  const acc = accountId.toLowerCase()
  const prev = byAccount.get(acc) ?? { name: '', avatarVersion: 0 }
  const next: UserProfile = { name: prev.name, avatarVersion: 0 }
  await client.insert({ table: 'price_data.user_avatars', values: [{ account_id: acc, image: '', deleted: 1 }], format: 'JSONEachRow' })
  byAccount.set(acc, next)
  await persistProfile(acc, next)
  return next
}

export async function getProfileAvatar(accountId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const acc = accountId.toLowerCase()
  if ((byAccount.get(acc)?.avatarVersion ?? 0) === 0) return null   // cheap negative path, no DB hit
  const res = await client.query({
    query: `SELECT image FROM price_data.user_avatars FINAL WHERE account_id = {acc:String} AND deleted = 0 LIMIT 1`,
    query_params: { acc },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ image: string }>()
  if (!rows.length || !rows[0].image) return null
  const bytes = Buffer.from(rows[0].image, 'base64')
  const contentType = validateAvatarBytes(bytes)
  return contentType ? { bytes, contentType } : null
}
