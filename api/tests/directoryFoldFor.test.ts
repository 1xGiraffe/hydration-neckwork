import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserListService, loadUserLists, ensurePersonalList, createList, createTag, setTagMembers, setMemberOrder,
  subscribePublic, listOrderFor, directoryFoldFor,
} from '../src/services/userListService.ts'
import { initTagService, loadTags } from '../src/services/tagService.ts'
import { fakeClient } from './helpers/userFakes.ts'

const VIEWER = '0x' + 'aa'.repeat(32)
const OWNER = '0x' + 'bb'.repeat(32)
const A1 = '0x' + '11'.repeat(32)   // carries no system tag
const A2 = '0x' + '22'.repeat(32)   // carries no system tag
const TREASURY = '0x' + '33'.repeat(32)   // carries a system tag ('treasury')

// directoryFoldFor is the server-side half of the accounts-directory fold —
// which of a viewer's own accounts should be folded, and under which of the
// viewer's own tags, resolved the SAME priority-order walk the client's own
// resolveTag() (userTags.ts) uses. It never touches ClickHouse (tagForAccount
// is tagService's in-memory index), so these are plain in-memory unit tests.
describe('directoryFoldFor', () => {
  beforeEach(async () => {
    initUserListService(fakeClient())
    await loadUserLists()
    initTagService(fakeClient({
      'price_data.account_tags': [
        { label_id: 'treasury', label_name: 'Treasury', color: '#74C742', note: '', icon: '🏦', account_id: TREASURY },
      ],
    }))
    await loadTags()
  })

  it('returns null for a viewer with no tags at all', () => {
    expect(directoryFoldFor(VIEWER)).toBeNull()
  })

  it('returns null when every one of the viewer\'s tagged accounts loses to its own system tag', async () => {
    const lib = await createList(OWNER, 'Public', '', 'public')
    const tag = await createTag(OWNER, lib.listId, { name: 'Desk', color: '#000' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [TREASURY], [])
    await subscribePublic(VIEWER, lib.listId)
    // No personal list yet, so the subscribed list ranks AFTER 'system'.
    expect(listOrderFor(VIEWER)).toEqual(['system', lib.listId])
    expect(directoryFoldFor(VIEWER)).toBeNull()
  })

  it('folds every system-tagless member under the viewer\'s own (personal, higher-priority) tag', async () => {
    const lib = await ensurePersonalList(VIEWER)
    const tag = await createTag(VIEWER, lib.listId, { name: 'Whales', color: '#22c55e', icon: '🐳' })
    await setTagMembers(VIEWER, lib.listId, tag.tagId, [A1, A2], [])

    const fold = directoryFoldFor(VIEWER)
    expect(fold).not.toBeNull()
    expect(new Set(fold!.ids)).toEqual(new Set([A1, A2]))
    expect(fold!.keys.every(k => k === `u:${tag.tagId}`)).toBe(true)
    const group = fold!.groups.get(`u:${tag.tagId}`)
    expect(group).toMatchObject({ tagId: tag.tagId, listId: lib.listId, name: 'Whales', color: '#22c55e', memberCount: 2 })
  })

  // The reserved 'system' slot: a subscribed (non-personal) list ranks AFTER
  // it by default, so a member who ALSO carries a system tag is claimed by
  // 'system' first and must be left out of the pairs — while an ordinary
  // member of the SAME tag, with no system tag of its own, still folds.
  it('lets the system tag win a system-tagged member even under a lower-priority user tag, while still folding its system-tagless co-member', async () => {
    const lib = await createList(OWNER, 'Public', '', 'public')
    const tag = await createTag(OWNER, lib.listId, { name: 'Desk', color: '#000' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [TREASURY, A1], [])
    await subscribePublic(VIEWER, lib.listId)
    expect(listOrderFor(VIEWER)).toEqual(['system', lib.listId])

    const fold = directoryFoldFor(VIEWER)
    expect(fold).not.toBeNull()
    expect(fold!.ids).toEqual([A1])
    expect(fold!.keys).toEqual([`u:${tag.tagId}`])
  })

  // A personal list ranks AHEAD of 'system' (listOrderFor's own default), so
  // the SAME system-tagged account instead folds under the viewer's tag when
  // it lives on their personal list rather than a subscribed one.
  it('lets a higher-priority (personal) user tag outrank the system tag for the same account', async () => {
    const lib = await ensurePersonalList(VIEWER)
    const tag = await createTag(VIEWER, lib.listId, { name: 'Mine', color: '#000' })
    await setTagMembers(VIEWER, lib.listId, tag.tagId, [TREASURY], [])
    expect(listOrderFor(VIEWER)).toEqual([lib.listId, 'system'])

    const fold = directoryFoldFor(VIEWER)
    expect(fold).not.toBeNull()
    expect(fold!.ids).toEqual([TREASURY])
    expect(fold!.keys).toEqual([`u:${tag.tagId}`])
  })

  it('carries the tag\'s FULL member count, not just how many of its members ended up in the fold pairs', async () => {
    const lib = await createList(OWNER, 'Public', '', 'public')
    const tag = await createTag(OWNER, lib.listId, { name: 'Desk', color: '#000' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [TREASURY, A1], [])   // 2 members total
    await subscribePublic(VIEWER, lib.listId)   // TREASURY excluded (system wins) — only A1 folds

    const fold = directoryFoldFor(VIEWER)!
    expect(fold.ids).toEqual([A1])
    expect(fold.groups.get(`u:${tag.tagId}`)?.memberCount).toBe(2)
  })

  it('the fingerprint does not depend on member order', async () => {
    const lib = await ensurePersonalList(VIEWER)
    const tag = await createTag(VIEWER, lib.listId, { name: 'Whales', color: '#000' })
    await setTagMembers(VIEWER, lib.listId, tag.tagId, [A1, A2], [])
    const fp1 = directoryFoldFor(VIEWER)!.fingerprint

    await setMemberOrder(VIEWER, lib.listId, tag.tagId, [A2, A1])
    const fp2 = directoryFoldFor(VIEWER)!.fingerprint

    expect(fp1).toBe(fp2)
  })

  it('the fingerprint changes when the fold pairs actually change', async () => {
    const lib = await ensurePersonalList(VIEWER)
    const tag = await createTag(VIEWER, lib.listId, { name: 'Whales', color: '#000' })
    await setTagMembers(VIEWER, lib.listId, tag.tagId, [A1], [])
    const fp1 = directoryFoldFor(VIEWER)!.fingerprint

    await setTagMembers(VIEWER, lib.listId, tag.tagId, [A2], [A1])
    const fp2 = directoryFoldFor(VIEWER)!.fingerprint

    expect(fp1).not.toBe(fp2)
  })
})
