import type { ClickHouseClient } from '../../db/client.js'
import type { CommentRow, MediaRow, MediaUrlRow, ModLogRow, PostRow, RevisionRow } from './rows.js'

// Reads and writes of the forum tables. The tables are small (a few thousand rows),
// so a cycle reads each whole, FINAL, once — the in-memory diff then decides which
// rows changed. Inserts are synchronous (no async insert), so a row is visible before
// the next cycle reads it back.

export interface StoredPost { post_id: string; kind: string; authority: string; body_format: string; revision: number; source_hash: string; source_comments_count: number; source_activity_ms: number; hidden: number; hidden_reason: string; source_removed: number; row_fp: string; seq: number; title: string; body: string; source_id: string; linked: string[]; poll_json: string; updated_ms: number; author_account_id: string; author_legacy_name: string; created_ms: number
  /** Native-owned state the sync carries on every rewrite (see 021_forum.sql); `edited_at` as ISO. */
  tldr: string; labels: string[]; edited_at: string; deleted: number; moderated: number; locked: number; banner_cid: string }
export interface StoredComment { thread_key: string; comment_id: string; authority: string; body_format: string; revision: number; source_hash: string; row_fp: string; seq: number; body: string; hidden: number; hidden_reason: string; source_removed: number; parent_id: string; reply_to_id: string; author_account_id: string; author_legacy_name: string; created_ms: number; kind: string
  edited_at: string; deleted: number; moderated: number; updated_ms: number }
export interface StoredMediaUrl { original_url: string; cid: string; status: string; reason: string; attempts: number; updated_ms: number }

export interface ForumState {
  posts: Map<string, StoredPost>
  comments: Map<string, StoredComment>
  mediaUrls: Map<string, StoredMediaUrl>
  mediaCids: Set<string>
  /** CIDs moderators removed (forum_media deleted = 1): never pinned or added again, never written back live */
  removedCids: Set<string>
}

/** A DateTime64 column as an ISO string (what ts() writes back). */
const ISO = (col: string) => `formatDateTime(${col}, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS ${col}`

const READ_SETTINGS = { max_threads: 2, max_memory_usage: '1000000000' } as const

async function rows<T>(client: ClickHouseClient, query: string): Promise<T[]> {
  const res = await client.query({ query, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS })
  return res.json<T>()
}

export async function loadForumState(client: ClickHouseClient): Promise<ForumState> {
  const [posts, comments, urls, media] = await Promise.all([
    rows<StoredPost>(client, `SELECT post_id, kind, authority, body_format, revision, source_hash, source_comments_count,
        toUnixTimestamp64Milli(source_activity_at) AS source_activity_ms, hidden, hidden_reason, source_removed, row_fp, seq,
        title, body, source_id, linked, poll_json, toUnixTimestamp64Milli(updated_at) AS updated_ms, author_account_id,
        author_legacy_name, toUnixTimestamp64Milli(created_at) AS created_ms,
        tldr, labels, ${ISO('edited_at')}, deleted, moderated, locked, banner_cid
      FROM price_data.forum_posts FINAL`),
    rows<StoredComment>(client, `SELECT thread_key, comment_id, authority, body_format, revision, source_hash, row_fp, seq, body, hidden,
        hidden_reason, source_removed, parent_id, reply_to_id, author_account_id, author_legacy_name,
        toUnixTimestamp64Milli(created_at) AS created_ms, kind,
        ${ISO('edited_at')}, deleted, moderated, toUnixTimestamp64Milli(updated_at) AS updated_ms
      FROM price_data.forum_comments FINAL`),
    rows<StoredMediaUrl>(client, `SELECT original_url, cid, status, reason, attempts, toUnixTimestamp64Milli(updated_at) AS updated_ms FROM price_data.forum_media_urls FINAL`),
    rows<{ cid: string; deleted: number | string }>(client, `SELECT cid, deleted FROM price_data.forum_media FINAL`),
  ])
  const num = <T extends object>(r: T, keys: Array<keyof T>) => { for (const k of keys) (r[k] as unknown) = Number(r[k]); return r }
  return {
    posts: new Map(posts.map(p => [p.post_id, num(p, ['revision', 'source_comments_count', 'source_activity_ms', 'hidden', 'source_removed', 'seq', 'updated_ms', 'created_ms', 'deleted', 'moderated', 'locked'])])),
    comments: new Map(comments.map(c => [c.comment_id, num(c, ['revision', 'seq', 'hidden', 'source_removed', 'created_ms', 'deleted', 'moderated', 'updated_ms'])])),
    mediaUrls: new Map(urls.map(u => [u.original_url, num(u, ['attempts', 'updated_ms'])])),
    mediaCids: new Set(media.filter(m => Number(m.deleted) === 0).map(m => m.cid)),
    removedCids: new Set(media.filter(m => Number(m.deleted) !== 0).map(m => m.cid)),
  }
}

/**
 * Whether moderators removed `cid`: any tombstone row ever written for it (no FINAL —
 * nothing restores a removed image, so a tombstone is durable even if a later row for
 * the same CID raced it in). Read fresh, around a pin, not from the cycle's state.
 */
export async function isCidRemoved(client: ClickHouseClient, cid: string): Promise<boolean> {
  const res = await client.query({
    query: `SELECT count() AS n FROM price_data.forum_media WHERE cid = {c:String} AND deleted = 1`,
    query_params: { c: cid }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  return Number((await res.json<{ n: string | number }>())[0]?.n ?? 0) > 0
}

/** What the sync stored today (UTC): images and bytes it added to forum_media (its rows name no uploader). */
export async function loadSyncMediaToday(client: ClickHouseClient, dayStartMs: number): Promise<{ images: number; bytes: number }> {
  const res = await client.query({
    query: `SELECT count() AS images, sum(bytes) AS bytes FROM price_data.forum_media FINAL
            WHERE uploader_account_id = '' AND created_at >= fromUnixTimestamp64Milli({since:Int64})`,
    query_params: { since: dayStartMs }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  const r = (await res.json<{ images: string | number; bytes: string | number }>())[0]
  return { images: Number(r?.images ?? 0), bytes: Number(r?.bytes ?? 0) }
}

export interface WriteBatch {
  posts: PostRow[]
  comments: CommentRow[]
  revisions: RevisionRow[]
  modlog: ModLogRow[]
  media: MediaRow[]
  mediaUrls: MediaUrlRow[]
}

export const emptyBatch = (): WriteBatch => ({ posts: [], comments: [], revisions: [], modlog: [], media: [], mediaUrls: [] })

export function batchSize(b: WriteBatch): number {
  return b.posts.length + b.comments.length + b.revisions.length + b.modlog.length + b.media.length + b.mediaUrls.length
}

/** Writes a batch, revisions and the log before the rows that point at them. */
export async function writeBatch(client: ClickHouseClient, b: WriteBatch): Promise<void> {
  const insert = async (table: string, values: object[]) => {
    for (let i = 0; i < values.length; i += 500) {
      await client.insert({
        table: `price_data.${table}`, values: values.slice(i, i + 500), format: 'JSONEachRow',
        clickhouse_settings: { date_time_input_format: 'best_effort', async_insert: 0 },
      })
    }
  }
  await insert('forum_revisions', b.revisions)
  await insert('forum_moderation_log', b.modlog)
  await insert('forum_media', b.media)
  await insert('forum_media_urls', b.mediaUrls)
  await insert('forum_posts', b.posts)
  await insert('forum_comments', b.comments)
}

/** Whole stored rows, for rewriting one with a flag changed (a removal) — DateTime64 columns as ISO strings. */
const POST_COLUMNS = ['post_id', 'kind', 'title', 'body', 'body_format', 'tldr', 'labels', 'linked', 'author_account_id', 'author_legacy_name', 'authority', 'source', 'source_id', 'source_cid', 'source_hash', ISO('source_activity_at'), 'source_removed', 'source_comments_count', 'poll_json', 'banner_cid', 'revision', 'hidden', 'hidden_reason', 'deleted', ISO('created_at'), ISO('edited_at'), ISO('last_activity_at'), 'seq', 'row_fp', 'moderated', 'locked']
const COMMENT_COLUMNS = ['thread_key', 'comment_id', 'kind', 'parent_id', 'reply_to_id', 'author_account_id', 'author_legacy_name', 'body', 'body_format', 'authority', 'source', 'source_id', 'source_cid', 'source_hash', 'source_height', 'source_removed', 'revision', 'hidden', 'hidden_reason', 'deleted', ISO('created_at'), ISO('edited_at'), 'seq', 'row_fp', 'moderated']

export async function loadFullPosts(client: ClickHouseClient, ids: string[]): Promise<PostRow[]> {
  if (!ids.length) return []
  const res = await client.query({
    query: `SELECT ${POST_COLUMNS.join(', ')}, '' AS updated_at FROM price_data.forum_posts FINAL WHERE post_id IN {ids:Array(String)}`,
    query_params: { ids }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  return (await res.json<PostRow>()).map(r => ({ ...r, revision: Number(r.revision), hidden: Number(r.hidden), deleted: Number(r.deleted), source_removed: Number(r.source_removed), source_comments_count: Number(r.source_comments_count), seq: Number(r.seq), moderated: Number(r.moderated), locked: Number(r.locked) }))
}

export async function loadFullComments(client: ClickHouseClient, ids: string[]): Promise<CommentRow[]> {
  if (!ids.length) return []
  const res = await client.query({
    query: `SELECT ${COMMENT_COLUMNS.join(', ')}, '' AS updated_at FROM price_data.forum_comments FINAL WHERE comment_id IN {ids:Array(String)}`,
    query_params: { ids }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  return (await res.json<CommentRow>()).map(r => ({ ...r, revision: Number(r.revision), hidden: Number(r.hidden), deleted: Number(r.deleted), source_removed: Number(r.source_removed), source_height: Number(r.source_height), seq: Number(r.seq), moderated: Number(r.moderated) }))
}

/**
 * Imported revisions whose text may hold a Subsquare link (a superset of what
 * links.ts rewrites: any markdown link, any href, any Subsquare host), for the
 * normalisation pass. `created_at` is the row's version: written back unchanged, the
 * rewritten row replaces the stored one (ReplacingMergeTree keeps the last insert of
 * equal versions).
 */
export async function loadRevisionsToNormalise(client: ClickHouseClient): Promise<RevisionRow[]> {
  const res = await client.query({
    query: `SELECT target_id, revision, title, body, editor_account_id, source, ${ISO('created_at')}
            FROM price_data.forum_revisions FINAL
            WHERE source = 'subsquare' AND (positionCaseInsensitive(title, 'subsquare.io') > 0 OR positionCaseInsensitive(body, 'subsquare.io') > 0
              OR position(body, '](') > 0 OR positionCaseInsensitive(body, 'href') > 0)`,
    format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  return (await res.json<RevisionRow>()).map(r => ({ ...r, revision: Number(r.revision) }))
}

// ---- the write-time recheck ----
//
// A cycle reads the tables once at its start and writes minutes later (the fetches run
// in between). The api writes the same tables — an author's edit or delete, a
// moderator's hide, a stub post under a first native comment — and a row it wrote in
// that gap must not be overwritten by a plan made from the older read (nor its
// revision number reused: forum_revisions is keyed (target_id, revision)). So just
// before the batch is written, the current `updated_at` of every post and comment it
// would write is read back, and a row stored newer than the cycle's read — or present
// now and absent then — is dropped from the batch with its revisions and log rows. It
// is deferred, not lost: its fingerprint still differs from the source, so the next
// cycle that sees the item plans it again from fresh state.

export interface CurrentStamps { posts: Map<string, number>; comments: Map<string, number> }

const RECHECK_CHUNK = 500

/** Current updated_at (epoch ms) of the given posts and comments; a row that does not exist is absent from the maps. */
export async function loadUpdatedMs(client: ClickHouseClient, postIds: string[], comments: Array<{ thread_key: string; comment_id: string }>): Promise<CurrentStamps> {
  const out: CurrentStamps = { posts: new Map(), comments: new Map() }
  for (let i = 0; i < postIds.length; i += RECHECK_CHUNK) {
    const ids = postIds.slice(i, i + RECHECK_CHUNK)
    const res = await client.query({
      query: `SELECT post_id AS id, toUnixTimestamp64Milli(updated_at) AS ms FROM price_data.forum_posts FINAL WHERE post_id IN {ids:Array(String)}`,
      query_params: { ids }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    })
    for (const r of await res.json<{ id: string; ms: number | string }>()) out.posts.set(r.id, Number(r.ms))
  }
  for (let i = 0; i < comments.length; i += RECHECK_CHUNK) {
    const chunk = comments.slice(i, i + RECHECK_CHUNK)
    const res = await client.query({
      query: `SELECT comment_id AS id, toUnixTimestamp64Milli(updated_at) AS ms FROM price_data.forum_comments FINAL
              WHERE thread_key IN {keys:Array(String)} AND comment_id IN {ids:Array(String)}`,
      query_params: { keys: [...new Set(chunk.map(c => c.thread_key))], ids: chunk.map(c => c.comment_id) },
      format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    })
    for (const r of await res.json<{ id: string; ms: number | string }>()) out.comments.set(r.id, Number(r.ms))
  }
  return out
}

/** The stored posts and comments a batch writes or rewrites a revision of: what the recheck must read back. */
export function recheckTargets(batch: WriteBatch, state: ForumState): { postIds: string[]; comments: Array<{ thread_key: string; comment_id: string }> } {
  const postIds = new Set(batch.posts.map(p => p.post_id))
  const comments = new Map(batch.comments.map(c => [c.comment_id, { thread_key: c.thread_key, comment_id: c.comment_id }]))
  for (const r of batch.revisions) {
    if (state.posts.has(r.target_id)) postIds.add(r.target_id)
    const c = state.comments.get(r.target_id)
    if (c && !comments.has(c.comment_id)) comments.set(c.comment_id, { thread_key: c.thread_key, comment_id: c.comment_id })
  }
  return { postIds: [...postIds], comments: [...comments.values()] }
}

/**
 * The batch without every post/comment written since `state` was read (with their
 * revision and log rows), and the ids deferred. A revision rewritten on its own (the
 * normalisation pass) is held to its item's stamp too: an erasure here moves the
 * item, and its revisions must not be written back after it.
 */
export function dropRacedRows(batch: WriteBatch, state: ForumState, current: CurrentStamps): { batch: WriteBatch; deferred: string[] } {
  const raced = (now: number | undefined, then: number | undefined) => now != null && (then == null || now > then)
  const deferred = new Set<string>()
  for (const p of batch.posts) if (raced(current.posts.get(p.post_id), state.posts.get(p.post_id)?.updated_ms)) deferred.add(p.post_id)
  for (const c of batch.comments) if (raced(current.comments.get(c.comment_id), state.comments.get(c.comment_id)?.updated_ms)) deferred.add(c.comment_id)
  for (const r of batch.revisions) {
    const t = r.target_id
    if (state.posts.has(t) && raced(current.posts.get(t), state.posts.get(t)?.updated_ms)) deferred.add(t)
    if (state.comments.has(t) && raced(current.comments.get(t), state.comments.get(t)?.updated_ms)) deferred.add(t)
  }
  if (!deferred.size) return { batch, deferred: [] }
  return {
    batch: {
      ...batch,
      posts: batch.posts.filter(p => !deferred.has(p.post_id)),
      comments: batch.comments.filter(c => !deferred.has(c.comment_id)),
      revisions: batch.revisions.filter(r => !deferred.has(r.target_id)),
      modlog: batch.modlog.filter(m => !deferred.has(m.target_id)),
    },
    deferred: [...deferred],
  }
}
