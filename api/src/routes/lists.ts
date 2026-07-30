import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getProfileAvatar } from '../services/userProfileService.ts'
import { publicLists, publicListsByOwner, getList } from '../services/userListService.ts'
import { listSummaryRef, listDetailResponse } from './user.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import { accountRef, resolveDisplayAccountId } from '../services/explorerService.ts'

// Public read surface for user-authored data. Everything here is identical for
// every viewer, so it stays behind the shared nginx/api caches like the rest of
// /explorer — the per-user views of the same data live under /user/*.
export async function listsRoutes(fastify: FastifyInstance) {
  const accountParam = z.object({ accountId: z.string().regex(/^0x[0-9a-f]{64}$/) })

  fastify.get('/explorer/profile-avatar/:accountId', async (req, reply) => {
    const params = accountParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid account id' })
    const avatar = await getProfileAvatar(params.data.accountId)
    if (!avatar) return reply.status(404).send({ error: 'No avatar' })
    // The ?v=<avatarVersion> query is part of the URL the UI builds, so the
    // representation behind any given URL never changes → cache forever.
    reply.header('cache-control', 'public, max-age=31536000, immutable')
    reply.header('x-content-type-options', 'nosniff')
    reply.type(avatar.contentType)
    return reply.send(avatar.bytes)
  })

  fastify.get('/explorer/lists', async () => publicLists().map(listSummaryRef))

  const listParam = z.object({ id: z.string().min(1).max(64) })
  fastify.get('/explorer/list/:id', async (req, reply) => {
    const params = listParam.safeParse(req.params)
    if (!params.success) return reply.status(404).send({ error: 'List not found' })
    const list = getList(params.data.id)
    // Private lists are indistinguishable from missing ones here — their
    // per-user view is GET /user/lists/:id.
    if (!list || list.visibility !== 'public') return reply.status(404).send({ error: 'List not found' })
    return listDetailResponse(list, null)
  })

  // Display refs for a short list of wallet addresses, so the connect dialog
  // can show accounts exactly the way pills do (canonical Polkadot SS58 / H160
  // form plus identity/profile) instead of the extension's generic substrate
  // encoding. Answers in input order, null per unparseable entry, so the
  // client zips the response back onto the extension's account list.
  const refsQuery = z.object({ addresses: z.string().min(1).max(2048) })
  fastify.get('/explorer/account-refs', async (req, reply) => {
    const query = refsQuery.safeParse(req.query)
    if (!query.success) return reply.status(400).send({ error: 'Missing addresses' })
    const addresses = query.data.addresses.split(',').map(a => a.trim()).filter(Boolean)
    if (!addresses.length || addresses.length > 20) return reply.status(400).send({ error: 'Between 1 and 20 addresses' })
    return addresses.map(a => {
      const n = normalizeAddress(a)
      return n ? accountRef(resolveDisplayAccountId(n.accountId)) : null
    })
  })

  const addressParam = z.object({ address: z.string().min(3).max(128) })
  fastify.get('/explorer/address/:address/lists', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const n = normalizeAddress(params.data.address)
    if (!n) return reply.status(400).send({ error: 'Invalid address' })
    return publicListsByOwner(resolveDisplayAccountId(n.accountId)).map(listSummaryRef)
  })
}
