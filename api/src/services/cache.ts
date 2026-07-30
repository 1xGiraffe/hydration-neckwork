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
let accessSequence = 0
const maxEntries = (() => {
  const parsed = Number(process.env.API_CACHE_MAX_ENTRIES?.trim() || '5000')
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 5000
})()

function assertDuration(name: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError(`${name} must be a finite, non-negative duration`)
  }
}

function nextAccess(): number {
  accessSequence += 1
  return accessSequence
}

function prune(now: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key)
  }

  while (store.size > maxEntries) {
    let oldestKey: string | null = null
    let oldestAccess = Infinity
    for (const [key, entry] of store) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt
        oldestKey = key
      }
    }
    if (oldestKey == null) return
    store.delete(oldestKey)
  }
}

function loadAndCache<T>(key: string, freshMs: number | undefined, staleMs: number, fn: () => Promise<T>, generation?: number): Promise<T> {
  const pending = (async () => {
    try {
      const value = await fn()
      const resolvedAt = Date.now()
      store.set(key, {
        value,
        ...(freshMs == null ? {} : { freshUntil: resolvedAt + freshMs }),
        ...(generation == null ? {} : { generation }),
        expiresAt: resolvedAt + staleMs,
        lastAccessedAt: nextAccess(),
      })
      prune(resolvedAt)
      return value
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, pending)
  return pending
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  assertDuration('ttlMs', ttlMs)
  const now = Date.now()
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && hit.expiresAt > now) {
    hit.lastAccessedAt = nextAccess()
    return hit.value
  }
  if (hit) store.delete(key)

  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending

  return loadAndCache(key, undefined, ttlMs, fn)
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
    hit.lastAccessedAt = nextAccess()
    const superseded = generation != null && hit.generation !== generation
    if ((superseded || (hit.freshUntil ?? hit.expiresAt) <= now) && !inflight.has(key)) {
      loadAndCache(key, freshMs, staleMs, fn, generation).catch(() => { /* stale entry stays valid until staleMs */ })
    }
    return hit.value
  }
  if (hit) store.delete(key)

  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending

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
