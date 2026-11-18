import { ImageError, MAX_IMAGE_BYTES, sanitizeImage } from './imageSanitize.js'
import type { KuboClient } from './kubo.js'
import { ipfsCidOf, sha256Hex, ts, type MediaRow, type MediaUrlRow } from './rows.js'
import { SafeFetchError, safeFetch, type SafeFetchOptions } from './safeFetch.js'
import type { StoredMediaUrl } from './store.js'

// Re-hosting the images imported bodies reference, and posts' banners, onto the
// forum's IPFS node. Image URLs in bodies stay as received; the renderer rewrites one through
// forum_media_urls, and one that could not be re-hosted renders as a plain link to its
// original host — never a hot-linked <img>.
//
// An image already on IPFS (Subsquare's own uploads, `…/ipfs/<cid>`) is pinned by its
// EXISTING CID, so it keeps its identity: fetched over the IPFS network, validated
// without stripping (its bytes ARE its CID). If the network cannot supply it, it is
// fetched over HTTPS through the SSRF guard like any other image: validated, stripped
// of metadata, and added as a new CIDv1.
//
// When neither answers (a dead host, a CID nobody provides), the Internet Archive's
// raw capture of the same URL is tried (`web.archive.org/web/<ts>id_/<url>`, the
// earliest capture), through the same SSRF guard, one request a second at most —
// but never after the host itself answered 404, 410 or 451: an image its owner or a
// court took down stays down. A capture of an IPFS URL is kept only if its bytes
// reproduce the CID (validated unstripped and pinned under that CID); any other
// capture is a snapshot of the original image and is validated and stripped like a
// direct fetch.
//
// Nothing is pinned or added before two checks, both on the CID it would be stored
// under (computed first, without storing): a CID a moderator removed is refused
// (`refuseCid`; the URL is recorded as failed `removed`), however the image is
// spelled — another URL for it, the same bytes stripped again — and `admit` must
// accept its size (the repo ceiling and the sync's daily and per-author caps), else
// the image is deferred, not failed: nothing is recorded and it is due again later.
// A removal can land while an image is being fetched and pinned, so `refuseCid` is
// asked again once the pin is in place: if the CID was removed meanwhile, the pin is
// dropped again and the URL recorded as failed `removed`. Whichever of the removal's
// unpin and this pin runs last, nothing removed stays pinned.

export const RETRY_FAILED_AFTER_MS = 24 * 60 * 60_000
export const MAX_ATTEMPTS = 5

/** Whether a URL still needs re-hosting (new, or a failure due for its daily retry). */
export function urlDue(stored: StoredMediaUrl | undefined, now: number): boolean {
  if (!stored) return true
  if (stored.status === 'ok') return false
  return stored.attempts < MAX_ATTEMPTS && now - stored.updated_ms >= RETRY_FAILED_AFTER_MS
}

export type RehostResult =
  | { media: MediaRow | null; url: MediaUrlRow; kind: 'pinned-cid' | 'rehosted' | 'archived' | 'failed' }
  /** Not stored for now (the repo ceiling or a cap): nothing to record, due again later. */
  | { media: null; url: null; kind: 'deferred'; reason: string }

type Stored = 'pinned-cid' | 'rehosted' | 'archived'

/** Statuses by which a host says an image is gone on purpose: no archive copy is sought after them. */
export const TAKEDOWN_STATUSES = new Set(['fetch:http-404', 'fetch:http-410', 'fetch:http-451'])

/** The archive's raw (`id_`, no replay rewriting) earliest capture of a URL; it redirects to the capture itself. */
export function archiveUrl(url: string): string {
  return `https://web.archive.org/web/20000101000000id_/${url}`
}

/** The archive answers slowly; its fetch gets longer than a direct one. */
export const ARCHIVE_TIMEOUT_MS = 30_000

export interface RehostDeps {
  kubo: KuboClient
  fetchOptions?: SafeFetchOptions
  pinTimeoutMs?: number
  now: () => number
  /**
   * Runs a fetch from a Subsquare-owned host (its static host, its IPFS gateway) in the
   * API client's own queue, so Subsquare as a whole sees one request in flight at most
   * SUBSQUARE_RPS. Other hosts are fetched directly.
   */
  throttle?: <T>(fn: () => Promise<T>) => Promise<T>
  /** Called when blocks were fetched or unpinned without a pin to keep them: the cycle then runs repo/gc. */
  onGarbage?: () => void
  /** Runs an archive fetch at most once a second, one at a time; absent, the archive is not tried. */
  archiveThrottle?: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * A CID moderators removed (forum_media deleted = 1): never pinned or added again.
   * Asked before a pin and again after it, so it must read the durable tombstone, not
   * a set loaded earlier.
   */
  refuseCid?: (cid: string) => boolean | Promise<boolean>
  /** Whether `bytes` more may be stored now: null to go ahead, else the reason it is deferred. */
  admit?: (bytes: number) => Promise<string | null>
}

/** Thrown inside a re-host to defer it (see RehostDeps.admit). */
class Deferred extends Error { constructor(readonly reason: string) { super(reason) } }

/** After a pin: false (and the pin dropped again) when a moderator removed the CID meanwhile. */
async function keptAfterPin(cid: string, deps: RehostDeps): Promise<boolean> {
  if (!(await deps.refuseCid?.(cid))) return true
  await deps.kubo.pinRm(cid)
  deps.onGarbage?.()
  return false
}

async function admitOrDefer(deps: RehostDeps, bytes: number): Promise<void> {
  const reason = deps.admit ? await deps.admit(bytes) : null
  if (reason) throw new Deferred(reason)
}

/** A one-at-a-time limiter spacing calls at least `gapMs` apart (the archive's politeness). */
export function spacedQueue(gapMs: number, now: () => number = Date.now, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  let last = -Infinity
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(async () => {
      const wait = last + gapMs - now()
      if (wait > 0) await sleep(wait)
      last = now()
      return fn()
    })
    tail = run.catch(() => undefined)
    return run
  }
}

/**
 * The add parameters that reproduce `cid` from `bytes`, or null: CIDv0 is dag-pb
 * without raw leaves; a CIDv1 raw block is one raw leaf; a CIDv1 dag-pb file is tried
 * with raw leaves (kubo's CIDv1 default) and without.
 */
async function reproducingParams(kubo: KuboClient, cid: string, bytes: Uint8Array): Promise<{ cidVersion: 0 | 1; rawLeaves: boolean } | null | 'unsupported'> {
  const p = await kubo.cidParams(cid)
  if (p.hash !== 'sha2-256' || (p.version !== 0 && p.version !== 1)) return 'unsupported'
  const tries = p.version === 0 ? [{ cidVersion: 0 as const, rawLeaves: false }]
    : p.codec === 'raw' ? [{ cidVersion: 1 as const, rawLeaves: true }]
      : [{ cidVersion: 1 as const, rawLeaves: true }, { cidVersion: 1 as const, rawLeaves: false }]
  for (const t of tries) if ((await kubo.add(bytes, { onlyHash: true, ...t })) === cid) return t
  return null
}

/** Hosts Subsquare operates, whose fetches share the API client's rate limit. */
export function isSubsquareHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h === 'subsquare.io' || h.endsWith('.subsquare.io') || h === 'subsquare.infura-ipfs.io'
  } catch { return false }
}

/**
 * Pins an image by its EXISTING CID, validated before anything is pinned: the root
 * block's stated size caps it (no data fetched yet), the bytes are read with a length
 * cap and a timeout, the container walk validates them unstripped (trailing bytes
 * refused), and the bytes are re-hashed with the CID's own parameters and must
 * reproduce the CID — only then is it pinned. Anything refused leaves only unpinned
 * blocks behind, which the cycle's repo/gc removes. Null when the IPFS network could
 * not supply it (the caller falls back to the guarded HTTPS fetch).
 */
async function pinExistingCid(cid: string, deps: RehostDeps, ok: (bytes: Uint8Array, img: { mime: string; width: number; height: number }) => RehostResult, failed: (reason: string) => RehostResult): Promise<RehostResult | null> {
  const timeout = deps.pinTimeoutMs ?? 30_000
  let stat
  try { stat = await deps.kubo.rootStat(cid, timeout) } catch { deps.onGarbage?.(); return null }
  // A file's own size, plus the DAG's link overhead for a chunked one.
  if (!(stat.size <= MAX_IMAGE_BYTES) || !(stat.cumulativeSize <= MAX_IMAGE_BYTES + 64 * 1024)) { deps.onGarbage?.(); return failed('image:too-large') }
  let bytes: Uint8Array
  try { bytes = await deps.kubo.cat(cid, MAX_IMAGE_BYTES, timeout) } catch { deps.onGarbage?.(); return null }
  let img
  try { img = sanitizeImage(bytes, { strip: false }) } catch (err) { deps.onGarbage?.(); return failed(err instanceof ImageError ? `image:${err.reason}` : 'image:error') }
  try {
    const params = await reproducingParams(deps.kubo, cid, bytes)
    if (params === 'unsupported') { deps.onGarbage?.(); return failed('cid-params') }
    if (!params) { deps.onGarbage?.(); return failed('cid-mismatch') }
  } catch { deps.onGarbage?.(); return failed('ipfs-rehash') }
  await admitOrDefer(deps, stat.cumulativeSize)
  if (!(await deps.kubo.pinAdd(cid, timeout))) { deps.onGarbage?.(); return failed('ipfs-pin') }
  if (!(await keptAfterPin(cid, deps))) return failed('removed')
  return ok(bytes, img)
}

export async function rehostImage(url: string, stored: StoredMediaUrl | undefined, deps: RehostDeps): Promise<RehostResult> {
  try {
    return await rehost(url, stored, deps)
  } catch (err) {
    if (err instanceof Deferred) { deps.onGarbage?.(); return { media: null, url: null, kind: 'deferred', reason: err.reason } }
    throw err
  }
}

/** Adds `bytes` under the CID they hash to, unless that CID was removed or `admit` defers it; the CID added. */
async function addChecked(bytes: Uint8Array, deps: RehostDeps, params: { cidVersion?: 0 | 1; rawLeaves?: boolean } = {}): Promise<string | 'removed'> {
  const cid = await deps.kubo.add(bytes, { ...params, onlyHash: true })
  if (await deps.refuseCid?.(cid)) return 'removed'
  await admitOrDefer(deps, bytes.length)
  const added = await deps.kubo.add(bytes, { ...params, pin: true })
  return (await keptAfterPin(added, deps)) ? added : 'removed'
}

async function rehost(url: string, stored: StoredMediaUrl | undefined, deps: RehostDeps): Promise<RehostResult> {
  const now = ts(deps.now())
  const attempts = (stored?.attempts ?? 0) + 1
  const ok = (media: MediaRow, kind: Stored): RehostResult => ({ media, kind, url: { original_url: url, cid: media.cid, status: 'ok', reason: '', attempts, updated_at: now } })
  const failed = (reason: string): RehostResult => ({ media: null, kind: 'failed', url: { original_url: url, cid: '', status: 'failed', reason, attempts, updated_at: now } })

  const existing = ipfsCidOf(url)
  if (existing && await deps.refuseCid?.(existing)) return failed('removed')
  if (existing) {
    const pinned = await pinExistingCid(existing, deps,
      (bytes, img) => ok(media(existing, bytes, img.mime, img.width, img.height, 'subsquare-cid'), 'pinned-cid'), failed)
    if (pinned) return pinned
    // Not reachable over IPFS: fall through to the guarded HTTPS fetch.
  }
  let bytes: Uint8Array
  try {
    const fetchIt = () => safeFetch(url, deps.fetchOptions)
    bytes = (await (deps.throttle && isSubsquareHost(url) ? deps.throttle(fetchIt) : fetchIt())).bytes
  } catch (err) {
    const reason = err instanceof SafeFetchError ? `fetch:${err.reason}` : 'fetch:error'
    if (TAKEDOWN_STATUSES.has(reason)) return failed(reason)
    return (await fromArchive(url, existing, deps, ok, failed)) ?? failed(reason)
  }
  let img
  try { img = sanitizeImage(bytes) } catch (err) { return failed(err instanceof ImageError ? `image:${err.reason}` : 'image:error') }
  let cid: string | 'removed'
  try { cid = await addChecked(img.bytes, deps) } catch (err) { if (err instanceof Deferred) throw err; return failed('ipfs-add') }
  if (cid === 'removed') return failed('removed')
  return ok(media(cid, img.bytes, img.mime, img.width, img.height, 'subsquare-rehost'), 'rehosted')

  function media(cid: string, bytes: Uint8Array, mime: string, width: number, height: number, origin: string): MediaRow {
    return {
      cid, mime, bytes: bytes.length, width, height, sha256: sha256Hex(bytes), uploader_account_id: '', origin,
      original_url: url, deleted: 0, created_at: now, updated_at: now,
    }
  }
}

/**
 * The archive's capture of `url`, re-hosted; null when the archive has none (or is
 * not configured), so the caller reports the direct fetch's failure. A capture of an
 * IPFS URL must reproduce its CID and is pinned under it; any other is stripped and
 * added like a direct fetch.
 */
async function fromArchive(
  url: string, cid: string | null, deps: RehostDeps,
  ok: (media: MediaRow, kind: Stored) => RehostResult, failed: (reason: string) => RehostResult,
): Promise<RehostResult | null> {
  if (!deps.archiveThrottle) return null
  let bytes: Uint8Array
  try {
    bytes = (await deps.archiveThrottle(() => safeFetch(archiveUrl(url), { ...deps.fetchOptions, timeoutMs: ARCHIVE_TIMEOUT_MS }))).bytes
  } catch { return null }
  const now = ts(deps.now())
  const row = (c: string, b: Uint8Array, img: { mime: string; width: number; height: number }, origin: string): MediaRow => ({
    cid: c, mime: img.mime, bytes: b.length, width: img.width, height: img.height, sha256: sha256Hex(b), uploader_account_id: '', origin,
    original_url: url, deleted: 0, created_at: now, updated_at: now,
  })
  if (cid) {
    let img
    try { img = sanitizeImage(bytes, { strip: false }) } catch (err) { return failed(err instanceof ImageError ? `archive:image:${err.reason}` : 'archive:image:error') }
    try {
      const params = await reproducingParams(deps.kubo, cid, bytes)
      if (!params || params === 'unsupported') return failed('archive:cid-mismatch')
      const added = await addChecked(bytes, deps, params)
      if (added === 'removed') return failed('removed')
      if (added !== cid) { deps.onGarbage?.(); return failed('archive:cid-mismatch') }
    } catch (err) { if (err instanceof Deferred) throw err; return failed('archive:ipfs') }
    return ok(row(cid, bytes, img, 'wayback-cid'), 'archived')
  }
  let img
  try { img = sanitizeImage(bytes) } catch (err) { return failed(err instanceof ImageError ? `archive:image:${err.reason}` : 'archive:image:error') }
  let added: string | 'removed'
  try { added = await addChecked(img.bytes, deps) } catch (err) { if (err instanceof Deferred) throw err; return failed('ipfs-add') }
  if (added === 'removed') return failed('removed')
  return ok(row(added, img.bytes, img, 'wayback'), 'archived')
}
