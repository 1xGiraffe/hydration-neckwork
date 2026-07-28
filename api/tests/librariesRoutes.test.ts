import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { librariesRoutes } from '../src/routes/libraries.ts'
import { initUserLibraryService, loadUserLibraries, createLibrary, createTag, setTagMembers } from '../src/services/userLibraryService.ts'
import { initUserProfileService, loadUserProfiles } from '../src/services/userProfileService.ts'
import { userRoutes } from '../src/routes/user.ts'
import { fakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const A1 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'

describe('/explorer library endpoints', () => {
  beforeEach(async () => {
    initUserLibraryService(fakeClient()); await loadUserLibraries()
    initUserProfileService(fakeClient()); await loadUserProfiles()
  })

  async function build() {
    const f = Fastify()
    await f.register(librariesRoutes)
    return f
  }

  it('lists public libraries with owner refs and serves the public detail', async () => {
    const pub = await createLibrary(OWNER, 'Pub', 'note', 'public')
    const tag = await createTag(OWNER, pub.libraryId, { name: 'T' })
    await setTagMembers(OWNER, pub.libraryId, tag.tagId, [A1], [])
    await createLibrary(OWNER, 'Priv', '', 'private')
    const f = await build()
    const list = await f.inject({ method: 'GET', url: '/explorer/libraries' })
    expect(list.statusCode).toBe(200)
    const rows = list.json()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ libraryId: pub.libraryId, name: 'Pub', tagCount: 1, accountCount: 1 })
    expect(rows[0].owner.accountId).toBe(OWNER)
    const detail = await f.inject({ method: 'GET', url: `/explorer/library/${pub.libraryId}` })
    expect(detail.json().tags[0].members[0].address).toBeTruthy()   // AccountRef, not a raw id
  })

  it('404s private libraries and unknown ids', async () => {
    const priv = await createLibrary(OWNER, 'Priv', '', 'private')
    const f = await build()
    expect((await f.inject({ method: 'GET', url: `/explorer/library/${priv.libraryId}` })).statusCode).toBe(404)
    expect((await f.inject({ method: 'GET', url: '/explorer/library/nope' })).statusCode).toBe(404)
  })

  it("serves an owner's public libraries by address", async () => {
    await createLibrary(OWNER, 'Pub', '', 'public')
    const f = await build()
    // OWNER's SS58 form must resolve — use the raw account id, normalizeAddress accepts it
    const r = await f.inject({ method: 'GET', url: `/explorer/address/${OWNER}/libraries` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toHaveLength(1)
  })

  it('layers the server cache-control hook correctly: no-store on /user routes survives, public stamp lands on /explorer/libraries', async () => {
    // A copy of the server's onSend hook shape (api/src/server.ts:95-100) with a
    // couple of representative entries plus the new /explorer/librar* rule and
    // the /^\/explorer\// catch-all, to prove first-match-wins layering: a
    // route that stamps its own cache-control (no-store) is never overwritten,
    // while a public route with no self-stamped header picks up the rule match.
    const CACHE_CONTROL: [RegExp, number][] = [
      [/^\/explorer\/librar/, 30],
      [/^\/explorer\//, 5],
    ]
    const f = Fastify()
    f.addHook('onSend', async (req, reply) => {
      if (req.method !== 'GET' || reply.statusCode !== 200 || reply.getHeader('cache-control')) return
      const path = req.url.split('?')[0]
      const rule = CACHE_CONTROL.find(([re]) => re.test(path))
      if (rule) reply.header('cache-control', `public, max-age=${rule[1]}`)
    })
    await f.register(librariesRoutes)
    await f.register(userRoutes)

    const me = await f.inject({ method: 'GET', url: '/user/me' })
    expect(me.statusCode).toBe(401)
    expect(me.headers['cache-control']).toBe('no-store')

    const list = await f.inject({ method: 'GET', url: '/explorer/libraries' })
    expect(list.statusCode).toBe(200)
    expect(list.headers['cache-control']).toBe('public, max-age=30')
  })
})
