import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { userRoutes } from '../src/routes/user.ts'
import { initUserAuthService, resetUserAuthForTests, issueSession } from '../src/services/userAuthService.ts'
import { initUserListService, loadUserLists, createList, createTag, setTagMembers } from '../src/services/userListService.ts'
import { initUserProfileService, setProfileAvatar } from '../src/services/userProfileService.ts'
import { accountIcon } from '../src/services/omniwatchIdentity.ts'
import { fakeClient } from './helpers/userFakes.ts'

// Regression coverage for a real bug: tagRef used to ship ONE `icon` field
// carrying the DERIVED display value (which can be a profile-avatar URL once
// the first-member fallback engages, or the first member's emoji). The
// management page's edit form seeds itself from that field and resubmits it
// unconditionally on save — so a plain rename would resubmit a URL/derived
// icon straight into `updateTag`, which 422s (checkIcon is emoji-only) or,
// for the emoji case, silently froze the dynamic fallback into a permanent
// explicit icon. The fix ships BOTH `icon` (raw, possibly '') and
// `displayIcon` (derived) — this pins that a caller which reads and
// resubmits `icon` (as the fixed client does) never regresses into either
// failure mode, and that `displayIcon` is never what should be resubmitted.
const OWNER = '0x' + 'aa'.repeat(32)
const MEMBER = '0x' + '11'.repeat(32)
const MEMBER_NO_AVATAR = '0x' + '22'.repeat(32)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])

async function build() {
  const f = Fastify()
  await f.register(userRoutes)
  return f
}

describe('tag icon round-trip: raw vs. derived', () => {
  let token: string
  let listId: string
  let tagId: string

  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(fakeClient())
    initUserListService(fakeClient())
    await loadUserLists()
    initUserProfileService(fakeClient())

    const lib = await createList(OWNER, 'Desk', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'Watch' })   // icon left unset ('')
    await setTagMembers(OWNER, lib.listId, tag.tagId, [MEMBER], [])
    await setProfileAvatar(MEMBER, PNG.toString('base64'))                  // first member now has an avatar
    listId = lib.listId
    tagId = tag.tagId
    token = await issueSession(OWNER)
  })

  function auth(t: string) { return { authorization: `Bearer ${t}` } }

  it('ships a URL-shaped displayIcon but keeps the raw icon empty', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/lists/${listId}`, headers: auth(token) })
    expect(r.statusCode).toBe(200)
    const tag = r.json().tags[0]
    expect(tag.icon).toBe('')
    expect(tag.displayIcon).toMatch(/^\/api\/explorer\/profile-avatar\//)
  })

  it('a rename that resubmits the RAW icon (as the fixed client does) succeeds and leaves the stored icon empty', async () => {
    const f = await build()
    const before = await f.inject({ method: 'GET', url: `/user/lists/${listId}`, headers: auth(token) })
    const rawIcon = before.json().tags[0].icon
    expect(rawIcon).toBe('')

    const renamed = await f.inject({
      method: 'PATCH', url: `/user/lists/${listId}/tags/${tagId}`,
      headers: auth(token), payload: { name: 'Renamed', icon: rawIcon },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ name: 'Renamed', icon: '' })
    expect(renamed.json().displayIcon).toMatch(/^\/api\/explorer\/profile-avatar\//)
  })

  it('resubmitting the DERIVED displayIcon instead — the pre-fix bug — is rejected, which is exactly why the two fields must stay separate', async () => {
    const f = await build()
    const before = await f.inject({ method: 'GET', url: `/user/lists/${listId}`, headers: auth(token) })
    const displayIcon = before.json().tags[0].displayIcon
    expect(displayIcon).toMatch(/^\//)   // URL-shaped

    const renamed = await f.inject({
      method: 'PATCH', url: `/user/lists/${listId}/tags/${tagId}`,
      headers: auth(token), payload: { name: 'Renamed', icon: displayIcon },
    })
    // A profile-avatar URL is over the tag-icon field's 64-char zod cap before
    // it would even reach checkIcon's emoji-only 422 — either way, a plain
    // rename that resubmitted the derived value instead of the raw one fails
    // (400 here; a shorter URL/emoji-glyph-shaped value would 422 instead).
    expect(renamed.statusCode).toBe(400)
    expect(renamed.json().error).toMatch(/invalid tag payload/i)
  })

  // The emoji-only variant of the bug never 422s (an emoji glyph passes
  // checkIcon fine) — its failure mode is silent instead: resubmitting the
  // derived emoji would WRITE it as a permanent explicit icon, freezing what
  // was meant to stay a dynamic per-first-member fallback. A rename that
  // resubmits the raw '' must leave it dynamic.
  it('a rename against a plain-emoji fallback (no avatar) stays dynamic when the client resubmits the raw icon', async () => {
    const f = await build()
    const bare = await createList(OWNER, 'Desk2', '', 'private')
    const bareTag = await createTag(OWNER, bare.listId, { name: 'Bare' })
    await setTagMembers(OWNER, bare.listId, bareTag.tagId, [MEMBER_NO_AVATAR], [])

    const before = await f.inject({ method: 'GET', url: `/user/lists/${bare.listId}`, headers: auth(token) })
    const tag = before.json().tags[0]
    expect(tag.icon).toBe('')
    expect(tag.displayIcon).toBe(accountIcon(MEMBER_NO_AVATAR).emojiUrl || accountIcon(MEMBER_NO_AVATAR).emoji)

    const renamed = await f.inject({
      method: 'PATCH', url: `/user/lists/${bare.listId}/tags/${bareTag.tagId}`,
      headers: auth(token), payload: { name: 'Bare renamed', icon: tag.icon },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().icon).toBe('')   // never frozen into a permanent explicit icon
  })
})
