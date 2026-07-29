import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { cryptoWaitReady, encodeAddress, randomAsU8a } from '@polkadot/util-crypto'
import { listsRoutes } from '../src/routes/lists.ts'
import { initUserListService, loadUserLists, createList, createTag, setTagMembers } from '../src/services/userListService.ts'
import { initUserProfileService, loadUserProfiles } from '../src/services/userProfileService.ts'
import { userRoutes } from '../src/routes/user.ts'
import { fakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const A1 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'

describe('/explorer list endpoints', () => {
  beforeEach(async () => {
    initUserListService(fakeClient()); await loadUserLists()
    initUserProfileService(fakeClient()); await loadUserProfiles()
  })

  async function build() {
    const f = Fastify()
    await f.register(listsRoutes)
    return f
  }

  it('lists public lists with owner refs and serves the public detail', async () => {
    const pub = await createList(OWNER, 'Pub', 'note', 'public')
    const tag = await createTag(OWNER, pub.listId, { name: 'T' })
    await setTagMembers(OWNER, pub.listId, tag.tagId, [A1], [])
    await createList(OWNER, 'Priv', '', 'private')
    const f = await build()
    const list = await f.inject({ method: 'GET', url: '/explorer/lists' })
    expect(list.statusCode).toBe(200)
    const rows = list.json()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ listId: pub.listId, name: 'Pub', tagCount: 1, accountCount: 1 })
    expect(rows[0].owner.accountId).toBe(OWNER)
    const detail = await f.inject({ method: 'GET', url: `/explorer/list/${pub.listId}` })
    // Another user's curation is never enumerable — the public detail carries
    // only the statistics; tag names and members stay with the owner.
    expect(detail.json().tags).toEqual([])
    expect(detail.json()).toMatchObject({ tagCount: 1, accountCount: 1 })
  })

  it('404s private lists and unknown ids', async () => {
    const priv = await createList(OWNER, 'Priv', '', 'private')
    const f = await build()
    expect((await f.inject({ method: 'GET', url: `/explorer/list/${priv.listId}` })).statusCode).toBe(404)
    expect((await f.inject({ method: 'GET', url: '/explorer/list/nope' })).statusCode).toBe(404)
  })

  it("serves an owner's public lists by address", async () => {
    await createList(OWNER, 'Pub', '', 'public')
    const f = await build()
    // OWNER's SS58 form must resolve — use the raw account id, normalizeAddress accepts it
    const r = await f.inject({ method: 'GET', url: `/explorer/address/${OWNER}/lists` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toHaveLength(1)
  })

  it('layers the server cache-control hook correctly: no-store on /user routes survives, public stamp lands on /explorer/lists', async () => {
    // A copy of the server's onSend hook shape (api/src/server.ts:95-100) with a
    // couple of representative entries plus the new /explorer/list* rule and
    // the /^\/explorer\// catch-all, to prove first-match-wins layering: a
    // route that stamps its own cache-control (no-store) is never overwritten,
    // while a public route with no self-stamped header picks up the rule match.
    const CACHE_CONTROL: [RegExp, number][] = [
      [/^\/explorer\/list/, 30],
      [/^\/explorer\//, 5],
    ]
    const f = Fastify()
    f.addHook('onSend', async (req, reply) => {
      if (req.method !== 'GET' || reply.statusCode !== 200 || reply.getHeader('cache-control')) return
      const path = req.url.split('?')[0]
      const rule = CACHE_CONTROL.find(([re]) => re.test(path))
      if (rule) reply.header('cache-control', `public, max-age=${rule[1]}`)
    })
    await f.register(listsRoutes)
    await f.register(userRoutes)

    const me = await f.inject({ method: 'GET', url: '/user/me' })
    expect(me.statusCode).toBe(401)
    expect(me.headers['cache-control']).toBe('no-store')

    const list = await f.inject({ method: 'GET', url: '/explorer/lists' })
    expect(list.statusCode).toBe(200)
    expect(list.headers['cache-control']).toBe('public, max-age=30')
  })
})

// The connect dialog lists wallet accounts exactly the way pills do elsewhere:
// canonical display address (Polkadot SS58 / H160, never the extension's
// generic substrate encoding) plus identity/profile. The endpoint answers in
// input order with null for entries that don't parse, so the client can zip
// the response back onto the extension's account list.
describe('/explorer/account-refs', () => {
  beforeEach(async () => {
    initUserListService(fakeClient()); await loadUserLists()
    initUserProfileService(fakeClient()); await loadUserProfiles()
  })

  async function build() {
    const f = Fastify()
    await f.register(listsRoutes)
    return f
  }

  it('answers in input order with the Polkadot display form', async () => {
    await cryptoWaitReady()
    const pubkey = randomAsU8a(32)
    const generic = encodeAddress(pubkey, 42)   // what extensions typically return
    const polkadot = encodeAddress(pubkey, 0)
    const f = await build()
    const r = await f.inject({ method: 'GET', url: `/explorer/account-refs?addresses=${generic},not-an-address` })
    expect(r.statusCode).toBe(200)
    const refs = r.json()
    expect(refs).toHaveLength(2)
    expect(refs[0].address).toBe(polkadot)
    expect(refs[0].accountId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(refs[1]).toBeNull()
  })

  it('rejects an oversized or empty list', async () => {
    const f = await build()
    const many = Array.from({ length: 21 }, () => '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ').join(',')
    expect((await f.inject({ method: 'GET', url: `/explorer/account-refs?addresses=${many}` })).statusCode).toBe(400)
    expect((await f.inject({ method: 'GET', url: '/explorer/account-refs' })).statusCode).toBe(400)
  })
})
