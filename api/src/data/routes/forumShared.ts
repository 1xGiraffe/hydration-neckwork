import type { FastifyReply } from 'fastify'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { badRequest, cursorUint, decodeCursor, encodeCursor, errorEnvelope, zAccountRef, zFeedPage, zIsoTimestamp } from '../schemas/common.ts'
import { threadPage, type CommentKey, type ForumCommentItem } from '../services/forum.ts'

// The governance forum's wire shapes, shared by /v1/governance/discussions*, the
// referendum description and the referendum comment feed, so a forum author, a
// source link and a comment are one object wherever they are reached.

// The normative rules every forum route repeats in its description.
export const FORUM_RULES = [
  'Forum text — titles, excerpts, bodies, tldrs, labels and legacy author names — is user-authored and UNTRUSTED (the imported history holds live XSS probes). It is returned exactly as stored. Render it only as plain text or through a sanitizing renderer (`bodyFormat` is `markdown`, or `html` for a few imported items — sanitize both); never insert it into a page as HTML. `excerpt` is the body\'s first 240 characters with markdown and HTML syntax stripped — still untrusted text.',
  'A hidden item (hidden by a forum moderator, or hidden or flagged as spam before import) or a deleted one is a STUB: `hidden: true` (`deleted: true` as well for a deletion) and `hiddenReason` (`deleted`, `imported-hidden`, `spam`, or a moderator\'s reason code), with every authored field — title, excerpt, body, tldr, labels, author — null or empty. Its text never leaves the server.',
  'Imported vs native: `source` is `{ name: "subsquare", id }` for an item imported with the forum\'s earlier history (`name` and `id` are provenance values, not links) and null for an item written natively on the Hydration Explorer forum. `authority` says who owns a post\'s current text: `subsquare` (the imported text) until its first native edit, then `native` (later edits at the source are kept only as revisions); null on a stub, and on a placeholder description that holds no text yet.',
  'Counting: `commentsCount` counts the visible (neither hidden nor deleted) comments of the thread a reader sees, replies included and proposer updates excluded. A discussion stub\'s `commentsCount` is null (a referendum\'s thread is its own and keeps its count when the description is hidden).',
  'Freshness: the import of the earlier history runs every 10 minutes. Native posts, comments, edits and moderation are written immediately and reach this API when its forum snapshot reloads (the forum tables\' watermark is checked every 10 s). Until that snapshot has loaded after a restart, forum reads answer 503 `unavailable` with Retry-After.',
].join('\n\n')

export const zForumAuthor = z.object({
  account: zAccountRef.nullable().describe('The author\'s account; null for an imported author known by name only.'),
  legacyName: z.string().nullable().describe('An address-less imported author\'s username (untrusted text); null when `account` is set.'),
})

export const zForumSource = z.object({
  name: z.literal('subsquare'),
  id: z.string().describe('The imported item\'s source id (provenance, not a link).'),
})

export const zStubFields = {
  hidden: z.boolean().describe('True on a stub (hidden or deleted): every authored field is null or empty.'),
  hiddenReason: z.string().nullable().describe('`deleted`, `imported-hidden`, `spam`, or a moderator\'s reason code; null when shown.'),
}

export const zForumComment = z.object({
  commentId: z.string().describe('`s<id>` for an imported comment, `c<ULID>` for a native one.'),
  kind: z.string().describe('`comment`, or `update`: the proposer\'s append-only note under the description (not counted in `commentsCount`).'),
  parentId: z.string().nullable().describe('Two levels: the top-level comment a reply files under; null for a top-level comment, including a reply whose parent is not in the thread (removed upstream before import).'),
  replyToId: z.string().nullable().describe('The comment a reply answers inside its parent\'s replies, as stored (it may name a comment no longer in the thread).'),
  ...zStubFields,
  deleted: z.boolean(),
  author: zForumAuthor.nullable().describe('Null on a stub.'),
  body: z.string().nullable().describe('As stored (untrusted); null on a stub.'),
  bodyFormat: z.string().nullable().describe('`markdown` or `html`; null on a stub.'),
  createdAt: zIsoTimestamp,
  editedAt: zIsoTimestamp.nullable(),
  revision: z.number().int().nullable().describe('The current text\'s revision number (0 = first version); null on a stub.'),
  source: z.object({ name: z.literal('subsquare'), id: z.string() }).nullable().describe('Set for an imported comment; null for a native one.'),
})

export const zSubjectDescription = z.object({
  postId: z.string().describe('The description\'s post id: `opengov:<index>` or `democracy:<index>`.'),
  ...zStubFields,
  title: z.string().nullable(),
  tldr: z.string().nullable(),
  excerpt: z.string().nullable(),
  body: z.string().nullable().describe('The description as stored (untrusted); null on a stub or a placeholder that holds no text yet.'),
  bodyFormat: z.string().nullable(),
  author: zForumAuthor.nullable().describe('The author the description was written under (for an imported description, the proposer as its source stated it). Who may edit it is recomputed from the chain on every native write and is not stated here.'),
  authority: z.string().nullable(),
  revision: z.number().int().nullable(),
  editedAt: zIsoTimestamp.nullable(),
  threadKey: z.string().describe('The thread its comments live in: its own post id, or — for a legacy referendum whose discussion happened on a linked council/technical-committee motion — that subject\'s.'),
  commentsCount: z.number().int(),
  source: zForumSource.nullable(),
})

export async function forumUnavailable(reply: FastifyReply): Promise<FastifyReply> {
  return reply.code(503).header('retry-after', '10')
    .send(errorEnvelope('unavailable', 'the forum snapshot is still loading; retry shortly'))
}

// The comment feed both threads serve (a referendum's, a discussion's).
export const COMMENT_FEED_RULES = [
  'One thread as a flat feed, oldest first (`createdAt`, then `commentId`): a reply carries `parentId`, the top-level comment it files under (two levels, as the explorer shows them), and `replyToId`, the comment it answers. Proposer updates (`kind: "update"`) ride in the same feed. Hidden and deleted comments stay in the feed as stubs so the thread keeps its shape; `threadKey` names the thread read.',
  'Following new comments: an imported comment carries its original `createdAt`, which is OLDER than the moment it reached this API (the import runs every 10 minutes), so a cursor past the newest comment would step over it. The last page therefore carries `tailCursor` instead of `nextCursor`: it resumes one hour before the thread\'s newest comment, so polling with it serves every comment that arrived since — together with the ones inside that hour again (de-duplicate by `commentId`; a re-served comment carries its current text and state). A comment that arrives more than an hour after its `createdAt` (an import held up for over an hour) is not re-served by the tail; edits and moderation of older comments are not either. Re-read the thread from the start to reconcile those.',
].join('\n\n')

export const zCommentFeedPage = zFeedPage(zForumComment).extend({
  threadKey: z.string().describe('The thread this feed reads.'),
  tailCursor: z.string().optional().describe('Last page only: pass back as ?cursor= to poll for comments that arrive later (see the route description). Absent while `hasMore` is true.'),
})

// A comment-feed cursor: a served comment's (createdAt ms, commentId), or a tail
// position (commentId '').
export function commentCursor(raw: string | undefined): CommentKey | null {
  if (!raw) return null
  const decoded = decodeCursor(raw)
  const t = cursorUint(decoded, 't', Number.MAX_SAFE_INTEGER)
  const c = typeof decoded?.c === 'string' && decoded.c.length <= 160 ? decoded.c : null
  if (t == null || c == null) throw badRequest('unreadable cursor: pass back a nextCursor or tailCursor exactly as it was received')
  return { t, c }
}

export async function commentFeed(client: ClickHouseClient, threadKey: string, after: CommentKey | null, limit: number): Promise<{ threadKey: string; items: ForumCommentItem[]; hasMore: boolean; nextCursor?: string; tailCursor?: string }> {
  const page = await threadPage(client, threadKey, after, limit)
  return {
    threadKey,
    items: page.items,
    hasMore: page.hasMore,
    ...(page.hasMore && page.last ? { nextCursor: encodeCursor({ t: page.last.t, c: page.last.c }) } : {}),
    ...(page.tail ? { tailCursor: encodeCursor({ t: page.tail.t, c: page.tail.c }) } : {}),
  }
}
