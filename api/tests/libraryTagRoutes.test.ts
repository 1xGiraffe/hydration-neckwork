import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { userRoutes } from '../src/routes/user.ts'
import { librariesRoutes } from '../src/routes/libraries.ts'
import { initUserAuthService, resetUserAuthForTests, issueSession } from '../src/services/userAuthService.ts'
import {
  initUserLibraryService, loadUserLibraries, createLibrary, createTag, setTagMembers,
  inviteToLibrary, respondToInvite,
} from '../src/services/userLibraryService.ts'
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
    getLibraryTagDetail: vi.fn(async (_libraryId: string, presentation: { tagId: string; name: string; color: string; icon: string; note: string }, members: string[]) => {
      if (!members.length) return null
      return {
        tagId: presentation.tagId, name: presentation.name, color: presentation.color, note: presentation.note, icon: presentation.icon,
        members: members.map(stubRef), balances: [], topAssets: [], portfolioUsd: 0,
        moneyMarket: [], liquidityPositions: [], activeDcas: [], portfolioSeries: [], portfolioDates: [], balanceHistory: [],
      } satisfies TagDetail
    }),
    getLibraryTagActivity: vi.fn(async () => []),
    getLibraryTagExtrinsics: vi.fn(async () => []),
    getLibraryTagEvents: vi.fn(async () => []),
    getLibraryTagVotes: vi.fn(async () => []),
    getLibraryTagTabCounts: vi.fn(async () => ({ extrinsics: 0, extrinsicsOnBehalf: 0, events: 0, votes: 0 })),
    getLibraryTagListTotal: vi.fn(async () => ({ total: 0, complete: true })),
    getLibraryTagValueEvents: vi.fn(async () => []),
  }
})

const OWNER = '0x' + 'aa'.repeat(32)
const SUBSCRIBER = '0x' + 'bb'.repeat(32)
const OUTSIDER = '0x' + 'cc'.repeat(32)
const MEMBER_ADDRESS = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'

async function build() {
  const f = Fastify()
  await f.register(userRoutes)
  await f.register(librariesRoutes)
  return f
}

describe('/user/library-tag', () => {
  let libraryId: string
  let tagId: string
  let memberAccountId: string
  let ownerToken: string
  let subscriberToken: string
  let outsiderToken: string

  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(fakeClient())
    initUserLibraryService(fakeClient())
    await loadUserLibraries()

    const lib = await createLibrary(OWNER, 'Desk', 'note', 'private')
    const tag = await createTag(OWNER, lib.libraryId, { name: 'Giraffe', color: '#22c55e', icon: '🦒' })
    const updated = await setTagMembers(OWNER, lib.libraryId, tag.tagId, [MEMBER_ADDRESS], [])
    await inviteToLibrary(OWNER, lib.libraryId, SUBSCRIBER)
    await respondToInvite(SUBSCRIBER, lib.libraryId, true)

    libraryId = lib.libraryId
    tagId = tag.tagId
    memberAccountId = [...updated.members][0]
    ownerToken = await issueSession(OWNER)
    subscriberToken = await issueSession(SUBSCRIBER)
    outsiderToken = await issueSession(OUTSIDER)
  })

  function auth(token: string) { return { authorization: `Bearer ${token}` } }

  it('200s the owner and carries the tag name/color and member accountRefs', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}`, headers: auth(ownerToken) })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body).toMatchObject({ tagId, name: 'Giraffe', color: '#22c55e' })
    expect(body.members).toHaveLength(1)
    expect(body.members[0].accountId).toBe(memberAccountId)
  })

  it('200s an active subscriber', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}`, headers: auth(subscriberToken) })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ tagId, name: 'Giraffe' })
  })

  it('404s a non-subscriber — indistinguishable from an unknown tag', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}`, headers: auth(outsiderToken) })
    expect(r.statusCode).toBe(404)
    const rUnknown = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/not-a-tag`, headers: auth(ownerToken) })
    expect(rUnknown.statusCode).toBe(404)
    expect(rUnknown.json()).toEqual(r.json())
  })

  it('404s an unknown library id', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/library-tag/not-a-library/${tagId}`, headers: auth(ownerToken) })
    expect(r.statusCode).toBe(404)
  })

  it('401s an anonymous request', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}` })
    expect(r.statusCode).toBe(401)
  })

  it('stamps no-store on every response, success or not', async () => {
    const f = await build()
    const ok = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}`, headers: auth(ownerToken) })
    expect(ok.headers['cache-control']).toBe('no-store')
    const anon = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}` })
    expect(anon.headers['cache-control']).toBe('no-store')
  })

  it('gates a feed endpoint (activity) the same way and answers the stubbed empty feed', async () => {
    const f = await build()
    const ok = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}/activity`, headers: auth(ownerToken) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual([])
    const denied = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}/activity`, headers: auth(outsiderToken) })
    expect(denied.statusCode).toBe(404)
    const anon = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}/activity` })
    expect(anon.statusCode).toBe(401)
  })

  it('rejects an unusable activity filter the same way the system tag route does', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}/activity?type=bogus`, headers: auth(ownerToken) })
    expect(r.statusCode).toBe(400)
  })

  it('gates counts, list-count and value-events', async () => {
    const f = await build()
    const counts = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}/counts`, headers: auth(ownerToken) })
    expect(counts.statusCode).toBe(200)
    expect(counts.json()).toMatchObject({ extrinsics: 0, events: 0, votes: 0 })

    const listCount = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}/list-count?tab=activity`, headers: auth(ownerToken) })
    expect(listCount.statusCode).toBe(200)
    expect(listCount.json()).toEqual({ total: 0, complete: true })
    const badTab = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}/list-count?tab=bogus`, headers: auth(ownerToken) })
    expect(badTab.statusCode).toBe(400)

    const valueEvents = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}/value-events`, headers: auth(ownerToken) })
    expect(valueEvents.statusCode).toBe(200)
    expect(valueEvents.json()).toEqual([])

    const denied = await f.inject({ method: 'GET', url: `/user/library-tag/${libraryId}/${tagId}/counts`, headers: auth(outsiderToken) })
    expect(denied.statusCode).toBe(404)
  })
})
