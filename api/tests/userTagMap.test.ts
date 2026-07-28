import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserLibraryService, loadUserLibraries, ensurePersonalLibrary, createLibrary, createTag, setTagMembers, setMemberOrder,
  subscribePublic, setLibraryOrder, libraryOrderFor, tagMapFor, publicLibraries, publicLibrariesByOwner, deleteLibrary,
} from '../src/services/userLibraryService.ts'
import { accountIcon } from '../src/services/omniwatchIdentity.ts'
import { fakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const VIEWER = '0x' + 'bb'.repeat(32)
const A1 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'

describe('priority order and tag map', () => {
  beforeEach(async () => { initUserLibraryService(fakeClient()); await loadUserLibraries() })

  it('defaults to personal, then system, then subscriptions in creation order', async () => {
    const personal = await ensurePersonalLibrary(VIEWER)
    const pub1 = await createLibrary(OWNER, 'P1', '', 'public')
    const pub2 = await createLibrary(OWNER, 'P2', '', 'public')
    await subscribePublic(VIEWER, pub1.libraryId)
    await subscribePublic(VIEWER, pub2.libraryId)
    expect(libraryOrderFor(VIEWER)).toEqual([personal.libraryId, 'system', pub1.libraryId, pub2.libraryId])
  })

  it('honors a stored order, drops stale ids, appends unlisted', async () => {
    const personal = await ensurePersonalLibrary(VIEWER)
    const pub1 = await createLibrary(OWNER, 'P1', '', 'public')
    const pub2 = await createLibrary(OWNER, 'P2', '', 'public')
    await subscribePublic(VIEWER, pub1.libraryId)
    await setLibraryOrder(VIEWER, [pub1.libraryId, 'deleted-lib', 'system', personal.libraryId])
    await subscribePublic(VIEWER, pub2.libraryId)   // subscribed after ordering → appended
    expect(libraryOrderFor(VIEWER)).toEqual([pub1.libraryId, 'system', personal.libraryId, pub2.libraryId])
  })

  it('assembles the tag map in priority order with a system marker', async () => {
    const personal = await ensurePersonalLibrary(VIEWER)
    const pTag = await createTag(VIEWER, personal.libraryId, { name: 'Mine', color: '#0f0' })
    await setTagMembers(VIEWER, personal.libraryId, pTag.tagId, [A1], [])
    const pub = await createLibrary(OWNER, 'Pub', '', 'public')
    const oTag = await createTag(OWNER, pub.libraryId, { name: 'Theirs' })
    await setTagMembers(OWNER, pub.libraryId, oTag.tagId, [A1], [])
    await subscribePublic(VIEWER, pub.libraryId)
    const map = tagMapFor(VIEWER)
    expect(map.map(l => l.libraryId)).toEqual([personal.libraryId, 'system', pub.libraryId])
    expect(map[0].tags[0]).toMatchObject({ name: 'Mine', color: '#0f0' })
    expect(map[0].tags[0].members[0]).toMatch(/^0x[0-9a-f]{64}$/)
    expect(map[1]).toEqual({ libraryId: 'system', name: 'Hydration', tags: [] })
  })

  it('lists public libraries globally and per owner, most subscribed first', async () => {
    const p1 = await createLibrary(OWNER, 'Alpha', '', 'public')
    const p2 = await createLibrary(OWNER, 'Beta', '', 'public')
    await createLibrary(OWNER, 'Hidden', '', 'private')
    await subscribePublic(VIEWER, p2.libraryId)
    expect(publicLibraries().map(l => l.libraryId)).toEqual([p2.libraryId, p1.libraryId])
    expect(publicLibrariesByOwner(OWNER)).toHaveLength(2)
    await deleteLibrary(OWNER, p1.libraryId)
    expect(publicLibraries().map(l => l.libraryId)).toEqual([p2.libraryId])
  })
})

// B2: an unset tag icon derives from the FIRST member in display order, so
// the tag map (every pill's label source) always agrees with the management
// page and the aggregate page — see tagDisplayIcon's own unit tests
// (userTagIcon.test.ts) for the precedence rule itself.
describe('tag map icon derivation follows member order', () => {
  beforeEach(async () => { initUserLibraryService(fakeClient()); await loadUserLibraries() })

  function tagOf(accountId: string, libraryId: string) {
    return tagMapFor(accountId).find(l => l.libraryId === libraryId)!.tags[0]
  }

  it('derives from the first member, and a reorder changes which one', async () => {
    const lib = await createLibrary(OWNER, 'Icons', '', 'private')
    const tag = await createTag(OWNER, lib.libraryId, { name: 'T' })   // no icon → derives
    const m1 = '0x' + '11'.repeat(32)
    const m2 = '0x' + '22'.repeat(32)
    await setTagMembers(OWNER, lib.libraryId, tag.tagId, [m1, m2], [])
    expect(tagOf(OWNER, lib.libraryId).icon).toBe(accountIcon(m1).emojiUrl || accountIcon(m1).emoji)

    await setMemberOrder(OWNER, lib.libraryId, tag.tagId, [m2, m1])
    expect(tagOf(OWNER, lib.libraryId).icon).toBe(accountIcon(m2).emojiUrl || accountIcon(m2).emoji)
  })

  it('an explicit icon always wins over the derived fallback', async () => {
    const lib = await createLibrary(OWNER, 'Icons', '', 'private')
    const tag = await createTag(OWNER, lib.libraryId, { name: 'T', icon: '🔥' })
    await setTagMembers(OWNER, lib.libraryId, tag.tagId, ['0x' + '11'.repeat(32)], [])
    expect(tagOf(OWNER, lib.libraryId).icon).toBe('🔥')
  })

  it('falls back to the tag-icon glyph when the tag has no members yet', async () => {
    const lib = await createLibrary(OWNER, 'Icons', '', 'private')
    await createTag(OWNER, lib.libraryId, { name: 'Empty' })
    expect(tagOf(OWNER, lib.libraryId).icon).toBe('🏷️')
  })
})
