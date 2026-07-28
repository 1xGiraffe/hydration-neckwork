import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getProfileAvatar } from '../services/userProfileService.ts'
import { publicLibraries, publicLibrariesByOwner, getLibrary } from '../services/userLibraryService.ts'
import { libSummaryRef, libraryDetailResponse } from './user.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import { resolveDisplayAccountId } from '../services/explorerService.ts'

// Public read surface for user-authored data. Everything here is identical for
// every viewer, so it stays behind the shared nginx/api caches like the rest of
// /explorer — the per-user views of the same data live under /user/*.
export async function librariesRoutes(fastify: FastifyInstance) {
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

  fastify.get('/explorer/libraries', async () => publicLibraries().map(libSummaryRef))

  const libParam = z.object({ id: z.string().min(1).max(64) })
  fastify.get('/explorer/library/:id', async (req, reply) => {
    const params = libParam.safeParse(req.params)
    if (!params.success) return reply.status(404).send({ error: 'Library not found' })
    const lib = getLibrary(params.data.id)
    // Private libraries are indistinguishable from missing ones here — their
    // per-user view is GET /user/libraries/:id.
    if (!lib || lib.visibility !== 'public') return reply.status(404).send({ error: 'Library not found' })
    return libraryDetailResponse(lib, null)
  })

  const addressParam = z.object({ address: z.string().min(3).max(128) })
  fastify.get('/explorer/address/:address/libraries', async (req, reply) => {
    const params = addressParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid address' })
    const n = normalizeAddress(params.data.address)
    if (!n) return reply.status(400).send({ error: 'Invalid address' })
    return publicLibrariesByOwner(resolveDisplayAccountId(n.accountId)).map(libSummaryRef)
  })
}
