import { forumPost, forumThreadCounts, type ForumPostMeta } from './forumStore.ts'

// The forum read rules every surface that serves forum content states the same way:
// the explorer's forum routes (forumRead.ts) and the Data API (data/services/forum.ts).
// A leaf over the in-process snapshot (forumStore.ts) — it imports nothing else, so
// the Data API may use it without reaching the explorer's account rendering.

/**
 * Whether an item's text may leave the api. A hidden or deleted post or comment is
 * served as a stub with no title, body or excerpt: the imported hidden set holds
 * live XSS probes, and a consumer that is not the explorer's renderer must not
 * receive them either.
 */
export function forumItemShown(item: { hidden: boolean; deleted: boolean }): boolean {
  return !item.hidden && !item.deleted
}

/** The thread a post's readers see: its own when it holds comments, else the first linked subject's that does. */
export function threadKeyFor(postId: string): string {
  const own = forumThreadCounts(postId)
  if (own && own.comments > 0) return postId
  for (const linked of forumPost(postId)?.linked ?? []) {
    const c = forumThreadCounts(linked)
    if (c && c.comments > 0) return linked
  }
  return postId
}

/** A post's last activity (ms): the newer of its own activity stamp and the newest shown comment in `threadKey`. */
export function postLastActivityAt(meta: ForumPostMeta, threadKey = meta.postId): number {
  return Math.max(meta.lastActivityAt, forumThreadCounts(threadKey)?.lastCommentAt ?? 0) || meta.createdAt
}

/** How a text query is compared with forum titles and excerpts: NFKC then lower case, in any script (the explorer search folds the same way). */
export function textFold(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}
