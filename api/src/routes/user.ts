import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import {
  createChallenge, verifyChallenge, issueSession, revokeSession, requireUser,
  listSessions, revokeSessionByHash, deviceLabelFromUserAgent,
} from '../services/userAuthService.ts'
import { createDeviceLink, claimDeviceLink, deviceLinkStatus } from '../services/deviceLinkService.ts'
import {
  accountRef, resolveDisplayAccountId, getAccounts, getAccountsForViewerFold,
  getHolders, getHoldersForViewerFold,
  getListTagDetail, getListTagActivity, getListTagExtrinsics, getListTagEvents, getListTagVotes,
  getListTagTabCounts, getListTagListTotal, getListTagValueEvents,
} from '../services/explorerService.ts'
import { setProfileName, setProfileAvatar, clearProfileAvatar, profileForAccount, UserDataError } from '../services/userProfileService.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import {
  ensurePersonalList, ownedListsFor, subscriptionsFor, invitesFor, listOrderFor, tagMapFor, directoryFoldFor,
  getList, canView, createList, updateList, deleteList,
  createTag, updateTag, deleteTag, setTagMembers, setMemberOrder, visibleTagMembers, tagDisplayIcon,
  inviteToList, revokeShare, respondToInvite, subscribePublic, unsubscribe, setListOrder, sharesFor,
  listSummary, LIMITS, type ListSummary, type UserList,
} from '../services/userListService.ts'
import {
  limitParam, offsetParam, badOffset, textParam, valueFilters, activityTypeParam,
  extrinsicFilters, eventFilters, dateParam, activityOffsetParam, boundedActivityOffset,
  maxActivityOffsetFor, maxScopedActivityOffsetFor, scopedListQuery, listTabSchema,
  unusableFilterParam, accountSortParam, uint32Param,
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
    lists: ownedListsFor(accountId).map(listSummaryRef),
    subscriptions: subscriptionsFor(accountId).map(listSummaryRef),
    invites: invitesFor(accountId).map(listSummaryRef),
    order: listOrderFor(accountId),
  }
}
// Serialize owner as a display ref exactly once, here.
export function listSummaryRef(s: ListSummary) {
  const { ownerAccountId, ...rest } = s
  return { ...rest, owner: accountRef(ownerAccountId) }
}
export function listDetailResponse(list: UserList, viewer: string | null) {
  // Tag contents (names + member rosters) are the owner's curation — everyone
  // else gets the statistics already on the summary (tagCount, accountCount,
  // subscriberCount). Subscribers still RECEIVE memberships through their own
  // /user/tag-map (that's what resolves pills client-side); this only keeps
  // another user's list from being browsed or scraped as a page.
  const isOwner = viewer !== null && viewer === list.owner
  return {
    ...listSummaryRef(listSummary(list)),
    subscribed: viewer ? subscriptionsFor(viewer).some(s => s.listId === list.listId) : false,
    // Alphabetical, not creation order — matches the system tag directory
    // (tagService's allTags(), also name-sorted). `list.tags` is a Map, so
    // without this every consumer of the detail response would otherwise see
    // tags in whatever order they were created, not a stable, browsable one.
    // Case-insensitive so "apple"/"Banana" interleave by letter rather than
    // every uppercase name sorting ahead of every lowercase one; tagId is a
    // deterministic tiebreak for two names that compare equal, not just
    // relying on sort() stability. tagMapFor's own tag order is untouched —
    // resolution there doesn't care about display order — and this doesn't
    // touch a tag's MEMBER order, which stays position-based.
    tags: isOwner ? [...list.tags.values()].map(tagRef).sort(compareTagRefsByName) : [],
    // Subscribers tab (owner-only, additive): who has a live invite or an
    // active subscription. Undefined — not an empty array — for every other
    // viewer (including the anonymous public detail this same function builds
    // for /explorer/list/:id), so it drops out of the JSON entirely rather
    // than reading as "nobody's subscribed" on a list whose sharing state
    // this viewer has no right to see.
    shares: isOwner ? sharesFor(list.listId).map(s => ({ account: accountRef(s.accountId), status: s.status })) : undefined,
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
function compareTagRefsByName(a: { name: string; tagId: string }, b: { name: string; tagId: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.tagId.localeCompare(b.tagId)
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
    const token = await issueSession(accountId, { label: deviceLabelFromUserAgent(req.headers['user-agent']), via: 'wallet' })
    await ensurePersonalList(accountId)
    return { token, me: await meResponse(accountId) }
  })

  // ---- QR device-link handoff. All three live under /user/auth/ on purpose:
  // the UI's authedJson never drops a local session on a 401 from that prefix,
  // so a rejected (expired/used) code can't log the scanning device out of an
  // account it is already into. ----

  const deviceLinkClaimBody = z.object({ code: z.string().regex(/^[0-9a-f]{64}$/) })

  // A logged-in device mints the code the QR carries. The response's `code`
  // goes into the QR only; `linkId` is what the dialog polls with.
  fastify.post('/user/auth/device-link', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const link = createDeviceLink(accountId)
    if (!link) return reply.status(503).send({ error: 'Too many pending link codes — try again shortly' })
    return link
  })

  // The issuing device's poll: has anyone claimed this code yet?
  fastify.get('/user/auth/device-link/:linkId', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    return { status: deviceLinkStatus((req.params as { linkId: string }).linkId, accountId) }
  })

  // The scanning device trades the code for its own session — same response
  // shape as verify, so the client logs in identically either way. 401 covers
  // unknown, expired, and already-claimed alike: the caller can't act on the
  // difference, and collapsing them leaks nothing to whoever found a stale QR.
  fastify.post('/user/auth/device-link/claim', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    noStore(reply)
    const body = deviceLinkClaimBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid link code' })
    const accountId = claimDeviceLink(body.data.code)
    if (!accountId) return reply.status(401).send({ error: 'This code has expired or was already used' })
    const token = await issueSession(accountId, { label: deviceLabelFromUserAgent(req.headers['user-agent']), via: 'qr' })
    await ensurePersonalList(accountId)
    return { token, me: await meResponse(accountId) }
  })

  // ---- Devices: every live session of the account, revocable one by one. ----

  fastify.get('/user/sessions', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    return { sessions: listSessions(accountId, (req.headers.authorization as string).slice(7)) }
  })

  fastify.delete('/user/sessions/:id', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const revoked = await revokeSessionByHash(accountId, (req.params as { id: string }).id)
    if (!revoked) return reply.status(404).send({ error: 'Unknown session' })
    return { ok: true }
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
    return { lists: tagMapFor(accountId) }
  })

  // The accounts directory, folded under THIS viewer's own tags too — same
  // params, same shape as the public /explorer/accounts (reuses its exact
  // parsers), so the client can swap endpoints without changing anything else
  // about how it reads the response. directoryFoldFor is the userListService
  // half of the fold (which accounts win, and under what presentation); the
  // shared getAccounts/getAccountsForViewerFold in explorerService is the
  // other half (the SAME bounded whole-directory query the public route runs
  // — see accountsPage's cost comment — grouped by this fold if there is one).
  // A tagless viewer (directoryFoldFor returns null) costs nothing beyond the
  // shared endpoint: this calls getAccounts directly rather than paying for a
  // second, per-viewer cache entry that would be byte-identical to the shared
  // one anyway.
  fastify.get('/user/accounts', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const q = req.query as Record<string, unknown>
    const limit = limitParam(q, 50)
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    const sort = accountSortParam(q)
    const fold = directoryFoldFor(accountId)
    return fold ? getAccountsForViewerFold(offset, limit, sort, fold) : getAccounts(offset, limit, sort)
  })

  // An asset's holder list, folded under THIS viewer's own tags too — the
  // /user/accounts pattern applied to /explorer/holders/:assetId: same params,
  // same parsers, same response shape, so the client swaps endpoints without
  // changing how it reads the page. The fold rides the same directoryFoldFor
  // result the accounts directory uses, so the two surfaces always group an
  // account the same way for the same viewer.
  fastify.get('/user/holders/:assetId', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const params = z.object({ assetId: uint32Param }).safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: 'Invalid asset id' })
    const q = req.query as Record<string, unknown>
    const limit = limitParam(q, 100)
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    const fold = directoryFoldFor(accountId)
    return fold ? getHoldersForViewerFold(params.data.assetId, limit, offset, fold) : getHolders(params.data.assetId, limit, offset)
  })

  const listCreateBody = z.object({ name: z.string().max(200), note: z.string().max(400).optional(), visibility: z.enum(['private', 'public']) })
  const listUpdateBody = z.object({ name: z.string().max(200).optional(), note: z.string().max(400).optional(), visibility: z.enum(['private', 'public']).optional() })

  fastify.get('/user/lists/:id', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id } = req.params as { id: string }
    if (!canView(accountId, id)) return reply.status(404).send({ error: 'List not found' })
    return listDetailResponse(getList(id)!, accountId)
  })

  fastify.post('/user/lists', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = listCreateBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid list payload' })
    return withUserErrors(reply, async () => listDetailResponse(
      await createList(accountId, body.data.name, body.data.note ?? '', body.data.visibility), accountId,
    ))
  })

  fastify.patch('/user/lists/:id', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id } = req.params as { id: string }
    const body = listUpdateBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid list payload' })
    return withUserErrors(reply, async () => listDetailResponse(await updateList(accountId, id, body.data), accountId))
  })

  fastify.delete('/user/lists/:id', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id } = req.params as { id: string }
    return withUserErrors(reply, async () => { await deleteList(accountId, id); return { ok: true } })
  })

  const tagCreateBody = z.object({ name: z.string().max(200), color: z.string().max(64).optional(), icon: z.string().max(64).optional(), note: z.string().max(400).optional() })
  const tagUpdateBody = tagCreateBody.partial()
  const membersBody = z.object({ add: z.array(z.string()).max(500).optional(), remove: z.array(z.string()).max(500).optional() })
  const memberOrderBody = z.object({ accountIds: z.array(z.string()).max(LIMITS.membersPerTag) })

  fastify.post('/user/lists/:id/tags', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id } = req.params as { id: string }
    const body = tagCreateBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid tag payload' })
    return withUserErrors(reply, async () => tagRef(await createTag(accountId, id, body.data)))
  })

  fastify.patch('/user/lists/:id/tags/:tagId', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id, tagId } = req.params as { id: string; tagId: string }
    const body = tagUpdateBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid tag payload' })
    return withUserErrors(reply, async () => tagRef(await updateTag(accountId, id, tagId, body.data)))
  })

  fastify.delete('/user/lists/:id/tags/:tagId', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id, tagId } = req.params as { id: string; tagId: string }
    return withUserErrors(reply, async () => { await deleteTag(accountId, id, tagId); return { ok: true } })
  })

  fastify.put('/user/lists/:id/tags/:tagId/members', async (req, reply) => {
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
  fastify.put('/user/lists/:id/tags/:tagId/member-order', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { id, tagId } = req.params as { id: string; tagId: string }
    const body = memberOrderBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid member-order payload' })
    return withUserErrors(reply, async () => tagRef(await setMemberOrder(accountId, id, tagId, body.data.accountIds)))
  })

  fastify.post('/user/lists/:id/invites', async (req, reply) => {
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
    return withUserErrors(reply, async () => { await inviteToList(accountId, id, grantee); return { ok: true } })
  })

  fastify.delete('/user/lists/:id/invites/:address', async (req, reply) => {
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
    return invitesFor(accountId).map(listSummaryRef)
  })

  fastify.post('/user/invites/:listId/accept', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { listId } = req.params as { listId: string }
    return withUserErrors(reply, async () => { await respondToInvite(accountId, listId, true); return { ok: true } })
  })

  fastify.post('/user/invites/:listId/decline', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { listId } = req.params as { listId: string }
    return withUserErrors(reply, async () => { await respondToInvite(accountId, listId, false); return { ok: true } })
  })

  const subscriptionBody = z.object({ listId: z.string().max(64) })

  fastify.post('/user/subscriptions', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = subscriptionBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid subscription payload' })
    return withUserErrors(reply, async () => { await subscribePublic(accountId, body.data.listId); return { ok: true } })
  })

  fastify.delete('/user/subscriptions/:listId', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const { listId } = req.params as { listId: string }
    return withUserErrors(reply, async () => { await unsubscribe(accountId, listId); return { ok: true } })
  })

  const orderBody = z.object({ listIds: z.array(z.string().max(64)).max(500) })

  fastify.put('/user/list-order', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const body = orderBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid order payload' })
    return withUserErrors(reply, async () => ({ order: await setListOrder(accountId, body.data.listIds) }))
  })

  // ── User-tag aggregate view ─────────────────────────────────────────────
  // A list tag's own combined portfolio/activity page — the same shape as
  // the system /explorer/tag/:id routes, over a viewer's own (or subscribed)
  // list tag instead. Gating is the same rule listDetailResponse's tag
  // contents use (owner or active subscriber, never mere public visibility):
  // visibleTagMembers returns null for "not visible or missing" and every
  // route below answers that with the same 404, so a private list's tag
  // and an unknown one are indistinguishable from outside.
  const listTagParams = z.object({ listId: z.string().min(1).max(64), tagId: z.string().min(1).max(64) })
  // Resolves params + permission in one place; replies 404 itself on a miss
  // so every route below just returns on a null.
  function requireListTag(req: FastifyRequest, reply: FastifyReply, accountId: string) {
    const params = listTagParams.safeParse(req.params)
    if (!params.success) { reply.status(400).send({ error: 'Invalid list/tag id' }); return null }
    const tag = visibleTagMembers(accountId, params.data.listId, params.data.tagId)
    if (!tag) { reply.status(404).send({ error: 'Tag not found' }); return null }
    return { listId: params.data.listId, tagId: params.data.tagId, tag }
  }

  fastify.get('/user/list-tag/:listId/:tagId', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireListTag(req, reply, accountId)
    if (!resolved) return
    const { listId, tagId, tag } = resolved
    const summary = (req.query as { summary?: string })?.summary === '1'
    const detail = await getListTagDetail(listId, { tagId, name: tag.name, color: tag.color, icon: tag.icon, note: tag.note }, tag.members, { summary })
    if (!detail) return reply.status(404).send({ error: 'Tag not found' })
    return detail
  })

  fastify.get('/user/list-tag/:listId/:tagId/activity', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireListTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    const activityType = activityTypeParam(q)
    const maxOffset = maxScopedActivityOffsetFor(q, activityType)
    const offset = boundedActivityOffset(q, maxOffset)
    if (offset == null) return reply.status(400).send({ error: `Activity offset must be between 0 and ${maxOffset}` })
    return getListTagActivity(resolved.listId, resolved.tagId, resolved.tag.members, activityType, limitParam(q, 40), offset, textParam(q, 'action', 32), valueFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get('/user/list-tag/:listId/:tagId/extrinsics', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireListTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getListTagExtrinsics(resolved.listId, resolved.tagId, resolved.tag.members, limitParam(q, 25), offset, extrinsicFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get('/user/list-tag/:listId/:tagId/events', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireListTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getListTagEvents(resolved.listId, resolved.tagId, resolved.tag.members, limitParam(q, 25), offset, eventFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get('/user/list-tag/:listId/:tagId/votes', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireListTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    const offset = activityOffsetParam(q, 'vote')
    if (offset == null) return reply.status(400).send({ error: `Votes offset must be between 0 and ${maxActivityOffsetFor('vote')}` })
    return getListTagVotes(resolved.listId, resolved.tagId, resolved.tag.members, limitParam(q, 25), offset, dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get('/user/list-tag/:listId/:tagId/counts', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireListTag(req, reply, accountId)
    if (!resolved) return
    return getListTagTabCounts(resolved.listId, resolved.tagId, resolved.tag.members)
  })

  fastify.get('/user/list-tag/:listId/:tagId/list-count', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireListTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    const query = scopedListQuery(q)
    if (!query) return reply.status(400).send({ error: `List tab must be one of ${listTabSchema.options.join(', ')}` })
    return getListTagListTotal(resolved.listId, resolved.tagId, resolved.tag.members, query)
  })

  fastify.get('/user/list-tag/:listId/:tagId/value-events', async (req, reply) => {
    noStore(reply)
    const accountId = requireUser(req, reply)
    if (!accountId) return
    const resolved = requireListTag(req, reply, accountId)
    if (!resolved) return
    const q = req.query as Record<string, unknown>
    const bad = unusableFilterParam(q)
    if (bad) return reply.status(400).send({ error: `Invalid ${bad.key}; expected ${bad.expected}` })
    return getListTagValueEvents(resolved.listId, resolved.tagId, resolved.tag.members, dateParam(q, 'from'), dateParam(q, 'to'))
  })
}
