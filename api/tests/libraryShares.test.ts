import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserLibraryService, loadUserLibraries, createLibrary, getLibrary,
  inviteToLibrary, respondToInvite,
} from '../src/services/userLibraryService.ts'
import { libraryDetailResponse } from '../src/routes/user.ts'
import { fakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const INVITED = '0x' + 'bb'.repeat(32)
const ACTIVE = '0x' + 'cc'.repeat(32)
const STRANGER = '0x' + 'dd'.repeat(32)

// C10: the Subscribers tab's server side — libraryDetailResponse gains
// `shares` (invited + active accounts) ONLY for the owner's own view. Every
// other viewer of the same library object — an active subscriber, or the
// anonymous public detail routes/libraries.ts builds with `viewer: null` —
// must see no `shares` field at all, not an empty array (an empty array would
// read as "no subscribers", which is a different, and wrong, statement for a
// viewer who has no right to that information in the first place).
describe('library detail shares (Subscribers tab, owner-only)', () => {
  beforeEach(async () => { initUserLibraryService(fakeClient()); await loadUserLibraries() })

  it('ships invited + active shares to the owner, in first-shared order, and hides them from everyone else', async () => {
    const lib = await createLibrary(OWNER, 'Shared', '', 'private')
    await inviteToLibrary(OWNER, lib.libraryId, INVITED)
    await inviteToLibrary(OWNER, lib.libraryId, ACTIVE)
    await respondToInvite(ACTIVE, lib.libraryId, true)
    // Declining removes the subscription outright (see respondToInvite), so a
    // declined invite is excluded from `shares` the same way it's excluded
    // from every other membership view — there is no persisted 'declined' row
    // to leak.
    await inviteToLibrary(OWNER, lib.libraryId, STRANGER)
    await respondToInvite(STRANGER, lib.libraryId, false)

    const fresh = () => getLibrary(lib.libraryId)!

    const asOwner = libraryDetailResponse(fresh(), OWNER)
    expect(asOwner.shares).toHaveLength(2)
    expect(asOwner.shares?.map(s => [s.account.accountId, s.status])).toEqual([
      [INVITED, 'invited'],
      [ACTIVE, 'active'],
    ])
    expect(asOwner.shares?.every(s => s.account.accountId !== STRANGER)).toBe(true)

    expect(libraryDetailResponse(fresh(), ACTIVE).shares).toBeUndefined()
    expect(libraryDetailResponse(fresh(), null).shares).toBeUndefined()
  })

  it('omits shares for a library with no sharing activity too — never an empty array for a non-owner', async () => {
    const lib = await createLibrary(OWNER, 'Quiet', '', 'public')
    expect(libraryDetailResponse(getLibrary(lib.libraryId)!, OWNER).shares).toEqual([])
    expect(libraryDetailResponse(getLibrary(lib.libraryId)!, null).shares).toBeUndefined()
  })
})
