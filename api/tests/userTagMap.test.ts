import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserListService, loadUserLists, ensurePersonalList, createList, createTag, setTagMembers, setMemberOrder,
  subscribePublic, setListOrder, listOrderFor, tagMapFor, publicLists, publicListsByOwner, deleteList,
} from '../src/services/userListService.ts'
import { accountIcon } from '../src/services/omniwatchIdentity.ts'
import { fakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const VIEWER = '0x' + 'bb'.repeat(32)
const A1 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'

describe('priority order and tag map', () => {
  beforeEach(async () => { initUserListService(fakeClient()); await loadUserLists() })

  it('defaults to personal, then system, then subscriptions in creation order', async () => {
    const personal = await ensurePersonalList(VIEWER)
    const pub1 = await createList(OWNER, 'P1', '', 'public')
    const pub2 = await createList(OWNER, 'P2', '', 'public')
    await subscribePublic(VIEWER, pub1.listId)
    await subscribePublic(VIEWER, pub2.listId)
    expect(listOrderFor(VIEWER)).toEqual([personal.listId, 'system', pub1.listId, pub2.listId])
  })

  it('honors a stored order, drops stale ids, appends unlisted', async () => {
    const personal = await ensurePersonalList(VIEWER)
    const pub1 = await createList(OWNER, 'P1', '', 'public')
    const pub2 = await createList(OWNER, 'P2', '', 'public')
    await subscribePublic(VIEWER, pub1.listId)
    await setListOrder(VIEWER, [pub1.listId, 'deleted-list', 'system', personal.listId])
    await subscribePublic(VIEWER, pub2.listId)   // subscribed after ordering → appended
    expect(listOrderFor(VIEWER)).toEqual([pub1.listId, 'system', personal.listId, pub2.listId])
  })

  it('assembles the tag map in priority order with a system marker', async () => {
    const personal = await ensurePersonalList(VIEWER)
    const pTag = await createTag(VIEWER, personal.listId, { name: 'Mine', color: '#0f0' })
    await setTagMembers(VIEWER, personal.listId, pTag.tagId, [A1], [])
    const pub = await createList(OWNER, 'Pub', '', 'public')
    const oTag = await createTag(OWNER, pub.listId, { name: 'Theirs' })
    await setTagMembers(OWNER, pub.listId, oTag.tagId, [A1], [])
    await subscribePublic(VIEWER, pub.listId)
    const map = tagMapFor(VIEWER)
    expect(map.map(l => l.listId)).toEqual([personal.listId, 'system', pub.listId])
    expect(map[0].tags[0]).toMatchObject({ name: 'Mine', color: '#0f0' })
    expect(map[0].tags[0].members[0]).toMatch(/^0x[0-9a-f]{64}$/)
    expect(map[1]).toEqual({ listId: 'system', name: 'Hydration', tags: [] })
  })

  it('lists public lists globally and per owner, most subscribed first', async () => {
    const p1 = await createList(OWNER, 'Alpha', '', 'public')
    const p2 = await createList(OWNER, 'Beta', '', 'public')
    await createList(OWNER, 'Hidden', '', 'private')
    await subscribePublic(VIEWER, p2.listId)
    expect(publicLists().map(l => l.listId)).toEqual([p2.listId, p1.listId])
    expect(publicListsByOwner(OWNER)).toHaveLength(2)
    await deleteList(OWNER, p1.listId)
    expect(publicLists().map(l => l.listId)).toEqual([p2.listId])
  })
})

// B2: an unset tag icon derives from the FIRST member in display order, so
// the tag map (every pill's label source) always agrees with the management
// page and the aggregate page — see tagDisplayIcon's own unit tests
// (userTagIcon.test.ts) for the precedence rule itself.
describe('tag map icon derivation follows member order', () => {
  beforeEach(async () => { initUserListService(fakeClient()); await loadUserLists() })

  function tagOf(accountId: string, listId: string) {
    return tagMapFor(accountId).find(l => l.listId === listId)!.tags[0]
  }

  it('derives from the first member, and a reorder changes which one', async () => {
    const lib = await createList(OWNER, 'Icons', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T' })   // no icon → derives
    const m1 = '0x' + '11'.repeat(32)
    const m2 = '0x' + '22'.repeat(32)
    await setTagMembers(OWNER, lib.listId, tag.tagId, [m1, m2], [])
    expect(tagOf(OWNER, lib.listId).icon).toBe(accountIcon(m1).emojiUrl || accountIcon(m1).emoji)

    await setMemberOrder(OWNER, lib.listId, tag.tagId, [m2, m1])
    expect(tagOf(OWNER, lib.listId).icon).toBe(accountIcon(m2).emojiUrl || accountIcon(m2).emoji)
  })

  it('an explicit icon always wins over the derived fallback', async () => {
    const lib = await createList(OWNER, 'Icons', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T', icon: '🔥' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, ['0x' + '11'.repeat(32)], [])
    expect(tagOf(OWNER, lib.listId).icon).toBe('🔥')
  })

  it('falls back to the tag-icon glyph when the tag has no members yet', async () => {
    const lib = await createList(OWNER, 'Icons', '', 'private')
    await createTag(OWNER, lib.listId, { name: 'Empty' })
    expect(tagOf(OWNER, lib.listId).icon).toBe('🏷️')
  })
})
