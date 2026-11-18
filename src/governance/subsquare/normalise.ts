import { createHash } from 'node:crypto'
import { erased } from './diff.js'
import type { LinkRewriteOptions } from './links.js'
import { commentFingerprint, importedCommentText, importedPostText, postFingerprint, ts, type CommentRow, type PostRow, type RevisionRow } from './rows.js'
import type { ForumState, StoredComment, StoredPost, WriteBatch } from './store.js'

// Stored imported rows brought to what the sync now writes, without waiting for
// Subsquare to change the item: text (links.ts: Subsquare links pointing at the
// explorer, or unlinked; lengths capped, rows.ts IMPORT_LIMITS) and a post's edit time (set only when there is more than
// one version, so a single-version post has none). Every cycle, after planning, the
// sync rewrites any stored imported post, comment or revision that differs — what was
// imported before a rule existed, or before a mapping changed, converges. Once
// converged it writes nothing.
//
// A normalisation, not an edit: the row keeps its revision number, `seq`,
// `source_hash` and every forum-decided column, and gets no revision row of its own;
// instead the imported revision rows (source 'subsquare') are rewritten in place, so
// the history and the current text agree. `row_fp` is recomputed from the row (a
// post's edit time counted as the source's constant zero); where a forum decision
// makes the row differ from its source (a moderator's hide), the next fetch rewrites
// it once with the source's fingerprint — the same text, no revision.
//
// Never touched: native rows (decimal discussion ids, 'c…' comments), anything a
// native edit took over (`authority = 'native'`), and erased items (an author's
// delete, a moderator's purge). Rows already in the batch were built from the source
// this cycle and are rewritten there; a removal (a stored row loaded whole) is
// rewritten here.

export interface NormaliseLoader {
  posts(ids: string[]): Promise<PostRow[]>
  comments(ids: string[]): Promise<CommentRow[]>
  revisions(): Promise<RevisionRow[]>
}

export interface NormaliseStats { posts: number; comments: number; revisions: number }

const isImportedPost = (p: Pick<StoredPost, 'source_id' | 'authority' | 'deleted' | 'hidden_reason'>) => !!p.source_id && p.authority !== 'native' && !erased(p)
const isImportedComment = (c: Pick<StoredComment, 'comment_id' | 'authority' | 'deleted' | 'hidden_reason'>) => c.comment_id.startsWith('s') && c.authority !== 'native' && !erased(c)

/** A stored row's DateTime64 columns as ts() spells them (ClickHouse's ISO has six fraction digits), so its fingerprint can be recomputed. */
function asWritten<T extends object>(row: T, columns: Array<keyof T>): T {
  const out = { ...row }
  for (const c of columns) {
    const ms = Date.parse(String(row[c]))
    if (Number.isFinite(ms)) (out[c] as unknown) = ts(ms)
  }
  return out
}
const EPOCH = ts(0)
const postFp = (r: PostRow) => postFingerprint({ ...asWritten(r, ['source_activity_at', 'created_at', 'last_activity_at']), edited_at: EPOCH })
const commentFp = (r: CommentRow) => commentFingerprint(asWritten(r, ['created_at', 'edited_at']))

function rewritePost(r: { title: string; body: string; body_format: string; revision: number; edited_at: string }, links: LinkRewriteOptions): boolean {
  const { title, body } = importedPostText(r.title, r.body, r.body_format, links)
  // One version is no edit (Subsquare's `edited` flag and moving updatedAt once set it).
  const editedAt = r.revision === 0 && Date.parse(r.edited_at) > 0 ? EPOCH : r.edited_at
  if (title === r.title && body === r.body && editedAt === r.edited_at) return false
  r.title = title; r.body = body; r.edited_at = editedAt
  return true
}

function rewriteComment(r: { body: string; body_format: string }, links: LinkRewriteOptions): boolean {
  const body = importedCommentText(r.body, r.body_format, links)
  if (body === r.body) return false
  r.body = body
  return true
}

/** Adds to `batch` every stored imported row and revision the rules above still change. */
/**
 * What this process found already normalised: a row by its stored `updated_ms`, a
 * revision by a hash of its text. A row is examined again only once it was written
 * since, so a converged table costs a map lookup per row, not a rewrite.
 */
export type NormaliseMemo = Map<string, string>

const textKey = (title: string, body: string) => createHash('sha1').update(title).update('\u0000').update(body).digest('hex')

export async function planNormalisation(batch: WriteBatch, state: ForumState, links: LinkRewriteOptions, loader: NormaliseLoader, now: number, memo: NormaliseMemo = new Map()): Promise<NormaliseStats> {
  const stats: NormaliseStats = { posts: 0, comments: 0, revisions: 0 }
  const updatedAt = ts(now)

  // Rows already planned. Built from the source they are rewritten already (a no-op);
  // a removal carries the stored text.
  for (const p of batch.posts) if (p.source === 'subsquare' && isImportedPost(p) && rewritePost(p, links)) stats.posts++
  for (const c of batch.comments) if (c.source === 'subsquare' && isImportedComment(c) && rewriteComment(c, links)) stats.comments++

  const plannedPosts = new Set(batch.posts.map(p => p.post_id))
  const plannedComments = new Set(batch.comments.map(c => c.comment_id))
  // A stored row needs work when the rules change it; one found converged is skipped until written again.
  const due = (key: string, version: number, changes: () => boolean): boolean => {
    if (memo.get(key) === String(version)) return false
    if (changes()) return true
    memo.set(key, String(version))
    return false
  }
  const postIds = [...state.posts.values()]
    .filter(p => !plannedPosts.has(p.post_id) && isImportedPost(p) && due(`p:${p.post_id}`, p.updated_ms, () => rewritePost({ ...p }, links)))
    .map(p => p.post_id)
  const commentIds = [...state.comments.values()]
    .filter(c => !plannedComments.has(c.comment_id) && isImportedComment(c) && due(`c:${c.comment_id}`, c.updated_ms, () => rewriteComment({ ...c }, links)))
    .map(c => c.comment_id)

  for (const row of await loader.posts(postIds)) {
    // Re-checked on the whole row as stored now (the cycle's read may be minutes old).
    if (row.source !== 'subsquare' || !isImportedPost(row)) continue
    if (!rewritePost(row, links)) continue
    row.row_fp = postFp(row)
    row.updated_at = updatedAt
    batch.posts.push(row)
    stats.posts++
  }
  for (const row of await loader.comments(commentIds)) {
    if (row.source !== 'subsquare' || !isImportedComment(row)) continue
    if (!rewriteComment(row, links)) continue
    row.row_fp = commentFp(row)
    row.updated_at = updatedAt
    batch.comments.push(row)
    stats.comments++
  }

  // Imported revisions, rewritten in place (same target, number and created_at).
  const plannedRevisions = new Set(batch.revisions.map(r => `${r.target_id}\u0000${r.revision}`))
  for (const r of await loader.revisions()) {
    if (r.source !== 'subsquare' || plannedRevisions.has(`${r.target_id}\u0000${r.revision}`)) continue
    const post = state.posts.get(r.target_id)
    const comment = post ? undefined : state.comments.get(r.target_id)
    const item = post ?? comment
    // An erased item's revisions were deleted with its text; one this cycle cannot see is left alone.
    if (!item || erased(item)) continue
    const key = `r:${r.target_id}#${r.revision}`
    const seen = textKey(r.title, r.body)
    if (memo.get(key) === seen) continue
    const format = item.body_format || 'markdown'
    const { title, body } = post ? importedPostText(r.title, r.body, format, links) : { title: r.title, body: importedCommentText(r.body, format, links) }
    if (title === r.title && body === r.body) { memo.set(key, seen); continue }
    batch.revisions.push({ ...r, title, body })
    stats.revisions++
  }
  return stats
}
