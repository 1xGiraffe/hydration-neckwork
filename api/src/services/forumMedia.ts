import { createHash } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { applyLocalMedia, forumMedia } from './forumStore.ts'
import { ImageError, MAX_IMAGE_BYTES, sanitizeImage } from './imageSanitize.ts'
import { ForumWriteError, limiter, standingOf, type WriteContext } from './forumWrite.ts'
import { limitMessage, type LimitAction, type LimitRefusal } from './forumLimits.ts'

// Image uploads for forum posts (POST /user/forum/media): the bytes a signed-in
// account pasted or dropped into the editor, validated WITHOUT decoding pixels by the
// same container walk the Subsquare sync uses (imageSanitize.ts — a copy pinned
// byte-identical by a test): PNG, JPEG, WebP or GIF only, SVG and everything else
// refused, every metadata chunk stripped, a polyglot's trailing payload dropped,
// dimensions and animation size bounded from the headers (decompression bombs). The
// stripped bytes are added to the forum's IPFS node (CIDv1, sha2-256, raw leaves) and
// pinned, recorded in forum_media, and served same-origin at /ipfs/<cid> — which
// serves only CIDs with a live forum_media row.
//
// The node's disk is shared with ClickHouse and holds a 2 GB StorageMax that garbage
// collection enforces only for UNPINNED blocks — pins can grow past it. So uploads are
// bounded three ways: per account (FORUM_LIMITS.upload, plus a lifetime byte quota),
// across all accounts (uploadGlobal, plus a daily byte budget), and by the repo itself:
// an upload that would take the repo past STORAGE_HEADROOM of StorageMax is refused.
//
// Every one of those checks is a RESERVATION taken synchronously — the request slots
// and the bytes, against the committed totals plus everything still in flight — after
// the last await that gathers facts and before the first await that does work, so
// concurrent uploads can never all pass the same last free byte. A failed upload gives
// its reservation back; a successful one turns it into a committed total. The totals
// that must survive a restart (an account's lifetime bytes, the day's global bytes and
// uploads) are seeded from forum_media.
//
// An upload no post, comment or revision references a day later is unpinned and its
// row removed (sweepUnreferencedUploads), so pasting images without posting cannot
// fill the node either.

let client: ClickHouseClient

const IPFS_API_URL = (process.env.IPFS_API_URL ?? 'http://hydration-neckwork-ipfs:5001').replace(/\/+$/, '')
/** Lifetime upload bytes per account. */
export const UPLOAD_QUOTA_BYTES = 200 * 1024 * 1024
/** Upload bytes across every account per rolling day. */
export const GLOBAL_DAILY_BYTES = 512 * 1024 * 1024
/** Uploads stop once the repo would pass this share of its StorageMax. */
export const STORAGE_HEADROOM = 0.8
/** An upload nothing references after this long is unpinned. */
export const UNREFERENCED_AFTER_MS = 24 * 3_600_000
const SWEEP_EVERY_MS = 30 * 60_000
const DAY_MS = 86_400_000

const WRITE_SETTINGS = { async_insert: 0, wait_for_async_insert: 1, date_time_input_format: 'best_effort' } as const
const READ_SETTINGS = { max_threads: 2 } as const
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

/**
 * The api's bearer token for the node's RPC (API.Authorizations, ops/ipfs-init.sh: scoped to
 * add, pin/rm, repo/stat and repo/gc); empty sends none, which a node without
 * authorizations still accepts.
 */
const IPFS_TOKEN = process.env.IPFS_TOKEN_API ?? ''

async function kubo(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const headers = new Headers(init.headers)
  if (IPFS_TOKEN) headers.set('Authorization', `Bearer ${IPFS_TOKEN}`)
  const res = await fetch(`${IPFS_API_URL}/api/v0/${path}`, { method: 'POST', ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`ipfs ${path.split('?')[0]} → HTTP ${res.status}`)
  return res
}

async function kuboAdd(bytes: Uint8Array, onlyHash: boolean): Promise<string> {
  const params = new URLSearchParams({ 'cid-version': '1', hash: 'sha2-256', 'raw-leaves': 'true', pin: String(!onlyHash), quiet: 'true' })
  if (onlyHash) params.set('only-hash', 'true')
  const form = new FormData()
  form.append('file', new Blob([Uint8Array.from(bytes)]), 'image')
  const text = await (await kubo(`add?${params}`, { body: form }, 60_000)).text()
  const hash = (JSON.parse(text.trim().split('\n').pop() ?? '{}') as { Hash?: string }).Hash
  if (!hash || !/^b[a-z2-7]{50,100}$/.test(hash)) throw new Error('ipfs add returned no CIDv1')
  return hash
}

async function kuboGc(): Promise<void> {
  try { await (await kubo('repo/gc?quiet=true', {}, 300_000)).text() } catch { /* the daemon's own GC period catches up */ }
}

export async function kuboUnpin(cid: string, gc = true): Promise<void> {
  try { await kubo(`pin/rm?arg=${encodeURIComponent(cid)}`) } catch { /* not pinned */ }
  // Collect the unpinned blocks in the background; the daemon also runs GC on its own period.
  if (gc) void kuboGc()
}

// ---- the ledgers (committed + in flight) ----

/** The repo's size against its ceiling, read at most every 30 s; bytes accepted since that read are added. */
let repoStat: { at: number; size: number; max: number } | null = null
let acceptedSinceStat = 0
let pendingRepoBytes = 0

/** Global uploads of the rolling day (seeded from forum_media at boot). */
const globalBytes: Array<{ at: number; bytes: number }> = []
let pendingGlobalBytes = 0

/** Per account: lifetime bytes committed (seeded once from forum_media) and in flight. */
const accountBytes = new Map<string, number>()
const accountSeeding = new Map<string, Promise<void>>()
const pendingAccountBytes = new Map<string, number>()

function globalBytesToday(now = Date.now()): number {
  while (globalBytes.length && globalBytes[0].at <= now - DAY_MS) globalBytes.shift()
  return globalBytes.reduce((n, e) => n + e.bytes, 0)
}

/** Seeds the day's global uploads (bytes and the uploadGlobal window) from forum_media, once per boot. */
async function seedGlobal(): Promise<void> {
  const res = await client.query({
    query: `SELECT toUnixTimestamp64Milli(created_at) AS at, bytes FROM price_data.forum_media FINAL
            WHERE origin = 'upload' AND created_at > now() - INTERVAL 1 DAY ORDER BY created_at`,
    format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  const rows = (await res.json<{ at: number | string; bytes: number | string }>()).map(r => ({ at: Number(r.at), bytes: Number(r.bytes) }))
  globalBytes.splice(0, globalBytes.length, ...rows)
  limiter.seed('uploadGlobal', 'all', rows.map(r => r.at))
}

/** An account's lifetime upload bytes and the times of the last day's uploads (seeding its per-day window). */
async function seedAccount(accountId: string): Promise<void> {
  if (accountBytes.has(accountId)) return
  let p = accountSeeding.get(accountId)
  if (!p) {
    p = (async () => {
      const res = await client.query({
        query: `SELECT toUInt64(sum(bytes)) AS bytes, groupArrayIf(toUnixTimestamp64Milli(created_at), created_at > now() - INTERVAL 1 DAY) AS recent
                FROM price_data.forum_media FINAL WHERE uploader_account_id = {a:String} AND origin = 'upload'`,
        query_params: { a: accountId }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
      })
      const r = (await res.json<{ bytes: string | number; recent: Array<string | number> }>())[0]
      if (!accountBytes.has(accountId)) accountBytes.set(accountId, Number(r?.bytes ?? 0))
      limiter.seed('upload', accountId, (r?.recent ?? []).map(Number))
    })().finally(() => accountSeeding.delete(accountId))
    accountSeeding.set(accountId, p)
  }
  await p
}

async function readRepoStat(): Promise<void> {
  if (repoStat && Date.now() - repoStat.at <= 30_000) return
  const j = await (await kubo('repo/stat?size-only=true', {}, 10_000)).json() as { RepoSize?: number; StorageMax?: number }
  const size = Number(j.RepoSize), max = Number(j.StorageMax)
  if (!(size >= 0) || !(max > 0)) throw new Error('repo/stat unreadable')
  repoStat = { at: Date.now(), size, max }
  acceptedSinceStat = 0
}

export function initForumMedia(c: ClickHouseClient): void { client = c }

/** Boot: seed the day's global budget, then sweep unreferenced uploads every half hour. Never throws. */
export async function startForumMediaHousekeeping(): Promise<void> {
  await seedGlobal().catch(err => console.warn('[forum-media] could not seed the global upload budget', err instanceof Error ? err.name : 'error'))
  const tick = () => { void sweepUnreferencedUploads().catch(err => console.warn('[forum-media] sweep failed', err instanceof Error ? err.name : 'error')) }
  setInterval(tick, SWEEP_EVERY_MS).unref()
}

export interface UploadResult { cid: string; url: string; mime: string; bytes: number; width: number; height: number }

const IMAGE_REASONS: Record<string, string> = {
  'svg-or-markup': 'SVG and other documents are not accepted — use PNG, JPEG, WebP or GIF.',
  'not-an-image': 'This is not a PNG, JPEG, WebP or GIF image.',
  'too-large': `Images are limited to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
  'too-wide': 'Images are limited to 8192 pixels on a side.',
  'too-many-pixels': 'Images are limited to 40 megapixels.',
  'no-dimensions': 'This image does not say how large it is.',
  'gif-frame-outside': 'A frame of this animation lies outside the image.',
  'png-frame-outside': 'A frame of this animation lies outside the image.',
  'too-many-frames': 'Animations are limited to 1,000 frames.',
  'too-much-animation': 'This animation is too large (frames × size); shorten it or make it smaller.',
}
/** Reasons that are about the image's size rather than its format: 422, not 415. */
const DIMENSION_REASONS = new Set(['too-wide', 'too-many-pixels', 'no-dimensions', 'gif-frame-outside', 'png-frame-outside', 'too-many-frames', 'too-much-animation'])

interface Reservation { slots: Array<{ action: LimitAction; who: string; at: number }>; bytes: number; accountId: string }

function release(r: Reservation): void {
  for (const s of r.slots) limiter.release(s.action, s.who, s.at)
  pendingGlobalBytes -= r.bytes
  pendingRepoBytes -= r.bytes
  const pa = (pendingAccountBytes.get(r.accountId) ?? 0) - r.bytes
  if (pa > 0) pendingAccountBytes.set(r.accountId, pa); else pendingAccountBytes.delete(r.accountId)
  r.bytes = 0
  r.slots = []
}

/** Turns a reservation's bytes into committed totals (the image is pinned and recorded). */
function commit(r: Reservation, counted: boolean): void {
  const bytes = r.bytes
  r.slots = [] // the request slots stay used
  release(r)
  if (!counted) return
  accountBytes.set(r.accountId, (accountBytes.get(r.accountId) ?? 0) + bytes)
  globalBytes.push({ at: Date.now(), bytes })
  acceptedSinceStat += bytes
}

const refusal = (r: LimitRefusal): ForumWriteError => new ForumWriteError(429, limitMessage(r), 'rate-limited', r.retryAfterSec)

/**
 * Takes every slot and byte this upload needs, or none: synchronous from the first
 * check to the last record, so no other upload can interleave.
 */
function reserve(ctx: WriteContext, bytes: number): Reservation {
  const r: Reservation = { slots: [], bytes: 0, accountId: ctx.accountId }
  const take = (action: LimitAction, who: string) => {
    const got = limiter.reserve(action, who)
    if ('window' in got) { release(r); throw refusal(got) }
    r.slots.push({ action, who, at: got.at })
  }
  take('upload', ctx.accountId)
  if (ctx.ip) take('ip', ctx.ip)
  take('uploadGlobal', 'all')
  const account = (accountBytes.get(ctx.accountId) ?? 0) + (pendingAccountBytes.get(ctx.accountId) ?? 0)
  if (account + bytes > UPLOAD_QUOTA_BYTES) {
    release(r)
    throw new ForumWriteError(429, `This account has used its ${UPLOAD_QUOTA_BYTES / 1024 / 1024} MB of image uploads. You can still post without images.`, 'quota')
  }
  if (globalBytesToday() + pendingGlobalBytes + bytes > GLOBAL_DAILY_BYTES) {
    release(r)
    throw new ForumWriteError(503, 'Image hosting has taken all it can for today — try again tomorrow. Your text is kept.', 'storage-full')
  }
  if (!repoStat || repoStat.size + acceptedSinceStat + pendingRepoBytes + bytes > repoStat.max * STORAGE_HEADROOM) {
    release(r)
    throw new ForumWriteError(503, 'Image hosting is full right now. Your text is kept; moderators have been told.', 'storage-full')
  }
  r.bytes = bytes
  pendingGlobalBytes += bytes
  pendingRepoBytes += bytes
  pendingAccountBytes.set(ctx.accountId, (pendingAccountBytes.get(ctx.accountId) ?? 0) + bytes)
  return r
}

/** Validates, strips, pins and records one uploaded image. */
export async function uploadImage(ctx: WriteContext, raw: Uint8Array): Promise<UploadResult> {
  if (raw.length > MAX_IMAGE_BYTES) throw new ForumWriteError(413, IMAGE_REASONS['too-large'], 'too-large')
  // Facts first (every await that only reads), then one synchronous reservation.
  const standing = await standingOf(ctx.accountId)
  if (!standing.canComment) throw new ForumWriteError(403, standing.gate?.detail ?? 'This account cannot upload images here.', standing.gate?.reason ?? 'gated')
  let img
  try { img = sanitizeImage(raw) } catch (err) {
    const reason = err instanceof ImageError ? err.reason : 'not-an-image'
    throw new ForumWriteError(DIMENSION_REASONS.has(reason) ? 422 : 415, IMAGE_REASONS[reason] ?? 'This image could not be read as a PNG, JPEG, WebP or GIF.', `image:${reason}`)
  }
  await seedAccount(ctx.accountId)
  try { await readRepoStat() } catch {
    throw new ForumWriteError(503, 'Image hosting is temporarily unavailable. Your text is kept — try again in a minute.', 'ipfs-unavailable')
  }
  const reservation = reserve(ctx, img.bytes.length)
  try {
    let cid: string
    // The CID first, without storing: an image moderators removed is refused before it is pinned again.
    try { cid = await kuboAdd(img.bytes, true) } catch {
      throw new ForumWriteError(503, 'Image hosting is temporarily unavailable. Your text is kept — try again in a minute.', 'ipfs-unavailable')
    }
    const res = await client.query({
      query: `SELECT deleted FROM price_data.forum_media FINAL WHERE cid = {c:String} LIMIT 1`,
      query_params: { c: cid }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    })
    const prior = (await res.json<{ deleted: number }>())[0]
    if (prior && Number(prior.deleted) === 1) throw new ForumWriteError(451, 'Moderators removed this image from the forum; it cannot be uploaded again.', 'removed')
    const result: UploadResult = { cid, url: `/ipfs/${cid}`, mime: img.mime, bytes: img.bytes.length, width: img.width, height: img.height }
    if (prior) { commit(reservation, false); return result } // already hosted: nothing to pin or count twice
    try {
      if ((await kuboAdd(img.bytes, false)) !== cid) throw new Error('cid changed between hash and add')
    } catch {
      throw new ForumWriteError(503, 'Image hosting is temporarily unavailable. Your text is kept — try again in a minute.', 'ipfs-unavailable')
    }
    const now = Date.now()
    await client.insert({
      table: 'price_data.forum_media', format: 'JSONEachRow', clickhouse_settings: WRITE_SETTINGS,
      values: [{
        cid, mime: img.mime, bytes: img.bytes.length, width: img.width, height: img.height,
        sha256: createHash('sha256').update(img.bytes).digest('hex'), uploader_account_id: ctx.accountId, origin: 'upload',
        original_url: '', deleted: 0, created_at: ts(now), updated_at: ts(now),
      }],
    })
    commit(reservation, true)
    if (!forumMedia(cid)) applyLocalMedia(cid, { cid, mime: img.mime, bytes: img.bytes.length, width: img.width, height: img.height, origin: 'upload', createdAt: now })
    return result
  } catch (err) {
    release(reservation)
    throw err
  }
}

/** Every `/ipfs/<cid>` any stored post, comment or revision body names (bounded: the forum tables are small). */
// The image URLs a body names — markdown `![](…)` and HTML `<img src>` — in ClickHouse
// (re2) form, the same two shapes forumRead.imageUrlsIn finds: an imported body names
// Subsquare's URL, which forum_media_urls maps to the CID the sync re-hosted.
const MD_IMAGE_RE = '!\\[[^\\]]*\\]\\(\\s*<?([^)\\s>]+)'
const HTML_IMAGE_RE = '(?i)<img\\b[^>]*?\\bsrc\\s*=\\s*["\']?([^"\'\\s>]+)'

/**
 * Every CID a forum item references: a literal `/ipfs/<cid>` in a body, an imported
 * image URL through the re-hosting map, and a post's banner (pinned under its own CID
 * or re-hosted through the map, as forumRead.bannerPathFor resolves it). With `visibleOnly`, only
 * items a reader can see count (not hidden, not deleted; revisions of such items) —
 * what decides whether an image is still served and whether a purge may drop it.
 */
export async function referencedCids(opts: { visibleOnly?: boolean } = {}): Promise<Set<string>> {
  const vis = opts.visibleOnly ? 'hidden = 0 AND deleted = 0' : '1'
  const revs = opts.visibleOnly
    ? `target_id IN (SELECT post_id FROM price_data.forum_posts FINAL WHERE ${vis}) OR target_id IN (SELECT comment_id FROM price_data.forum_comments FINAL WHERE ${vis})`
    : '1'
  const res = await client.query({
    query: `WITH bodies AS (
              SELECT body FROM price_data.forum_posts FINAL WHERE ${vis}
              UNION ALL SELECT body FROM price_data.forum_comments FINAL WHERE ${vis}
              UNION ALL SELECT body FROM price_data.forum_revisions FINAL WHERE ${revs})
            SELECT DISTINCT cid FROM (
              SELECT arrayJoin(extractAll(body, '/ipfs/([A-Za-z0-9]{46,121})')) AS cid FROM bodies WHERE position(body, '/ipfs/') > 0
              UNION ALL
              SELECT cid FROM price_data.forum_media_urls FINAL WHERE status = 'ok' AND cid != '' AND original_url IN (
                SELECT arrayJoin(arrayConcat(extractAll(body, {md:String}), extractAll(body, {html:String}))) FROM bodies)
              UNION ALL
              SELECT banner_cid AS cid FROM price_data.forum_posts FINAL WHERE ${vis} AND banner_cid != ''
              UNION ALL
              SELECT cid FROM price_data.forum_media_urls FINAL WHERE status = 'ok' AND cid != '' AND original_url IN (
                SELECT concat('https://subsquare.infura-ipfs.io/ipfs/', banner_cid) FROM price_data.forum_posts FINAL WHERE ${vis} AND banner_cid != ''))`,
    query_params: { md: MD_IMAGE_RE, html: HTML_IMAGE_RE },
    format: 'JSONEachRow', clickhouse_settings: { ...READ_SETTINGS, max_memory_usage: '1000000000' },
  })
  return new Set((await res.json<{ cid: string }>()).map(r => r.cid))
}

// The serving gate's view of visible references, rebuilt at most once a minute (a
// newly posted image is an upload the gate admits on its own; an imported item
// re-hosted or hidden shows within the minute).
const VISIBLE_REFS_TTL_MS = 60_000
let visibleRefs: { at: number; set: Promise<Set<string>> } | null = null
export function visibleReferencedCids(now = Date.now()): Promise<Set<string>> {
  if (!visibleRefs || now - visibleRefs.at > VISIBLE_REFS_TTL_MS) {
    const set = referencedCids({ visibleOnly: true })
    visibleRefs = { at: now, set }
    set.catch(() => { if (visibleRefs?.set === set) visibleRefs = null })
  }
  return visibleRefs.set
}
export function invalidateVisibleReferencedCids(): void { visibleRefs = null }
export function setVisibleReferencedCidsForTest(set: Set<string> | null): void { visibleRefs = set ? { at: Number.MAX_SAFE_INTEGER, set: Promise.resolve(set) } : null }

/**
 * Whether /ipfs/<cid> may serve a pinned image: a visible item references it, or it
 * is a fresh upload (an editor previews its images before the post exists; the
 * housekeeping sweep removes uploads still unreferenced a day later). An image only
 * hidden, deleted or purged items use is not served.
 */
export async function mayServeMedia(entry: { cid: string; origin: string; createdAt: number }, now = Date.now()): Promise<boolean> {
  if (entry.origin === 'upload' && now - entry.createdAt < UNREFERENCED_AFTER_MS) return true
  return (await visibleReferencedCids(now)).has(entry.cid)
}

/**
 * Housekeeping: an upload no post, comment or revision references a day after it was
 * made (pasted into a draft and never posted) is unpinned and its forum_media row
 * removed — a hard delete, so the same image can be uploaded again later (a
 * moderator's removal is a tombstone instead, which refuses that). One GC follows.
 */
export async function sweepUnreferencedUploads(): Promise<string[]> {
  const res = await client.query({
    query: `SELECT cid FROM price_data.forum_media FINAL
            WHERE origin = 'upload' AND deleted = 0 AND created_at < now64(3) - toIntervalMillisecond({age:UInt64})`,
    query_params: { age: UNREFERENCED_AFTER_MS }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  const candidates = (await res.json<{ cid: string }>()).map(r => r.cid)
  if (!candidates.length) return []
  const used = await referencedCids()
  const orphans = candidates.filter(c => !used.has(c))
  if (!orphans.length) return []
  await client.command({
    query: `DELETE FROM price_data.forum_media WHERE cid IN {c:Array(String)} AND origin = 'upload'`,
    query_params: { c: orphans }, clickhouse_settings: { lightweight_deletes_sync: '2' },
  })
  for (const cid of orphans) { await kuboUnpin(cid, false); applyLocalMedia(cid, null) }
  await kuboGc()
  console.log(`[forum-media] unpinned ${orphans.length} upload(s) nothing referenced after a day`)
  return orphans
}

/**
 * A moderator's removal: the row tombstoned (so /ipfs/<cid> stops serving and a
 * re-upload is refused) and the pin dropped.
 */
export async function removeMedia(moderator: string, cid: string, reasonCode: string): Promise<{ generation: string }> {
  const res = await client.query({
    query: `SELECT cid, mime, bytes, width, height, sha256, uploader_account_id, origin, original_url, toString(created_at) AS created_at
            FROM price_data.forum_media FINAL WHERE cid = {c:String} AND deleted = 0 LIMIT 1`,
    query_params: { c: cid }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  const row = (await res.json<Record<string, unknown>>())[0]
  if (!row) throw new ForumWriteError(404, 'No such image.', 'not-found')
  const now = Date.now()
  await client.insert({
    table: 'price_data.forum_moderation_log', format: 'JSONEachRow', clickhouse_settings: WRITE_SETTINGS,
    values: [{ action_id: `mod:media:${cid}:${now}`, target_id: cid, action: 'media-remove', reason_code: reasonCode, moderator_account_id: moderator, created_at: ts(now) }],
  })
  await client.insert({
    table: 'price_data.forum_media', format: 'JSONEachRow', clickhouse_settings: WRITE_SETTINGS,
    values: [{ ...row, deleted: 1, updated_at: ts(now) }],
  })
  await kuboUnpin(cid)
  invalidateVisibleReferencedCids()
  return { generation: applyLocalMedia(cid, null) }
}

/** The account's upload standing, for the editor ("12 of 200 MB used"). */
export async function uploadStanding(accountId: string): Promise<{ usedBytes: number; maxBytes: number; maxFileBytes: number }> {
  await seedAccount(accountId)
  return { usedBytes: (accountBytes.get(accountId) ?? 0) + (pendingAccountBytes.get(accountId) ?? 0), maxBytes: UPLOAD_QUOTA_BYTES, maxFileBytes: MAX_IMAGE_BYTES }
}

/** Clears the in-process ledgers (tests). */
export function resetForumMediaForTests(stat: { size: number; max: number } | null = null): void {
  repoStat = stat ? { at: Date.now() + 3_600_000, ...stat } : null
  acceptedSinceStat = 0; pendingRepoBytes = 0; pendingGlobalBytes = 0
  globalBytes.length = 0; accountBytes.clear(); accountSeeding.clear(); pendingAccountBytes.clear()
}
