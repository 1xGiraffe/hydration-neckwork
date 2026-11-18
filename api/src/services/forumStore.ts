import { createHash } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'

// The governance forum's in-process snapshot (forum_* tables, 021_forum.sql).
//
// Every post row WITHOUT its body (plus a short plain-text excerpt), the per-thread
// comment counts, the per-author activity counts, the
// pinned media set and the importer's image rewrite map — a few MB at today's volume
// (~2k posts, ~2k comments). Lists, titles, counts and the media gate answer from it;
// a thread or a post body is one primary-key-bounded FINAL read, cached per
// `generation`.
//
// The forum is written by the api (native posts, later) and the Subsquare sync (a
// batch every ten minutes), never by an MV, so the snapshot reloads when the tables'
// watermark (newest updated_at and row count of each) moves — a few-ms check every
// FORUM_REFRESH_MS — and `generation` is that watermark: it keys every derived cache,
// so a reload is visible on the next request with no TTL to wait out.
//
// Every title, body and name here is HOSTILE (live XSS probes exist in the imported
// set): it is passed through as data and made safe only by the explorer's one
// renderer. A hidden or deleted item never leaves this module with its text.

export interface ForumPostMeta {
  postId: string
  kind: string
  title: string
  excerpt: string
  bodyFormat: string
  bodyLength: number
  tldr: string
  labels: string[]
  linked: string[]
  authorAccountId: string
  authorLegacyName: string
  authority: string
  source: string
  sourceId: string
  sourceCid: string
  sourceRemoved: boolean
  bannerCid: string
  pollJson: string
  revision: number
  hidden: boolean
  hiddenReason: string
  deleted: boolean
  /** A moderator locked the thread: no new comments or replies. */
  locked: boolean
  /** The current visibility is a moderator's decision here (the sync keeps it). */
  moderated: boolean
  createdAt: number
  editedAt: number | null
  lastActivityAt: number
  updatedAt: number
}

/** A comment's metadata without its body (plus a plain-text excerpt) — visibility, authorship, placement. */
export interface ForumCommentMeta {
  commentId: string
  threadKey: string
  kind: string
  parentId: string
  replyToId: string
  authorAccountId: string
  hidden: boolean
  deleted: boolean
  createdAt: number
  excerpt: string
}

export interface ThreadCounts { comments: number; replies: number; updates: number; lastCommentAt: number | null; commenters: number }
export interface AuthorCounts { posts: number; comments: number }
export interface MediaEntry { cid: string; mime: string; bytes: number; width: number; height: number; origin: string; createdAt: number }

interface Snapshot {
  generation: string
  /** The tables' watermark this snapshot was loaded at (== generation until a local patch). */
  watermark: string
  posts: Map<string, ForumPostMeta>
  comments: Map<string, ForumCommentMeta>
  threads: Map<string, ThreadCounts>
  authors: Map<string, AuthorCounts>
  media: Map<string, MediaEntry>
  urlMap: Map<string, string>
  loadedAt: number
}

const FORUM_REFRESH_MS = 10_000
const EXCERPT_CHARS = 240

let client: ClickHouseClient | null = null
let snapshot: Snapshot | null = null
let inflight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null
let writeEpoch = 0

export function initForumStore(c: ClickHouseClient): void { client = c }

const ms = (v: string | number | null | undefined): number => {
  if (v == null || v === '') return 0
  const t = Date.parse(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z'))
  return Number.isFinite(t) ? t : 0
}

/**
 * Plain text for an excerpt or a search index: markdown and HTML markup stripped to
 * words. The output is still untrusted text (rendered as React text, never as HTML);
 * this only removes syntax so the excerpt reads as prose.
 */
export function plainText(body: string, max = EXCERPT_CHARS): string {
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~|]+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

async function readGeneration(c: ClickHouseClient): Promise<string> {
  const res = await c.query({
    query: `SELECT
              (SELECT concat(toString(count()), ':', toString(max(updated_at))) FROM price_data.forum_posts) AS p,
              (SELECT concat(toString(count()), ':', toString(max(updated_at))) FROM price_data.forum_comments) AS c,
              (SELECT concat(toString(count()), ':', toString(max(updated_at))) FROM price_data.forum_media) AS m,
              (SELECT concat(toString(count()), ':', toString(max(updated_at))) FROM price_data.forum_media_urls) AS u`,
    format: 'JSONEachRow',
  })
  const r = (await res.json<Record<string, string>>())[0] ?? {}
  // A short opaque token: it travels in URLs (`?g=`) and response bodies.
  return createHash('sha256').update([r.p, r.c, r.m, r.u].join('|')).digest('hex').slice(0, 16)
}

async function load(c: ClickHouseClient, generation: string): Promise<Snapshot> {
  const q = async <T>(query: string): Promise<T[]> => (await c.query({ query, format: 'JSONEachRow' })).json<T>()
  const [postRows, threadRows, authorCommentRows, mediaRows, urlRows, commentRows] = await Promise.all([
    q<{
      post_id: string; kind: string; title: string; head: string; body_len: number; body_format: string; tldr: string
      labels: string[]; linked: string[]; author_account_id: string; author_legacy_name: string; authority: string
      source: string; source_id: string; source_cid: string; source_removed: number; banner_cid: string; poll_json: string
      revision: number; hidden: number; hidden_reason: string; deleted: number; locked: number; moderated: number
      created_at: string; edited_at: string; last_activity_at: string; updated_at: string
    }>(`SELECT post_id, kind, title, substring(body, 1, 2000) AS head, length(body) AS body_len, body_format, tldr, labels, linked,
               author_account_id, author_legacy_name, authority, source, source_id, source_cid, source_removed, banner_cid, poll_json,
               revision, hidden, hidden_reason, deleted, locked, moderated, toString(created_at) AS created_at, toString(edited_at) AS edited_at,
               toString(last_activity_at) AS last_activity_at, toString(updated_at) AS updated_at
        FROM price_data.forum_posts FINAL`),
    q<{ thread_key: string; comments: number; replies: number; updates: number; last_at: string; commenters: number }>(
      `SELECT thread_key,
              countIf(kind = 'comment' AND hidden = 0 AND deleted = 0) AS comments,
              countIf(kind = 'comment' AND hidden = 0 AND deleted = 0 AND parent_id != '') AS replies,
              countIf(kind = 'update' AND hidden = 0 AND deleted = 0) AS updates,
              toString(maxIf(created_at, kind = 'comment' AND hidden = 0 AND deleted = 0)) AS last_at,
              uniqExactIf(if(author_account_id != '', author_account_id, concat('legacy:', author_legacy_name)), kind = 'comment' AND hidden = 0 AND deleted = 0) AS commenters
       FROM price_data.forum_comments FINAL GROUP BY thread_key`),
    q<{ author: string; n: number }>(`SELECT author_account_id AS author, count() AS n FROM price_data.forum_comments FINAL
       WHERE author_account_id != '' AND hidden = 0 AND deleted = 0 AND kind = 'comment' GROUP BY author`),
    q<{ cid: string; mime: string; bytes: number; width: number; height: number; origin: string; deleted: number; created_at: string }>(
      `SELECT cid, mime, bytes, width, height, origin, deleted, toString(created_at) AS created_at FROM price_data.forum_media FINAL`),
    q<{ original_url: string; cid: string; status: string }>(`SELECT original_url, cid, status FROM price_data.forum_media_urls FINAL`),
    q<{ comment_id: string; thread_key: string; kind: string; parent_id: string; reply_to_id: string; author_account_id: string; hidden: number; deleted: number; created_at: string; head: string }>(
      `SELECT comment_id, thread_key, kind, parent_id, reply_to_id, author_account_id, hidden, deleted, toString(created_at) AS created_at, substring(body, 1, 600) AS head
       FROM price_data.forum_comments FINAL`),
  ])

  const posts = new Map<string, ForumPostMeta>()
  const authors = new Map<string, AuthorCounts>()
  const authorOf = (id: string) => authors.get(id) ?? authors.set(id, { posts: 0, comments: 0 }).get(id)!
  for (const r of postRows) {
    const hidden = Number(r.hidden) === 1, deleted = Number(r.deleted) === 1
    const meta: ForumPostMeta = {
      postId: r.post_id,
      kind: r.kind,
      title: r.title,
      excerpt: plainText(r.head),
      bodyFormat: r.body_format,
      bodyLength: Number(r.body_len),
      tldr: r.tldr,
      labels: r.labels ?? [],
      linked: r.linked ?? [],
      authorAccountId: r.author_account_id,
      authorLegacyName: r.author_legacy_name,
      authority: r.authority,
      source: r.source,
      sourceId: r.source_id,
      sourceCid: r.source_cid,
      sourceRemoved: Number(r.source_removed) === 1,
      bannerCid: r.banner_cid,
      pollJson: r.poll_json,
      revision: Number(r.revision),
      hidden,
      hiddenReason: r.hidden_reason,
      deleted,
      locked: Number(r.locked) === 1,
      moderated: Number(r.moderated) === 1,
      createdAt: ms(r.created_at),
      editedAt: ms(r.edited_at) || null,
      lastActivityAt: ms(r.last_activity_at),
      updatedAt: ms(r.updated_at),
    }
    posts.set(meta.postId, meta)
    if (meta.kind === 'discussion' && meta.authorAccountId && !hidden && !deleted) authorOf(meta.authorAccountId).posts++
  }
  const threads = new Map<string, ThreadCounts>()
  for (const r of threadRows) {
    threads.set(r.thread_key, {
      comments: Number(r.comments), replies: Number(r.replies), updates: Number(r.updates),
      lastCommentAt: Number(r.comments) > 0 ? ms(r.last_at) || null : null, commenters: Number(r.commenters),
    })
  }
  for (const r of authorCommentRows) authorOf(r.author).comments = Number(r.n)
  const media = new Map<string, MediaEntry>()
  for (const r of mediaRows) {
    if (Number(r.deleted) === 1) continue
    media.set(r.cid, { cid: r.cid, mime: r.mime, bytes: Number(r.bytes), width: Number(r.width), height: Number(r.height), origin: r.origin, createdAt: Date.parse(`${String(r.created_at).replace(' ', 'T')}Z`) || 0 })
  }
  const comments = new Map<string, ForumCommentMeta>()
  for (const r of commentRows) {
    const hidden = Number(r.hidden) === 1, deleted = Number(r.deleted) === 1
    comments.set(r.comment_id, {
      commentId: r.comment_id, threadKey: r.thread_key, kind: r.kind, parentId: r.parent_id, replyToId: r.reply_to_id, authorAccountId: r.author_account_id,
      hidden, deleted, createdAt: ms(r.created_at), excerpt: hidden || deleted ? '' : plainText(r.head),
    })
  }
  const urlMap = new Map<string, string>()
  for (const r of urlRows) if (r.status === 'ok' && r.cid && media.has(r.cid)) urlMap.set(r.original_url, r.cid)
  return { generation, watermark: generation, posts, comments, threads, authors, media, urlMap, loadedAt: Date.now() }
}

export function refreshForumStore(): Promise<void> {
  if (inflight) return inflight
  const c = client
  if (!c) return Promise.resolve()
  inflight = (async () => {
    // A native write patches the snapshot in place (applyLocal* below) and moves
    // `writeEpoch`. A load that began before such a write read the tables without it,
    // so installing it would roll the write back for a refresh interval: it is
    // dropped, and the next tick reloads (the write moved the tables' watermark).
    const epoch = writeEpoch
    const generation = await readGeneration(c)
    if (snapshot && (snapshot.generation === generation || snapshot.watermark === generation)) return
    const next = await load(c, generation)
    if (epoch !== writeEpoch) return
    snapshot = next
  })().finally(() => { inflight = null })
  return inflight
}

export function startForumStoreRefresh(intervalMs = FORUM_REFRESH_MS): void {
  if (timer) return
  timer = setInterval(() => { refreshForumStore().catch(err => console.warn('[forum] snapshot refresh failed; serving the previous one', err instanceof Error ? err.message : err)) }, intervalMs)
  timer.unref()
}

export function stopForumStoreRefresh(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function forumReady(): boolean { return snapshot != null }
/** The snapshot's identity: changes whenever any forum table changed. '' before the first load. */
export function forumGeneration(): string { return snapshot?.generation ?? '' }
export function forumPost(postId: string): ForumPostMeta | null { return snapshot?.posts.get(postId) ?? null }
export function forumPosts(): Iterable<ForumPostMeta> { return snapshot?.posts.values() ?? [] }
export function forumComment(commentId: string): ForumCommentMeta | null { return snapshot?.comments.get(commentId) ?? null }
export function forumComments(): Iterable<ForumCommentMeta> { return snapshot?.comments.values() ?? [] }
export function forumThreadCounts(threadKey: string): ThreadCounts | null { return snapshot?.threads.get(threadKey) ?? null }
export function forumAuthorCounts(accountId: string): AuthorCounts | null { return snapshot?.authors.get(accountId) ?? null }
/** A live (pinned, not removed) forum image, or null — the /ipfs/<cid> gate. */
export function forumMedia(cid: string): MediaEntry | null { return snapshot?.media.get(cid) ?? null }
/** The importer's rewrite map: original image URL → the CID it was re-hosted under. */
export function forumMediaUrlMap(): ReadonlyMap<string, string> { return snapshot?.urlMap ?? new Map() }

/** The post_id of an on-chain subject's description ('opengov:450', 'democracy:12', …). */
export function subjectPostId(kind: string, subject: number | string): string { return `${kind}:${subject}` }

/** For tests: install a snapshot directly. */
let testSnapshots = 0
export function setForumSnapshotForTest(s: Partial<Snapshot> | null): void {
  // Each installed snapshot is a new generation unless the test names one, as a real reload would be.
  const generation = s?.generation ?? `test-${++testSnapshots}`
  snapshot = s ? {
    generation, watermark: s.watermark ?? generation, posts: s.posts ?? new Map(), comments: s.comments ?? new Map(), threads: s.threads ?? new Map(),
    authors: s.authors ?? new Map(), media: s.media ?? new Map(), urlMap: s.urlMap ?? new Map(), loadedAt: Date.now(),
  } : null
}

// ---- native writes: patch the snapshot in place ----
//
// The api is the forum's only interactive writer. After its synchronous insert it
// patches the snapshot so the author's next read (and everyone's) shows the write at
// once, and moves `generation` so every cache keyed by it misses. The periodic
// refresh then reloads the tables whole within FORUM_REFRESH_MS — one reload however
// many writes landed, so a burst of writes never turns into a burst of reloads.

function patched(): Snapshot {
  if (!snapshot) throw new Error('forum snapshot not loaded')
  writeEpoch++
  snapshot.generation = createHash('sha256').update(`${snapshot.watermark}|local|${writeEpoch}|${Date.now()}`).digest('hex').slice(0, 16)
  return snapshot
}

/** Installs a post's metadata after a native write. Returns the new generation. */
export function applyLocalPost(meta: ForumPostMeta): string {
  const s = patched()
  s.posts.set(meta.postId, meta)
  return s.generation
}

/** Installs a comment's metadata after a native write, adjusting its thread's counts. Returns the new generation. */
export function applyLocalComment(meta: ForumCommentMeta): string {
  const s = patched()
  const before = s.comments.get(meta.commentId)
  s.comments.set(meta.commentId, meta)
  const shown = (c: ForumCommentMeta | undefined) => !!c && !c.hidden && !c.deleted
  const t = s.threads.get(meta.threadKey) ?? { comments: 0, replies: 0, updates: 0, lastCommentAt: null, commenters: 0 }
  const delta = (shown(meta) ? 1 : 0) - (shown(before) ? 1 : 0)
  if (meta.kind === 'update') t.updates = Math.max(0, t.updates + delta)
  else {
    t.comments = Math.max(0, t.comments + delta)
    if (meta.parentId) t.replies = Math.max(0, t.replies + delta)
    if (!before && shown(meta)) t.lastCommentAt = Math.max(t.lastCommentAt ?? 0, meta.createdAt)
  }
  s.threads.set(meta.threadKey, t)
  return s.generation
}

/** Installs a newly pinned image, or removes one a moderator took down. Returns the new generation. */
export function applyLocalMedia(cid: string, entry: MediaEntry | null): string {
  const s = patched()
  if (entry) s.media.set(cid, entry); else s.media.delete(cid)
  return s.generation
}
