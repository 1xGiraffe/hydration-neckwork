import type { KuboClient } from './kubo.js'
import { bannerUrl, imageUrlsIn } from './rows.js'

// Which images the sync re-hosts, and how much it may store. Imported bodies are
// strangers' text and the IPFS repo shares its disk with ClickHouse, so the pass is
// bounded like uploads are (api/src/services/forumMedia.ts):
//   - only images a VISIBLE item references (not hidden, deleted or removed on
//     Subsquare), at most IMAGES_PER_BODY per body, plus each visible post's banner;
//   - every pin or add first admitted by ImageBudget: the repo below
//     STORAGE_HEADROOM of its StorageMax, and the sync's own daily image and byte caps
//     (counted from forum_media, so a restart does not reset them) and a daily cap per
//     author (counted from today's re-hosted URLs). An image over a cap is deferred,
//     never failed: it is due again once the cap allows.

export const IMAGES_PER_BODY = 20
export const STORAGE_HEADROOM = 0.8
export const SYNC_DAILY_IMAGES = 300
export const SYNC_DAILY_BYTES = 256 * 1024 * 1024
export const SYNC_DAILY_IMAGES_PER_AUTHOR = 40

interface TextItem { hidden: number; deleted: number; source_removed: number; body: string; author_account_id: string; author_legacy_name: string }

/** An item's author as the caps count it: its account, `legacy:<name>`, or '' for none. */
export const authorOf = (i: Pick<TextItem, 'author_account_id' | 'author_legacy_name'>): string =>
  i.author_account_id || (i.author_legacy_name ? `legacy:${i.author_legacy_name}` : '')

const visible = (i: TextItem) => !i.hidden && !i.deleted && !i.source_removed

/**
 * Image URL → the author of the first visible item referencing it, over the given
 * posts and comments (a later list of the same id wins: pass the cycle's batch after
 * the stored rows). A post's banner counts as its image.
 */
export function imageCandidates(posts: Iterable<TextItem & { post_id: string; banner_cid: string }>, comments: Iterable<TextItem & { comment_id: string }>): Map<string, string> {
  const postsById = new Map<string, TextItem & { banner_cid: string }>()
  for (const p of posts) postsById.set(p.post_id, p)
  const commentsById = new Map<string, TextItem>()
  for (const c of comments) commentsById.set(c.comment_id, c)
  const out = new Map<string, string>()
  const take = (url: string | null, author: string) => { if (url && !out.has(url)) out.set(url, author) }
  for (const p of postsById.values()) {
    if (!visible(p)) continue
    take(bannerUrl(p.banner_cid), authorOf(p))
    for (const u of imageUrlsIn(p.body).slice(0, IMAGES_PER_BODY)) take(u, authorOf(p))
  }
  for (const c of commentsById.values()) {
    if (!visible(c)) continue
    for (const u of imageUrlsIn(c.body).slice(0, IMAGES_PER_BODY)) take(u, authorOf(c))
  }
  return out
}

/** Deferral reasons that hold for every image (the pass stops), as against one author's cap (the pass goes on). */
export const STOPS_THE_PASS = new Set(['storage-ceiling', 'repo-stat', 'daily-images', 'daily-bytes'])

export class ImageBudget {
  constructor(
    private readonly kubo: Pick<KuboClient, 'repoStat'>,
    /** what the sync stored today (UTC), from forum_media */
    private readonly today: { images: number; bytes: number },
    /** images re-hosted today per author */
    private readonly perAuthor: Map<string, number>,
  ) {}

  /** Null when `bytes` more for `author` may be stored now, else why not. */
  async admit(author: string, bytes: number): Promise<string | null> {
    if (this.today.images >= SYNC_DAILY_IMAGES) return 'daily-images'
    if (this.today.bytes + bytes > SYNC_DAILY_BYTES) return 'daily-bytes'
    if (author && (this.perAuthor.get(author) ?? 0) >= SYNC_DAILY_IMAGES_PER_AUTHOR) return 'author-daily-images'
    let stat
    try { stat = await this.kubo.repoStat() } catch { return 'repo-stat' }
    if (stat.repoSize + bytes > STORAGE_HEADROOM * stat.storageMax) return 'storage-ceiling'
    return null
  }

  /** Counts a stored image. */
  commit(author: string, bytes: number): void {
    this.today.images++
    this.today.bytes += bytes
    if (author) this.perAuthor.set(author, (this.perAuthor.get(author) ?? 0) + 1)
  }
}
