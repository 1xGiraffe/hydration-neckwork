import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import {
  createChallenge, verifyChallenge, issueSession, revokeSession, requireUser,
} from '../services/userAuthService.ts'
import {
  accountRef, resolveDisplayAccountId,
  getLibraryTagDetail, getLibraryTagActivity, getLibraryTagExtrinsics, getLibraryTagEvents, getLibraryTagVotes,
  getLibraryTagTabCounts, getLibraryTagListTotal, getLibraryTagValueEvents,
} from '../services/explorerService.ts'
import { setProfileName, setProfileAvatar, clearProfileAvatar, profileForAccount, UserDataError } from '../services/userProfileService.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import {
  ensurePersonalLibrary, ownedLibrariesFor, subscriptionsFor, invitesFor, libraryOrderFor, tagMapFor,
  getLibrary, canView, createLibrary, updateLibrary, deleteLibrary,
  createTag, updateTag, deleteTag, setTagMembers, setMemberOrder, visibleTagMembers, tagDisplayIcon,
  inviteToLibrary, revokeShare, respondToInvite, subscribePublic, unsubscribe, setLibraryOrder,
  librarySummary, LIMITS, type LibrarySummary, type UserLibrary,
} from '../services/userLibraryService.ts'
import {
  limitParam, offsetParam, badOffset, textParam, valueFilters, activityTypeParam,
  extrinsicFilters, eventFilters, dateParam, activityOffsetParam, boundedActivityOffset,
  maxActivityOffsetFor, maxScopedActivityOffsetFor, scopedListQuery, listTabSchema,
  unusableFilterParam,
} from './explorer.ts'

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

export async function meResponse(accountId: string) {
  return {
    account: accountRef(accountId),
    profile: profileForAccount(accountId),
    libraries: ownedLibrariesFor(accountId).map(libSummaryRef),
    subscriptions: subscriptionsFor(accountId).map(libSummaryRef),
    invites: invitesFor(accountId).map(libSummaryRef),
    order: libraryOrderFor(accountId),
  }
}
// Serialize owner as a display ref exactly once, here.
export function libSummaryRef(s: LibrarySummary) {
  const { ownerAccountId, ...rest } = s
  return { ...rest, owner: accountRef(ownerAccountId) }
}
export function libraryDetailResponse(lib: UserLibrary, viewer: string | null) {
  // Tag contents (names + member lists) are the owner's curation — everyone
  // else gets the statistics already on the summary (tagCount, accountCount,
  // subscriberCount). Subscribers still RECEIVE memberships through their own
  // /user/tag-map (that's what resolves pills client-side); this only keeps
  // another user's library from being browsed or scraped as a page.
  const isOwner = viewer !== null && viewer === lib.owner
  return {
    ...libSummaryRef(librarySummary(lib)),
    subscribed: viewer ? subscriptionsFor(viewer).some(s => s.libraryId === lib.libraryId) : false,
    tags: isOwner ? [...lib.tags.values()].map(tagRef) : [],
  }
}
// A single tag, serialized the same way whether it comes back from create,
// update, a members write, or a reorder — members as display accountRefs in
// display order, like a detail tag. Ships TWO icon fields, deliberately not
// collapsed into one: `icon` is the raw stored value (possibly '') — the
// management page's edit form must seed from and resubmit exactly this, or
// resubmitting the DERIVED value (which can be a profile-avatar URL once the
// first-member fallback engages) would 422 a plain rename against
// checkIcon's emoji-only rule, and would also silently freeze a dynamic
// fallback into a permanent explicit icon. `displayIcon` is the resolved
// value every display surface (this tag's header, its pill) shows — the same
// derivation tagMapFor and visibleTagMembers apply, so all three surfaces
// that show this tag agree on what it looks like.
function tagRef(t: { tagId: string; name: string; color: string; icon: string; note: string; order: string[] }) {
  return {
    tagId: t.tagId, name: t.name, color: t.color, icon: t.icon, displayIcon: tagDisplayIcon(t.icon, t.order),
    note: t.note, members: t.order.map(accountRef),
  }
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
    await ensurePersonalLibrary(accountId)
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

  fastify.get('/user/tag-map', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    return { libraries: tagMapFor(accountId) }
  })

  const libraryCreateBody = z.object({ name: z.string().max(200), note: z.string().max(400).optional(), visibility: z.enum(['private', 'public']) })
  const libraryUpdateBody = z.object({ name: z.string().max(200).optional(), note: z.string().max(400).optional(), visibility: z.enum(['private', 'public']).optional() })

  fastify.get('/user/libraries/:id', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id } = req.params as { id: string }
    if (!canView(accountId, id)) return reply.status(404).send({ error: 'Library not found' })
    return libraryDetailResponse(getLibrary(id)!, accountId)
  })

  fastify.post('/user/libraries', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = libraryCreateBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid library payload' })
    return withUserErrors(reply, async () => libraryDetailResponse(
      await createLibrary(accountId, body.data.name, body.data.note ?? '', body.data.visibility), accountId,
    ))
  })

  fastify.patch('/user/libraries/:id', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id } = req.params as { id: string }
    const body = libraryUpdateBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid library payload' })
    return withUserErrors(reply, async () => libraryDetailResponse(await updateLibrary(accountId, id, body.data), accountId))
  })

  fastify.delete('/user/libraries/:id', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id } = req.params as { id: string }
    return withUserErrors(reply, async () => { await deleteLibrary(accountId, id); return { ok: true } })
  })

  const tagCreateBody = z.object({ name: z.string().max(200), color: z.string().max(64).optional(), icon: z.string().max(64).optional(), note: z.string().max(400).optional() })
  const tagUpdateBody = tagCreateBody.partial()
  const membersBody = z.object({ add: z.array(z.string()).max(500).optional(), remove: z.array(z.string()).max(500).optional() })
  const memberOrderBody = z.object({ accountIds: z.array(z.string()).max(LIMITS.membersPerTag) })

  fastify.post('/user/libraries/:id/tags', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id } = req.params as { id: string }
    const body = tagCreateBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid tag payload' })
    return withUserErrors(reply, async () => tagRef(await createTag(accountId, id, body.data)))
  })

  fastify.patch('/user/libraries/:id/tags/:tagId', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id, tagId } = req.params as { id: string; tagId: string }
    const body = tagUpdateBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid tag payload' })
    return withUserErrors(reply, async () => tagRef(await updateTag(accountId, id, tagId, body.data)))
  })

  fastify.delete('/user/libraries/:id/tags/:tagId', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id, tagId } = req.params as { id: string; tagId: string }
    return withUserErrors(reply, async () => { await deleteTag(accountId, id, tagId); return { ok: true } })
  })

  fastify.put('/user/libraries/:id/tags/:tagId/members', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id, tagId } = req.params as { id: string; tagId: string }
    const body = membersBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid members payload' })
    return withUserErrors(reply, async () => tagRef(await setTagMembers(accountId, id, tagId, body.data.add ?? [], body.data.remove ?? [])))
  })

  // Drag/keyboard reorder of a tag's members (B3): `accountIds` must be a
  // permutation of the tag's CURRENT members — setMemberOrder 400s otherwise,
  // rather than best-effort applying a client order that dropped or duplicated
  // an id.
  fastify.put('/user/libraries/:id/tags/:tagId/member-order', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id, tagId } = req.params as { id: string; tagId: string }
    const body = memberOrderBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid member-order payload' })
    return withUserErrors(reply, async () => tagRef(await setMemberOrder(accountId, id, tagId, body.data.accountIds)))
  })

  fastify.post('/user/libraries/:id/invites', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id } = req.params as { id: string }
    const body = addressBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid address' })
    const normalized = normalizeAddress(body.data.address)
    if (!normalized) return reply.status(400).send({ error: 'Invalid address' })
    // Canonicalize exactly like login: a bound-EVM grantee's invite must land
    // under the SAME accountId their own session resolves to, or the invite
    // never shows up in their invites list (invitesFor looks up their session id).
    const grantee = resolveDisplayAccountId(normalized.accountId)
    return withUserErrors(reply, async () => { await inviteToLibrary(accountId, id, grantee); return { ok: true } })
  })

  fastify.delete('/user/libraries/:id/invites/:address', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id, address } = req.params as { id: string; address: string }
    const normalized = normalizeAddress(address)
    if (!normalized) return reply.status(400).send({ error: 'Invalid address' })
    // Same canonicalization as the invite route above, so revoking by address
    // resolves to the exact id the invite was stored under.
    const grantee = resolveDisplayAccountId(normalized.accountId)
    return withUserErrors(reply, async () => { await revokeShare(accountId, id, grantee); return { ok: true } })
  })

  fastify.get('/user/invites', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    return invitesFor(accountId).map(libSummaryRef)
  })

  fastify.post('/user/invites/:libraryId/accept', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { libraryId } = req.params as { libraryId: string }
    return withUserErrors(reply, async () => { await respondToInvite(accountId, libraryId, true); return { ok: true } })
  })

  fastify.post('/user/invites/:libraryId/decline', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { libraryId } = req.params as { libraryId: string }
    return withUserErrors(reply, async () => { await respondToInvite(accountId, libraryId, false); return { ok: true } })
  })

  const subscriptionBody = z.object({ libraryId: z.string().max(64) })

  fastify.post('/user/subscriptions', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = subscriptionBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid subscription payload' })
    return withUserErrors(reply, async () => { await subscribePublic(accountId, body.data.libraryId); return { ok: true } })
  })

  fastify.delete('/user/subscriptions/:libraryId', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { libraryId } = req.params as { libraryId: string }
    return withUserErrors(reply, async () => { await unsubscribe(accountId, libraryId); return { ok: true } })
  })

  const orderBody = z.object({ libraryIds: z.array(z.string().max(64)).max(500) })

  fastify.put('/user/library-order', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = orderBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid order payload' })
    return withUserErrors(reply, async () => ({ order: await setLibraryOrder(accountId, body.data.libraryIds) }))
  })

  // ── User-tag aggregate view ─────────────────────────────────────────────
  // A library tag's own combined portfolio/activity page — the same shape as
  // the system /explorer/tag/:id routes, over a viewer's own (or subscribed)
  // library tag instead. Gating is the same rule libraryDetailResponse's tag
  // contents use (owner or active subscriber, never mere public visibility):
  // visibleTagMembers returns null for "not visible or missing" and every
  // route below answers that with the same 404, so a private library's tag
  // and an unknown one are indistinguishable from outside.
  const libraryTagParams = z.object({ libraryId: z.string().min(1).max(64), tagId: z.string().min(1).max(64) })
  // Resolves params + permission in one place; replies 404 itself on a miss
  // so every route below just returns on a null.
  function requireLibraryTag(req: FastifyRequest, reply: FastifyReply, accountId: string) {
    const params = libraryTagParams.safeParse(req.params)
    if (!params.success) { reply.status(400).send({ error: 'Invalid library/tag id' }); return null }
    const tag = visibleTagMembers(accountId, params.data.libraryId, params.data.tagId)
    if (!tag) { reply.status(404).send({ error: 'Tag not found' }); return null }
    return { libraryId: params.data.libraryId, tagId: params.data.tagId, tag }
  }

  fastify.get('/user/library-tag/:libraryId/:tagId', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireLibraryTag(req, reply, accountId)
    if (!resolved) return
    const { libraryId, tagId, tag } = resolved
    const summary = (req.query as { summary?: string })?.summary === '1'
    const detail = await getLibraryTagDetail(libraryId, { tagId, name: tag.name, color: tag.color, icon: tag.icon, note: tag.note }, tag.members, { summary })
    if (!detail) return reply.status(404).send({ error: 'Tag not found' })
    return detail
  })

  fastify.get('/user/library-tag/:libraryId/:tagId/activity', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireLibraryTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    const activityType = activityTypeParam(q)
    const maxOffset = maxScopedActivityOffsetFor(q, activityType)
    const offset = boundedActivityOffset(q, maxOffset)
    if (offset == null) return reply.status(400).send({ error: `Activity offset must be between 0 and ${maxOffset}` })
    return getLibraryTagActivity(resolved.libraryId, resolved.tagId, resolved.tag.members, activityType, limitParam(q, 40), offset, textParam(q, 'action', 32), valueFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get('/user/library-tag/:libraryId/:tagId/extrinsics', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireLibraryTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getLibraryTagExtrinsics(resolved.libraryId, resolved.tagId, resolved.tag.members, limitParam(q, 25), offset, extrinsicFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get('/user/library-tag/:libraryId/:tagId/events', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireLibraryTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getLibraryTagEvents(resolved.libraryId, resolved.tagId, resolved.tag.members, limitParam(q, 25), offset, eventFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get('/user/library-tag/:libraryId/:tagId/votes', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireLibraryTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    const offset = activityOffsetParam(q, 'vote')
    if (offset == null) return reply.status(400).send({ error: `Votes offset must be between 0 and ${maxActivityOffsetFor('vote')}` })
    return getLibraryTagVotes(resolved.libraryId, resolved.tagId, resolved.tag.members, limitParam(q, 25), offset, dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get('/user/library-tag/:libraryId/:tagId/counts', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireLibraryTag(req, reply, accountId)
    if (!resolved) return
    return getLibraryTagTabCounts(resolved.libraryId, resolved.tagId, resolved.tag.members)
  })

  fastify.get('/user/library-tag/:libraryId/:tagId/list-count', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireLibraryTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    const query = scopedListQuery(q)
    if (!query) return reply.status(400).send({ error: `List tab must be one of ${listTabSchema.options.join(', ')}` })
    return getLibraryTagListTotal(resolved.libraryId, resolved.tagId, resolved.tag.members, query)
  })

  fastify.get('/user/library-tag/:libraryId/:tagId/value-events', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireLibraryTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    return getLibraryTagValueEvents(resolved.libraryId, resolved.tagId, resolved.tag.members, dateParam(q, 'from'), dateParam(q, 'to'))
  })
}
