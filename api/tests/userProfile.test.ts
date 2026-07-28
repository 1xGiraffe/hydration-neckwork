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

  it('validates magic bytes and size', () => {
    expect(validateAvatarBytes(PNG)).toBe('image/png')
    expect(validateAvatarBytes(WEBP)).toBe('image/webp')
    expect(validateAvatarBytes(JPEG)).toBe('image/jpeg')
    expect(validateAvatarBytes(Buffer.from('GIF89a……'))).toBeNull()
    expect(validateAvatarBytes(Buffer.alloc(65 * 1024, 1))).toBeNull()  // over 64 KiB
  })

  it('profileForAccount is null until something is set, and loads persisted rows', async () => {
    expect(profileForAccount('0x' + 'ee'.repeat(32))).toBeNull()
    const restore = fakeClient({ user_profiles: [{ account_id: ACC, display_name: 'Bob', avatar_version: 3 }] })
    initUserProfileService(restore); await loadUserProfiles()
    expect(profileForAccount(ACC)).toEqual({ name: 'Bob', avatarVersion: 3 })
  })
})
