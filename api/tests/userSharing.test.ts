import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserListService, loadUserLists, createList, updateList, listSummary, getList,
  inviteToList, revokeShare, respondToInvite, subscribePublic, unsubscribe,
  invitesFor, subscriptionsFor, canView,
} from '../src/services/userListService.ts'
import { fakeClient, insertedRows } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const GUEST = '0x' + 'bb'.repeat(32)
const OTHER = '0x' + 'cc'.repeat(32)

describe('sharing', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); initUserListService(client); await loadUserLists() })

  it('invite → accept grants view; decline does not; owner can revoke', async () => {
    const lib = await createList(OWNER, 'Shared', '', 'private')
    await inviteToList(OWNER, lib.listId, GUEST)
    expect(invitesFor(GUEST).map(s => s.listId)).toEqual([lib.listId])
    expect(canView(GUEST, lib.listId)).toBe(false)
    await respondToInvite(GUEST, lib.listId, true)
    expect(canView(GUEST, lib.listId)).toBe(true)
    expect(subscriptionsFor(GUEST).map(s => s.listId)).toEqual([lib.listId])
    expect(invitesFor(GUEST)).toHaveLength(0)
    await revokeShare(OWNER, lib.listId, GUEST)
    expect(canView(GUEST, lib.listId)).toBe(false)

    await inviteToList(OWNER, lib.listId, OTHER)
    await respondToInvite(OTHER, lib.listId, false)
    expect(canView(OTHER, lib.listId)).toBe(false)
    expect(invitesFor(OTHER)).toHaveLength(0)
  })

  it('public lists are viewable and self-subscribable; private ones are not', async () => {
    const pub = await createList(OWNER, 'Pub', '', 'public')
    const priv = await createList(OWNER, 'Priv', '', 'private')
    expect(canView(GUEST, pub.listId)).toBe(true)     // public = viewable by anyone
    await subscribePublic(GUEST, pub.listId)
    expect(subscriptionsFor(GUEST).map(s => s.listId)).toEqual([pub.listId])
    expect(listSummary(getList(pub.listId)!).subscriberCount).toBe(1)
    await expect(subscribePublic(GUEST, priv.listId)).rejects.toMatchObject({ status: 403 })
    await unsubscribe(GUEST, pub.listId)
    expect(subscriptionsFor(GUEST)).toHaveLength(0)
  })

  it('going private revokes public-origin subscriptions but keeps invited ones', async () => {
    const lib = await createList(OWNER, 'Flip', '', 'public')
    await subscribePublic(GUEST, lib.listId)
    await inviteToList(OWNER, lib.listId, OTHER)
    await respondToInvite(OTHER, lib.listId, true)
    await updateList(OWNER, lib.listId, { visibility: 'private' })
    expect(canView(GUEST, lib.listId)).toBe(false)   // public-origin revoked
    expect(canView(OTHER, lib.listId)).toBe(true)    // invite-origin survives
    const rows = insertedRows(client, 'user_list_subscriptions')
    expect(rows.some(r => r.account_id === GUEST && r.deleted === 1)).toBe(true)
  })

  it('reloads subscription state from persisted rows', async () => {
    const lib = await createList(OWNER, 'R', '', 'public')
    await subscribePublic(GUEST, lib.listId)
    const restore = fakeClient({
      user_lists: insertedRows(client, 'user_lists'),
      user_list_subscriptions: insertedRows(client, 'user_list_subscriptions').filter(r => r.deleted === 0),
    })
    initUserListService(restore); await loadUserLists()
    expect(subscriptionsFor(GUEST).map(s => s.listId)).toEqual([lib.listId])
  })
})
