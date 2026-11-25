import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, SEGMENT, api, forumApi, govApi, seg, userApi } from '../src/api/explorer'
import { oraclesApi } from '../src/api/oracles'
import { setSession } from '../src/session'

// An id written into an api path stays ONE segment of that path: a `.`/`..` segment
// or an id outside its shape is refused before any request is made, so a crafted
// id (from the address bar, which the router decodes) never addresses a different
// endpoint — with the reader's session or without it.

function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  }
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  setSession({ token: 't'.repeat(64), accountId: '0x' + 'aa'.repeat(32), address: '15Reader' })
  fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const requested = () => fetchMock.mock.calls.map(c => String(c[0]))

/** The call refused before any request: thrown, or (for an async builder) rejected, with a 400 ApiError. */
async function refused(call: () => Promise<unknown>) {
  let error: unknown
  try { await call() } catch (e) { error = e }
  expect(error).toBeInstanceOf(ApiError)
  expect((error as ApiError).status).toBe(400)
}

describe('seg', () => {
  it('encodes an id as one segment', () => {
    expect(seg('7KTFfPoa44KxwZsa5N3syqxoSPddApcioLEMUEjYY8cohVos')).toBe('7KTFfPoa44KxwZsa5N3syqxoSPddApcioLEMUEjYY8cohVos')
    expect(seg('referendum:opengov:12')).toBe('referendum%3Aopengov%3A12')
    expect(seg('c#1@x')).toBe('c%231%40x')
    expect(seg('dia:0xab:DOT/USD', SEGMENT.oracleFeed)).toBe('dia%3A0xab%3ADOT%2FUSD')
  })

  it('refuses dot segments and anything outside the shape', () => {
    for (const bad of ['.', '..', '', '../x', 'a/b', 'a\\b', 'a%2Fb', 'a b', 'a\nb', 'a?b', 'x'.repeat(201)]) {
      expect(() => seg(bad), JSON.stringify(bad)).toThrow(ApiError)
    }
    expect(() => seg('dia:x:../../user', SEGMENT.oracleFeed)).toThrow(ApiError)
    expect(() => seg('dia:x:a\\b', SEGMENT.oracleFeed)).toThrow(ApiError)
    expect(() => seg('not-a-uuid', SEGMENT.uuid)).toThrow(ApiError)
  })
})

describe('the api client', () => {
  it('sends a well-formed id', async () => {
    await userApi.deleteList('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    await forumApi.setReport('0123456789abcdef0123456789abcdef', 'resolved')
    await oraclesApi.feed('dia:0x' + 'ab'.repeat(20) + ':DOT/USD', '30d', 0)
    await api.extrinsic('0x' + 'cd'.repeat(32))
    expect(requested()).toEqual([
      '/api/user/lists/7c9e6679-7425-40de-944b-e07fc1f90ae7',
      '/api/user/admin/forum/reports/0123456789abcdef0123456789abcdef',
      `/api/explorer/oracle/dia%3A0x${'ab'.repeat(20)}%3ADOT%2FUSD?range=30d`,
      `/api/explorer/extrinsic/0x${'cd'.repeat(32)}`,
    ])
  })

  it('refuses a traversing id before any request, with the session or without', async () => {
    await refused(() => userApi.deleteList('../api-tokens/x'))
    await refused(() => userApi.deleteList('..'))
    await refused(() => userApi.revokeSession('x/../../api-tokens/y'))
    await refused(() => userApi.updateTag('list', '..', { name: 'x' }))
    await refused(() => userApi.listTag('..%2F..%2Fsessions', 'tag'))
    await refused(() => forumApi.deletePost('../../sessions/x'))
    await refused(() => forumApi.setReport('../../moderate', 'resolved'))
    await refused(() => forumApi.setReport('not-hex', 'dismissed'))
    await refused(() => userApi.deviceLinkStatus('../sessions'))
    await refused(() => api.extrinsic('../user/me'))
    await refused(() => api.v3Pool('..'))
    await refused(() => api.address('a/../../user/me'))
    await refused(() => govApi.post('..'))
    await refused(() => oraclesApi.feed('dia:x:../../user/me', '30d', 0))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
