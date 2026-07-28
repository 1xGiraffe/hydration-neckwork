import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserLibraryService, loadUserLibraries, ensurePersonalLibrary,
  createLibrary, updateLibrary, deleteLibrary,
  createTag, updateTag, deleteTag, setTagMembers,
  getLibrary, ownedLibrariesFor,
} from '../src/services/userLibraryService.ts'
import { UserDataError } from '../src/services/userProfileService.ts'
import { fakeClient, insertedRows } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const MEMBER_SS58 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'  // Kraken cold — any valid SS58 works

describe('library + tag CRUD', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); initUserLibraryService(client); await loadUserLibraries() })

  it('creates the personal library once, idempotently', async () => {
    const a = await ensurePersonalLibrary(OWNER)
    const b = await ensurePersonalLibrary(OWNER)
    expect(a.libraryId).toBe(b.libraryId)
    expect(a.isPersonal).toBe(true)
    expect(a.name).toBe('Personal')
    expect(insertedRows(client, 'user_libraries')).toHaveLength(1)
  })

  it('creates, renames, and deletes a library — but never the personal one', async () => {
    const personal = await ensurePersonalLibrary(OWNER)
    const lib = await createLibrary(OWNER, 'Whales', 'big fish', 'private')
    expect(getLibrary(lib.libraryId)?.name).toBe('Whales')
    await updateLibrary(OWNER, lib.libraryId, { name: 'Megalodons', visibility: 'public' })
    expect(getLibrary(lib.libraryId)?.visibility).toBe('public')
    const forbidden = updateLibrary('0x' + 'bb'.repeat(32), lib.libraryId, { name: 'x' })
    await expect(forbidden).rejects.toBeInstanceOf(UserDataError)
    await expect(forbidden).rejects.toMatchObject({ status: 403 })
    await deleteLibrary(OWNER, lib.libraryId)
    expect(getLibrary(lib.libraryId)).toBeNull()
    await expect(deleteLibrary(OWNER, personal.libraryId)).rejects.toMatchObject({ status: 403 })
  })

  it('manages tags and enforces one tag per account per library (move semantics)', async () => {
    const lib = await createLibrary(OWNER, 'CEX', '', 'private')
    const hot = await createTag(OWNER, lib.libraryId, { name: 'Hot wallets', color: '#f80', icon: '🔥' })
    const cold = await createTag(OWNER, lib.libraryId, { name: 'Cold wallets' })
    await setTagMembers(OWNER, lib.libraryId, hot.tagId, [MEMBER_SS58], [])
    // moving: adding the same account to `cold` removes it from `hot`
    await setTagMembers(OWNER, lib.libraryId, cold.tagId, [MEMBER_SS58], [])
    const l = getLibrary(lib.libraryId)!
    expect([...l.tags.get(hot.tagId)!.members]).toHaveLength(0)
    expect([...l.tags.get(cold.tagId)!.members]).toHaveLength(1)
    expect(l.memberTag.get([...l.tags.get(cold.tagId)!.members][0])).toBe(cold.tagId)
    // the move is persisted as a tombstone for the old membership row
    const memberRows = insertedRows(client, 'user_tag_members')
    expect(memberRows.filter(r => r.deleted === 1 && r.tag_id === hot.tagId)).toHaveLength(1)
    // tag rename / delete
    await updateTag(OWNER, lib.libraryId, cold.tagId, { name: 'Vaults', icon: '🧊' })
    expect(getLibrary(lib.libraryId)!.tags.get(cold.tagId)!.name).toBe('Vaults')
    await deleteTag(OWNER, lib.libraryId, cold.tagId)
    expect(getLibrary(lib.libraryId)!.tags.has(cold.tagId)).toBe(false)
    expect(getLibrary(lib.libraryId)!.memberTag.size).toBe(0)
  })

  it('rejects invalid member addresses and enforces caps', async () => {
    const lib = await createLibrary(OWNER, 'L', '', 'private')
    const tag = await createTag(OWNER, lib.libraryId, { name: 'T' })
    await expect(setTagMembers(OWNER, lib.libraryId, tag.tagId, ['not-an-address'], [])).rejects.toMatchObject({ status: 400 })
    await expect(createTag(OWNER, lib.libraryId, { name: 'x'.repeat(49) })).rejects.toMatchObject({ status: 422 })
    await expect(createTag(OWNER, lib.libraryId, { name: 'ok', icon: 'https://evil' })).rejects.toMatchObject({ status: 422 })
    await expect(createLibrary(OWNER, 'x'.repeat(49), '', 'private')).rejects.toMatchObject({ status: 422 })
  })

  it('reloads its whole state from persisted rows', async () => {
    const lib = await createLibrary(OWNER, 'Keep', 'note', 'public')
    const tag = await createTag(OWNER, lib.libraryId, { name: 'T', color: '#abc', icon: '🐋' })
    await setTagMembers(OWNER, lib.libraryId, tag.tagId, [MEMBER_SS58], [])
    const restore = fakeClient({
      user_libraries: insertedRows(client, 'user_libraries'),
      user_tags: insertedRows(client, 'user_tags'),
      user_tag_members: insertedRows(client, 'user_tag_members').filter(r => r.deleted === 0),
    })
    initUserLibraryService(restore); await loadUserLibraries()
    const l = getLibrary(lib.libraryId)!
    expect(l.name).toBe('Keep')
    expect(l.tags.get(tag.tagId)!.members.size).toBe(1)
    expect(ownedLibrariesFor(OWNER)).toHaveLength(1)
  })
})
