import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { accountRef, resolveRelatedAccounts, type AccountRef } from './explorerService.ts'
import { getReferendum } from './governanceService.ts'
import { htmlImageSources, markdownImageTargets, ownImageUrls } from './forumText.ts'
import { forumItemShown, postLastActivityAt, textFold, threadKeyFor } from './forumView.ts'
import {
  forumComment, forumComments, forumGeneration, forumMedia, forumMediaUrlMap, forumPost, forumPosts, forumThreadCounts,
  type ForumPostMeta,
} from './forumStore.ts'

// The forum's read side (explorer routes under /explorer/forum/*): discussions,
// posts, threads, revisions, the public moderation log and an account's
// forum activity.
//
// Lists answer from the in-process snapshot (forumStore.ts); a post body, a thread,
// a revision list are one primary-key-bounded FINAL read each, cached per forum
// `generation` — the snapshot's watermark, which every write moves — so a cache never
// outlives the content it was built from.
//
// Every text field is HOSTILE user content passed through as data: the explorer's one
// renderer makes it safe. A hidden or deleted item is a stub that carries no title,
// body or excerpt — Subsquare's own hidden set holds live XSS probes, and an API
// consumer that is not our renderer must not receive them either.

let client: ClickHouseClient
export function initForumRead(c: ClickHouseClient): void { client = c }

const PUBLIC_URL = (process.env.EXPLORER_PUBLIC_URL ?? 'https://hydration-explorer.neckwork.net').replace(/\/+$/, '')

export interface ForumAuthor { account: AccountRef | null; legacyName: string | null }

function author(accountId: string, legacyName: string): ForumAuthor {
  return /^0x[0-9a-f]{64}$/.test(accountId)
    ? { account: accountRef(accountId), legacyName: null }
    : { account: null, legacyName: legacyName || null }
}

// The visibility/stub rule and the thread resolution live in the
// forumView.ts leaf, so the Data API states them exactly as these routes do.
export { threadKeyFor } from './forumView.ts'

const visible = (p: ForumPostMeta) => forumItemShown(p)

// ---- discussions ----

export type DiscussionSort = 'active' | 'new'

export interface DiscussionRow {
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
  source: { name: 'subsquare' } | null
  bannerCid: string | null
  /** The banner as our own image (`/ipfs/<cid>`) once the sync has re-hosted it, else null (bannerPathFor). */
  banner: string | null
  hasPoll: boolean
}

export interface DiscussionsPage { generation: string; total: number; rows: DiscussionRow[]; nextCursor: string | null }

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null)

function discussionRow(p: ForumPostMeta): DiscussionRow {
  const counts = forumThreadCounts(p.postId)
  return {
    postId: p.postId,
    title: p.title,
    excerpt: p.excerpt,
    labels: p.labels,
    author: author(p.authorAccountId, p.authorLegacyName),
    createdAt: iso(p.createdAt)!,
    lastActivityAt: iso(postLastActivityAt(p))!,
    editedAt: iso(p.editedAt),
    commentsCount: counts?.comments ?? 0,
    linked: p.linked,
    source: p.source === 'subsquare' ? { name: 'subsquare' } : null,
    bannerCid: p.bannerCid || null,
    banner: bannerPathFor(p.bannerCid),
    hasPoll: !!p.pollJson,
  }
}

/**
 * The post kinds the forum lists as collections: discussions, and the imported
 * descriptions of every on-chain subject (the pre-OpenGov archive is browsable by
 * its own records — a council motion, a tip, a treasury proposal — not only from
 * the chain rows). Referenda have their own directory and pages.
 */
export const LISTED_POST_KINDS = ['discussion', 'democracy_proposal', 'external', 'council', 'tc', 'treasury_proposal', 'treasury_spend', 'tip'] as const
export type ListedPostKind = typeof LISTED_POST_KINDS[number]

export function listDiscussions(opts: { sort: DiscussionSort; label?: string; q?: string; offset: number; limit: number; kind?: ListedPostKind }): DiscussionsPage {
  const q = textFold(opts.q?.trim() ?? '')
  const kind = opts.kind ?? 'discussion'
  const metas = [...forumPosts()]
    .filter(p => p.kind === kind && visible(p))
    .filter(p => !opts.label || p.labels.includes(opts.label))
    .filter(p => !q || textFold(p.title).includes(q) || textFold(p.excerpt).includes(q))
  const thin = new Set(metas.filter(p => p.bodyLength < HIGHLIGHT_MIN_BODY).map(p => p.postId))
  const rows = metas.map(discussionRow)
  // 'active' ranks a thin post nobody engaged with (a body under HIGHLIGHT_MIN_BODY,
  // no comment) after every other one, so a one-line test post does not
  // lead the directory; it stays listed, and 'new' still shows it first.
  const sunk = (r: DiscussionRow) => (opts.sort === 'active' && thin.has(r.postId) && r.commentsCount === 0 ? 1 : 0)
  const key = (r: DiscussionRow) => Date.parse(opts.sort === 'new' ? r.createdAt : r.lastActivityAt)
  rows.sort((a, b) => sunk(a) - sunk(b) || key(b) - key(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.postId < b.postId ? -1 : 1))
  const page = rows.slice(opts.offset, opts.offset + opts.limit)
  return {
    generation: forumGeneration(),
    total: rows.length,
    rows: page,
    nextCursor: opts.offset + page.length < rows.length ? String(opts.offset + page.length) : null,
  }
}

/**
 * The hub's "recent discussions": the most recently active discussions that have a
 * real body (HIGHLIGHT_MIN_BODY characters) and at least one comment — a one-line
 * test post or a probe does not lead the page. Every discussion
 * stays listed in the full directory.
 */
export const HIGHLIGHT_MIN_BODY = 280

export function highlightDiscussions(limit: number): DiscussionRow[] {
  const rows = [...forumPosts()]
    .filter(p => p.kind === 'discussion' && visible(p) && p.bodyLength >= HIGHLIGHT_MIN_BODY)
    .map(discussionRow)
    .filter(r => r.commentsCount > 0)
  rows.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) || (a.postId < b.postId ? -1 : 1))
  return rows.slice(0, limit)
}

/** Every label in use on visible discussions, with counts. */
export function discussionLabels(): { label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const p of forumPosts()) if (p.kind === 'discussion' && visible(p)) for (const l of p.labels) counts.set(l, (counts.get(l) ?? 0) + 1)
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

// ---- a post ----

export interface ForumPostStub { postId: string; kind: string; hidden: true; hiddenReason: string; deleted: boolean; createdAt: string }

export interface ForumPostDetail {
  postId: string
  kind: string
  title: string
  body: string
  bodyFormat: string
  tldr: string
  labels: string[]
  linked: string[]
  author: ForumAuthor
  authority: string
  revision: number
  createdAt: string
  editedAt: string | null
  lastActivityAt: string
  commentsCount: number
  updatesCount: number
  /** The thread a reader of this post sees: its own, or a linked subject's merged thread. */
  threadKey: string
  source: { name: 'subsquare'; id: string; cid: string | null; removed: boolean } | null
  bannerCid: string | null
  /** The banner as our own image (`/ipfs/<cid>`) once the sync has re-hosted it, else null (bannerPathFor). */
  banner: string | null
  poll: unknown
  /** A moderator locked the thread: it takes no new comments. */
  locked: boolean
  /** Imported image URL → `/ipfs/<cid>` for the images in this body that were re-hosted. */
  media: Record<string, string>
  hidden: false
  generation: string
}

/** The image URLs written in a body (markdown `![](…)` and HTML `<img src>`), for the rewrite map. */
export function imageUrlsIn(body: string): string[] {
  return [...new Set([...markdownImageTargets(body), ...htmlImageSources(body)])]
}

/**
 * The images in a body a reader's browser may load, as `url → /ipfs/<cid>`: imported
 * URLs the sync re-hosted (the rewrite map), and our own `/ipfs/<cid>` URLs (an upload
 * here) whose CID is a live forum image. Anything else renders as a plain link.
 */
/**
 * A post's banner as our own image path, or null until the sync has re-hosted it. The
 * sync keys a banner in the image map by Subsquare's gateway URL for its CID
 * (src/governance/subsquare/rows.ts `bannerUrl`) and pins it under that CID where the
 * bytes reproduce it, so either lookup finds it; a reader never loads a stranger's host.
 */
export function bannerPathFor(bannerCid: string): string | null {
  if (!bannerCid) return null
  const cid = forumMediaUrlMap().get(`https://subsquare.infura-ipfs.io/ipfs/${bannerCid}`) ?? (forumMedia(bannerCid) ? bannerCid : null)
  return cid ? `/ipfs/${cid}` : null
}

export function mediaMapFor(body: string): Record<string, string> {
  const map = forumMediaUrlMap()
  const out: Record<string, string> = {}
  for (const url of imageUrlsIn(body)) {
    const cid = map.get(url)
    if (cid) out[url] = `/ipfs/${cid}`
  }
  for (const { url, cid } of ownImageUrls(body, PUBLIC_URL)) if (forumMedia(cid)) out[url] = `/ipfs/${cid}`
  return out
}

export async function getForumPost(postId: string): Promise<ForumPostDetail | ForumPostStub | null> {
  const meta = forumPost(postId)
  if (!meta) return null
  if (!visible(meta)) return { postId, kind: meta.kind, hidden: true, hiddenReason: meta.deleted ? 'deleted' : meta.hiddenReason, deleted: meta.deleted, createdAt: iso(meta.createdAt)! }
  const generation = forumGeneration()
  return cached(`forum:post:${postId}:${generation}`, 60_000, async () => {
    const res = await client.query({
      query: `SELECT body FROM price_data.forum_posts FINAL WHERE post_id = {id:String} LIMIT 1`,
      query_params: { id: postId }, format: 'JSONEachRow',
    })
    const body = (await res.json<{ body: string }>())[0]?.body ?? ''
    const threadKey = threadKeyFor(postId)
    const counts = forumThreadCounts(threadKey)
    let poll: unknown = null
    if (meta.pollJson) { try { poll = JSON.parse(meta.pollJson) } catch { poll = null } }
    return {
      postId,
      kind: meta.kind,
      title: meta.title,
      body,
      bodyFormat: meta.bodyFormat,
      tldr: meta.tldr,
      labels: meta.labels,
      linked: meta.linked,
      author: author(meta.authorAccountId, meta.authorLegacyName),
      authority: meta.authority,
      revision: meta.revision,
      createdAt: iso(meta.createdAt)!,
      editedAt: iso(meta.editedAt),
      lastActivityAt: iso(postLastActivityAt(meta, threadKey))!,
      commentsCount: counts?.comments ?? 0,
      updatesCount: forumThreadCounts(postId)?.updates ?? 0,
      threadKey,
      source: meta.source === 'subsquare'
        ? { name: 'subsquare', id: meta.sourceId, cid: meta.sourceCid || null, removed: meta.sourceRemoved }
        : null,
      bannerCid: meta.bannerCid || null,
      banner: bannerPathFor(meta.bannerCid),
      poll,
      locked: meta.locked || (forumPost(threadKey)?.locked ?? false),
      media: mediaMapFor(body),
      hidden: false,
      generation,
    }
  })
}

// ---- a thread ----

export interface CommentRow {
  thread_key: string; comment_id: string; kind: string; parent_id: string; reply_to_id: string
  author_account_id: string; author_legacy_name: string; body: string; body_format: string; authority: string
  source: string; source_id: string; source_cid: string; source_height: number; source_removed: number
  revision: number; hidden: number; hidden_reason: string; deleted: number; created_at: string; edited_at: string
}

export interface ForumComment {
  commentId: string
  parentId: string | null
  replyToId: string | null
  author: ForumAuthor | null
  /** Null on a hidden or deleted comment (a stub that keeps the thread's shape). */
  body: string | null
  bodyFormat: string
  hidden: boolean
  hiddenReason: string | null
  deleted: boolean
  createdAt: string
  editedAt: string | null
  revision: number
  source: { name: 'subsquare'; id: string; cid: string | null; height: number | null } | null
  /** On a referendum thread: the author's standing vote there (direction, conviction, amount). */
  position: { side: string; conviction: string | null; balance: string; weighted: string } | null
  media: Record<string, string>
  replies: ForumComment[]
}

export type ThreadSort = 'new' | 'old'
export type ThreadFilter = 'voters' | 'identity' | null

export interface ForumThread {
  requested: string
  threadKey: string
  generation: string
  total: number
  rows: ForumComment[]
  updates: ForumComment[]
  nextCursor: string | null
  /** False when the referendum's voter list was cut (positions shown for its heaviest voters only). */
  positionsComplete: boolean | null
  /** A moderator locked the thread: it takes no new comments. */
  locked: boolean
}

const ms = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`) || 0
const parseIso = (s: string) => (ms(s) ? new Date(ms(s)).toISOString() : null)

async function threadRows(threadKey: string): Promise<CommentRow[]> {
  return cached(`forum:thread-rows:${threadKey}:${forumGeneration()}`, 60_000, async () => {
    const res = await client.query({
      query: `SELECT thread_key, comment_id, kind, parent_id, reply_to_id, author_account_id, author_legacy_name, body, body_format, authority,
                     source, source_id, source_cid, source_height, source_removed, revision, hidden, hidden_reason, deleted,
                     toString(created_at) AS created_at, toString(edited_at) AS edited_at
              FROM price_data.forum_comments FINAL
              WHERE thread_key = {k:String}
              ORDER BY created_at, comment_id`,
      query_params: { k: threadKey }, format: 'JSONEachRow',
    })
    return res.json<CommentRow>()
  })
}

async function positionsFor(threadKey: string): Promise<{ map: Map<string, ForumComment['position']>; complete: boolean } | null> {
  const m = /^(opengov|democracy):(\d+)$/.exec(threadKey)
  if (!m) return null
  const detail = await getReferendum(m[1] as 'opengov' | 'democracy', Number(m[2])).catch(() => null)
  if (!detail) return null
  const map = new Map<string, ForumComment['position']>()
  for (const v of detail.voters) {
    if (!v.account || v.removed) continue
    map.set(v.account.accountId, { side: v.side, conviction: v.conviction, balance: v.balance, weighted: v.weighted })
  }
  return { map, complete: detail.votesShown >= detail.votesTotal }
}

/** A stored comment row as the API returns it (no vote position: a write's response). */
export function commentFromRow(r: CommentRow): ForumComment { return commentOf(r, null) }

function commentOf(r: CommentRow, positions: Map<string, ForumComment['position']> | null): ForumComment {
  const hidden = Number(r.hidden) === 1, deleted = Number(r.deleted) === 1
  const shown = !hidden && !deleted
  return {
    commentId: r.comment_id,
    parentId: r.parent_id || null,
    replyToId: r.reply_to_id || null,
    author: deleted ? null : author(r.author_account_id, r.author_legacy_name),
    body: shown ? r.body : null,
    bodyFormat: r.body_format,
    hidden,
    hiddenReason: hidden ? r.hidden_reason || null : null,
    deleted,
    createdAt: parseIso(r.created_at) ?? r.created_at,
    editedAt: ms(r.edited_at) > 0 ? parseIso(r.edited_at) : null,
    revision: Number(r.revision),
    source: r.source === 'subsquare' ? { name: 'subsquare', id: r.source_id, cid: r.source_cid || null, height: Number(r.source_height) || null } : null,
    position: shown && r.author_account_id ? positions?.get(r.author_account_id) ?? null : null,
    media: shown ? mediaMapFor(r.body) : {},
    replies: [],
  }
}

// Thread pages are keyset-paged: the cursor is the last row's sort key — (createdAt,
// id) — so a comment arriving
// between two page reads neither repeats a row nor skips one, as an offset would.
// Opaque on the wire (base64url JSON naming its sort, so a cursor is never applied to
// another order).
type ThreadKey = [number, string] // [createdAt ms, commentId]

function threadKeyOf(c: ForumComment): ThreadKey {
  return [Date.parse(c.createdAt) || 0, c.commentId]
}

/** Total order per sort: old = time asc; new = time desc; id breaks ties. */
function compareThreadKeys(a: ThreadKey, b: ThreadKey, sort: ThreadSort): number {
  const dir = sort === 'new' ? -1 : 1
  if (a[0] !== b[0]) return dir * (a[0] - b[0])
  return dir * (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
}

export function encodeThreadCursor(sort: ThreadSort, key: ThreadKey): string {
  return Buffer.from(JSON.stringify([sort, ...key])).toString('base64url')
}

/** The key a cursor names, or null when it is malformed or was issued for another sort. */
export function decodeThreadCursor(cursor: string, sort: ThreadSort): ThreadKey | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(v) || v.length !== 3 || v[0] !== sort) return null
    const [, at, id] = v
    return Number.isFinite(at) && typeof id === 'string' && id.length <= 160 ? [at, id] : null
  } catch { return null }
}

export class BadCursorError extends Error {}

export async function getForumThread(requested: string, opts: { sort: ThreadSort; filter: ThreadFilter; cursor: string | null; limit: number }): Promise<ForumThread> {
  const after = opts.cursor ? decodeThreadCursor(opts.cursor, opts.sort) : null
  if (opts.cursor && !after) throw new BadCursorError('cursor does not belong to this thread order')
  const threadKey = forumPost(requested) ? threadKeyFor(requested) : requested
  const [rows, positions] = await Promise.all([threadRows(threadKey), positionsFor(threadKey)])
  const posMap = positions?.map ?? null
  const all = rows.map(r => commentOf(r, posMap))
  const updates = all.filter((_, i) => rows[i].kind === 'update')
  const comments = all.filter((_, i) => rows[i].kind !== 'update')
  // Two levels: a reply files under its top-level parent; a reply whose parent is
  // missing (removed on Subsquare before import) stands as a top-level row.
  const byId = new Map(comments.map(c => [c.commentId, c]))
  const top: ForumComment[] = []
  for (const c of comments) {
    const parent = c.parentId ? byId.get(c.parentId) : null
    if (parent && parent !== c && !parent.parentId) parent.replies.push(c)
    else top.push(c)
  }
  const keep = (c: ForumComment): boolean => {
    if (opts.filter === 'voters') return !!c.position
    if (opts.filter === 'identity') return !!c.author?.account?.identity
    return true
  }
  const filtered = opts.filter ? top.filter(c => keep(c) || c.replies.some(keep)) : top
  const t = (c: ForumComment) => Date.parse(c.createdAt) || 0
  filtered.sort((a, b) => compareThreadKeys(threadKeyOf(a), threadKeyOf(b), opts.sort))
  for (const c of filtered) c.replies.sort((a, b) => t(a) - t(b) || (a.commentId < b.commentId ? -1 : 1))
  const rest = after ? filtered.filter(c => compareThreadKeys(threadKeyOf(c), after, opts.sort) > 0) : filtered
  const page = rest.slice(0, opts.limit)
  const last = page[page.length - 1]
  return {
    requested,
    threadKey,
    generation: forumGeneration(),
    total: filtered.length,
    rows: page,
    updates: updates.sort((a, b) => t(a) - t(b)),
    nextCursor: page.length < rest.length && last ? encodeThreadCursor(opts.sort, threadKeyOf(last)) : null,
    positionsComplete: positions ? positions.complete : null,
    locked: forumPost(threadKey)?.locked ?? false,
  }
}

// ---- revisions, moderation log ----

/** Whether a post or comment exists and is shown (null: unknown id) — from the in-memory snapshot. */
function targetVisible(targetId: string): boolean | null {
  const post = forumPost(targetId)
  if (post) return visible(post)
  const c = forumComment(targetId)
  return c ? !c.hidden && !c.deleted : null
}

export interface ForumRevision { revision: number; title: string; body: string; editor: ForumAuthor | null; source: string; createdAt: string }

export async function getForumRevisions(targetId: string): Promise<{ targetId: string; generation: string; revisions: ForumRevision[] } | null> {
  const vis = targetVisible(targetId)
  if (vis == null) return null
  const generation = forumGeneration()
  if (!vis) return { targetId, generation, revisions: [] }
  return cached(`forum:revisions:${targetId}:${generation}`, 60_000, async () => {
    const res = await client.query({
      query: `SELECT revision, title, body, editor_account_id, source, toString(created_at) AS created_at
              FROM price_data.forum_revisions FINAL WHERE target_id = {id:String} ORDER BY revision`,
      query_params: { id: targetId }, format: 'JSONEachRow',
    })
    const rows = await res.json<{ revision: number; title: string; body: string; editor_account_id: string; source: string; created_at: string }>()
    return {
      targetId, generation,
      revisions: rows.map(r => ({
        revision: Number(r.revision), title: r.title, body: r.body,
        editor: r.editor_account_id ? author(r.editor_account_id, '') : null,
        source: r.source, createdAt: parseIso(r.created_at) ?? r.created_at,
      })),
    }
  })
}

// `threadKey` names a comment target's thread, so the log can link into it: a
// comment id is no address of its own. Absent for a post, an image, or a comment
// the snapshot does not hold.
export interface ModerationLogRow { actionId: string; targetId: string; action: string; reasonCode: string; moderator: ForumAuthor | { source: 'subsquare' | 'reports' }; at: string; threadKey?: string }

export async function getModerationLog(offset: number, limit: number): Promise<{ generation: string; total: number; rows: ModerationLogRow[]; nextCursor: string | null }> {
  const generation = forumGeneration()
  const all = await cached(`forum:moderation-log:${generation}`, 60_000, async () => {
    const res = await client.query({
      query: `SELECT action_id, target_id, action, reason_code, moderator_account_id, toString(created_at) AS created_at
              FROM price_data.forum_moderation_log FINAL ORDER BY created_at DESC, action_id`,
      format: 'JSONEachRow',
    })
    return res.json<{ action_id: string; target_id: string; action: string; reason_code: string; moderator_account_id: string; created_at: string }>()
  })
  const rows = all.slice(offset, offset + limit).map((r): ModerationLogRow => {
    const threadKey = forumComment(r.target_id)?.threadKey
    return {
      actionId: r.action_id, targetId: r.target_id, action: r.action, reasonCode: r.reason_code,
      moderator: r.moderator_account_id === 'subsquare' ? { source: 'subsquare' as const }
        : r.moderator_account_id === 'reports' ? { source: 'reports' as const } : author(r.moderator_account_id, ''),
      at: parseIso(r.created_at) ?? r.created_at,
      ...(threadKey ? { threadKey } : {}),
    }
  })
  return { generation, total: all.length, rows, nextCursor: offset + rows.length < all.length ? String(offset + rows.length) : null }
}

// ---- an account's forum activity ----

export interface AccountForumItem {
  type: 'post' | 'comment'
  id: string
  threadKey: string
  title: string | null
  excerpt: string
  createdAt: string
}

export async function getAccountForum(address: string, offset: number, limit: number): Promise<{ generation: string; total: number; rows: AccountForumItem[]; nextCursor: string | null } | null> {
  const resolved = await resolveRelatedAccounts(address)
  if (!resolved) return null
  const ids = [...resolved.related]
  const generation = forumGeneration()
  const all = await cached(`forum:account:${resolved.norm.accountId}:${generation}`, 60_000, async () => {
    const items: AccountForumItem[] = []
    for (const p of forumPosts()) {
      if (p.kind !== 'discussion' || !visible(p) || !ids.includes(p.authorAccountId)) continue
      items.push({ type: 'post', id: p.postId, threadKey: p.postId, title: p.title, excerpt: p.excerpt, createdAt: iso(p.createdAt)! })
    }
    for (const c of forumComments()) {
      if (c.kind !== 'comment' || c.hidden || c.deleted || !ids.includes(c.authorAccountId)) continue
      const parent = forumPost(c.threadKey)
      items.push({
        type: 'comment', id: c.commentId, threadKey: c.threadKey,
        title: parent && visible(parent) ? parent.title || null : null,
        excerpt: c.excerpt, createdAt: iso(c.createdAt)!,
      })
    }
    return items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  })
  const rows = all.slice(offset, offset + limit)
  return { generation, total: all.length, rows, nextCursor: offset + rows.length < all.length ? String(offset + rows.length) : null }
}

// ---- the forum facts the referendum surfaces carry ----

/** A referendum's (or any on-chain subject's) forum record: its description post and its thread. */
export interface SubjectForumRef {
  postId: string
  /** The thread readers see (its own, or the merged thread of a linked subject). */
  threadKey: string
  commentsCount: number
  /** A visible description post with text exists (fetch it from /explorer/forum/post/:postId). */
  hasDescription: boolean
  authority: string | null
  source: { name: 'subsquare' } | null
}

export function subjectForumRef(postId: string): SubjectForumRef {
  const meta = forumPost(postId)
  const threadKey = meta ? threadKeyFor(postId) : postId
  const shown = !!meta && visible(meta)
  return {
    postId,
    threadKey,
    commentsCount: forumThreadCounts(threadKey)?.comments ?? 0,
    hasDescription: shown && meta!.bodyLength > 0,
    authority: meta?.authority ?? null,
    source: meta?.source === 'subsquare' ? { name: 'subsquare' } : null,
  }
}
