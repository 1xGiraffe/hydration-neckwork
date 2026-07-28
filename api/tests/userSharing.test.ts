import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserLibraryService, loadUserLibraries, createLibrary, updateLibrary, librarySummary, getLibrary,
  inviteToLibrary, revokeShare, respondToInvite, subscribePublic, unsubscribe,
  invitesFor, subscriptionsFor, canView,
} from '../src/services/userLibraryService.ts'
import { fakeClient, insertedRows } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const GUEST = '0x' + 'bb'.repeat(32)
const OTHER = '0x' + 'cc'.repeat(32)

describe('sharing', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); initUserLibraryService(client); await loadUserLibraries() })

  it('invite → accept grants view; decline does not; owner can revoke', async () => {
    const lib = await createLibrary(OWNER, 'Shared', '', 'private')
    await inviteToLibrary(OWNER, lib.libraryId, GUEST)
    expect(invitesFor(GUEST).map(s => s.libraryId)).toEqual([lib.libraryId])
    expect(canView(GUEST, lib.libraryId)).toBe(false)
    await respondToInvite(GUEST, lib.libraryId, true)
    expect(canView(GUEST, lib.libraryId)).toBe(true)
    expect(subscriptionsFor(GUEST).map(s => s.libraryId)).toEqual([lib.libraryId])
    expect(invitesFor(GUEST)).toHaveLength(0)
    await revokeShare(OWNER, lib.libraryId, GUEST)
    expect(canView(GUEST, lib.libraryId)).toBe(false)

    await inviteToLibrary(OWNER, lib.libraryId, OTHER)
    await respondToInvite(OTHER, lib.libraryId, false)
    expect(canView(OTHER, lib.libraryId)).toBe(false)
    expect(invitesFor(OTHER)).toHaveLength(0)
  })

  it('public libraries are viewable and self-subscribable; private ones are not', async () => {
    const pub = await createLibrary(OWNER, 'Pub', '', 'public')
    const priv = await createLibrary(OWNER, 'Priv', '', 'private')
    expect(canView(GUEST, pub.libraryId)).toBe(true)     // public = viewable by anyone
    await subscribePublic(GUEST, pub.libraryId)
    expect(subscriptionsFor(GUEST).map(s => s.libraryId)).toEqual([pub.libraryId])
    expect(librarySummary(getLibrary(pub.libraryId)!).subscriberCount).toBe(1)
    await expect(subscribePublic(GUEST, priv.libraryId)).rejects.toMatchObject({ status: 403 })
    await unsubscribe(GUEST, pub.libraryId)
    expect(subscriptionsFor(GUEST)).toHaveLength(0)
  })

  it('going private revokes public-origin subscriptions but keeps invited ones', async () => {
    const lib = await createLibrary(OWNER, 'Flip', '', 'public')
    await subscribePublic(GUEST, lib.libraryId)
    await inviteToLibrary(OWNER, lib.libraryId, OTHER)
    await respondToInvite(OTHER, lib.libraryId, true)
    await updateLibrary(OWNER, lib.libraryId, { visibility: 'private' })
    expect(canView(GUEST, lib.libraryId)).toBe(false)   // public-origin revoked
    expect(canView(OTHER, lib.libraryId)).toBe(true)    // invite-origin survives
    const rows = insertedRows(client, 'user_library_subscriptions')
    expect(rows.some(r => r.account_id === GUEST && r.deleted === 1)).toBe(true)
  })

  it('reloads subscription state from persisted rows', async () => {
    const lib = await createLibrary(OWNER, 'R', '', 'public')
    await subscribePublic(GUEST, lib.libraryId)
    const restore = fakeClient({
      user_libraries: insertedRows(client, 'user_libraries'),
      user_library_subscriptions: insertedRows(client, 'user_library_subscriptions').filter(r => r.deleted === 0),
    })
    initUserLibraryService(restore); await loadUserLibraries()
    expect(subscriptionsFor(GUEST).map(s => s.libraryId)).toEqual([lib.libraryId])
  })
})
