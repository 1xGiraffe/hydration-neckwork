// Single-flight TTL cache.
//
// This is the core mechanism that keeps ClickHouse load O(1) in the number of
// connected clients for the live Explorer feeds: N browsers polling the same
// endpoint inside a TTL window collapse to a single DB query. Concurrent misses
// for the same key share one in-flight promise (no thundering herd), and the
// resolved value is served for `ttlMs`.
interface Entry<T> { value: T; expiresAt: number; freshUntil?: number; lastAccessedAt: number; generation?: number }

const store = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()
// Per-key write epochs (cacheInstall). Every load takes the sequence's value when it
// starts; an install raises its key's epoch past every load already running, so a load
// that started before the install and resolves after it is returned to its caller but
// never written over the installed value. Recorded only while a load is in flight on the
// key (no other load can predate the install), and dropped when that load settles.
let writeSequence = 0
const installEpochs = new Map<string, number>()
let accessSequence = 0
const maxEntries = (() => {
  const parsed = Number(process.env.API_CACHE_MAX_ENTRIES?.trim() || '5000')
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 5000
})()

/* ---------------- hit/miss counters ---------------- */

// What every cache read did, counted per key FAMILY — the key's first one or two
// colon-separated segments while they are plain words (`explorer:activity`,
// `pair-volume:tail`), never a segment carrying an id, a block or an address, so
// the logged names stay a short, fixed vocabulary and nothing a key was built from
// reaches the log. `hit` is a value served inside its TTL (or fresh window), `stale`
// one served past its fresh window while it revalidates, `join` a reader that
// shared another's in-flight load, `miss` a load this read started, `error` a load
// that threw. Plain integer increments on paths that already do a Map lookup, so
// they cost nothing measurable; the totals since the last line are logged every
// API_CACHE_STATS_MS (default five minutes, 0 turns the line off).
type CacheOutcome = 'hit' | 'stale' | 'join' | 'miss' | 'error'
type FamilyCounts = Record<CacheOutcome, number>
const familyCounts = new Map<string, FamilyCounts>()
// Bound on distinct families kept per window; anything past it is counted as `other`.
const MAX_FAMILIES = 400
const FAMILY_SEGMENT = /^[a-z][a-z0-9-]{0,39}$/
const statsIntervalMs = (() => {
  const parsed = Number(process.env.API_CACHE_STATS_MS?.trim() || '300000')
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300_000
})()
let statsTimer: ReturnType<typeof setInterval> | null = null
let statsWindowStart = Date.now()

/** The logged name of a key's family (see the counters above). */
export function cacheKeyFamily(key: string): string {
  const [first, second] = key.split(':', 3)
  const word = (s: string | undefined) => s != null && FAMILY_SEGMENT.test(s) && !/\d{3}/.test(s)
  if (!word(first)) return '?'
  return word(second) ? `${first}:${second}` : first!
}

function count(key: string, outcome: CacheOutcome): void {
  let family = cacheKeyFamily(key)
  let counts = familyCounts.get(family)
  if (!counts) {
    if (familyCounts.size >= MAX_FAMILIES) family = 'other'
    counts = familyCounts.get(family)
    if (!counts) familyCounts.set(family, counts = { hit: 0, stale: 0, join: 0, miss: 0, error: 0 })
  }
  counts[outcome] += 1
  if (statsTimer == null && statsIntervalMs > 0 && !process.env.VITEST) {
    statsTimer = setInterval(logCacheStats, statsIntervalMs)
    statsTimer.unref?.()
  }
}

/** The counters since the last stats line (or reset), per family, plus the store's size. */
export function cacheStats(): { sinceMs: number; entries: number; inflight: number; families: Record<string, FamilyCounts> } {
  return {
    sinceMs: Date.now() - statsWindowStart,
    entries: store.size,
    inflight: inflight.size,
    families: Object.fromEntries([...familyCounts].map(([family, counts]) => [family, { ...counts }])),
  }
}

// One line per window, busiest families first, then the window starts over — so a
// hit ratio is read straight off one line rather than differenced across two.
function logCacheStats(): void {
  const stats = cacheStats()
  familyCounts.clear()
  statsWindowStart = Date.now()
  const total = (c: FamilyCounts) => c.hit + c.stale + c.join + c.miss + c.error
  const families = Object.entries(stats.families).filter(([, c]) => total(c) > 0).sort((a, b) => total(b[1]) - total(a[1]))
  if (!families.length) return
  console.log(`[cache] stats ${JSON.stringify({ windowSec: Math.round(stats.sinceMs / 1000), entries: stats.entries, inflight: stats.inflight, families: Object.fromEntries(families) })}`)
}

function assertDuration(name: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError(`${name} must be a finite, non-negative duration`)
  }
}

function nextAccess(): number {
  accessSequence += 1
  return accessSequence
}

// Map insertion order IS access order: every hit re-inserts its key, so the
// first entry is always the least recently used and eviction is a single
// `keys().next()` rather than a linear min-scan per evicted entry.
function touch(key: string, entry: Entry<unknown>): void {
  entry.lastAccessedAt = nextAccess()
  store.delete(key)
  store.set(key, entry)
}

// How often the expired-entry sweep is allowed to run. It is O(store.size), and
// running it on the tail of EVERY resolved miss cost a full pass over as many as
// API_CACHE_MAX_ENTRIES entries per miss — for entries that expire on their own
// schedule whether or not they are swept. The cap below is still enforced on
// every call, so the sweep's cadence bounds memory nowhere.
const SWEEP_INTERVAL_MS = 1_000
let lastSweepAt = 0

function prune(now: number): void {
  if (now - lastSweepAt >= SWEEP_INTERVAL_MS || store.size > maxEntries) {
    lastSweepAt = now
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) store.delete(key)
    }
  }

  while (store.size > maxEntries) {
    const oldest = store.keys().next()
    if (oldest.done) return
    store.delete(oldest.value)
  }
}

function loadAndCache<T>(key: string, freshMs: number | undefined, staleMs: number, fn: () => Promise<T>, generation?: number, keepIf?: (value: T) => boolean): Promise<T> {
  const startEpoch = writeSequence
  const pending = (async () => {
    try {
      let value: T
      try {
        value = await fn()
      } catch (error) {
        count(key, 'error')
        throw error
      }
      const resolvedAt = Date.now()
      // An install landed while this load ran: its value is the newer one (see installEpochs).
      const superseded = (installEpochs.get(key) ?? -1) > startEpoch
      if (!superseded && (keepIf == null || keepIf(value))) {
        store.set(key, {
          value,
          ...(freshMs == null ? {} : { freshUntil: resolvedAt + freshMs }),
          ...(generation == null ? {} : { generation }),
          expiresAt: resolvedAt + staleMs,
          lastAccessedAt: nextAccess(),
        })
        prune(resolvedAt)
      }
      return value
    } finally {
      // At most one load per key is in flight (every caller checks first), so this
      // load's end is also the end of the epoch it alone could have violated.
      inflight.delete(key)
      installEpochs.delete(key)
    }
  })()
  inflight.set(key, pending)
  return pending
}

// Test-only: a fresh app under test must not see the previous test's entries.
export function resetCacheForTests(): void {
  store.clear()
  inflight.clear()
  installEpochs.clear()
  familyCounts.clear()
  writeSequence = 0
  lastSweepAt = 0
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  assertDuration('ttlMs', ttlMs)
  const now = Date.now()
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && hit.expiresAt > now) {
    touch(key, hit)
    count(key, 'hit')
    return hit.value
  }
  if (hit) store.delete(key)

  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) {
    count(key, 'join')
    return pending
  }

  count(key, 'miss')
  return loadAndCache(key, undefined, ttlMs, fn)
}

/**
 * `cached`, except a NEGATIVE answer is never stored.
 *
 * Every lookup addressed by block coordinates or an extrinsic hash can be asked
 * for something that exists on chain but has not reached ClickHouse yet:
 * `raw-live` follows the FINALIZED head (see `src/raw/flushPolicy.ts`), so a
 * just-made action is ~46s of finality plus under a second of indexing from
 * being readable (measured 2026-10-03; finality lands in bursts every ~8s).
 * Caching that miss makes the 404 outlive the wait — measured on
 * `/explorer/trade`, the rows landed 6s into
 * a probe and the endpoint kept answering 404 for the remaining 54s of its 60s
 * TTL, i.e. the cache, not finality, was most of what the user waited for.
 * A miss here is one primary-key point read, so re-running it beats serving a
 * "not found" that has already stopped being true.
 *
 * Negative means null/undefined or an empty array; `isFound` overrides that for
 * a payload whose emptiness lives in a field.
 */
export async function cachedFound<T>(key: string, ttlMs: number, fn: () => Promise<T>, isFound: (value: T) => boolean = isNonEmpty): Promise<T> {
  assertDuration('ttlMs', ttlMs)
  const now = Date.now()
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && hit.expiresAt > now) {
    touch(key, hit)
    count(key, 'hit')
    return hit.value
  }
  if (hit) store.delete(key)

  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) {
    count(key, 'join')
    return pending
  }

  count(key, 'miss')
  return loadAndCache(key, undefined, ttlMs, fn, undefined, isFound)
}

function isNonEmpty(value: unknown): boolean {
  if (value == null) return false
  return Array.isArray(value) ? value.length > 0 : true
}

// Stale-while-revalidate variant for results that are expensive to compute but
// tolerate minutes-old data (whole-directory rankings). Within `freshMs` it
// behaves like cached(); between `freshMs` and `staleMs` it returns the stale
// value IMMEDIATELY and refreshes once in the background (single-flight), so
// no request ever waits on the recompute except a truly cold first hit. A
// failed background refresh keeps serving the stale value until `staleMs`.
//
// `generation` names the data generation the value was computed against (for
// the account directory: the account-value generation, which advances every
// five minutes). When it advances the entry becomes STALE, not absent — the
// previous generation's value keeps being served while the new one computes.
// Putting the generation in the KEY instead would make the entry absent, which
// defeats stale-while-revalidate by construction: there is no previous value to
// find, so every generation change costs a cold, blocking recompute. Each
// cached value is one whole generation, so serving the previous one is
// internally consistent; it is never merged with the new one.
export async function cachedSwr<T>(key: string, freshMs: number, staleMs: number, fn: () => Promise<T>, generation?: number): Promise<T> {
  assertDuration('freshMs', freshMs)
  assertDuration('staleMs', staleMs)
  if (staleMs < freshMs) throw new RangeError('staleMs must be greater than or equal to freshMs')
  const now = Date.now()
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && hit.expiresAt > now) {
    touch(key, hit)
    const superseded = generation != null && hit.generation !== generation
    const stale = superseded || (hit.freshUntil ?? hit.expiresAt) <= now
    count(key, stale ? 'stale' : 'hit')
    if (stale && !inflight.has(key)) {
      loadAndCache(key, freshMs, staleMs, fn, generation).catch(err => {
        // The stale entry stays valid until staleMs; say so, or a failing recompute
        // keeps serving an old value for hours with nothing in the log.
        console.warn(`[cache] background refresh of ${key} failed; serving the stale value`, err instanceof Error ? err.message : err)
      })
    }
    return hit.value
  }
  if (hit) store.delete(key)

  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) {
    count(key, 'join')
    return pending
  }

  count(key, 'miss')
  return loadAndCache(key, freshMs, staleMs, fn, generation)
}

// Recompute a key now and install the result, for a background pass that OWNS
// the refresh of that key. Unlike cachedSwr it is never satisfied by the value
// it exists to replace, and unlike a bare call it shares cachedSwr's
// single-flight, so a prewarm pass and a reader's background revalidation of the
// same key collapse into one computation instead of racing.
export function cacheRefresh<T>(key: string, freshMs: number, staleMs: number, fn: () => Promise<T>, generation?: number): Promise<T> {
  assertDuration('freshMs', freshMs)
  assertDuration('staleMs', staleMs)
  if (staleMs < freshMs) throw new RangeError('staleMs must be greater than or equal to freshMs')
  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending
  return loadAndCache(key, freshMs, staleMs, fn, generation)
}

// Install a value a background pass has just computed itself, replacing whatever the
// key held. For an owner that must bypass the cache to get a FRESH answer (a sweep
// recount that a key-stable entry would otherwise satisfy with the value it exists to
// replace) and then hand that answer to the readers of the same key. `freshMs` omitted
// stores a plain TTL entry (cached/cachedFound); given, a cachedSwr entry fresh for
// that long, carrying `generation`. A reader's load already in flight on the key keeps
// its single flight and still answers its own callers, but it started before this install
// and must not overwrite it when it resolves (installEpochs): it may have read the very
// state the installed value was computed to replace.
export function cacheInstall<T>(key: string, value: T, staleMs: number, freshMs?: number, generation?: number): void {
  assertDuration('staleMs', staleMs)
  if (freshMs != null) {
    assertDuration('freshMs', freshMs)
    if (staleMs < freshMs) throw new RangeError('staleMs must be greater than or equal to freshMs')
  }
  if (inflight.has(key)) installEpochs.set(key, ++writeSequence)
  const at = Date.now()
  store.delete(key)
  store.set(key, {
    value,
    ...(freshMs == null ? {} : { freshUntil: at + freshMs }),
    ...(generation == null ? {} : { generation }),
    expiresAt: at + staleMs,
    lastAccessedAt: nextAccess(),
  })
  prune(at)
}

// Adopt an already-computed value — a page persisted to ClickHouse by an earlier
// process — as a key's STALE value. It is never treated as fresh, so the first
// reader serves it immediately and starts the refresh that replaces it, instead
// of blocking on a cold recompute. `load` runs only when the key holds nothing,
// so a warm cache pays nothing for it, and it may not outlive the freshness the
// persisted value already declares (`staleMs` is the remainder of that budget).
export async function seedStale<T>(key: string, load: () => Promise<{ value: T; staleMs: number } | null>): Promise<boolean> {
  if (occupied(key, Date.now())) return false
  const seed = await load()
  if (!seed || !Number.isFinite(seed.staleMs) || seed.staleMs <= 0) return false
  const at = Date.now()
  // Re-check: the load above is a round trip, and a reader may have filled the
  // key meanwhile. A live entry is never older than a persisted one.
  if (occupied(key, at)) return false
  store.set(key, { value: seed.value, freshUntil: at, expiresAt: at + seed.staleMs, lastAccessedAt: nextAccess() })
  prune(at)
  return true
}

// When the value under `key` stops being servable, or null when nothing is stored (an
// in-flight computation counts as landing now, since it is about to install one).
//
// For a background pass that owns a key: it decides whether an entry will still be there
// at the next cycle, so a pass on a short interval does not turn a long-lived entry into
// a re-read per cycle. Reading the cache's own expiry rather than keeping a second copy of
// it is what keeps the pass and the readers — whose stale-while-revalidate refreshes also
// move it — from disagreeing about how old the value is.
export function cacheExpiry(key: string): number | null {
  const now = Date.now()
  if (inflight.has(key)) return now
  const hit = store.get(key)
  return hit != null && hit.expiresAt > now ? hit.expiresAt : null
}

function occupied(key: string, now: number): boolean {
  if (inflight.has(key)) return true
  const hit = store.get(key)
  return hit != null && hit.expiresAt > now
}

/**
 * The value a key holds right now (fresh or stale, not yet expired), without
 * loading, touching or refreshing it. For a page builder that reuses an
 * expensive per-row value only when someone already computed it.
 */
export function peekCached<T>(key: string): T | undefined {
  const hit = store.get(key) as Entry<T> | undefined
  return hit != null && hit.expiresAt > Date.now() ? hit.value : undefined
}
