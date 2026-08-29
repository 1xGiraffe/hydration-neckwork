import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import { requireUser } from '../services/userAuthService.ts'
import { noStore, withUserErrors } from './user.ts'
import {
  MAX_ACTIVE_TOKENS, MAX_LABEL_LEN, adminApiUsers, adminClearLimits, adminSetLimits, apiLimitDefaults,
  createApiToken, isApiAdmin, listApiTokens, revokeApiToken,
} from '../services/userApiTokenService.ts'
import { accountRef } from '../services/explorerService.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'

// Control plane for the Data API (hydration-data host): token CRUD for the
// logged-in account, and the admin surface (per-account limits, usage
// overview, admin revoke). The data plane itself lives in src/data/ and only
// reads what these routes write.

const TOKEN_HASH_RE = /^[0-9a-f]{64}$/

const createBody = z.object({ label: z.string().max(MAX_LABEL_LEN).optional() })
const limitsBody = z.object({
  perMinute: z.number().int(),
  perDay: z.number().int(),
  note: z.string().max(400).optional(),
})

// Non-admins get a 404, never a 403: the admin surface stays invisible.
function requireAdmin(req: FastifyRequest, reply: FastifyReply): string | null {
  const accountId = requireUser(req, reply)
  if (!accountId) return null
  if (!isApiAdmin(accountId)) {
    void reply.status(404).send({ error: 'Not found' })
    return null
  }
  return accountId
}

export async function apiTokenRoutes(fastify: FastifyInstance) {
  // Scoped to this plugin's encapsulation context, like the user routes.
  await fastify.register(rateLimit, { max: 60, timeWindow: '1 minute' })

  fastify.get('/user/api-tokens', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    return { tokens: await listApiTokens(accountId), maxTokens: MAX_ACTIVE_TOKENS, docsUrl: 'https://hydration-data.neckwork.net/docs' }
  })

  // The per-route brake sits above MAX_ACTIVE_TOKENS so the cap's own 422 is
  // reachable within one window; minting is still bounded.
  fastify.post('/user/api-tokens', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = createBody.safeParse(req.body ?? {})
    if (!body.success) return reply.status(400).send({ error: 'Invalid token payload' })
    // The response carries the raw token — the only time it ever leaves the
    // service. The UI shows it once with a copy button.
    return withUserErrors(reply, () => createApiToken(accountId, body.data.label ?? ''))
  })

  fastify.delete('/user/api-tokens/:tokenHash', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { tokenHash } = req.params as { tokenHash: string }
    if (!TOKEN_HASH_RE.test(tokenHash)) return reply.status(400).send({ error: 'Invalid token id' })
    return withUserErrors(reply, async () => { await revokeApiToken(accountId, tokenHash); return { ok: true } })
  })

  // ---- Admin ----

  fastify.get('/user/admin/api-users', async (req, reply) => {
    noStore(reply)
    if (!requireAdmin(req, reply)) return
    const users = await adminApiUsers()
    return {
      defaults: apiLimitDefaults(),
      users: users.map(({ accountId, ...rest }) => ({ account: accountRef(accountId), ...rest })),
    }
  })

  fastify.put('/user/admin/api-users/:accountId/limits', async (req, reply) => {
    noStore(reply)
    const admin = requireAdmin(req, reply)
    if (!admin) return
    const normalized = normalizeAddress((req.params as { accountId: string }).accountId)
    if (!normalized) return reply.status(400).send({ error: 'Invalid account' })
    const body = limitsBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid limits payload' })
    return withUserErrors(reply, async () => {
      await adminSetLimits(admin, normalized.accountId, body.data.perMinute, body.data.perDay, body.data.note ?? '')
      return { ok: true }
    })
  })

  fastify.delete('/user/admin/api-users/:accountId/limits', async (req, reply) => {
    noStore(reply)
    const admin = requireAdmin(req, reply)
    if (!admin) return
    const normalized = normalizeAddress((req.params as { accountId: string }).accountId)
    if (!normalized) return reply.status(400).send({ error: 'Invalid account' })
    return withUserErrors(reply, async () => { await adminClearLimits(admin, normalized.accountId); return { ok: true } })
  })

  fastify.delete('/user/admin/api-tokens/:tokenHash', async (req, reply) => {
    noStore(reply)
    const admin = requireAdmin(req, reply)
    if (!admin) return
    const { tokenHash } = req.params as { tokenHash: string }
    if (!TOKEN_HASH_RE.test(tokenHash)) return reply.status(400).send({ error: 'Invalid token id' })
    return withUserErrors(reply, async () => { await revokeApiToken(admin, tokenHash, true); return { ok: true } })
  })
}
