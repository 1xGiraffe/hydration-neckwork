import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { userRoutes } from '../src/routes/user.ts'
import { initUserAuthService, resetUserAuthForTests, issueSession } from '../src/services/userAuthService.ts'
import { initUserListService, loadUserLists, ensurePersonalList, createTag, setTagMembers } from '../src/services/userListService.ts'
import { fakeClient } from './helpers/userFakes.ts'
import type { AccountsPage, AccountSort, ViewerFold } from '../src/services/explorerService.ts'

// The route layer's own job: gate on a session, parse offset/limit/sort the
// exact same way the public /explorer/accounts route does, resolve THIS
// viewer's fold, and pick which of explorerService's two entry points to
// call — never both, never neither. The heavy ClickHouse-backed grouping
// itself is exercised where it lives (accountsViewerFold.test.ts, source-shape
// checks; the two accountsPage sort/grouping suites for the shared query), so
// this stubs both entry points rather than needing a ClickHouse-shaped fake.
// vi.mock's factory is hoisted above the module's own top-level statements,
// so the mocks it returns have to be created inside vi.hoisted() too — a
// plain `const` here would throw "Cannot access ... before initialization".
const { getAccountsMock, getAccountsForViewerFoldMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(async (_offset: number, _limit: number, _sort: AccountSort): Promise<AccountsPage> => ({ rows: [], total: 0 })),
  getAccountsForViewerFoldMock: vi.fn(async (_offset: number, _limit: number, _sort: AccountSort, _fold: ViewerFold): Promise<AccountsPage> => ({
    rows: [{
      account: null,
      tag: { tagId: 'tag-x', name: 'Whales', color: '#22c55e', icon: '🐳', memberCount: 2, userTagId: 'tag-x', listId: 'lib1' },
      portfolioUsd: 1, lastBlock: 1, suppliedUsd: null, borrowedUsd: null,
    }],
    total: 1,
  })),
}))

vi.mock('../src/services/explorerService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/explorerService.ts')>()
  return { ...actual, getAccounts: getAccountsMock, getAccountsForViewerFold: getAccountsForViewerFoldMock }
})

const VIEWER = '0x' + 'aa'.repeat(32)
const MEMBER = '0x' + '11'.repeat(32)

async function build() {
  const f = Fastify()
  await f.register(userRoutes)
  return f
}

describe('GET /user/accounts', () => {
  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(fakeClient())
    initUserListService(fakeClient())
    await loadUserLists()
    getAccountsMock.mockClear()
    getAccountsForViewerFoldMock.mockClear()
  })

  it('401s an anonymous request', async () => {
    const f = await build()
    const r = await f.inject({ method: 'GET', url: '/user/accounts' })
    expect(r.statusCode).toBe(401)
  })

  it('stamps no-store', async () => {
    const token = await issueSession(VIEWER)
    const f = await build()
    const r = await f.inject({ method: 'GET', url: '/user/accounts', headers: { authorization: `Bearer ${token}` } })
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('400s an out-of-range offset, the same rule the public route enforces', async () => {
    const token = await issueSession(VIEWER)
    const f = await build()
    const r = await f.inject({ method: 'GET', url: '/user/accounts?offset=-1', headers: { authorization: `Bearer ${token}` } })
    expect(r.statusCode).toBe(400)
  })

  // A tagless viewer costs nothing beyond the shared endpoint: directoryFoldFor
  // returns null, and the route reaches for getAccounts directly rather than
  // paying for a second, per-viewer cache entry that would be byte-identical
  // to the shared one anyway.
  it('a tagless viewer gets the shared result — never the fold path', async () => {
    const token = await issueSession(VIEWER)
    const f = await build()
    const r = await f.inject({ method: 'GET', url: '/user/accounts', headers: { authorization: `Bearer ${token}` } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ rows: [], total: 0 })
    expect(getAccountsMock).toHaveBeenCalledTimes(1)
    expect(getAccountsForViewerFoldMock).not.toHaveBeenCalled()
  })

  it('a tagged viewer gets the fold — the resolved fold, offset/limit/sort passed straight through', async () => {
    const lib = await ensurePersonalList(VIEWER)
    const tag = await createTag(VIEWER, lib.listId, { name: 'Whales', color: '#22c55e', icon: '🐳' })
    await setTagMembers(VIEWER, lib.listId, tag.tagId, [MEMBER], [])
    const token = await issueSession(VIEWER)

    const f = await build()
    const r = await f.inject({ method: 'GET', url: '/user/accounts?offset=10&limit=25&sort=identity', headers: { authorization: `Bearer ${token}` } })
    expect(r.statusCode).toBe(200)
    expect(r.json().rows).toHaveLength(1)
    expect(r.json().rows[0].tag.userTagId).toBe('tag-x')
    expect(getAccountsMock).not.toHaveBeenCalled()
    expect(getAccountsForViewerFoldMock).toHaveBeenCalledTimes(1)
    const [offset, limit, sort, fold] = getAccountsForViewerFoldMock.mock.calls[0]
    expect([offset, limit, sort]).toEqual([10, 25, 'identity'])
    expect(fold.ids).toEqual([MEMBER])
    expect(fold.keys).toEqual([`u:${tag.tagId}`])
  })
})
