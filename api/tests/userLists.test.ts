import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserListService, loadUserLists, ensurePersonalList,
  createList, updateList, deleteList,
  createTag, updateTag, deleteTag, setTagMembers, setMemberOrder,
  getList, ownedListsFor, publicListsTagging,
} from '../src/services/userListService.ts'
import { listDetailResponse } from '../src/routes/user.ts'
import { UserDataError } from '../src/services/userProfileService.ts'
import { fakeClient, insertedRows } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const MEMBER_SS58 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'  // Kraken cold — any valid SS58 works
const M1 = '0x' + '11'.repeat(32)
const M2 = '0x' + '22'.repeat(32)
const M3 = '0x' + '33'.repeat(32)

// fakeClient's insert() just accumulates every call, so a reload test that
// mutates the same (tag, account) key more than once (e.g. add, then
// reorder) sees every historical row, not just the current one. The real
// query is `FROM user_tag_members FINAL`, which collapses to the latest row
// per key by `updated_at` (ReplacingMergeTree) — this reproduces that
// collapse over the captured insert calls before feeding them to a fresh
// fakeClient, so "reload" in a test means what it means against ClickHouse.
function finalMemberRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>()
  for (const r of rows) byKey.set(`${r.list_id}:${r.tag_id}:${r.account_id}`, r)
  return [...byKey.values()]
}

describe('list + tag CRUD', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); initUserListService(client); await loadUserLists() })

  it('creates the personal list once, idempotently', async () => {
    const a = await ensurePersonalList(OWNER)
    const b = await ensurePersonalList(OWNER)
    expect(a.listId).toBe(b.listId)
    expect(a.isPersonal).toBe(true)
    expect(a.name).toBe('Personal')
    expect(insertedRows(client, 'user_lists')).toHaveLength(1)
  })

  it('creates, renames, and deletes a list — but never the personal one', async () => {
    const personal = await ensurePersonalList(OWNER)
    const lib = await createList(OWNER, 'Whales', 'big fish', 'private')
    expect(getList(lib.listId)?.name).toBe('Whales')
    await updateList(OWNER, lib.listId, { name: 'Megalodons', visibility: 'public' })
    expect(getList(lib.listId)?.visibility).toBe('public')
    const forbidden = updateList('0x' + 'bb'.repeat(32), lib.listId, { name: 'x' })
    await expect(forbidden).rejects.toBeInstanceOf(UserDataError)
    await expect(forbidden).rejects.toMatchObject({ status: 403 })
    await deleteList(OWNER, lib.listId)
    expect(getList(lib.listId)).toBeNull()
    await expect(deleteList(OWNER, personal.listId)).rejects.toMatchObject({ status: 403 })
  })

  it('lists tags alphabetically in the detail response, regardless of creation order', async () => {
    const lib = await createList(OWNER, 'CEX', '', 'private')
    // Created out of alphabetical order on purpose; "alpha" vs "Alpha" pins
    // the comparison as case-insensitive (sensitivity: 'base'), not a plain
    // localeCompare that would sort every uppercase name ahead of every
    // lowercase one.
    const zebra = await createTag(OWNER, lib.listId, { name: 'Zebra wallets' })
    const banana = await createTag(OWNER, lib.listId, { name: 'banana wallets' })
    const appleUpper = await createTag(OWNER, lib.listId, { name: 'Alpha wallets' })
    const appleLower = await createTag(OWNER, lib.listId, { name: 'alpha wallets' })

    const detail = listDetailResponse(getList(lib.listId)!, OWNER)
    const names = detail.tags.map(t => t.name)
    // The two "alpha wallets" case variants compare equal under sensitivity:
    // 'base', so which one leads between THEM is a tiebreak, not fixed —
    // asserted separately below via the actual (random) tagIds rather than
    // hardcoded here. The OUTER order (this pair vs "banana"/"Zebra") is not
    // ambiguous and is asserted directly.
    expect(names[0].toLowerCase()).toBe('alpha wallets')
    expect(names[1].toLowerCase()).toBe('alpha wallets')
    expect(names[2]).toBe('banana wallets')
    expect(names[3]).toBe('Zebra wallets')
    // tagId is the deterministic tiebreak (the same localeCompare the
    // production comparator uses) — computed from the actual generated ids,
    // never a hardcoded direction, since createTag's ids are random.
    const [first, second] = detail.tags
    const expectedIdOrder = [appleLower.tagId, appleUpper.tagId].sort((a, b) => a.localeCompare(b))
    expect([first.tagId, second.tagId]).toEqual(expectedIdOrder)
    void banana; void zebra
  })

  it('manages tags and enforces one tag per account per list (move semantics)', async () => {
    const lib = await createList(OWNER, 'CEX', '', 'private')
    const hot = await createTag(OWNER, lib.listId, { name: 'Hot wallets', color: '#f80', icon: '🔥' })
    const cold = await createTag(OWNER, lib.listId, { name: 'Cold wallets' })
    await setTagMembers(OWNER, lib.listId, hot.tagId, [MEMBER_SS58], [])
    // moving: adding the same account to `cold` removes it from `hot`
    await setTagMembers(OWNER, lib.listId, cold.tagId, [MEMBER_SS58], [])
    const l = getList(lib.listId)!
    expect([...l.tags.get(hot.tagId)!.members]).toHaveLength(0)
    expect([...l.tags.get(cold.tagId)!.members]).toHaveLength(1)
    expect(l.memberTag.get([...l.tags.get(cold.tagId)!.members][0])).toBe(cold.tagId)
    // the move is persisted as a tombstone for the old membership row
    const memberRows = insertedRows(client, 'user_tag_members')
    expect(memberRows.filter(r => r.deleted === 1 && r.tag_id === hot.tagId)).toHaveLength(1)
    // tag rename / delete
    await updateTag(OWNER, lib.listId, cold.tagId, { name: 'Vaults', icon: '🧊' })
    expect(getList(lib.listId)!.tags.get(cold.tagId)!.name).toBe('Vaults')
    await deleteTag(OWNER, lib.listId, cold.tagId)
    expect(getList(lib.listId)!.tags.has(cold.tagId)).toBe(false)
    expect(getList(lib.listId)!.memberTag.size).toBe(0)
  })

  it('rejects invalid member addresses and enforces caps', async () => {
    const lib = await createList(OWNER, 'L', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T' })
    await expect(setTagMembers(OWNER, lib.listId, tag.tagId, ['not-an-address'], [])).rejects.toMatchObject({ status: 400 })
    await expect(createTag(OWNER, lib.listId, { name: 'x'.repeat(49) })).rejects.toMatchObject({ status: 422 })
    await expect(createTag(OWNER, lib.listId, { name: 'ok', icon: 'https://evil' })).rejects.toMatchObject({ status: 422 })
    await expect(createList(OWNER, 'x'.repeat(49), '', 'private')).rejects.toMatchObject({ status: 422 })
  })

  it('reloads its whole state from persisted rows', async () => {
    const lib = await createList(OWNER, 'Keep', 'note', 'public')
    const tag = await createTag(OWNER, lib.listId, { name: 'T', color: '#abc', icon: '🐋' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [MEMBER_SS58], [])
    const restore = fakeClient({
      user_lists: insertedRows(client, 'user_lists'),
      user_tags: insertedRows(client, 'user_tags'),
      user_tag_members: insertedRows(client, 'user_tag_members').filter(r => r.deleted === 0),
    })
    initUserListService(restore); await loadUserLists()
    const l = getList(lib.listId)!
    expect(l.name).toBe('Keep')
    expect(l.tags.get(tag.tagId)!.members.size).toBe(1)
    expect(ownedListsFor(OWNER)).toHaveLength(1)
  })
})

describe('ordered membership (drag/keyboard reorder)', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); initUserListService(client); await loadUserLists() })

  it('orders members by add sequence, then a reorder persists and reload preserves it', async () => {
    const lib = await createList(OWNER, 'Order', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T' })
    // Added across separate calls (like the UI's sequential-submit), and
    // again within one call — both land at the end in the given order.
    await setTagMembers(OWNER, lib.listId, tag.tagId, [M1], [])
    await setTagMembers(OWNER, lib.listId, tag.tagId, [M2, M3], [])
    expect(getList(lib.listId)!.tags.get(tag.tagId)!.order).toEqual([M1, M2, M3])

    const reordered = await setMemberOrder(OWNER, lib.listId, tag.tagId, [M3, M1, M2])
    expect(reordered.order).toEqual([M3, M1, M2])
    // A move-semantics add after a reorder still appends at the end, past
    // the reordered rows — nextPosition tracks the new order's length.
    const withAppend = await setTagMembers(OWNER, lib.listId, tag.tagId, [MEMBER_SS58], [])
    expect(withAppend.order.slice(0, 3)).toEqual([M3, M1, M2])
    expect(withAppend.order).toHaveLength(4)

    const restore = fakeClient({
      user_lists: insertedRows(client, 'user_lists'),
      user_tags: insertedRows(client, 'user_tags'),
      user_tag_members: finalMemberRows(insertedRows(client, 'user_tag_members')).filter(r => r.deleted === 0),
    })
    initUserListService(restore); await loadUserLists()
    expect(getList(lib.listId)!.tags.get(tag.tagId)!.order).toEqual(withAppend.order)
  })

  it('rejects a reorder that is not an exact permutation of the current members', async () => {
    const lib = await createList(OWNER, 'Order', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [M1, M2], [])
    await expect(setMemberOrder(OWNER, lib.listId, tag.tagId, [M1])).rejects.toMatchObject({ status: 400 })              // missing M2
    await expect(setMemberOrder(OWNER, lib.listId, tag.tagId, [M1, M2, M3])).rejects.toMatchObject({ status: 400 })      // unknown extra
    await expect(setMemberOrder(OWNER, lib.listId, tag.tagId, [M1, M1])).rejects.toMatchObject({ status: 400 })          // duplicate
    // unaffected by the rejected attempts
    expect(getList(lib.listId)!.tags.get(tag.tagId)!.order).toEqual([M1, M2])
  })

  it('is owner-only, like every other tag mutation', async () => {
    const lib = await createList(OWNER, 'Order', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [M1, M2], [])
    await expect(setMemberOrder('0x' + 'bb'.repeat(32), lib.listId, tag.tagId, [M2, M1])).rejects.toMatchObject({ status: 403 })
  })

  it('removing a member drops it from order without disturbing the rest, and delete tombstones every ordered row', async () => {
    const lib = await createList(OWNER, 'Order', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [M1, M2, M3], [])
    const afterRemove = await setTagMembers(OWNER, lib.listId, tag.tagId, [], [M2])
    expect(afterRemove.order).toEqual([M1, M3])
    await deleteTag(OWNER, lib.listId, tag.tagId)
    // Tombstoned across two calls (the plain remove of M2, then deleteTag's
    // sweep of what was left, M1 and M3) — every member ever on this tag
    // ends up deleted exactly once.
    const memberRows = insertedRows(client, 'user_tag_members')
    const tombstoned = memberRows.filter(r => r.deleted === 1 && r.tag_id === tag.tagId).map(r => r.account_id)
    expect(new Set(tombstoned)).toEqual(new Set([M1, M2, M3]))
  })

  // Regression: `trulyNew` used to filter `addIds` against the PRE-mutation
  // Set, so a caller-supplied duplicate in one `add` array passed that check
  // twice and got pushed into `order` (and persisted) twice for one Set
  // entry — `order` desynced from `members` until the next reload, and any
  // member-order submission built from that corrupted `order` would then
  // fail the permutation check (accountIds.length !== tag.members.size).
  it('a duplicate id in one add() call is deduped, keeping order and members in sync', async () => {
    const lib = await createList(OWNER, 'Order', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T' })
    const added = await setTagMembers(OWNER, lib.listId, tag.tagId, [M1, M1], [])
    expect(added.order).toEqual([M1])
    expect(added.members.size).toBe(1)
    // A member-order submission built from the (now correctly deduped) list
    // succeeds — this is exactly the operation the corrupted `order` used to
    // 400 the user out of.
    await expect(setMemberOrder(OWNER, lib.listId, tag.tagId, [M1])).resolves.toMatchObject({ order: [M1] })
  })
})

// publicListsTagging is the account page's "this account is tagged in a
// public list" teaser for a viewer who isn't a subscriber — ownership
// (publicListsByOwner, tested above via ownedListsFor) is a DIFFERENT
// question: an account can own zero public lists yet still be tagged as a
// member of someone else's, which is exactly the case this exists to catch.
describe('publicListsTagging — member-of teaser for non-subscribers', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); initUserListService(client); await loadUserLists() })

  it('finds a public list that tags the account as a member, via the canonical accountId', async () => {
    const lib = await createList(OWNER, 'Whales', '', 'public')
    const tag = await createTag(OWNER, lib.listId, { name: 'Big fish' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [M1], [])
    expect(publicListsTagging(M1)).toMatchObject([{ listId: lib.listId, name: 'Whales' }])
    // A different account, never added, is not tagged anywhere.
    expect(publicListsTagging(M2)).toEqual([])
  })

  it('excludes a private list even though the account is genuinely a member of it', async () => {
    const lib = await createList(OWNER, 'Private watch', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'Watch' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [M1], [])
    expect(publicListsTagging(M1)).toEqual([])
  })

  it('returns [] for an account tagged nowhere, including when public lists exist', async () => {
    const lib = await createList(OWNER, 'Whales', '', 'public')
    const tag = await createTag(OWNER, lib.listId, { name: 'Big fish' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [M1], [])
    expect(publicListsTagging(M3)).toEqual([])
  })

  it('never reveals tag names or membership — only the same summary shape ownership-based lists get', async () => {
    // listSummary()'s own shape has no `tags`/`members` field at all — this
    // pins that publicListsTagging returns exactly that shape, not something
    // richer that a route could accidentally forward.
    const keys = ['listId', 'name', 'note', 'visibility', 'isPersonal', 'ownerAccountId', 'tagCount', 'accountCount', 'subscriberCount']
    const lib = await createList(OWNER, 'Whales', '', 'public')
    const tag = await createTag(OWNER, lib.listId, { name: 'Big fish' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [M1], [])
    const [summary] = publicListsTagging(M1)
    expect(Object.keys(summary).sort()).toEqual(keys.sort())
  })
})
