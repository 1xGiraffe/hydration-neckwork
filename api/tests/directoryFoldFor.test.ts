import { describe, it, expect, beforeEach } from 'vitest'
import {
  initUserListService, loadUserLists, ensurePersonalList, createList, createTag, updateTag, setTagMembers, setMemberOrder,
  subscribePublic, listOrderFor, directoryFoldFor, LIMITS, MAX_DIRECTORY_FOLD_PAIRS,
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

  // I3: membership pairs alone under-describe what a cached fold page would
  // show — a rename/recolor/re-icon changes it too, with no id:key pair
  // moving at all.
  it('the fingerprint changes on a rename even though the fold pairs are unchanged', async () => {
    const lib = await ensurePersonalList(VIEWER)
    const tag = await createTag(VIEWER, lib.listId, { name: 'Whales', color: '#22c55e', icon: '🐳' })
    await setTagMembers(VIEWER, lib.listId, tag.tagId, [A1], [])
    const fold1 = directoryFoldFor(VIEWER)!

    await updateTag(VIEWER, lib.listId, tag.tagId, { name: 'Mega whales' })
    const fold2 = directoryFoldFor(VIEWER)!

    expect(fold2.ids).toEqual(fold1.ids)
    expect(fold2.keys).toEqual(fold1.keys)
    expect(fold2.fingerprint).not.toBe(fold1.fingerprint)
  })

  // I3, the subtler case: a winning tag's reported memberCount is its FULL
  // membership (see the "carries the tag's FULL member count" test above),
  // which can change from a member the fold itself never wins — here, one
  // added to the SAME tag through a DIFFERENT list, where it loses to a
  // higher-priority tag. No id:key pair moves; the presentation attached to
  // the OTHER winning row (memberCount) does.
  it('the fingerprint changes when a winning tag\'s memberCount changes via a member it does not itself win', async () => {
    const Z = '0x' + '44'.repeat(32)
    const W = '0x' + '55'.repeat(32)
    const personal = await ensurePersonalList(VIEWER)
    const t1 = await createTag(VIEWER, personal.listId, { name: 'Mine', color: '#000' })
    await setTagMembers(VIEWER, personal.listId, t1.tagId, [Z], [])

    const pub = await createList(OWNER, 'Public', '', 'public')
    const t2 = await createTag(OWNER, pub.listId, { name: 'Desk', color: '#000' })
    await setTagMembers(OWNER, pub.listId, t2.tagId, [W], [])
    await subscribePublic(VIEWER, pub.listId)
    expect(listOrderFor(VIEWER)).toEqual([personal.listId, 'system', pub.listId])

    const fold1 = directoryFoldFor(VIEWER)!
    const pairs1 = new Map(fold1.ids.map((id, i) => [id, fold1.keys[i]]))
    expect(pairs1.get(Z)).toBe(`u:${t1.tagId}`)
    expect(pairs1.get(W)).toBe(`u:${t2.tagId}`)
    expect(fold1.groups.get(`u:${t2.tagId}`)?.memberCount).toBe(1)

    // Z joins t2 too (a DIFFERENT list, so one-tag-per-account-per-list never
    // blocks it) — t2's own membership grows, but Z's winner is still t1
    // (the personal list outranks this subscribed one), so the fold PAIRS
    // this viewer sees are unchanged: only t2's presentation, attached to
    // W's row, is different.
    await setTagMembers(OWNER, pub.listId, t2.tagId, [Z], [])
    const fold2 = directoryFoldFor(VIEWER)!
    const pairs2 = new Map(fold2.ids.map((id, i) => [id, fold2.keys[i]]))
    expect(pairs2.get(Z)).toBe(`u:${t1.tagId}`)
    expect(pairs2.get(W)).toBe(`u:${t2.tagId}`)
    expect(fold2.groups.get(`u:${t2.tagId}`)?.memberCount).toBe(2)

    expect(fold2.fingerprint).not.toBe(fold1.fingerprint)
  })

  // C2: memoization — a second call with nothing mutated in between must be
  // served from the memo, not recomputed (object identity is the tell: a
  // fresh computeDirectoryFold() always builds a new object, even given
  // identical inputs). A real mutation invalidates it.
  it('memoizes per viewer until a mutation actually happens, and invalidates on one', async () => {
    const lib = await ensurePersonalList(VIEWER)
    const tag = await createTag(VIEWER, lib.listId, { name: 'Whales', color: '#000' })
    await setTagMembers(VIEWER, lib.listId, tag.tagId, [A1], [])

    const fold1 = directoryFoldFor(VIEWER)
    const fold2 = directoryFoldFor(VIEWER)
    expect(fold2).toBe(fold1)

    await setTagMembers(VIEWER, lib.listId, tag.tagId, [A2], [A1])
    const fold3 = directoryFoldFor(VIEWER)
    expect(fold3).not.toBe(fold1)
    expect(fold3!.ids).toEqual([A2])
  })
})

// C2: an oversized fold is dropped WHOLESALE, not truncated — see
// directoryFoldFor's own MAX_DIRECTORY_FOLD_PAIRS comment for the sizing. The
// cap is a budget on how much SQL one page build carries (the fold rides the
// query text), not the request-URI limit it used to be, so the counts here are
// derived from the constant rather than written out: a cap change must move
// this test's data with it, never quietly stop exercising the boundary.
describe('directoryFoldFor — the fold-size cap', () => {
  beforeEach(async () => {
    initUserListService(fakeClient())
    await loadUserLists()
    initTagService(fakeClient({}))
    await loadTags()
  })

  const idsFrom = (offset: number, n: number): string[] =>
    Array.from({ length: n }, (_, i) => '0x' + (offset + i).toString(16).padStart(64, '0'))

  // One list cannot reach the cap on its own (LIMITS.membersPerList), and one
  // tag cannot fill a list (LIMITS.membersPerTag), so an oversized viewer is
  // necessarily spread over several lists and many tags — which is exactly the
  // shape a heavy tagger has, and the shape that used to lose folding silently.
  it('returns null once candidates exceed the cap, rather than folding a truncated subset', async () => {
    let next = 0
    let placed = 0
    for (let l = 0; placed <= MAX_DIRECTORY_FOLD_PAIRS; l++) {
      const list = l === 0 ? await ensurePersonalList(VIEWER) : await createList(VIEWER, `L${l}`, '', 'private')
      for (let t = 0; t < LIMITS.membersPerList / LIMITS.membersPerTag && placed <= MAX_DIRECTORY_FOLD_PAIRS; t++) {
        const tag = await createTag(VIEWER, list.listId, { name: `T${l}-${t}`, color: '#000' })
        await setTagMembers(VIEWER, list.listId, tag.tagId, idsFrom(next, LIMITS.membersPerTag), [])
        next += LIMITS.membersPerTag
        placed += LIMITS.membersPerTag
      }
    }
    expect(placed).toBeGreaterThan(MAX_DIRECTORY_FOLD_PAIRS)
    expect(directoryFoldFor(VIEWER)).toBeNull()
  })

  // The regression this cap's old value caused: a viewer with a few thousand
  // tagged accounts folds, where under the URI-bound cap of 3,000 they silently
  // got the anonymous directory back while their tag pills kept rendering.
  it('folds a viewer whose footprint is in the thousands', async () => {
    const lib = await ensurePersonalList(VIEWER)
    for (let t = 0; t < 4; t++) {
      const tag = await createTag(VIEWER, lib.listId, { name: `T${t}`, color: '#000' })
      await setTagMembers(VIEWER, lib.listId, tag.tagId, idsFrom(t * 2_000, 2_000), [])
    }
    const fold = directoryFoldFor(VIEWER)
    expect(fold).not.toBeNull()
    expect(fold!.ids).toHaveLength(8_000)
  })

  it('a viewer comfortably under the cap still folds normally', async () => {
    const lib = await ensurePersonalList(VIEWER)
    const tag = await createTag(VIEWER, lib.listId, { name: 'A', color: '#000' })
    await setTagMembers(VIEWER, lib.listId, tag.tagId, idsFrom(0, 100), [])

    const fold = directoryFoldFor(VIEWER)
    expect(fold).not.toBeNull()
    expect(fold!.ids).toHaveLength(100)
  })
})
