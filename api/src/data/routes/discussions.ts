import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { badRequest, cursorUint, decodeCursor, encodeCursor, errorEnvelope, zCursor, zError, zFeedPage, zIsoTimestamp, zLimit } from '../schemas/common.ts'
import { DISCUSSION_SORTS, forumSnapshotReady, listDiscussions, loadDiscussion, resolveThreadKey, type DiscussionKey, type DiscussionSort } from '../services/forum.ts'
import { forumPost } from '../../services/forumStore.ts'
import { COMMENT_FEED_RULES, FORUM_RULES, commentCursor, commentFeed, forumUnavailable, zCommentFeedPage, zForumAuthor, zForumSource, zStubFields } from './forumShared.ts'

// /v1/governance/discussions*: the governance forum's discussions (the explorer's
// /discussions), from the process's forum snapshot.

const zPostId = z.string().regex(/^[A-Za-z0-9]{1,40}$/, 'a discussion id: a decimal for a native discussion, s<n> for an imported one')

const zDiscussionCommon = {
  postId: z.string().describe('A decimal for a discussion written here, `s<n>` for an imported one.'),
  labels: z.array(z.string()).describe('Topic labels (untrusted text); empty on a stub.'),
  createdAt: zIsoTimestamp,
  editedAt: zIsoTimestamp.nullable(),
  linked: z.array(z.string()).describe('Post ids of on-chain subjects this discussion is linked to (`opengov:<i>`, `democracy:<i>`, …).'),
  source: zForumSource.nullable(),
  explorerUrl: z.string().describe('The discussion on the Hydration Explorer.'),
}

const zDiscussionItem = z.object({
  ...zDiscussionCommon,
  title: z.string(),
  excerpt: z.string(),
  author: zForumAuthor,
  lastActivityAt: zIsoTimestamp.describe('The newer of the post\'s own activity (creation, edits) and its newest visible comment.'),
  commentsCount: z.number().int(),
})

const zDiscussionDetail = z.object({
  ...zDiscussionCommon,
  ...zStubFields,
  deleted: z.boolean(),
  title: z.string().nullable(),
  excerpt: z.string().nullable(),
  body: z.string().nullable().describe('The current text as stored (untrusted); null on a stub.'),
  bodyFormat: z.string().nullable().describe('`markdown` or `html`; null on a stub.'),
  tldr: z.string().nullable(),
  author: zForumAuthor.nullable(),
  authority: z.string().nullable(),
  revision: z.number().int().nullable().describe('The current text\'s revision number (0 = first version).'),
  lastActivityAt: zIsoTimestamp.nullable(),
  threadKey: z.string().describe('The thread its comments live in (normally its own post id).'),
  commentsCount: z.number().int().nullable(),
  locked: z.boolean().describe('A moderator locked the thread: it takes no new comments.'),
})

function discussionCursor(raw: string | undefined, sort: DiscussionSort): DiscussionKey | null {
  if (!raw) return null
  const decoded = decodeCursor(raw)
  const k = cursorUint(decoded, 'k', Number.MAX_SAFE_INTEGER)
  const t = cursorUint(decoded, 't', Number.MAX_SAFE_INTEGER)
  const id = typeof decoded?.id === 'string' && decoded.id.length <= 40 ? decoded.id : null
  if (k == null || t == null || id == null || decoded?.s !== sort) {
    throw badRequest('unreadable cursor: pass back a nextCursor exactly as it was received, with the same sort')
  }
  return { k, t, id }
}

export const discussionsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/governance/discussions', {
    schema: {
      tags: ['governance'],
      summary: 'Governance forum discussions, paged',
      description: [
        'The governance forum\'s discussions — the threads not tied to one on-chain subject (a referendum\'s own description and comments are on /v1/governance/referenda/{pallet}/{index}). Hidden and deleted discussions are omitted from this list; they stay addressable by id as stubs.',
        '`sort`: `active` (default; newest `lastActivityAt` first), or `new` (newest `createdAt` first); ties fall to the newer `createdAt`, then the post id. `q` keeps discussions whose title or excerpt contains it (case-insensitive substring); `label` keeps those carrying that exact label.',
        'The cursor continues after the last item\'s sort position and is valid only for the same `sort`. Under `active` an item whose activity changes between two page reads moves in the order, so it can appear on two pages or on none; read from the start for a consistent pass.',
        FORUM_RULES,
      ].join('\n\n'),
      querystring: z.object({
        limit: zLimit,
        cursor: zCursor,
        sort: z.enum(DISCUSSION_SORTS).default('active'),
        q: z.string().trim().min(1).max(100).optional().describe('Case-insensitive substring of the title or excerpt.'),
        label: z.string().min(1).max(64).optional().describe('An exact topic label.'),
      }),
      response: { 200: zFeedPage(zDiscussionItem), 400: zError, 503: zError },
    },
  }, async (request, reply) => {
    const { limit, sort, q, label } = request.query
    const after = discussionCursor(request.query.cursor, sort)
    if (!(await forumSnapshotReady())) return forumUnavailable(reply)
    const page = listDiscussions({ sort, q, label, after, limit })
    return {
      items: page.items,
      hasMore: page.hasMore,
      ...(page.hasMore && page.last ? { nextCursor: encodeCursor({ s: sort, k: page.last.k, t: page.last.t, id: page.last.id }) } : {}),
    }
  })

  app.get('/v1/governance/discussions/:id', {
    schema: {
      tags: ['governance'],
      summary: 'One governance forum discussion with its body',
      description: [
        'One discussion with its current text (`body` as stored, in `bodyFormat`), `tldr`, revision number, counts and metadata. A hidden or deleted discussion answers 200 with a stub; an id that names no discussion answers 404 (on-chain subjects\' descriptions are on their referendum, not here).',
        FORUM_RULES,
      ].join('\n\n'),
      params: z.object({ id: zPostId }),
      response: { 200: zDiscussionDetail, 400: zError, 404: zError, 503: zError },
    },
  }, async (request, reply) => {
    if (!(await forumSnapshotReady())) return forumUnavailable(reply)
    const detail = await loadDiscussion(opts.client, request.params.id)
    if (!detail) {
      return reply.code(404).send(errorEnvelope('not_found', `no discussion ${request.params.id}`, { hint: 'list discussions via /v1/governance/discussions' }))
    }
    return detail
  })

  app.get('/v1/governance/discussions/:id/comments', {
    schema: {
      tags: ['governance'],
      summary: 'One governance forum discussion\'s comments, oldest first',
      description: [
        'The comment thread of one discussion (normally its own; a discussion linked to subjects reads the first linked thread holding comments when it has none of its own, as the explorer does). The same feed, shape and paging as a referendum\'s comments. A hidden or deleted discussion keeps its thread: each comment is shown or stubbed on its own state. An id that names no discussion answers 404.',
        COMMENT_FEED_RULES,
        FORUM_RULES,
      ].join('\n\n'),
      params: z.object({ id: zPostId }),
      querystring: z.object({ limit: zLimit, cursor: zCursor }),
      response: { 200: zCommentFeedPage, 400: zError, 404: zError, 503: zError },
    },
  }, async (request, reply) => {
    const after = commentCursor(request.query.cursor)
    if (!(await forumSnapshotReady())) return forumUnavailable(reply)
    const { id } = request.params
    if (forumPost(id)?.kind !== 'discussion') {
      return reply.code(404).send(errorEnvelope('not_found', `no discussion ${id}`, { hint: 'list discussions via /v1/governance/discussions' }))
    }
    return commentFeed(opts.client, resolveThreadKey(id), after, request.query.limit)
  })
}
