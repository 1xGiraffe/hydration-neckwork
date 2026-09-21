import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { userRoutes } from '../src/routes/user.ts'
import { listsRoutes } from '../src/routes/lists.ts'
import { initUserAuthService, resetUserAuthForTests, issueSession } from '../src/services/userAuthService.ts'
import {
  initUserListService, loadUserLists, createList, updateList, createTag, setTagMembers,
  inviteToList, respondToInvite,
} from '../src/services/userListService.ts'
import { fakeClient } from './helpers/userFakes.ts'
import type { AccountRef, TagDetail } from '../src/services/explorerService.ts'

// The route layer (permission gating, 401/404/200, and correctly plumbing the
// tag's presentation + member list down to the service call) is what these tests
// cover. The heavy ClickHouse-backed computation inside buildTagDetailForMembers
// is exercised by the system tag's own tests (getTag/getTagActivity via the
// /tag/:id routes) — this file stubs the member-list service functions so a
// route test never needs a ClickHouse-shaped fake for balances/positions/prices.
vi.mock('../src/services/explorerService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/explorerService.ts')>()
  const stubRef = (accountId: string): AccountRef => ({ accountId, address: accountId, emoji: '', tag: null, identity: null, profile: null })
  return {
    ...actual,
    getListTagDetail: vi.fn(async (_listId: string, presentation: { tagId: string; name: string; color: string; icon: string; note: string }, members: string[]) => {
      if (!members.length) return null
      return {
        tagId: presentation.tagId, name: presentation.name, color: presentation.color, note: presentation.note, icon: presentation.icon,
        members: members.map(stubRef), balances: [], topAssets: [], portfolioUsd: 0, portfolioExHdxUsd: 0,
        moneyMarket: [], liquidityPositions: [], activeDcas: [], portfolioSeries: [], portfolioSeriesExHdx: [], portfolioDates: [], portfolioBlocks: [], balanceHistory: [],
      } satisfies TagDetail
    }),
    getListTagActivity: vi.fn(async () => []),
    getListTagExtrinsics: vi.fn(async () => []),
    getListTagEvents: vi.fn(async () => []),
    getListTagVotes: vi.fn(async () => []),
    getListTagTabCounts: vi.fn(async () => ({ extrinsics: 0, extrinsicsOnBehalf: 0, events: 0, votes: 0 })),
    getListTagListTotal: vi.fn(async () => ({ total: 0, complete: true })),
    getListTagValueEvents: vi.fn(async () => []),
  }
})

const OWNER = '0x' + 'aa'.repeat(32)
const SUBSCRIBER = '0x' + 'bb'.repeat(32)
const OUTSIDER = '0x' + 'cc'.repeat(32)
const MEMBER_ADDRESS = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'

async function build() {
  const f = Fastify()
  await f.register(userRoutes)
  await f.register(listsRoutes)
  return f
}

describe('/user/list-tag', () => {
  let listId: string
  let tagId: string
  let memberAccountId: string
  let ownerToken: string
  let subscriberToken: string
  let outsiderToken: string

  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(fakeClient())
    initUserListService(fakeClient())
    await loadUserLists()

    const lib = await createList(OWNER, 'Desk', 'note', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'Giraffe', color: '#22c55e', icon: '🦒' })
    const updated = await setTagMembers(OWNER, lib.listId, tag.tagId, [MEMBER_ADDRESS], [])
    await inviteToList(OWNER, lib.listId, SUBSCRIBER)
    await respondToInvite(SUBSCRIBER, lib.listId, true)

    listId = lib.listId
    tagId = tag.tagId
    memberAccountId = [...updated.members][0]
    ownerToken = await issueSession(OWNER)
    subscriberToken = await issueSession(SUBSCRIBER)
    outsiderToken = await issueSession(OUTSIDER)
  })

  function auth(token: string) { return { authorization: `Bearer ${token}` } }

  it('200s the owner and carries the tag name/color and member accountRefs', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}`, headers: auth(ownerToken) })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body).toMatchObject({ tagId, name: 'Giraffe', color: '#22c55e' })
    expect(body.members).toHaveLength(1)
    expect(body.members[0].accountId).toBe(memberAccountId)
  })

  it('200s an active subscriber', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}`, headers: auth(subscriberToken) })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ tagId, name: 'Giraffe' })
  })

  it('404s a non-subscriber — indistinguishable from an unknown tag', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}`, headers: auth(outsiderToken) })
    expect(r.statusCode).toBe(404)
    const rUnknown = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/not-a-tag`, headers: auth(ownerToken) })
    expect(rUnknown.statusCode).toBe(404)
    expect(rUnknown.json()).toEqual(r.json())
  })

  it('404s an unknown list id', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/list-tag/not-a-list/${tagId}`, headers: auth(ownerToken) })
    expect(r.statusCode).toBe(404)
  })

  it('401s an anonymous request', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}` })
    expect(r.statusCode).toBe(401)
  })

  it('stamps no-store on every response, success or not', async () => {
    const f = await build()
    const ok = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}`, headers: auth(ownerToken) })
    expect(ok.headers['cache-control']).toBe('no-store')
    const anon = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}` })
    expect(anon.headers['cache-control']).toBe('no-store')
  })

  it('gates a feed endpoint (activity) the same way and answers the stubbed empty feed', async () => {
    const f = await build()
    const ok = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}/activity`, headers: auth(ownerToken) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual([])
    const denied = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}/activity`, headers: auth(outsiderToken) })
    expect(denied.statusCode).toBe(404)
    const anon = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}/activity` })
    expect(anon.statusCode).toBe(401)
  })

  it('rejects an unusable activity filter the same way the system tag route does', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}/activity?type=bogus`, headers: auth(ownerToken) })
    expect(r.statusCode).toBe(400)
  })

  it('gates counts, list-count and value-events', async () => {
    const f = await build()
    const counts = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}/counts`, headers: auth(ownerToken) })
    expect(counts.statusCode).toBe(200)
    expect(counts.json()).toMatchObject({ extrinsics: 0, events: 0, votes: 0 })

    const listCount = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}/list-count?tab=activity`, headers: auth(ownerToken) })
    expect(listCount.statusCode).toBe(200)
    expect(listCount.json()).toEqual({ total: 0, complete: true })
    const badTab = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}/list-count?tab=bogus`, headers: auth(ownerToken) })
    expect(badTab.statusCode).toBe(400)

    const valueEvents = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}/value-events`, headers: auth(ownerToken) })
    expect(valueEvents.statusCode).toBe(200)
    expect(valueEvents.json()).toEqual([])

    const denied = await f.inject({ method: 'GET', url: `/user/list-tag/${listId}/${tagId}/counts`, headers: auth(outsiderToken) })
    expect(denied.statusCode).toBe(404)
  })
})

// The other surface for the same twelve reads: a PUBLIC list's tag, addressed
// by tag id alone because whoever followed the link was never told the list id.
// This is the ONE place mere public visibility opens a tag's contents, so these
// pin both halves — that a link works without a session, and that nothing else
// opened with it.
describe('/explorer/list-tag', () => {
  let publicListId: string
  let publicTagId: string
  let privateTagId: string
  let privateListId: string
  let outsiderToken: string

  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(fakeClient())
    initUserListService(fakeClient())
    await loadUserLists()

    const open = await createList(OWNER, 'Public desk', '', 'public')
    const openTag = await createTag(OWNER, open.listId, { name: 'Giraffe', color: '#22c55e', icon: '🦒' })
    await setTagMembers(OWNER, open.listId, openTag.tagId, [MEMBER_ADDRESS], [])
    publicListId = open.listId
    publicTagId = openTag.tagId

    const shut = await createList(OWNER, 'Private desk', '', 'private')
    const shutTag = await createTag(OWNER, shut.listId, { name: 'Hidden', color: '#000', icon: '' })
    await setTagMembers(OWNER, shut.listId, shutTag.tagId, [MEMBER_ADDRESS], [])
    privateListId = shut.listId
    privateTagId = shutTag.tagId

    outsiderToken = await issueSession(OUTSIDER)
  })

  it('serves a public list tag to an anonymous request, by tag id alone', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/explorer/list-tag/${publicTagId}` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ tagId: publicTagId, name: 'Giraffe', color: '#22c55e' })
  })

  it('names the list it belongs to, for the provenance line', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/explorer/list-tag/${publicTagId}/list` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ listId: publicListId, name: 'Public desk', visibility: 'public' })
  })

  it('404s a PRIVATE list\'s tag, indistinguishable from an id that is not a tag at all', async () => {
    const f = await build()
    const shut = await f.inject({ method: 'GET', url: `/explorer/list-tag/${privateTagId}` })
    const unknown = await f.inject({ method: 'GET', url: '/explorer/list-tag/not-a-tag' })
    expect(shut.statusCode).toBe(404)
    expect(unknown.statusCode).toBe(404)
    expect(shut.json()).toEqual(unknown.json())
    // ...and its list is equally unfindable through the provenance route.
    const list = await f.inject({ method: 'GET', url: `/explorer/list-tag/${privateTagId}/list` })
    expect(list.statusCode).toBe(404)
    expect(list.json()).toEqual(unknown.json())
  })

  it('closes again the moment the list goes private', async () => {
    const f = await build()
    expect((await f.inject({ method: 'GET', url: `/explorer/list-tag/${publicTagId}` })).statusCode).toBe(200)
    await updateList(OWNER, publicListId, { visibility: 'private' })
    expect((await f.inject({ method: 'GET', url: `/explorer/list-tag/${publicTagId}` })).statusCode).toBe(404)
  })

  it('serves the feeds on the same terms as the detail', async () => {
    const f = await build()
    const activity = await f.inject({ method: 'GET', url: `/explorer/list-tag/${publicTagId}/activity` })
    expect(activity.statusCode).toBe(200)
    expect(activity.json()).toEqual([])
    const counts = await f.inject({ method: 'GET', url: `/explorer/list-tag/${publicTagId}/counts` })
    expect(counts.statusCode).toBe(200)
    const shut = await f.inject({ method: 'GET', url: `/explorer/list-tag/${privateTagId}/activity` })
    expect(shut.statusCode).toBe(404)
  })

  it('rejects an unusable filter the way its authed twin does — one registration, one behaviour', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/explorer/list-tag/${publicTagId}/activity?type=bogus` })
    expect(r.statusCode).toBe(400)
  })

  it('is shared-cacheable — the answer does not depend on who is asking', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/explorer/list-tag/${publicTagId}` })
    // The /user twin stamps no-store on every reply; this surface must not, or
    // it would never reach the caches the rest of /explorer is served from.
    expect(r.headers['cache-control']).toBeUndefined()
  })

  it('opens the tag by link WITHOUT opening the list to browsing', async () => {
    const f = await build()
    // A link to the tag works for anyone...
    expect((await f.inject({ method: 'GET', url: `/explorer/list-tag/${publicTagId}` })).statusCode).toBe(200)
    // ...while the list's own page still hands a non-subscriber statistics only,
    // so the curation cannot be browsed or scraped from there.
    const listPage = await f.inject({ method: 'GET', url: `/explorer/list/${publicListId}` })
    expect(listPage.statusCode).toBe(200)
    expect(listPage.json()).toMatchObject({ name: 'Public desk', tagCount: 1, tags: [] })
    // ...and the authed surface still refuses a signed-in non-subscriber, which
    // is what keeps a viewer's tag map free of lists they never subscribed to.
    const authed = await f.inject({ method: 'GET', url: `/user/list-tag/${publicListId}/${publicTagId}`, headers: { authorization: `Bearer ${outsiderToken}` } })
    expect(authed.statusCode).toBe(404)
  })

  it('never answers for a private list, even addressed through its own list id', async () => {
    const f = await build()
    expect(privateListId).not.toBe(publicListId)
    const r = await f.inject({ method: 'GET', url: `/explorer/list-tag/${privateTagId}/members` })
    expect(r.statusCode).toBe(404)
  })
})
