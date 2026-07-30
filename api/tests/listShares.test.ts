import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserListService, loadUserLists, createList, getList,
  inviteToList, respondToInvite,
} from '../src/services/userListService.ts'
import { listDetailResponse } from '../src/routes/user.ts'
import { fakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const INVITED = '0x' + 'bb'.repeat(32)
const ACTIVE = '0x' + 'cc'.repeat(32)
const STRANGER = '0x' + 'dd'.repeat(32)

// C10: the Subscribers tab's server side — listDetailResponse gains
// `shares` (invited + active accounts) ONLY for the owner's own view. Every
// other viewer of the same list object — an active subscriber, or the
// anonymous public detail routes/lists.ts builds with `viewer: null` —
// must see no `shares` field at all, not an empty array (an empty array would
// read as "no subscribers", which is a different, and wrong, statement for a
// viewer who has no right to that information in the first place).
describe('list detail shares (Subscribers tab, owner-only)', () => {
  beforeEach(async () => { initUserListService(fakeClient()); await loadUserLists() })

  it('ships invited + active shares to the owner, in first-shared order, and hides them from everyone else', async () => {
    const lib = await createList(OWNER, 'Shared', '', 'private')
    await inviteToList(OWNER, lib.listId, INVITED)
    await inviteToList(OWNER, lib.listId, ACTIVE)
    await respondToInvite(ACTIVE, lib.listId, true)
    // Declining removes the subscription outright (see respondToInvite), so a
    // declined invite is excluded from `shares` the same way it's excluded
    // from every other membership view — there is no persisted 'declined' row
    // to leak.
    await inviteToList(OWNER, lib.listId, STRANGER)
    await respondToInvite(STRANGER, lib.listId, false)

    const fresh = () => getList(lib.listId)!

    const asOwner = listDetailResponse(fresh(), OWNER)
    expect(asOwner.shares).toHaveLength(2)
    expect(asOwner.shares?.map(s => [s.account.accountId, s.status])).toEqual([
      [INVITED, 'invited'],
      [ACTIVE, 'active'],
    ])
    expect(asOwner.shares?.every(s => s.account.accountId !== STRANGER)).toBe(true)

    expect(listDetailResponse(fresh(), ACTIVE).shares).toBeUndefined()
    expect(listDetailResponse(fresh(), null).shares).toBeUndefined()
  })

  it('omits shares for a list with no sharing activity too — never an empty array for a non-owner', async () => {
    const lib = await createList(OWNER, 'Quiet', '', 'public')
    expect(listDetailResponse(getList(lib.listId)!, OWNER).shares).toEqual([])
    expect(listDetailResponse(getList(lib.listId)!, null).shares).toBeUndefined()
  })
})
