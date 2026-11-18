import type { SsAppendant, SsItem } from './parse.js'
import {
  SOURCE, appendantRow, flattenThread, kindOfSubject, linkedOf, postRow, seqFor, stubPostRow, ts,
  type BuildContext, type CommentRow, type Group, type ModLogRow, type PostRow, type RevisionRow,
} from './rows.js'
import { emptyBatch, type ForumState, type StoredComment, type StoredPost, type WriteBatch } from './store.js'
import type { ThreadResult, Warnings } from './fetchSource.js'
import { warn } from './fetchSource.js'
import type { LinkRewriteOptions } from './links.js'

// Source view → the rows to write. A row is written only when it is missing or its
// fingerprint changed; a content change is also a new revision; Subsquare's own
// hide/restore is logged publicly; a removal is a flag, never a delete. `row_fp` is
// always the fingerprint of the SOURCE fields, so what is carried from the stored row
// below never makes a quiet cycle write.
//
// What was decided on this forum survives every rewrite (021_forum.sql):
//   - native authority (a post or comment edited here) keeps its text — title, body,
//     TL;DR, labels and edit time of a post; body and edit time of a comment — and
//     later Subsquare edits become revisions only;
//   - `moderated` keeps a moderator's hide or restore, and native authority keeps the
//     visibility of an item edited here: Subsquare's hide, unhide or
//     removal changes neither the visibility nor the public log;
//   - `deleted` (an author's delete here) and `locked` (a locked thread) are carried
//     as stored; the sync never sets either, and a deleted item gets no revision row
//     (its author's delete purged every revision of its text).
// Native rows themselves (decimal discussion ids, 'c…' comment ids) are never
// planned: the source cannot name them, and removal detection reads 's…' ids only.

export interface SourceView {
  /** the freshest fetched version of each subject (a detail where one was fetched) */
  items: Map<string, SsItem>
  /** subjects whose detail answered 404 */
  gone: Set<string>
  groups: Map<string, Group>
  /** Subsquare discussion _id → our subject, for comments a discussion owns */
  discussionById: Map<string, string>
  /** bound-discussion links over every known item (boundLinks), so a subject's links never depend on what this cycle fetched */
  links: Map<string, Set<string>>
  threads: Map<string, ThreadResult>
  appendants: Map<string, SsAppendant[]>
  pollJson: Map<string, string>
  /** council/TC motions by `<body>:<hash>@<block>` → our id, for Subsquare links naming a motion that way (motionIdsOf) */
  motionIds?: ReadonlyMap<string, string>
}

/** Every known council/TC motion by the `<block>_<hash>` Subsquare's URLs name it by → our id (its index, or `<hash>@<block>`). */
export function motionIdsOf(items: Iterable<SsItem>): Map<string, string> {
  const out = new Map<string, string>()
  for (const it of items) {
    if ((it.collection !== 'council' && it.collection !== 'tc') || !it.hash || it.height == null) continue
    out.set(`${it.collection}:${it.hash}@${it.height}`, it.subject.slice(it.collection.length + 1))
  }
  return out
}

/** The link rewrite's options for a cycle (links.ts). */
export function linkOptions(motionIds: ReadonlyMap<string, string> | undefined): LinkRewriteOptions {
  return { resolveMotion: (body, hash, height) => motionIds?.get(`${body}:${hash}@${height}`) ?? null }
}

export interface Loader {
  posts(ids: string[]): Promise<PostRow[]>
  comments(ids: string[]): Promise<CommentRow[]>
}

export interface DiffStats {
  postsNew: number; postsChanged: number; postsRemoved: number; stubs: number
  commentsNew: number; commentsChanged: number; commentsRemoved: number
  revisions: number; modlog: number
  seqAssigned: number; skippedAuthors: number
}

/** An item whose text was erased here (an author's delete, a moderator's purge): the sync writes it no revision. */
export const erased = (stored: { deleted: number; hidden_reason: string }): boolean => stored.deleted === 1 || stored.hidden_reason === 'purged'

export function groupOfSubject(groups: Map<string, Group>): Map<string, Group> {
  const out = new Map<string, Group>()
  for (const g of groups.values()) {
    out.set(g.owner, g)
    for (const m of g.members) out.set(m.subject, g)
  }
  return out
}

const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16)

/**
 * Whether an item's visibility was decided here: a moderator's hide or restore, or a
 * native edit (its text is ours now, so Subsquare hiding or removing its own copy
 * says nothing about it).
 */
export const keepsVisibility = (stored: { moderated: number; authority: string }): boolean => stored.moderated === 1 || stored.authority === 'native'

/** Native-owned state of a stored post, carried onto a row rebuilt from the source. */
function carryPost(built: PostRow, stored: StoredPost): void {
  built.deleted = stored.deleted
  built.locked = stored.locked
  built.moderated = stored.moderated
  if (keepsVisibility(stored)) { built.hidden = stored.hidden; built.hidden_reason = stored.hidden_reason }
  if (stored.authority === 'native') {
    built.authority = 'native'
    built.title = stored.title; built.body = stored.body; built.tldr = stored.tldr; built.labels = stored.labels; built.edited_at = stored.edited_at
  }
}

/** Native-owned state of a stored comment, carried onto a row rebuilt from the source. */
function carryComment(row: CommentRow, stored: StoredComment): void {
  row.deleted = stored.deleted
  row.moderated = stored.moderated
  if (keepsVisibility(stored)) { row.hidden = stored.hidden; row.hidden_reason = stored.hidden_reason }
  if (stored.authority === 'native') { row.authority = 'native'; row.body = stored.body; row.edited_at = stored.edited_at }
}

export async function planWrites(view: SourceView, state: ForumState, ctx: BuildContext, loader: Loader, w: Warnings): Promise<{ batch: WriteBatch; stats: DiffStats }> {
  const batch = emptyBatch()
  const stats: DiffStats = { postsNew: 0, postsChanged: 0, postsRemoved: 0, stubs: 0, commentsNew: 0, commentsChanged: 0, commentsRemoved: 0, revisions: 0, modlog: 0, seqAssigned: 0, skippedAuthors: 0 }
  const now = ts(ctx.now)
  const bySubject = groupOfSubject(view.groups)
  const bound = view.links
  const writtenPosts = new Set<string>()
  const links = linkOptions(view.motionIds)

  const log = (target: string, action: string, reason: string, id: string, at: number) => {
    const row: ModLogRow = { action_id: id, target_id: target, action, reason_code: reason, moderator_account_id: 'subsquare', created_at: ts(at) }
    batch.modlog.push(row)
    stats.modlog++
  }
  const revision = (target: string, rev: number, title: string, body: string, editor: string, at: number) => {
    const r: RevisionRow = { target_id: target, revision: rev, title, body, editor_account_id: editor, source: 'subsquare', created_at: ts(at) }
    batch.revisions.push(r)
    stats.revisions++
  }

  // ---- posts ----
  for (const [subject, item] of view.items) {
    const built = postRow({ item, linked: linkedOf(subject, bySubject.get(subject), bound), removed: false, pollJson: view.pollJson.get(subject) ?? state.posts.get(subject)?.poll_json ?? '', links })
    if ('skip' in built) { warn(w, `author-${built.skip}`); stats.skippedAuthors++; continue }
    const stored = state.posts.get(subject)
    if (stored && stored.row_fp === built.row_fp) continue
    built.updated_at = now
    if (!stored) {
      built.seq = seqFor(ctx, subject, item.createdAt)
      if (built.seq) stats.seqAssigned++
      revision(subject, 0, built.title, built.body, built.author_account_id, item.updatedAt)
      if (built.hidden) log(subject, 'hide', built.hidden_reason, `subsquare:hide:${built.hidden_reason}:import`, item.updatedAt)
      stats.postsNew++
    } else {
      built.seq = stored.seq
      built.revision = stored.revision
      // Edited only when there is more than one version: a new version's time, else the stored one's.
      built.edited_at = stored.revision > 0 ? stored.edited_at : ts(0)
      // A post its author deleted here, or a moderator purged, has had every revision
      // of its text erased: a later Subsquare change writes none back. A new version
      // needs the text itself to differ (Subsquare's hash can move without it).
      if (!erased(stored) && stored.source_hash !== built.source_hash && (stored.authority === 'native' || stored.title !== built.title || stored.body !== built.body)) {
        // A stub (a subject named by a merged thread, or a native comment's thread)
        // holds no text of its own: the first source text is its revision 0.
        const stub = !stored.source_hash && stored.authority !== 'native' && !stored.title && !stored.body
        built.revision = stub ? stored.revision : stored.revision + 1
        if (!stub) built.edited_at = ts(item.updatedAt)
        revision(subject, built.revision, built.title, built.body, built.author_account_id, item.updatedAt)
      }
      carryPost(built, stored)
      if (!keepsVisibility(stored) && (stored.hidden !== built.hidden || stored.hidden_reason !== built.hidden_reason)) {
        const action = built.hidden ? 'hide' : 'restore'
        const reason = built.hidden ? built.hidden_reason : stored.hidden_reason
        log(subject, action, reason, `subsquare:${action}:${reason}:${minute(ctx.now)}`, ctx.now)
      }
      stats.postsChanged++
    }
    batch.posts.push(built)
    writtenPosts.add(subject)
  }

  // Subjects a merged thread names whose own item we do not hold: a stub, so a reader
  // on that subject finds the thread.
  for (const g of view.groups.values()) {
    if (!view.threads.has(g.rootPostId) && !g.members.some(m => view.items.has(m.subject))) continue
    for (const subject of new Set([g.owner, ...g.members.map(m => m.subject)])) {
      if (view.items.has(subject) || state.posts.has(subject) || writtenPosts.has(subject)) continue
      const created = Math.min(...g.members.map(m => m.createdAt))
      const activity = Math.max(...g.members.map(m => m.lastActivityAt))
      const stub = stubPostRow(subject, kindOfSubject(subject), linkedOf(subject, g), created, activity)
      stub.updated_at = now
      batch.posts.push(stub)
      writtenPosts.add(subject)
      stats.stubs++
    }
  }

  // Removed on Subsquare (the detail now answers 404): flagged, kept.
  const goneIds = [...view.gone].filter(s => { const p = state.posts.get(s); return p && !p.source_removed })
  for (const row of await loader.posts(goneIds)) {
    row.source_removed = 1; row.updated_at = now
    if (!keepsVisibility(row)) {
      row.hidden = 1; row.hidden_reason = 'removed-on-subsquare'
      log(row.post_id, 'hide', 'removed-on-subsquare', `subsquare:hide:removed-on-subsquare:${minute(ctx.now)}`, ctx.now)
    }
    batch.posts.push(row)
    stats.postsRemoved++
  }

  // ---- comments ----
  const removedCommentIds: string[] = []
  const planned = new Set<string>()
  // A comment files under the subject its own owner field names; a bound item's
  // endpoint (a tip written as a discussion) also returns the discussion's comments.
  const threadKeyOf = (fallback: string) => (c: { ownerType: string; ownerId: string }) =>
    view.groups.get(c.ownerId)?.owner ?? (c.ownerType === 'post' ? view.discussionById.get(c.ownerId) : undefined) ?? fallback
  for (const [rootPostId, thread] of view.threads) {
    const g = view.groups.get(rootPostId)
    if (!g) continue
    const flat = flattenThread(threadKeyOf(g.owner), thread.comments, reason => { warn(w, `comment-author-${reason}`); stats.skippedAuthors++ }, links)
    const seen = new Set<string>()
    for (const { row, source } of flat) {
      if (row.thread_key === g.owner) seen.add(row.comment_id)
      if (planned.has(row.comment_id)) continue
      planned.add(row.comment_id)
      const stored = state.comments.get(row.comment_id)
      if (stored && stored.thread_key !== row.thread_key) { warn(w, 'comment-moved-thread'); continue }
      if (stored && stored.row_fp === row.row_fp) continue
      row.updated_at = now
      if (!stored) {
        row.seq = seqFor(ctx, row.comment_id, source.createdAt)
        if (row.seq) stats.seqAssigned++
        revision(row.comment_id, 0, '', row.body, row.author_account_id, source.updatedAt)
        stats.commentsNew++
      } else {
        row.seq = stored.seq
        row.revision = stored.revision
        if (!erased(stored) && stored.source_hash !== row.source_hash && (stored.authority === 'native' || stored.body !== row.body)) {
          row.revision = stored.revision + 1
          revision(row.comment_id, row.revision, '', row.body, row.author_account_id, source.updatedAt)
        }
        carryComment(row, stored)
        stats.commentsChanged++
      }
      batch.comments.push(row)
    }
    // A comment that left a thread we read whole was removed on Subsquare.
    if (thread.ok) {
      for (const c of state.comments.values()) {
        if (c.thread_key !== g.owner || c.kind !== 'comment' || !c.comment_id.startsWith('s') || c.source_removed || seen.has(c.comment_id)) continue
        removedCommentIds.push(c.comment_id)
      }
    }
  }
  for (const row of await loader.comments(removedCommentIds)) {
    row.source_removed = 1; row.updated_at = now
    if (!keepsVisibility(row)) { row.hidden = 1; row.hidden_reason = 'removed-on-subsquare' }
    batch.comments.push(row)
    stats.commentsRemoved++
  }

  // Appendants: the description's Updates, filed under the subject itself.
  for (const [subject, list] of view.appendants) {
    for (const a of list) {
      const row = appendantRow(subject, a, links)
      if ('skip' in row) { warn(w, `appendant-author-${row.skip}`); continue }
      const stored = state.comments.get(row.comment_id)
      if (stored && stored.row_fp === row.row_fp) continue
      row.updated_at = now
      row.seq = stored ? stored.seq : seqFor(ctx, row.comment_id, a.createdAt)
      const textChanged = !stored || (!erased(stored) && stored.source_hash !== row.source_hash && (stored.authority === 'native' || stored.body !== row.body))
      row.revision = stored ? stored.revision + (textChanged ? 1 : 0) : 0
      if (textChanged) revision(row.comment_id, row.revision, '', row.body, row.author_account_id, a.updatedAt)
      if (stored) carryComment(row, stored)
      batch.comments.push(row)
      if (stored) stats.commentsChanged++; else stats.commentsNew++
    }
  }

  return { batch, stats }
}
