import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  getAccountsForMembers,
  getListTagDetail, getListTagHistoryWindow, getListTagActivity, getListTagExtrinsics, getListTagEvents,
  getListTagVotes, getListTagRevenueBreakdown, getListTagVotesByReferendum, getListTagTabCounts,
  getListTagListTotal, getListTagValueEvents,
  type ValueListFilters,
} from '../services/explorerService.ts'
import {
  limitParam, offsetParam, badOffset, textParam, activityTypeParam,
  extrinsicFilters, eventFilters, dateParam, activityOffsetParam, boundedActivityOffset,
  maxActivityOffsetFor, maxScopedActivityOffsetFor, scopedListQuery, listTabSchema,
  accountSortParam, historyWindowSchema,
} from './explorer.ts'

// A list tag resolved to the two things every route below needs: which tag it
// is (listId + tagId together key the aggregate models' caches) and who is in
// it. How a request is allowed to GET here is the surface's business, not any
// handler's — see ListTagReadSurface.
export interface ResolvedListTag {
  listId: string
  tagId: string
  tag: { name: string; color: string; icon: string; note: string; members: string[] }
}

// The two ways the same twelve reads are served. A list tag's aggregate view is
// one page, so it must not become two drifting sets of handlers — the surface
// carries only what genuinely differs between them:
//
//   /user/list-tag/:listId/:tagId — the viewer's own or subscribed tag, private
//     and never shared-cacheable, with the viewer's own tagged accounts counting
//     as names in the `identity` filter.
//   /explorer/list-tag/:tagId — a PUBLIC list's tag, addressed by tag id alone
//     because a viewer who was never told the list id still followed a link
//     here. Identical for every viewer, so it caches like the rest of /explorer.
export interface ListTagReadSurface {
  // Route path for the tag itself; every subpath below extends it.
  base: string
  // Params + permission in one step. Replies itself on a miss (404 for "not
  // visible or missing" — the two must stay indistinguishable from outside) and
  // returns null, so every handler just returns on a null.
  resolve: (req: FastifyRequest, reply: FastifyReply) => ResolvedListTag | null
  // The value filters a request carries. Only the `identity` one can depend on
  // who is asking, which is why this is the surface's call and not a handler's.
  valueFilters: (req: FastifyRequest, q: Record<string, unknown>) => ValueListFilters
}

// A list tag's own combined portfolio/activity page — the same shape as the
// system /explorer/tag/:id routes, over a user list's tag instead.
export function listTagReadRoutes(fastify: FastifyInstance, surface: ListTagReadSurface): void {
  const { base, resolve } = surface
  const query = (req: FastifyRequest) => req.query as Record<string, unknown>

  fastify.get(base, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    const { listId, tagId, tag } = resolved
    const summary = (req.query as { summary?: string })?.summary === '1'
    const detail = await getListTagDetail(listId, { tagId, name: tag.name, color: tag.color, icon: tag.icon, note: tag.note }, tag.members, { summary })
    if (!detail) return reply.status(404).send({ error: 'Tag not found' })
    return detail
  })

  // Chart-zoom refinement over the list tag's member set (block window).
  fastify.get(`${base}/history`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    const q = query(req)
    const w = historyWindowSchema.safeParse(q)
    if (!w.success) return reply.status(400).send({ error: 'Invalid block window' })
    const windowed = await getListTagHistoryWindow(resolved.listId, resolved.tagId, resolved.tag.members, w.data.fromBlock, w.data.toBlock, { seriesOnly: q.series === '1' })
    if (!windowed) return reply.status(404).send({ error: 'Tag not found' })
    return windowed
  })

  // The list tag's members as DIRECTORY rows — same shape and same renderer as
  // /explorer/accounts, so a user tag reads like the system tags beside it.
  fastify.get(`${base}/members`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    // The owner's own arrangement is the default order; an explicit ?sort
    // (a column header click) still re-ranks like the directory.
    const q = query(req)
    return getAccountsForMembers(resolved.tag.members, accountSortParam(q), typeof q.sort !== 'string')
  })

  fastify.get(`${base}/activity`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    const q = query(req)
    const activityType = activityTypeParam(q)
    const maxOffset = maxScopedActivityOffsetFor(q, activityType)
    const offset = boundedActivityOffset(q, maxOffset)
    if (offset == null) return reply.status(400).send({ error: `Activity offset must be between 0 and ${maxOffset}` })
    return getListTagActivity(resolved.listId, resolved.tagId, resolved.tag.members, activityType, limitParam(q, 40), offset, textParam(q, 'action', 32), surface.valueFilters(req, q), dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get(`${base}/extrinsics`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    const q = query(req)
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getListTagExtrinsics(resolved.listId, resolved.tagId, resolved.tag.members, limitParam(q, 25), offset, extrinsicFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get(`${base}/events`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    const q = query(req)
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getListTagEvents(resolved.listId, resolved.tagId, resolved.tag.members, limitParam(q, 25), offset, eventFilters(q), dateParam(q, 'from'), dateParam(q, 'to'))
  })

  fastify.get(`${base}/votes`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    const q = query(req)
    const offset = activityOffsetParam(q, 'vote')
    if (offset == null) return reply.status(400).send({ error: `Votes offset must be between 0 and ${maxActivityOffsetFor('vote')}` })
    return getListTagVotes(resolved.listId, resolved.tagId, resolved.tag.members, limitParam(q, 25), offset, dateParam(q, 'from'), dateParam(q, 'to'))
  })

  // The Protocol Revenue tab: where the revenue this tag's members generated
  // came from — per stream, per asset within the stream.
  fastify.get(`${base}/revenue-breakdown`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    return getListTagRevenueBreakdown(resolved.listId, resolved.tagId, resolved.tag.members)
  })

  // Grouped-mode counterpart of the votes route above — one row per referendum.
  fastify.get(`${base}/votes-by-referendum`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    const q = query(req)
    const offset = offsetParam(q)
    if (offset == null) return badOffset(reply)
    return getListTagVotesByReferendum(resolved.listId, resolved.tagId, resolved.tag.members, limitParam(q, 25), offset)
  })

  fastify.get(`${base}/counts`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    return getListTagTabCounts(resolved.listId, resolved.tagId, resolved.tag.members)
  })

  fastify.get(`${base}/list-count`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    const q = query(req)
    const listQuery = scopedListQuery(q)
    if (!listQuery) return reply.status(400).send({ error: `List tab must be one of ${listTabSchema.options.join(', ')}` })
    return getListTagListTotal(resolved.listId, resolved.tagId, resolved.tag.members, listQuery)
  })

  fastify.get(`${base}/value-events`, async (req, reply) => {
    const resolved = resolve(req, reply)
    if (!resolved) return
    const q = query(req)
    return getListTagValueEvents(resolved.listId, resolved.tagId, resolved.tag.members, dateParam(q, 'from'), dateParam(q, 'to'))
  })
}
