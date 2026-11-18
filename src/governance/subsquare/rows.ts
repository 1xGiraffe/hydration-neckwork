import { createHash } from 'node:crypto'
import { authorKey } from './authors.js'
import { rewriteSubsquareLinks, rewriteSubsquareText, type LinkRewriteOptions } from './links.js'
import { COLLECTIONS, KIND_OF, type SsAppendant, type SsComment, type SsItem } from './parse.js'

// Subsquare items → forum_* rows (clickhouse/schema/021_forum.sql), plus the merged-
// thread model. Text is copied as received — it is hostile and is made safe only by
// the renderer — except that links to Subsquare's own Hydration pages are rewritten to
// the explorer's (links.ts), the one normalisation applied. `source_hash` is always
// the hash of the text AS RECEIVED, so the rewrite never reads as an edit (no revision,
// no re-fetch). A row carries `row_fp`, a fingerprint of the normalized source fields,
// so the writer can skip a row whose source has not changed.

export const SOURCE = 'subsquare'

/**
 * Bounds on imported text, past which it is cut with a marker. Above the native
 * limits (forumText.ts LIMITS: title 160, post 50k, comment 10k) so that nothing
 * imported to date is cut — the largest description is 137,762 characters, the
 * largest comment 24,411 — while bounding every per-row cost of the rewrite.
 */
export const IMPORT_LIMITS = { titleChars: 160, postBodyChars: 200_000, commentBodyChars: 50_000 } as const

/** Cut to at most `max` UTF-16 units with `marker` at the end, never splitting a surrogate pair. */
export function capText(text: string, max: number, marker: string): string {
  if (text.length <= max) return text
  let end = Math.max(0, max - marker.length)
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return text.slice(0, end) + marker
}

const bodyMarker = (format: string) => (format === 'html' ? '<p>[…]</p>' : '\n\n[…]')

/**
 * An imported post's title and body as stored: links rewritten (links.ts), then
 * capped. A title over the cap is cut; when the body is empty (a tip whose reason is
 * its title) the full title becomes the body, so nothing is lost. Idempotent.
 */
export function importedPostText(title: string, body: string, format: string, links?: LinkRewriteOptions): { title: string; body: string } {
  const t = rewriteSubsquareText(title, links)
  const b = rewriteSubsquareLinks(t.length > IMPORT_LIMITS.titleChars && !body.trim() ? t : body, format, links)
  return { title: capText(t, IMPORT_LIMITS.titleChars, '…'), body: capText(b, IMPORT_LIMITS.postBodyChars, bodyMarker(format)) }
}

/** An imported comment's or Update's body as stored: links rewritten, then capped. Idempotent. */
export function importedCommentText(body: string, format: string, links?: LinkRewriteOptions): string {
  return capText(rewriteSubsquareLinks(body, format, links), IMPORT_LIMITS.commentBodyChars, bodyMarker(format))
}

export interface PostRow {
  post_id: string; kind: string; title: string; body: string; body_format: string; tldr: string
  labels: string[]; linked: string[]; author_account_id: string; author_legacy_name: string
  authority: string; source: string; source_id: string; source_cid: string; source_hash: string
  source_activity_at: string; source_removed: number; source_comments_count: number
  poll_json: string; banner_cid: string; revision: number; hidden: number; hidden_reason: string
  deleted: number; created_at: string; edited_at: string; last_activity_at: string; seq: number
  row_fp: string; updated_at: string
  /** Decided on this forum, carried from the stored row on every rewrite (021_forum.sql): a moderator's visibility decision, a locked thread. */
  moderated: number; locked: number
}

export interface CommentRow {
  thread_key: string; comment_id: string; kind: string; parent_id: string; reply_to_id: string
  author_account_id: string; author_legacy_name: string; body: string; body_format: string
  authority: string; source: string; source_id: string; source_cid: string; source_hash: string
  source_height: number; source_removed: number; revision: number; hidden: number; hidden_reason: string
  deleted: number; created_at: string; edited_at: string; seq: number; row_fp: string; updated_at: string
  /** A moderator's visibility decision on this forum, carried from the stored row on every rewrite. */
  moderated: number
}

export interface RevisionRow { target_id: string; revision: number; title: string; body: string; editor_account_id: string; source: string; created_at: string }
export interface MediaRow { cid: string; mime: string; bytes: number; width: number; height: number; sha256: string; uploader_account_id: string; origin: string; original_url: string; deleted: number; created_at: string; updated_at: string }
export interface MediaUrlRow { original_url: string; cid: string; status: string; reason: string; attempts: number; updated_at: string }
export interface ModLogRow { action_id: string; target_id: string; action: string; reason_code: string; moderator_account_id: string; created_at: string }

/** Epoch ms → the ISO string ClickHouse parses with date_time_input_format = best_effort. */
export function ts(ms: number): string {
  return new Date(Math.max(0, ms)).toISOString()
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash('sha256').update(s).digest('hex')
}

export function fingerprint(fields: unknown): string {
  return createHash('sha1').update(JSON.stringify(fields)).digest('hex')
}

/** Subsquare's contentHash, else our own hash of the text (comments carry none). */
export function contentHashOf(text: string, given: string | null): string {
  return given && /^[0-9a-f]{16,64}$/i.test(given) ? given.toLowerCase() : 'sha256:' + sha256Hex(text)
}

/** hidden flags from Subsquare's own moderation, and from removal. */
export function hiddenState(item: Pick<SsItem, 'hide' | 'isMalicious'>, removed: boolean): { hidden: number; reason: string } {
  if (removed) return { hidden: 1, reason: 'removed-on-subsquare' }
  if (item.isMalicious) return { hidden: 1, reason: 'spam' }
  if (item.hide) return { hidden: 1, reason: 'imported-hidden' }
  return { hidden: 0, reason: '' }
}

// ---- merged threads ----

/**
 * One Subsquare thread: every item whose rootPost is the same post shares one comment
 * list (council motion ↔ external ↔ TC motion ↔ democracy referendum, a treasury
 * proposal under its referendum). `owner` is the subject the comments are filed under.
 */
export interface Group { rootPostId: string; rootPostType: string; members: SsItem[]; owner: string }

const OWNER_COLLECTION: Record<string, Array<SsItem['collection']>> = {
  post: ['discussions'],
  referendaReferendum: ['opengov'],
  democracy: ['democracy_proposal', 'democracy'],
  motion: ['council'],
  techCommMotion: ['tc'],
  treasuryProposal: ['treasury'],
  treasurySpend: ['spend'],
  tip: ['tip'],
}

export function ownerOf(rootPostId: string, rootPostType: string, members: SsItem[], discussionById: ReadonlyMap<string, string>): string {
  if (rootPostType === 'post') {
    const d = discussionById.get(rootPostId)
    if (d) return d
  }
  for (const c of OWNER_COLLECTION[rootPostType] ?? []) {
    const m = members.filter(x => x.collection === c).sort((a, b) => a.createdAt - b.createdAt)[0]
    if (m) return m.subject
  }
  if (rootPostType === 'referendaReferendum') {
    const i = members.map(m => m.refs.referendumIndex).find(x => x != null)
    if (i != null) return `opengov:${i}`
  }
  return [...members].sort((a, b) => COLLECTIONS.indexOf(a.collection) - COLLECTIONS.indexOf(b.collection) || a.createdAt - b.createdAt)[0].subject
}

export function buildGroups(items: SsItem[], discussionById: ReadonlyMap<string, string>): Map<string, Group> {
  const byRoot = new Map<string, SsItem[]>()
  for (const it of items) {
    const list = byRoot.get(it.rootPostId) ?? []
    if (!list.some(x => x.subject === it.subject)) list.push(it)
    byRoot.set(it.rootPostId, list)
  }
  const out = new Map<string, Group>()
  for (const [rootPostId, members] of byRoot) {
    const rootPostType = members.find(m => m.rootPostType)?.rootPostType ?? ''
    out.set(rootPostId, { rootPostId, rootPostType, members, owner: ownerOf(rootPostId, rootPostType, members, discussionById) })
  }
  return out
}

/**
 * An on-chain item bound to a discussion (Subsquare's refToPost, e.g. a tip whose text
 * is a discussion) and that discussion link each other: both directions, by subject.
 */
export function boundLinks(items: Iterable<SsItem>, discussionById: ReadonlyMap<string, string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (a: string, b: string) => { const s = out.get(a) ?? new Set<string>(); s.add(b); out.set(a, s) }
  for (const it of items) {
    const d = it.boundDiscussionId ? discussionById.get(it.boundDiscussionId) : undefined
    if (d && d !== it.subject) { add(it.subject, d); add(d, it.subject) }
  }
  return out
}

/** Every other subject of an item's thread, the owner included, plus its bound discussion, sorted. */
export function linkedOf(subject: string, group: Group | undefined, extra?: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const set = new Set<string>(group ? [group.owner, ...group.members.map(m => m.subject)] : [])
  for (const s of extra?.get(subject) ?? []) set.add(s)
  set.delete(subject)
  return [...set].sort()
}

// ---- rows ----

export interface BuildContext { now: number; firstSeen: (id: string) => boolean; nextSeq: () => number; importing: boolean }

/** A new item gets a notification seq only when the sync sees it first and it is under an hour old. */
export function seqFor(ctx: BuildContext, id: string, createdAt: number): number {
  if (ctx.importing || !ctx.firstSeen(id)) return 0
  return ctx.now - createdAt <= 60 * 60_000 && ctx.now >= createdAt - 5 * 60_000 ? ctx.nextSeq() : 0
}

export interface PostSource {
  item: SsItem
  linked: string[]
  removed: boolean
  pollJson: string
  links?: LinkRewriteOptions
}

export type Skip = { skip: string }

/** The post row for an item, before revision/authority/seq merging with the stored row. */
export function postRow(src: PostSource): PostRow | Skip {
  const { item } = src
  const author = authorKey(item.author, item.proposer)
  if (!author.ok) return { skip: author.reason }
  const hidden = hiddenState(item, src.removed)
  const sourceHash = contentHashOf(item.title + '\u0000' + item.content, item.contentHash)
  const text = importedPostText(item.title, item.content, item.contentType, src.links)
  const row: PostRow = {
    post_id: item.subject,
    kind: KIND_OF[item.collection],
    title: text.title,
    body: text.body,
    body_format: item.contentType,
    tldr: '',
    labels: item.labels,
    linked: src.linked,
    author_account_id: author.accountId,
    author_legacy_name: author.legacyName,
    authority: SOURCE,
    source: SOURCE,
    source_id: item.sourceId,
    source_cid: item.cid ?? '',
    source_hash: sourceHash,
    source_activity_at: ts(item.lastActivityAt),
    source_removed: src.removed ? 1 : 0,
    source_comments_count: item.commentsCount,
    poll_json: src.pollJson,
    banner_cid: item.bannerCid ?? '',
    revision: 0,
    hidden: hidden.hidden,
    hidden_reason: hidden.reason,
    deleted: 0,
    created_at: ts(item.createdAt),
    // Not a source field: Subsquare flags on-chain placeholders `edited` and moves
    // updatedAt on any activity. planWrites sets it when the text actually changes.
    edited_at: ts(0),
    last_activity_at: ts(item.lastActivityAt),
    seq: 0,
    row_fp: '',
    updated_at: '',
    moderated: 0,
    locked: 0,
  }
  row.row_fp = postFingerprint(row)
  return row
}

export function postFingerprint(r: PostRow): string {
  return fingerprint([r.post_id, r.kind, r.title, r.body, r.body_format, r.labels, r.linked, r.author_account_id, r.author_legacy_name,
    r.source_id, r.source_cid, r.source_hash, r.source_activity_at, r.source_removed, r.source_comments_count, r.poll_json,
    r.banner_cid, r.hidden, r.hidden_reason, r.created_at, r.edited_at, r.last_activity_at])
}

/** A stub row for a subject only a merged thread names (its own item was not fetched). */
export function stubPostRow(subject: string, kind: string, linked: string[], createdAt: number, activityAt: number): PostRow {
  const row: PostRow = {
    post_id: subject, kind, title: '', body: '', body_format: 'markdown', tldr: '', labels: [], linked,
    author_account_id: '', author_legacy_name: '', authority: SOURCE, source: SOURCE, source_id: '', source_cid: '', source_hash: '',
    source_activity_at: ts(activityAt), source_removed: 0, source_comments_count: 0, poll_json: '', banner_cid: '', revision: 0,
    hidden: 0, hidden_reason: '', deleted: 0, created_at: ts(createdAt), edited_at: ts(0), last_activity_at: ts(activityAt),
    seq: 0, row_fp: '', updated_at: '', moderated: 0, locked: 0,
  }
  row.row_fp = postFingerprint(row)
  return row
}

export function kindOfSubject(subject: string): string {
  if (/^s\d+$/.test(subject)) return 'discussion'
  const prefix = subject.split(':')[0]
  return prefix === 'treasury' ? 'treasury_proposal' : prefix === 'spend' ? 'treasury_spend' : prefix
}

export function commentFingerprint(r: CommentRow): string {
  return fingerprint([r.thread_key, r.comment_id, r.kind, r.parent_id, r.reply_to_id, r.author_account_id, r.author_legacy_name,
    r.body, r.body_format, r.source_id, r.source_cid, r.source_hash, r.source_height, r.source_removed, r.hidden, r.hidden_reason,
    r.created_at, r.edited_at])
}

function commentBase(threadKey: string, c: { id: string; content: string; contentType: string; createdAt: number; updatedAt: number; cid: string | null }, author: { accountId: string; legacyName: string }, kind: string, links: LinkRewriteOptions | undefined): CommentRow {
  return {
    thread_key: threadKey, comment_id: 's' + c.id, kind, parent_id: '', reply_to_id: '',
    author_account_id: author.accountId, author_legacy_name: author.legacyName,
    body: importedCommentText(c.content, c.contentType, links), body_format: c.contentType, authority: SOURCE, source: SOURCE, source_id: c.id,
    source_cid: c.cid ?? '', source_hash: contentHashOf(c.content, null), source_height: 0, source_removed: 0,
    revision: 0, hidden: 0, hidden_reason: '', deleted: 0, created_at: ts(c.createdAt),
    edited_at: ts(c.updatedAt - c.createdAt > 1_000 ? c.updatedAt : 0), seq: 0, row_fp: '', updated_at: '', moderated: 0,
  }
}

export interface FlatComment { row: CommentRow; source: SsComment }

/**
 * A thread's comments flattened to two levels, deduplicated on the Subsquare _id. The
 * thread key is the subject a top-level comment's OWN owner field names (a bound item's
 * endpoint also returns its discussion's comments); a reply files with its parent.
 */
export function flattenThread(threadKey: string | ((c: SsComment) => string), comments: SsComment[], warn: (reason: string) => void, links?: LinkRewriteOptions): FlatComment[] {
  const out = new Map<string, FlatComment>()
  const keyOf = typeof threadKey === 'string' ? () => threadKey : threadKey
  const add = (c: SsComment, parent: string, key: string) => {
    if (out.has('s' + c.id)) return
    const author = authorKey(c.author, c.proposer)
    if (!author.ok) { warn(author.reason); return }
    const row = commentBase(key, c, author, 'comment', links)
    row.parent_id = parent
    row.reply_to_id = c.replyToComment ? 's' + c.replyToComment : ''
    row.source_height = c.height
    row.row_fp = commentFingerprint(row)
    out.set(row.comment_id, { row, source: c })
  }
  for (const c of comments) {
    const key = keyOf(c)
    add(c, '', key)
    for (const r of c.replies) add(r, 's' + c.id, key)
  }
  return [...out.values()]
}

export function appendantRow(threadKey: string, a: SsAppendant, links?: LinkRewriteOptions): CommentRow | Skip {
  const author = authorKey(a.author, a.proposer)
  if (!author.ok) return { skip: author.reason }
  const row = commentBase(threadKey, a, author, 'update', links)
  row.comment_id = 'su' + a.id
  row.row_fp = commentFingerprint(row)
  return row
}

// ---- images in bodies ----

const MD_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

/** Every http(s) image URL an imported body references (markdown images and <img src>). */
export function imageUrlsIn(body: string): string[] {
  const urls = new Set<string>()
  const take = (u: string | undefined) => {
    if (!u) return
    const v = u.replace(/&amp;/g, '&').trim()
    if (/^https?:\/\//i.test(v) && v.length <= 2048) urls.add(v)
  }
  for (const m of body.matchAll(MD_IMAGE)) take(m[1])
  for (const m of body.matchAll(HTML_IMAGE)) take(m[1] ?? m[2] ?? m[3])
  return [...urls]
}

/**
 * A post's banner as the image map keys it: Subsquare's gateway URL for its CID (what
 * Subsquare displayed). The image pass pins it by that CID; the api resolves the
 * banner through the same map. Null for no banner or a value that is not a CID.
 */
export function bannerUrl(cid: string | null | undefined): string | null {
  return cid && (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid) || /^b[a-z2-7]{50,100}$/.test(cid)) ? `https://subsquare.infura-ipfs.io/ipfs/${cid}` : null
}

/** The CID of an IPFS gateway URL (`…/ipfs/<cid>`), or null. */
export function ipfsCidOf(url: string): string | null {
  const m = /^https:\/\/[^/]+\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})(?:[/?#].*)?$/.exec(url)
  return m ? m[1] : null
}
