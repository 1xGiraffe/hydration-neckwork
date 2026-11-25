import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import { sessionUser } from '../services/userAuthService.ts'
import { privateUserHooks, withUserErrors } from './user.ts'
import {
  MAX_ACTIVE_TOKENS, MAX_LABEL_LEN, adminApiUsers, adminClearLimits, adminSetLimits, apiLimitDefaults,
  apiTokenMinMintUsd, createApiToken, isApiAdmin, listApiTokens, revokeApiToken,
} from '../services/userApiTokenService.ts'
import { accountRef, resolveDisplayAccountId } from '../services/explorerService.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import { mintHoldingsUsd } from '../services/apiTokenMintGate.ts'

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

// Non-admins get a 404, never a 403: the admin surface stays invisible. The
// session is already resolved by the plugin's private hook.
function requireAdmin(req: FastifyRequest, reply: FastifyReply): string | null {
  const accountId = sessionUser(req)
  if (!isApiAdmin(accountId)) {
    void reply.status(404).send({ error: 'Not found' })
    return null
  }
  return accountId
}

// The account a limit override is stored under, resolved exactly as login
// resolves the session's account: tokens are minted under that id, so an
// override keyed by any other form of the same account would never apply.
function limitsAccount(req: FastifyRequest): string | null {
  const normalized = normalizeAddress((req.params as { accountId: string }).accountId)
  return normalized ? resolveDisplayAccountId(normalized.accountId) : null
}

export async function apiTokenRoutes(fastify: FastifyInstance) {
  // Scoped to this plugin's encapsulation context, like the user routes.
  await fastify.register(rateLimit, { max: 60, timeWindow: '1 minute' })

  // Every route here is private: no shared cache, no anonymous access (see
  // privateUserHooks). Registered once for the plugin, never per handler.
  privateUserHooks(fastify)

  fastify.get('/user/api-tokens', async (req) => {
    const accountId = sessionUser(req)
    return { tokens: await listApiTokens(accountId), maxTokens: MAX_ACTIVE_TOKENS, docsUrl: 'https://hydration-data.neckwork.net/docs' }
  })

  // The per-route brake sits above MAX_ACTIVE_TOKENS so the cap's own 422 is
  // reachable within one window; minting is still bounded.
  //
  // Every account gets its own Data API budget, so minting needs the account
  // to hold more than DATA_API_MIN_MINT_USD in total (services/apiTokenMintGate.ts:
  // the explorer's account value, any asset, net of money-market debt) —
  // otherwise fresh accounts would multiply the budget for free. Identity,
  // votes and the forum's own gates do not count. Checked here, at mint time
  // only; a minted token is never re-checked on use. Admins are exempt. A value
  // that cannot be read refuses the mint (503, retryable), never allows it.
  fastify.post('/user/api-tokens', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const accountId = sessionUser(req)
    const body = createBody.safeParse(req.body ?? {})
    if (!body.success) return reply.status(400).send({ error: 'Invalid token payload' })
    if (!isApiAdmin(accountId)) {
      const minUsd = apiTokenMinMintUsd()
      let valueUsd: number
      try {
        valueUsd = await mintHoldingsUsd(accountId)
      } catch (err) {
        req.log.warn({ errClass: (err as Error)?.name ?? typeof err }, 'api token mint: account value unavailable')
        return reply.status(503).header('Retry-After', '30').send({
          error: 'Your account value could not be checked right now, so no token was created. Please try again in a minute.',
          reason: 'valuation-unavailable',
        })
      }
      if (!(valueUsd > minUsd)) {
        return reply.status(403).send({
          error: `Creating an API token needs an account holding more than $${minUsd} in total, counting every asset at current prices.`,
          reason: 'insufficient-balance',
        })
      }
    }
    // The response carries the raw token — the only time it ever leaves the
    // service. The UI shows it once with a copy button.
    return withUserErrors(reply, () => createApiToken(accountId, body.data.label ?? ''))
  })

  fastify.delete('/user/api-tokens/:tokenHash', async (req, reply) => {
    const accountId = sessionUser(req)
    const { tokenHash } = req.params as { tokenHash: string }
    if (!TOKEN_HASH_RE.test(tokenHash)) return reply.status(400).send({ error: 'Invalid token id' })
    return withUserErrors(reply, async () => { await revokeApiToken(accountId, tokenHash); return { ok: true } })
  })

  // ---- Admin ----

  fastify.get('/user/admin/api-users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const users = await adminApiUsers()
    return {
      defaults: apiLimitDefaults(),
      users: users.map(({ accountId, ...rest }) => ({ account: accountRef(accountId), ...rest })),
    }
  })

  fastify.put('/user/admin/api-users/:accountId/limits', async (req, reply) => {
    const admin = requireAdmin(req, reply)
    if (!admin) return
    const target = limitsAccount(req)
    if (!target) return reply.status(400).send({ error: 'Invalid account' })
    const body = limitsBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid limits payload' })
    return withUserErrors(reply, async () => {
      await adminSetLimits(admin, target, body.data.perMinute, body.data.perDay, body.data.note ?? '')
      return { ok: true }
    })
  })

  fastify.delete('/user/admin/api-users/:accountId/limits', async (req, reply) => {
    const admin = requireAdmin(req, reply)
    if (!admin) return
    const target = limitsAccount(req)
    if (!target) return reply.status(400).send({ error: 'Invalid account' })
    return withUserErrors(reply, async () => { await adminClearLimits(admin, target); return { ok: true } })
  })

  fastify.delete('/user/admin/api-tokens/:tokenHash', async (req, reply) => {
    const admin = requireAdmin(req, reply)
    if (!admin) return
    const { tokenHash } = req.params as { tokenHash: string }
    if (!TOKEN_HASH_RE.test(tokenHash)) return reply.status(400).send({ error: 'Invalid token id' })
    return withUserErrors(reply, async () => { await revokeApiToken(admin, tokenHash, true); return { ok: true } })
  })
}
