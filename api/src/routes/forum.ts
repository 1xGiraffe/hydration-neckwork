import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import { requireUser, sessionUser } from '../services/userAuthService.ts'
import { privateUserHooks } from './user.ts'
import { accountRef } from '../services/explorerService.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import { forumReady } from '../services/forumStore.ts'
import { FORUM_TOPICS, LIMITS } from '../services/forumText.ts'
import { FORUM_LIMITS } from '../services/forumLimits.ts'
import {
  ForumWriteError, MOD_ACTIONS, MOD_REASONS, PROBE_REPORTER, REPORT_REASONS, addUpdate, applyModeration, createComment, createDiscussion, deleteComment,
  deletePost, editComment, editPost, fileReport, isForumModerator, moderationQueue, postPermissions, setMute, setReportStatus,
  standingOf, type WriteContext,
} from '../services/forumWrite.ts'
import { removeMedia, uploadImage, uploadStanding } from '../services/forumMedia.ts'
import { MAX_IMAGE_BYTES } from '../services/imageSanitize.ts'

// The forum's authenticated surface: /user/forum/* (writes by the signed-in account)
// and /user/admin/forum/* (moderators: ADMIN_ACCOUNT_IDS ∪ FORUM_MODERATOR_ACCOUNT_IDS,
// a 404 for everyone else). Like every /user/ route: a bearer session (never a
// cookie, so no cross-site request carries a credential — CSRF does not apply),
// `no-store`, and nginx serves /api/user/ from an uncached location.
//
// A write answers with the new row and the forum `generation` it produced; a reader
// re-fetching with `?g=<generation>` misses every cache layer, so the author sees the
// write at once. Logs name a write by route, account, target and outcome only — never
// a body, a report note or a sanction's reason.

const forumId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_:@.#-]+$/)
const CID_V1 = /^b[a-z2-7]{50,100}$/

function ctxOf(req: FastifyRequest): WriteContext {
  return { accountId: sessionUser(req), ip: req.ip ?? null }
}

async function run<T>(req: FastifyRequest, reply: FastifyReply, route: string, target: string | null, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    const out = await fn()
    req.log.info({ forum: route, account: sessionUser(req), target, outcome: 'ok' }, 'forum write')
    return out
  } catch (err) {
    if (err instanceof ForumWriteError) {
      req.log.info({ forum: route, account: sessionUser(req), target, outcome: err.code }, 'forum write refused')
      if (err.retryAfterSec) reply.header('retry-after', String(err.retryAfterSec))
      return reply.status(err.status).send({ error: err.message, reason: err.code, ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}) })
    }
    // The error's class and code only: a database error can quote the row it refused,
    // and a forum row may be a private report note.
    req.log.error({ forum: route, account: sessionUser(req), target, outcome: 'error', errClass: errClass(err) }, 'forum write failed')
    return reply.status(500).send({ error: 'The forum could not save this — nothing was changed. Try again.', reason: 'error' })
  }
}

/** An error's class and code, never its message. */
export function errClass(err: unknown): string {
  if (!(err instanceof Error)) return typeof err
  const code = (err as { code?: unknown; type?: unknown }).code ?? (err as { type?: unknown }).type
  return typeof code === 'string' || typeof code === 'number' ? `${err.name}:${code}` : err.name
}

const bodyObj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {})

export async function forumRoutes(fastify: FastifyInstance): Promise<void> {
  // A per-address brake on the whole surface; the per-account windows are forumLimits.ts.
  await fastify.register(rateLimit, { max: 120, timeWindow: '1 minute' })
  // An image upload is refused before its body is read when it carries no live
  // session: onRequest runs before the body parser, so an anonymous 5 MiB body is
  // never buffered.
  fastify.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.url === '/user/forum/media' && !requireUser(req, reply)) return reply
  })
  privateUserHooks(fastify)

  // Image bytes arrive raw on one route only; every other body here is JSON under the
  // server's 1 MiB default.
  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES + 1024 }, (_req, body, done) => done(null, body))

  // Who am I here, and what may I do — the UI explains a gate before anyone types.
  fastify.get('/user/forum/me', async (req) => {
    const accountId = sessionUser(req)
    const [standing, upload] = await Promise.all([standingOf(accountId), uploadStanding(accountId)])
    return {
      account: accountRef(accountId),
      ...standing,
      topics: FORUM_TOPICS,
      limits: {
        titleChars: LIMITS.titleChars, postBodyChars: LIMITS.postBodyChars, commentBodyChars: LIMITS.commentBodyChars,
        labelsPerPost: LIMITS.labelsPerPost, mentionsPerItem: LIMITS.mentionsPerItem, reportNoteChars: LIMITS.reportNoteChars,
        linksPerBody: standing.linksUnlimited ? null : LIMITS.linksPerBodyLowBalance,
        discussionsPerHour: FORUM_LIMITS.discussion[0].max, commentsPerMinute: FORUM_LIMITS.comment[0].max,
      },
      upload,
      ready: forumReady(),
    }
  })

  fastify.get('/user/forum/permissions/:postId', async (req, reply) => {
    const p = z.object({ postId: forumId }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid post id' })
    return postPermissions(sessionUser(req), p.data.postId)
  })

  fastify.post('/user/forum/discussions', async (req, reply) =>
    run(req, reply, 'discussion.create', null, () => createDiscussion(ctxOf(req), bodyObj(req.body))))

  fastify.patch('/user/forum/posts/:postId', async (req, reply) => {
    const p = z.object({ postId: forumId }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid post id' })
    return run(req, reply, 'post.edit', p.data.postId, () => editPost(ctxOf(req), p.data.postId, bodyObj(req.body)))
  })

  fastify.delete('/user/forum/posts/:postId', async (req, reply) => {
    const p = z.object({ postId: forumId }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid post id' })
    return run(req, reply, 'post.delete', p.data.postId, async () => ({ ok: true, ...(await deletePost(ctxOf(req), p.data.postId)) }))
  })

  fastify.post('/user/forum/posts/:postId/updates', async (req, reply) => {
    const p = z.object({ postId: forumId }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid post id' })
    return run(req, reply, 'post.update', p.data.postId, () => addUpdate(ctxOf(req), p.data.postId, bodyObj(req.body)))
  })

  fastify.post('/user/forum/comments', async (req, reply) => {
    const body = bodyObj(req.body)
    if (typeof body.threadKey !== 'string' || !forumId.safeParse(body.threadKey).success) return reply.status(400).send({ error: 'Invalid thread key' })
    if (body.parentId != null && body.parentId !== '' && !forumId.safeParse(body.parentId).success) return reply.status(400).send({ error: 'Invalid reply target' })
    return run(req, reply, 'comment.create', body.threadKey, () => createComment(ctxOf(req), body))
  })

  fastify.patch('/user/forum/comments/:id', async (req, reply) => {
    const p = z.object({ id: forumId }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid comment id' })
    return run(req, reply, 'comment.edit', p.data.id, () => editComment(ctxOf(req), p.data.id, bodyObj(req.body)))
  })

  fastify.delete('/user/forum/comments/:id', async (req, reply) => {
    const p = z.object({ id: forumId }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid comment id' })
    return run(req, reply, 'comment.delete', p.data.id, async () => ({ ok: true, ...(await deleteComment(ctxOf(req), p.data.id)) }))
  })

  fastify.post('/user/forum/media', { bodyLimit: MAX_IMAGE_BYTES + 1024 }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.status(415).send({ error: 'Send the image bytes as application/octet-stream.', reason: 'content-type' })
    const bytes = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength)
    return run(req, reply, 'media.upload', null, () => uploadImage(ctxOf(req), bytes))
  })

  fastify.post('/user/forum/reports', async (req, reply) => {
    const body = bodyObj(req.body)
    // Logged by route and reporter only: who reported what is private (user_forum_reports).
    return run(req, reply, 'report', null, () => fileReport(ctxOf(req), body))
  })

  // ---- moderators ----

  function requireModerator(req: FastifyRequest, reply: FastifyReply): string | null {
    const accountId = sessionUser(req)
    if (!isForumModerator(accountId)) { void reply.status(404).send({ error: 'Not found' }); return null }
    return accountId
  }

  fastify.get('/user/admin/forum/queue', async (req, reply) => {
    if (!requireModerator(req, reply)) return reply
    const q = await moderationQueue()
    const ref = (id: string) => (/^0x[0-9a-f]{64}$/.test(id) ? accountRef(id) : null)
    const shape = (i: Awaited<ReturnType<typeof moderationQueue>>['reported'][number]) => ({
      ...i, author: ref(i.author), reports: i.reports.map(r => ({ ...r, reporter: ref(r.reporter), ...(r.reporter === PROBE_REPORTER ? { system: 'Import guard' } : {}) })),
    })
    return { reported: q.reported.map(shape), recent: q.recent.map(shape), actions: MOD_ACTIONS, reasons: MOD_REASONS, reportReasons: REPORT_REASONS }
  })

  fastify.post('/user/admin/forum/moderate', async (req, reply) => {
    const moderator = requireModerator(req, reply)
    if (!moderator) return reply
    const body = z.object({
      targetId: z.string().min(1).max(160),
      action: z.enum([...MOD_ACTIONS, 'media-remove']),
      reasonCode: z.enum(MOD_REASONS),
    }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid moderation request' })
    const { targetId, action, reasonCode } = body.data
    if (action === 'media-remove') {
      if (!CID_V1.test(targetId) && !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(targetId)) return reply.status(400).send({ error: 'Invalid CID' })
      return run(req, reply, 'moderate.media-remove', targetId, async () => ({ ok: true, ...(await removeMedia(moderator, targetId, reasonCode)) }))
    }
    if (!forumId.safeParse(targetId).success) return reply.status(400).send({ error: 'Invalid target id' })
    return run(req, reply, `moderate.${action}`, targetId, async () => ({ ok: true, ...(await applyModeration(moderator, targetId, action, reasonCode)) }))
  })

  fastify.post('/user/admin/forum/reports/:id', async (req, reply) => {
    if (!requireModerator(req, reply)) return reply
    const p = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }).safeParse(req.params)
    const body = z.object({ status: z.enum(['resolved', 'dismissed']) }).safeParse(req.body)
    if (!p.success || !body.success) return reply.status(400).send({ error: 'Invalid report update' })
    const ok = await setReportStatus(p.data.id, body.data.status)
    return ok ? { ok: true } : reply.status(404).send({ error: 'Unknown report' })
  })

  fastify.post('/user/admin/forum/sanctions', async (req, reply) => {
    const moderator = requireModerator(req, reply)
    if (!moderator) return reply
    const body = z.object({ account: z.string().min(3).max(128), until: z.string().max(40).nullable(), reason: z.string().max(500).default('') }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid sanction' })
    const n = normalizeAddress(body.data.account)
    if (!n) return reply.status(400).send({ error: 'Invalid account' })
    const until = body.data.until == null ? null : Date.parse(body.data.until)
    if (until != null && (!Number.isFinite(until) || until <= Date.now())) return reply.status(400).send({ error: 'until must be a future date, or null to lift the mute' })
    if (isForumModerator(n.accountId)) return reply.status(422).send({ error: 'Moderators cannot be muted here' })
    // Logged by route and moderator only: the muted account and the reason are private.
    return run(req, reply, 'moderate.mute', null, async () => { await setMute(moderator, n.accountId, until, body.data.reason); return { ok: true } })
  })
}
