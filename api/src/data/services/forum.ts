import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  forumGeneration, forumPost, forumPosts, forumReady, forumThreadCounts, refreshForumStore, type ForumPostMeta,
} from '../../services/forumStore.ts'
import { forumItemShown, postLastActivityAt, textFold, threadKeyFor } from '../../services/forumView.ts'
import { dataConfig } from '../config.ts'
import { iso } from '../schemas/common.ts'
import { accountRefOrNull, type AccountRef } from './address.ts'

// The governance forum for /v1/governance/discussions* and the referendum surfaces
// (description, comments). Lists, titles, excerpts and counts answer from the
// process's own forum snapshot (services/forumStore.ts, loaded at boot and reloaded
// whenever the forum tables' watermark moves); a body or a thread is one
// primary-key-bounded FINAL read, cached under the snapshot's `generation`, so a
// cache never outlives the content it was built from.
//
// The visibility rule and the merged-thread resolution are the
// explorer's own (services/forumView.ts). Every text field is HOSTILE user content
// passed through as data. A hidden or deleted item is a stub: no title, body,
// excerpt, tldr, labels or author — and the body reads re-check the stored row's
// flags, so a moderation the snapshot has not reloaded yet still withholds its text.

const CACHE_TTL_MS = 60_000

export interface ForumAuthor { account: AccountRef | null; legacyName: string | null }
/** An imported item's provenance id; no link to where it was first written is served. */
export interface ForumSource { name: 'subsquare'; id: string }

/** True once the snapshot is loaded; a request before that joins the in-flight load. */
export async function forumSnapshotReady(): Promise<boolean> {
  if (forumReady()) return true
  await refreshForumStore().catch(() => {})
  return forumReady()
}

export function forumAuthor(accountId: string, legacyName: string): ForumAuthor {
  const account = accountRefOrNull(accountId)
  return account ? { account, legacyName: null } : { account: null, legacyName: legacyName || null }
}

const isoOrNull = (ms: number | null | undefined): string | null => (ms ? iso(ms) : null)
const textOrNull = (s: string): string | null => (s ? s : null)

function postSource(meta: ForumPostMeta): ForumSource | null {
  return meta.source === 'subsquare' ? { name: 'subsquare', id: meta.sourceId } : null
}

export function discussionExplorerUrl(postId: string): string {
  return `${dataConfig.explorerUrl}/discussions/${encodeURIComponent(postId)}`
}

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------

export const DISCUSSION_SORTS = ['active', 'new'] as const
export type DiscussionSort = (typeof DISCUSSION_SORTS)[number]

export interface DiscussionItem {
  postId: string
  title: string
  excerpt: string
  labels: string[]
  author: ForumAuthor
  createdAt: string
  lastActivityAt: string
  editedAt: string | null
  commentsCount: number
  linked: string[]
  source: ForumSource | null
  explorerUrl: string
}

// The keyset position of a discussion under one sort: the sort's own key, then
// creation time (newest first), then the post id (ascending) — a total order.
export interface DiscussionKey { k: number; t: number; id: string }

function discussionKey(meta: ForumPostMeta, sort: DiscussionSort): DiscussionKey {
  const k = sort === 'new' ? meta.createdAt : postLastActivityAt(meta)
  return { k, t: meta.createdAt, id: meta.postId }
}

export function compareDiscussionKeys(a: DiscussionKey, b: DiscussionKey): number {
  return (b.k - a.k) || (b.t - a.t) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function discussionItem(meta: ForumPostMeta): DiscussionItem {
  return {
    postId: meta.postId,
    title: meta.title,
    excerpt: meta.excerpt,
    labels: meta.labels,
    author: forumAuthor(meta.authorAccountId, meta.authorLegacyName),
    createdAt: iso(meta.createdAt),
    lastActivityAt: iso(postLastActivityAt(meta)),
    editedAt: isoOrNull(meta.editedAt),
    commentsCount: forumThreadCounts(meta.postId)?.comments ?? 0,
    linked: meta.linked,
    source: postSource(meta),
    explorerUrl: discussionExplorerUrl(meta.postId),
  }
}

/**
 * One page of the visible discussions under `sort`, after `after` (exclusive). A
 * filter over the snapshot's ~350 posts: no SQL, no cache.
 */
export function listDiscussions(opts: { sort: DiscussionSort; label?: string; q?: string; after: DiscussionKey | null; limit: number }): { items: DiscussionItem[]; hasMore: boolean; last: DiscussionKey | null } {
  const q = textFold(opts.q?.trim() ?? '')
  const keyed: Array<{ meta: ForumPostMeta; key: DiscussionKey }> = []
  for (const meta of forumPosts()) {
    if (meta.kind !== 'discussion' || !forumItemShown(meta)) continue
    if (opts.label && !meta.labels.includes(opts.label)) continue
    if (q && !textFold(meta.title).includes(q) && !textFold(meta.excerpt).includes(q)) continue
    const key = discussionKey(meta, opts.sort)
    if (opts.after && compareDiscussionKeys(key, opts.after) <= 0) continue
    keyed.push({ meta, key })
  }
  keyed.sort((a, b) => compareDiscussionKeys(a.key, b.key))
  const page = keyed.slice(0, opts.limit)
  return { items: page.map(entry => discussionItem(entry.meta)), hasMore: keyed.length > page.length, last: page[page.length - 1]?.key ?? null }
}

// ---------------------------------------------------------------------------
// A post (a discussion, or an on-chain subject's description)
// ---------------------------------------------------------------------------

// The current text of one post: a primary-key-bounded FINAL read. The row's own
// flags decide, not the snapshot's: a post hidden since the last reload reads as
// null here and is served as a stub.
async function postText(client: ClickHouseClient, postId: string): Promise<{ body: string } | null> {
  return cached(`data:forum:post-body:${postId}:${forumGeneration()}`, CACHE_TTL_MS, async () => {
    const res = await client.query({
      query: `-- data:forum:post-body
        SELECT if(hidden = 0 AND deleted = 0, body, '') AS shown_body, hidden, deleted
        FROM price_data.forum_posts FINAL
        WHERE post_id = {id:String}
        LIMIT 1`,
      query_params: { id: postId },
      format: 'JSONEachRow',
    })
    const [row] = await res.json<{ shown_body: string; hidden: number; deleted: number }>()
    if (!row || Number(row.hidden) === 1 || Number(row.deleted) === 1) return null
    return { body: row.shown_body }
  })
}

export interface DiscussionDetail {
  postId: string
  hidden: boolean
  deleted: boolean
  hiddenReason: string | null
  title: string | null
  excerpt: string | null
  body: string | null
  bodyFormat: string | null
  tldr: string | null
  labels: string[]
  author: ForumAuthor | null
  authority: string | null
  revision: number | null
  createdAt: string
  editedAt: string | null
  lastActivityAt: string | null
  threadKey: string
  commentsCount: number | null
  locked: boolean
  linked: string[]
  source: ForumSource | null
  explorerUrl: string
}

function stubReason(meta: Pick<ForumPostMeta, 'deleted' | 'hiddenReason'>): string | null {
  return meta.deleted ? 'deleted' : meta.hiddenReason || null
}

function discussionStub(meta: ForumPostMeta): DiscussionDetail {
  return {
    postId: meta.postId,
    hidden: true,
    deleted: meta.deleted,
    hiddenReason: stubReason(meta),
    title: null, excerpt: null, body: null, bodyFormat: null, tldr: null, labels: [], author: null, authority: null, revision: null,
    createdAt: iso(meta.createdAt),
    editedAt: null, lastActivityAt: null,
    threadKey: meta.postId,
    commentsCount: null,
    locked: meta.locked,
    linked: meta.linked,
    source: null,
    explorerUrl: discussionExplorerUrl(meta.postId),
  }
}

/** One discussion, or null when no discussion has this id. A hidden or deleted one is a stub. */
export async function loadDiscussion(client: ClickHouseClient, postId: string): Promise<DiscussionDetail | null> {
  const meta = forumPost(postId)
  if (!meta || meta.kind !== 'discussion') return null
  if (!forumItemShown(meta)) return discussionStub(meta)
  const text = await postText(client, postId)
  if (!text) return discussionStub(meta)
  const threadKey = threadKeyFor(postId)
  return {
    postId,
    hidden: false,
    deleted: false,
    hiddenReason: null,
    title: meta.title,
    excerpt: meta.excerpt,
    body: text.body,
    bodyFormat: meta.bodyFormat,
    tldr: textOrNull(meta.tldr),
    labels: meta.labels,
    author: forumAuthor(meta.authorAccountId, meta.authorLegacyName),
    authority: meta.authority || null,
    revision: meta.revision,
    createdAt: iso(meta.createdAt),
    editedAt: isoOrNull(meta.editedAt),
    lastActivityAt: iso(postLastActivityAt(meta, threadKey)),
    threadKey,
    commentsCount: forumThreadCounts(threadKey)?.comments ?? 0,
    locked: meta.locked || (forumPost(threadKey)?.locked ?? false),
    linked: meta.linked,
    source: postSource(meta),
    explorerUrl: discussionExplorerUrl(postId),
  }
}

export interface SubjectDescription {
  postId: string
  hidden: boolean
  hiddenReason: string | null
  title: string | null
  tldr: string | null
  excerpt: string | null
  body: string | null
  bodyFormat: string | null
  author: ForumAuthor | null
  authority: string | null
  revision: number | null
  editedAt: string | null
  threadKey: string
  commentsCount: number
  source: ForumSource | null
}

export type DescriptionStatus = 'ok' | 'hidden' | 'none' | 'unavailable'

/**
 * An on-chain subject's description post ('opengov:<i>', 'democracy:<i>') and its
 * state: `none` when the forum holds no record for it, `unavailable` while the
 * snapshot is not loaded (the referendum is served regardless), `hidden` for a stub.
 */
export async function subjectDescription(client: ClickHouseClient, postId: string): Promise<{ status: DescriptionStatus; description: SubjectDescription | null }> {
  if (!(await forumSnapshotReady())) return { status: 'unavailable', description: null }
  const description = await loadSubjectDescription(client, postId)
  return { status: !description ? 'none' : description.hidden ? 'hidden' : 'ok', description }
}

/** A referendum's title: its visible description's, from the snapshot; null when there is none (or no snapshot yet). */
export function referendumTitle(pallet: string, refIndex: number): string | null {
  const meta = forumPost(`${pallet}:${refIndex}`)
  return meta && forumItemShown(meta) && meta.title ? meta.title : null
}

async function loadSubjectDescription(client: ClickHouseClient, postId: string): Promise<SubjectDescription | null> {
  const meta = forumPost(postId)
  if (!meta) return null
  const threadKey = threadKeyFor(postId)
  const commentsCount = forumThreadCounts(threadKey)?.comments ?? 0
  const text = forumItemShown(meta) ? await postText(client, postId) : null
  if (!text) {
    return {
      postId, hidden: true, hiddenReason: stubReason(meta),
      title: null, tldr: null, excerpt: null, body: null, bodyFormat: null, author: null, authority: null, revision: null, editedAt: null,
      threadKey, commentsCount, source: null,
    }
  }
  return {
    postId,
    hidden: false,
    hiddenReason: null,
    title: textOrNull(meta.title),
    tldr: textOrNull(meta.tldr),
    excerpt: textOrNull(meta.excerpt),
    body: textOrNull(text.body),
    bodyFormat: text.body ? meta.bodyFormat : null,
    author: meta.authorAccountId || meta.authorLegacyName ? forumAuthor(meta.authorAccountId, meta.authorLegacyName) : null,
    authority: meta.authority || null,
    revision: meta.revision,
    editedAt: isoOrNull(meta.editedAt),
    threadKey,
    commentsCount,
    source: postSource(meta),
  }
}

// ---------------------------------------------------------------------------
// A thread
// ---------------------------------------------------------------------------

export interface ForumCommentItem {
  commentId: string
  kind: string
  parentId: string | null
  replyToId: string | null
  hidden: boolean
  deleted: boolean
  hiddenReason: string | null
  author: ForumAuthor | null
  body: string | null
  bodyFormat: string | null
  createdAt: string
  editedAt: string | null
  revision: number | null
  source: { name: 'subsquare'; id: string } | null
}

export interface CommentKey { t: number; c: string }

interface ThreadRow {
  comment_id: string; kind: string; parent_id: string; reply_to_id: string
  shown_author_id: string; shown_legacy_name: string; shown_body: string; body_format: string
  source: string; source_id: string; revision: number; hidden: number; hidden_reason: string; deleted: number
  created_s: string; edited_s: string
}

const chMs = (s: string): number => Date.parse(`${s.replace(' ', 'T')}Z`) || 0

export function compareCommentKeys(a: CommentKey, b: CommentKey): number {
  return (a.t - b.t) || (a.c < b.c ? -1 : a.c > b.c ? 1 : 0)
}

// One thread's rows, oldest first: a primary-key prefix read (thread_key leads the
// table's key). The text of a hidden or deleted comment never leaves ClickHouse.
async function threadRows(client: ClickHouseClient, threadKey: string): Promise<ThreadRow[]> {
  return cached(`data:forum:thread:${threadKey}:${forumGeneration()}`, CACHE_TTL_MS, async () => {
    const res = await client.query({
      query: `-- data:forum:thread
        SELECT comment_id, kind, parent_id, reply_to_id,
               if(hidden = 0 AND deleted = 0, author_account_id, '') AS shown_author_id,
               if(hidden = 0 AND deleted = 0, author_legacy_name, '') AS shown_legacy_name,
               if(hidden = 0 AND deleted = 0, body, '') AS shown_body,
               body_format, source, source_id, revision, hidden, hidden_reason, deleted,
               toString(created_at) AS created_s, toString(edited_at) AS edited_s
        FROM price_data.forum_comments FINAL
        WHERE thread_key = {k:String}
        ORDER BY created_at, comment_id`,
      query_params: { k: threadKey },
      format: 'JSONEachRow',
    })
    return res.json<ThreadRow>()
  })
}

function commentItem(row: ThreadRow, topLevel: Set<string>): ForumCommentItem & { key: CommentKey } {
  const hidden = Number(row.hidden) === 1, deleted = Number(row.deleted) === 1
  const shown = !hidden && !deleted
  const createdMs = chMs(row.created_s)
  const editedMs = chMs(row.edited_s)
  return {
    key: { t: createdMs, c: row.comment_id },
    commentId: row.comment_id,
    kind: row.kind,
    // Two levels: a reply files under its top-level parent; one whose parent is not
    // a top-level comment of this thread (removed upstream before import) stands as
    // a top-level comment — the explorer's placement.
    parentId: row.parent_id && row.parent_id !== row.comment_id && topLevel.has(row.parent_id) ? row.parent_id : null,
    replyToId: row.reply_to_id || null,
    hidden: !shown,
    deleted,
    hiddenReason: deleted ? 'deleted' : hidden ? row.hidden_reason || null : null,
    author: shown ? forumAuthor(row.shown_author_id, row.shown_legacy_name) : null,
    body: shown ? row.shown_body : null,
    bodyFormat: shown ? row.body_format : null,
    createdAt: iso(createdMs),
    editedAt: shown && editedMs > 0 ? iso(editedMs) : null,
    revision: shown ? Number(row.revision) : null,
    source: row.source === 'subsquare' ? { name: 'subsquare', id: row.source_id } : null,
  }
}

/** The thread readers of `postId` see (its own, or a linked subject's merged thread). */
export function resolveThreadKey(postId: string): string {
  return forumPost(postId) ? threadKeyFor(postId) : postId
}

/**
 * How far behind the thread's newest comment a tail cursor starts. An imported
 * comment carries Subsquare's createdAt, which is older than its arrival here by
 * up to one sync interval (10 min) plus the sync's write and this snapshot's
 * reload; native comments are dated at write time. The margin covers that with
 * room to spare and matches the hour inside which the sync still treats an item
 * as new.
 */
export const TAIL_MARGIN_MS = 3_600_000

/**
 * One page of a thread, oldest first, after `after` (exclusive). On the last page
 * `tail` is the position a poller resumes from: TAIL_MARGIN_MS before the thread's
 * newest comment, so a later arrival with an older createdAt is still served (the
 * comments inside the margin are served again; a poller de-duplicates by id).
 */
export async function threadPage(client: ClickHouseClient, threadKey: string, after: CommentKey | null, limit: number): Promise<{ items: ForumCommentItem[]; hasMore: boolean; last: CommentKey | null; tail: CommentKey | null }> {
  const rows = await threadRows(client, threadKey)
  const topLevel = new Set(rows.filter(r => r.kind !== 'update' && !r.parent_id).map(r => r.comment_id))
  const all = rows.map(row => commentItem(row, topLevel)).sort((a, b) => compareCommentKeys(a.key, b.key))
  const rest = after ? all.filter(item => compareCommentKeys(item.key, after) > 0) : all
  const page = rest.slice(0, limit)
  const hasMore = rest.length > page.length
  const newest = all[all.length - 1]?.key.t ?? 0
  return {
    items: page.map(({ key: _key, ...item }) => item),
    hasMore,
    last: page[page.length - 1]?.key ?? null,
    tail: hasMore ? null : { t: Math.max(0, newest - TAIL_MARGIN_MS), c: '' },
  }
}
