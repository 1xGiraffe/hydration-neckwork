import type { FastifyInstance, FastifyReply } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import {
  createChallenge, verifyChallenge, issueSession, revokeSession, requireUser,
} from '../services/userAuthService.ts'
import { accountRef, resolveDisplayAccountId } from '../services/explorerService.ts'
import { setProfileName, setProfileAvatar, clearProfileAvatar, profileForAccount, UserDataError } from '../services/userProfileService.ts'

// Authenticated, per-user endpoints. Everything here is invisible to the shared
// caches by construction: `no-store` is stamped on every reply (the server-wide
// onSend hook skips replies that already carry cache-control), and nginx serves
// /api/user/ from an uncached location. Auth is a bearer token — no cookies, so
// the API keeps CORS `origin: '*'` without ever carrying credentials in a
// cacheable request.
export function noStore(reply: FastifyReply): void { reply.header('cache-control', 'no-store') }

// UserDataError carries its own HTTP status (422 caps, 403 ownership, 404 unknown ids).
export async function withUserErrors<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn() } catch (err) {
    if (err instanceof UserDataError) { void reply.status(err.status).send({ error: err.message }); return undefined }
    throw err
  }
}

const addressBody = z.object({ address: z.string().min(3).max(128) })
const verifyBody = z.object({ address: z.string().min(3).max(128), nonce: z.string().min(16).max(64), signature: z.string().min(64).max(600) })

// Assembled fully from Task 8 on; until then only libraries/subscriptions/invites/order stay empty.
export async function meResponse(accountId: string) {
  return { account: accountRef(accountId), profile: profileForAccount(accountId), libraries: [], subscriptions: [], invites: [], order: [] }
}

export async function userRoutes(fastify: FastifyInstance) {
  // Scoped to this plugin's encapsulation context — explorer routes unaffected.
  await fastify.register(rateLimit, { max: 120, timeWindow: '1 minute' })

  fastify.post('/user/auth/challenge', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    noStore(reply)
    const body = addressBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid address' })
    const challenge = createChallenge(req.headers.host ?? 'Hydration Explorer', body.data.address)
    if (!challenge) return reply.status(400).send({ error: 'Invalid address' })
    return challenge
  })

  fastify.post('/user/auth/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    noStore(reply)
    const body = verifyBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid login payload' })
    const verified = verifyChallenge(body.data.nonce, body.data.address, body.data.signature)
    if (!verified) return reply.status(401).send({ error: 'Signature verification failed' })
    // Canonicalize exactly like the display side: a bound EVM signer lands on
    // the substrate account the explorer already shows for it.
    const accountId = resolveDisplayAccountId(verified)
    const token = await issueSession(accountId)
    return { token, me: await meResponse(accountId) }
  })

  fastify.post('/user/auth/logout', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    await revokeSession((req.headers.authorization as string).slice(7))
    return { ok: true }
  })

  fastify.get('/user/me', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    return meResponse(accountId)
  })

  const nameBody = z.object({ name: z.string().max(200) })
  const avatarBody = z.object({ data: z.string().min(4).max(120_000) })  // 64 KiB binary ≈ 87 KiB base64

  fastify.put('/user/profile', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = nameBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid profile payload' })
    return withUserErrors(reply, () => setProfileName(accountId, body.data.name))
  })

  fastify.put('/user/profile/avatar', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = avatarBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid avatar payload' })
    return withUserErrors(reply, () => setProfileAvatar(accountId, body.data.data))
  })

  fastify.delete('/user/profile/avatar', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    return clearProfileAvatar(accountId)
  })
}
