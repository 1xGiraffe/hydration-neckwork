import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { cryptoWaitReady, sr25519PairFromSeed, sr25519Sign, encodeAddress, randomAsU8a } from '@polkadot/util-crypto'
import { u8aToHex, u8aWrapBytes } from '@polkadot/util'
import { userRoutes } from '../src/routes/user.ts'
import { initUserAuthService, resetUserAuthForTests } from '../src/services/userAuthService.ts'
import { initUserListService, loadUserLists, createList, createTag, setTagMembers, invitesFor } from '../src/services/userListService.ts'
import { initUserProfileService, loadUserProfiles } from '../src/services/userProfileService.ts'
import { initExplorerService, loadEvmBindings } from '../src/services/explorerService.ts'
import { fakeClient } from './helpers/userFakes.ts'

beforeAll(async () => { await cryptoWaitReady() })

const OWNER = '0x' + 'aa'.repeat(32)
// A genuine substrate accountId — resolveDisplayAccountId is identity for it,
// with or without any bindings loaded.
const PLAIN_SUBSTRATE = '0x' + 'cc'.repeat(32)
// An EVM signer bound to a substrate account via the evm-accounts pallet.
// resolveDisplayAccountId only reports this binding once account_alias_directory
// (loadEvmBindings) has been loaded — before that it is indistinguishable from
// a genuinely unbound EVM account, exactly like a fresh member add/invite would
// see if the boundary skipped canonicalization.
const BOUND_EVM_H160 = '0x' + '11'.repeat(20)
const BOUND_SUBSTRATE = '0x' + 'bb'.repeat(32)

async function seedBinding() {
  initExplorerService(fakeClient({
    account_alias_directory: [{ evm: BOUND_EVM_H160, account_id: BOUND_SUBSTRATE }],
  }))
  await loadEvmBindings()
}

describe('setTagMembers resolves through resolveDisplayAccountId', () => {
  beforeEach(async () => {
    initUserListService(fakeClient())
    await loadUserLists()
  })

  it('is identity for a plain substrate id with no bindings loaded (existing flows stay unaffected)', async () => {
    const lib = await createList(OWNER, 'L', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T' })
    const updated = await setTagMembers(OWNER, lib.listId, tag.tagId, [PLAIN_SUBSTRATE], [])
    expect([...updated.members]).toEqual([PLAIN_SUBSTRATE])
  })

  it('stores a bound-EVM H160 member under its resolved substrate accountId, not the raw truncated alias', async () => {
    await seedBinding()
    const lib = await createList(OWNER, 'L', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T' })
    const updated = await setTagMembers(OWNER, lib.listId, tag.tagId, [BOUND_EVM_H160], [])
    // Before the fix this stored the unresolved 0x455448... truncated alias —
    // which never equals BOUND_SUBSTRATE, so the tag would never match a pill
    // (pills always carry the resolved accountId).
    expect([...updated.members]).toEqual([BOUND_SUBSTRATE])
  })

  it('removes by the same resolved id it was added under', async () => {
    await seedBinding()
    const lib = await createList(OWNER, 'L', '', 'private')
    const tag = await createTag(OWNER, lib.listId, { name: 'T' })
    await setTagMembers(OWNER, lib.listId, tag.tagId, [BOUND_EVM_H160], [])
    const updated = await setTagMembers(OWNER, lib.listId, tag.tagId, [], [BOUND_EVM_H160])
    expect([...updated.members]).toHaveLength(0)
  })
})

describe('/user/lists/:id/invites resolves the grantee through resolveDisplayAccountId', () => {
  async function build() {
    const f = Fastify()
    await f.register(userRoutes)
    return f
  }
  function wallet() {
    const pair = sr25519PairFromSeed(randomAsU8a(32))
    return { pair, address: encodeAddress(pair.publicKey, 0) }
  }
  async function login(f: Awaited<ReturnType<typeof build>>, w = wallet()) {
    const ch = await f.inject({ method: 'POST', url: '/user/auth/challenge', payload: { address: w.address } })
    const { nonce, message } = ch.json()
    const signature = u8aToHex(sr25519Sign(u8aWrapBytes(message), w.pair))
    const v = await f.inject({ method: 'POST', url: '/user/auth/verify', payload: { address: w.address, nonce, signature } })
    return v.json() as { token: string; me: { account: { accountId: string }; lists: { listId: string }[] } }
  }

  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(fakeClient())
    initUserListService(fakeClient())
    await loadUserLists()
    initUserProfileService(fakeClient())
    await loadUserProfiles()
  })

  it('an invite addressed to a bound-EVM H160 lands under the accountId the invitee actually logs in as', async () => {
    await seedBinding()
    const f = await build()
    const owner = await login(f)
    const libId = owner.me.lists[0].listId
    const invite = await f.inject({
      method: 'POST', url: `/user/lists/${libId}/invites`,
      headers: { authorization: `Bearer ${owner.token}` }, payload: { address: BOUND_EVM_H160 },
    })
    expect(invite.statusCode).toBe(200)
    // BOUND_SUBSTRATE is exactly the session accountId a login as that
    // substrate key resolves to (resolveDisplayAccountId is identity on an
    // already-substrate id) — this is the invitee's real lookup key.
    expect(invitesFor(BOUND_SUBSTRATE).map(l => l.listId)).toEqual([libId])
    // The raw unresolved truncated alias — what would have been stored before
    // the fix — must NOT be left behind as a separate, dangling invite.
    expect(invitesFor('0x45544800' + '11'.repeat(20) + '0'.repeat(16))).toHaveLength(0)
  })
})
