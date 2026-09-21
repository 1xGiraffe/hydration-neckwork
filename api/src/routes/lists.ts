import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getProfileAvatar } from '../services/userProfileService.ts'
import { publicLists, publicListsByOwner, publicListsTagging, publicTagById, publicListSummary, getList } from '../services/userListService.ts'
import { listSummaryRef, listDetailResponse } from './user.ts'
import { listTagReadRoutes } from './listTagRoutes.ts'
import { valueFilters, unusableFilterParam } from './explorer.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import { accountRef, resolveDisplayAccountId } from '../services/explorerService.ts'

// Public read surface for user-authored data. Everything here is identical for
// every viewer, so it stays behind the shared nginx/api caches like the rest of
// /explorer — the per-user views of the same data live under /user/*.
export async function listsRoutes(fastify: FastifyInstance) {
  // The list-tag feeds below take the SAME list filters as the authed twin and
  // the system-tag routes, so they refuse an unusable one the same way —
  // plugin-wide, exactly as explorerRoutes and userRoutes do. A malformed
  // `type`/`asset`/`min`/`unit`/`from`/`to` would otherwise be dropped and the
  // answer silently WIDENED under the caller's own query string.
  fastify.addHook('preHandler', async (req, reply) => {
    const bad = unusableFilterParam(req.query as Record<string, unknown>)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
  })

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

  // A public list's tag, by tag id alone — what a shared /tag/<uuid> link
  // resolves to for a viewer who is not logged in, or is logged in but does not
  // subscribe. Same twelve reads the owner's own /user/list-tag surface serves
  // (one registration, so the two can never drift), with the tag id addressing
  // it because whoever followed the link was never told the list id.
  //
  // What stays shut: publicTagById only ever finds a PUBLIC list's tag, so a
  // private list's tag 404s exactly like an unknown id; the list's own page
  // still shows a non-subscriber nothing but statistics; and a member's account
  // page still names no tag it isn't already naming.
  //
  // The tag id is the whole address, so this answers identically for every
  // viewer and caches like the rest of /explorer.
  const publicTagParams = z.object({ tagId: z.string().min(1).max(64) })
  fastify.get('/explorer/list-tag/:tagId/list', async (req, reply) => {
    const params = publicTagParams.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const tag = publicTagById(params.data.tagId)
    // The provenance line's list name and owner. Behind the tag's own
    // visibility, not the list id's, so it cannot be used to probe list ids.
    const summary = tag && publicListSummary(tag.listId)
    if (!summary) return reply.status(404).send({ error: 'Tag not found' })
    return listSummaryRef(summary)
  })

  listTagReadRoutes(fastify, {
    base: '/explorer/list-tag/:tagId',
    resolve: (req, reply) => {
      const params = publicTagParams.safeParse(req.params)
      if (!params.success) { reply.status(400).send({ error: 'Invalid tag id' }); return null }
      const tag = publicTagById(params.data.tagId)
      if (!tag) { reply.status(404).send({ error: 'Tag not found' }); return null }
      return { listId: tag.listId, tagId: params.data.tagId, tag }
    },
    // No viewer, so no viewer-dependent `identity` filter — exactly what the
    // anonymous /explorer feeds next to this one already apply.
    valueFilters: (_req, q) => valueFilters(q),
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

  // Which public lists TAG this address as a member of one of their tags —
  // the teaser a non-subscriber's own account page may reveal ("this account
  // is tagged somewhere public"). Deliberately the same summary shape as the
  // sibling route above (name, owner, counts) and nothing more. A public list's
  // tag opens to anyone holding a link to it (publicTagById above), but nothing
  // here hands that link out: which tag of theirs names this account, and who
  // else it names, stay with the owner and subscribers, exactly as on the list's
  // own public detail page (see listDetailResponse's identical boundary).
  fastify.get('/explorer/address/:address/tagged-in', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const n = normalizeAddress(params.data.address)
    if (!n) return reply.status(400).send({ error: 'Invalid address' })
    return publicListsTagging(resolveDisplayAccountId(n.accountId)).map(listSummaryRef)
  })
}
