import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserLibraryService, loadUserLibraries, ensurePersonalLibrary,
  createLibrary, updateLibrary, deleteLibrary,
  createTag, updateTag, deleteTag, setTagMembers, setMemberOrder,
  getLibrary, ownedLibrariesFor,
} from '../src/services/userLibraryService.ts'
import { libraryDetailResponse } from '../src/routes/user.ts'
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
  for (const r of rows) byKey.set(`${r.library_id}:${r.tag_id}:${r.account_id}`, r)
  return [...byKey.values()]
}

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

  it('lists tags alphabetically in the detail response, regardless of creation order', async () => {
    const lib = await createLibrary(OWNER, 'CEX', '', 'private')
    // Created out of alphabetical order on purpose; "alpha" vs "Alpha" pins
    // the comparison as case-insensitive (sensitivity: 'base'), not a plain
    // localeCompare that would sort every uppercase name ahead of every
    // lowercase one.
    const zebra = await createTag(OWNER, lib.libraryId, { name: 'Zebra wallets' })
    const banana = await createTag(OWNER, lib.libraryId, { name: 'banana wallets' })
    const appleUpper = await createTag(OWNER, lib.libraryId, { name: 'Alpha wallets' })
    const appleLower = await createTag(OWNER, lib.libraryId, { name: 'alpha wallets' })

    const detail = libraryDetailResponse(getLibrary(lib.libraryId)!, OWNER)
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

describe('ordered membership (drag/keyboard reorder)', () => {
  let client: ReturnType<typeof fakeClient>
  beforeEach(async () => { client = fakeClient(); initUserLibraryService(client); await loadUserLibraries() })

  it('orders members by add sequence, then a reorder persists and reload preserves it', async () => {
    const lib = await createLibrary(OWNER, 'Order', '', 'private')
    const tag = await createTag(OWNER, lib.libraryId, { name: 'T' })
    // Added across separate calls (like the UI's sequential-submit), and
    // again within one call — both land at the end in the given order.
    await setTagMembers(OWNER, lib.libraryId, tag.tagId, [M1], [])
    await setTagMembers(OWNER, lib.libraryId, tag.tagId, [M2, M3], [])
    expect(getLibrary(lib.libraryId)!.tags.get(tag.tagId)!.order).toEqual([M1, M2, M3])

    const reordered = await setMemberOrder(OWNER, lib.libraryId, tag.tagId, [M3, M1, M2])
    expect(reordered.order).toEqual([M3, M1, M2])
    // A move-semantics add after a reorder still appends at the end, past
    // the reordered rows — nextPosition tracks the new order's length.
    const withAppend = await setTagMembers(OWNER, lib.libraryId, tag.tagId, [MEMBER_SS58], [])
    expect(withAppend.order.slice(0, 3)).toEqual([M3, M1, M2])
    expect(withAppend.order).toHaveLength(4)

    const restore = fakeClient({
      user_libraries: insertedRows(client, 'user_libraries'),
      user_tags: insertedRows(client, 'user_tags'),
      user_tag_members: finalMemberRows(insertedRows(client, 'user_tag_members')).filter(r => r.deleted === 0),
    })
    initUserLibraryService(restore); await loadUserLibraries()
    expect(getLibrary(lib.libraryId)!.tags.get(tag.tagId)!.order).toEqual(withAppend.order)
  })

  it('rejects a reorder that is not an exact permutation of the current members', async () => {
    const lib = await createLibrary(OWNER, 'Order', '', 'private')
    const tag = await createTag(OWNER, lib.libraryId, { name: 'T' })
    await setTagMembers(OWNER, lib.libraryId, tag.tagId, [M1, M2], [])
    await expect(setMemberOrder(OWNER, lib.libraryId, tag.tagId, [M1])).rejects.toMatchObject({ status: 400 })              // missing M2
    await expect(setMemberOrder(OWNER, lib.libraryId, tag.tagId, [M1, M2, M3])).rejects.toMatchObject({ status: 400 })      // unknown extra
    await expect(setMemberOrder(OWNER, lib.libraryId, tag.tagId, [M1, M1])).rejects.toMatchObject({ status: 400 })          // duplicate
    // unaffected by the rejected attempts
    expect(getLibrary(lib.libraryId)!.tags.get(tag.tagId)!.order).toEqual([M1, M2])
  })

  it('is owner-only, like every other tag mutation', async () => {
    const lib = await createLibrary(OWNER, 'Order', '', 'private')
    const tag = await createTag(OWNER, lib.libraryId, { name: 'T' })
    await setTagMembers(OWNER, lib.libraryId, tag.tagId, [M1, M2], [])
    await expect(setMemberOrder('0x' + 'bb'.repeat(32), lib.libraryId, tag.tagId, [M2, M1])).rejects.toMatchObject({ status: 403 })
  })

  it('removing a member drops it from order without disturbing the rest, and delete tombstones every ordered row', async () => {
    const lib = await createLibrary(OWNER, 'Order', '', 'private')
    const tag = await createTag(OWNER, lib.libraryId, { name: 'T' })
    await setTagMembers(OWNER, lib.libraryId, tag.tagId, [M1, M2, M3], [])
    const afterRemove = await setTagMembers(OWNER, lib.libraryId, tag.tagId, [], [M2])
    expect(afterRemove.order).toEqual([M1, M3])
    await deleteTag(OWNER, lib.libraryId, tag.tagId)
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
    const lib = await createLibrary(OWNER, 'Order', '', 'private')
    const tag = await createTag(OWNER, lib.libraryId, { name: 'T' })
    const added = await setTagMembers(OWNER, lib.libraryId, tag.tagId, [M1, M1], [])
    expect(added.order).toEqual([M1])
    expect(added.members.size).toBe(1)
    // A member-order submission built from the (now correctly deduped) list
    // succeeds — this is exactly the operation the corrupted `order` used to
    // 400 the user out of.
    await expect(setMemberOrder(OWNER, lib.libraryId, tag.tagId, [M1])).resolves.toMatchObject({ order: [M1] })
  })
})
