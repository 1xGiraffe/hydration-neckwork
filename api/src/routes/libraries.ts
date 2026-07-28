import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getProfileAvatar } from '../services/userProfileService.ts'

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
}
