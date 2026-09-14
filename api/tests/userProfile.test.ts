import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserProfileService, loadUserProfiles, profileForAccount,
  setProfileName, setProfileAvatar, clearProfileAvatar, validateAvatarBytes, UserDataError,
} from '../src/services/userProfileService.ts'
import { fakeClient, insertedRows } from './helpers/userFakes.ts'

const ACC = '0x' + 'cd'.repeat(32)
// Tiny valid magic-byte fixtures (headers only — validation reads magic bytes, not full decode).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])

describe('profiles', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); initUserProfileService(client); await loadUserProfiles() })

  it('stores a display name with write-through and caps its length', async () => {
    await setProfileName(ACC, 'Alice')
    expect(profileForAccount(ACC)).toEqual({ name: 'Alice', avatarVersion: 0 })
    expect(insertedRows(client, 'user_profiles')[0]).toMatchObject({ account_id: ACC, display_name: 'Alice', avatar_version: 0 })
    await expect(setProfileName(ACC, 'x'.repeat(49))).rejects.toThrow(UserDataError)
  })

  it('bumps avatarVersion on upload, keeps it on rename, clears on delete', async () => {
    const p1 = await setProfileAvatar(ACC, WEBP.toString('base64'))
    expect(p1.avatarVersion).toBe(1)
    await setProfileName(ACC, 'Alice')
    expect(profileForAccount(ACC)).toEqual({ name: 'Alice', avatarVersion: 1 })
    const p2 = await setProfileAvatar(ACC, PNG.toString('base64'))
    expect(p2.avatarVersion).toBe(2)
    const cleared = await clearProfileAvatar(ACC)
    expect(cleared.avatarVersion).toBe(0)
    // the avatar blob row is tombstoned, the profile row rewritten
    expect(insertedRows(client, 'user_avatars').at(-1)).toMatchObject({ account_id: ACC, deleted: 1 })
  })

  it('never reuses an avatar version after a clear → re-upload (the URL is cached immutable)', async () => {
    await setProfileAvatar(ACC, WEBP.toString('base64'))              // v1
    const before = await setProfileAvatar(ACC, PNG.toString('base64')) // v2
    expect(before.avatarVersion).toBe(2)
    const cleared = await clearProfileAvatar(ACC)
    expect(cleared.avatarVersion).toBe(0)
    // The persisted counter stays at its high-water mark (2), not reset to 0 —
    // otherwise the very next upload would compute 0+1=1, reusing a version
    // already served under the old (now-wrong) image at that URL.
    expect(insertedRows(client, 'user_profiles').at(-1)).toMatchObject({ account_id: ACC, avatar_version: 2 })
    const reuploaded = await setProfileAvatar(ACC, JPEG.toString('base64'))
    expect(reuploaded.avatarVersion).toBe(3)
  })

  it('keeps the counter monotonic across a reload even while no avatar is currently set', async () => {
    await setProfileAvatar(ACC, WEBP.toString('base64'))   // v1
    await setProfileAvatar(ACC, PNG.toString('base64'))    // v2
    await clearProfileAvatar(ACC)
    const profileRows = insertedRows(client, 'user_profiles')
    // Reload from exactly what was persisted: the profile row still carries the
    // counter (2), and user_avatars FINAL has no live row after the tombstone.
    const restore = fakeClient({ user_profiles: [profileRows.at(-1) as Record<string, unknown>], user_avatars: [] })
    initUserProfileService(restore); await loadUserProfiles()
    expect(profileForAccount(ACC)).toBeNull()   // no name, no live avatar -> null
    const p = await setProfileAvatar(ACC, JPEG.toString('base64'))
    expect(p.avatarVersion).toBe(3)   // continues past the last served version, not from 0
  })

  // The avatar URL is served `immutable`, so the ?v= a browser has already
  // fetched is never re-requested. If the image landed first and the version
  // write then failed (or the process restarted between the two), user_avatars
  // held the NEW bytes under the OLD counter and every browser that had seen the
  // old image kept it forever. A version ahead of its blob is harmless — the URL
  // is new, so it is re-fetched and answers with whatever is stored.
  it('persists the bumped version BEFORE the new image', async () => {
    await setProfileAvatar(ACC, WEBP.toString('base64'))

    const order = client.inserts.map(i => i.table)
    expect(order.indexOf('price_data.user_profiles')).toBeLessThan(order.indexOf('price_data.user_avatars'))
    expect(insertedRows(client, 'user_profiles')[0]).toMatchObject({ account_id: ACC, avatar_version: 1 })
  })

  it('leaves the OLD image under a NEW version when the image write fails, never the reverse', async () => {
    const failing = fakeClient()
    const realInsert = failing.insert.bind(failing)
    failing.insert = (async (args: { table: string; values: Record<string, unknown>[] }) => {
      if (args.table === 'price_data.user_avatars') throw new Error('clickhouse down')
      return realInsert(args)
    }) as typeof failing.insert
    initUserProfileService(failing)
    await loadUserProfiles()

    await expect(setProfileAvatar(ACC, WEBP.toString('base64'))).rejects.toThrow('clickhouse down')
    // The version moved and no image was written: the next read is a cache MISS
    // that serves the old bytes, not a hit that serves new bytes under an old
    // URL.
    expect(insertedRows(failing, 'user_profiles').at(-1)).toMatchObject({ avatar_version: 1 })
    expect(insertedRows(failing, 'user_avatars')).toEqual([])
  })

  it('validates magic bytes and size', () => {
    expect(validateAvatarBytes(PNG)).toBe('image/png')
    expect(validateAvatarBytes(WEBP)).toBe('image/webp')
    expect(validateAvatarBytes(JPEG)).toBe('image/jpeg')
    expect(validateAvatarBytes(Buffer.from('GIF89a……'))).toBeNull()
    expect(validateAvatarBytes(Buffer.alloc(65 * 1024, 1))).toBeNull()  // over 64 KiB
  })

  it('profileForAccount is null until something is set, and loads persisted rows', async () => {
    expect(profileForAccount('0x' + 'ee'.repeat(32))).toBeNull()
    // Presence comes from user_avatars, not from avatar_version alone.
    const restore = fakeClient({
      user_profiles: [{ account_id: ACC, display_name: 'Bob', avatar_version: 3 }],
      user_avatars: [{ account_id: ACC, deleted: 0 }],
    })
    initUserProfileService(restore); await loadUserProfiles()
    expect(profileForAccount(ACC)).toEqual({ name: 'Bob', avatarVersion: 3 })
  })
})
