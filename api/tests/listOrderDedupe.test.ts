import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserListService, loadUserLists, ensurePersonalList, createList, subscribePublic,
  setListOrder, listOrderFor, SYSTEM_LIST_ID,
} from '../src/services/userListService.ts'
import { fakeClient, insertedRows } from './helpers/userFakes.ts'

const VIEWER = '0x' + 'aa'.repeat(32)
const OWNER = '0x' + 'bb'.repeat(32)

// The stored order is client-supplied and persisted verbatim, and the route
// schema only bounds its length. A repeated ORDINARY list id is harmless — the
// second pass fails the visibility check — but SYSTEM_LIST_ID bypasses that
// check entirely, so ["system","system"] emitted the system slot twice and
// tagMapFor shipped two { listId: 'system' } entries.
describe('list order is a permutation', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); initUserListService(client); await loadUserLists() })

  it('never emits the system slot twice, however often the client sends it', async () => {
    const out = await setListOrder(VIEWER, [SYSTEM_LIST_ID, SYSTEM_LIST_ID, SYSTEM_LIST_ID])
    expect(out.filter(id => id === SYSTEM_LIST_ID)).toHaveLength(1)
    expect(listOrderFor(VIEWER).filter(id => id === SYSTEM_LIST_ID)).toHaveLength(1)
  })

  it('persists the deduplicated order, so a reload cannot resurrect the duplicate', async () => {
    await setListOrder(VIEWER, [SYSTEM_LIST_ID, SYSTEM_LIST_ID])
    expect(insertedRows(client, 'user_list_order').at(-1)).toMatchObject({
      account_id: VIEWER, list_ids: [SYSTEM_LIST_ID],
    })
  })

  it('keeps every distinct id exactly once, in the order given', async () => {
    const personal = await ensurePersonalList(VIEWER)
    const pub = await createList(OWNER, 'Public', '', 'public')
    await subscribePublic(VIEWER, pub.listId)

    const out = await setListOrder(VIEWER, [pub.listId, SYSTEM_LIST_ID, pub.listId, personal.listId, SYSTEM_LIST_ID])

    expect(out).toEqual([pub.listId, SYSTEM_LIST_ID, personal.listId])
  })
})
