// Single-flight TTL cache.
//
// This is the core mechanism that keeps ClickHouse load O(1) in the number of
// connected clients for the live Explorer feeds: N browsers polling the same
// endpoint inside a TTL window collapse to a single DB query. Concurrent misses
// for the same key share one in-flight promise (no thundering herd), and the
// resolved value is served for `ttlMs`.
interface Entry<T> { value: T; expiresAt: number; freshUntil?: number; lastAccessedAt: number }

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

function loadAndCache<T>(key: string, freshMs: number | undefined, staleMs: number, fn: () => Promise<T>): Promise<T> {
  const pending = (async () => {
    try {
      const value = await fn()
      const resolvedAt = Date.now()
      store.set(key, {
        value,
        ...(freshMs == null ? {} : { freshUntil: resolvedAt + freshMs }),
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
export async function cachedSwr<T>(key: string, freshMs: number, staleMs: number, fn: () => Promise<T>): Promise<T> {
  assertDuration('freshMs', freshMs)
  assertDuration('staleMs', staleMs)
  if (staleMs < freshMs) throw new RangeError('staleMs must be greater than or equal to freshMs')
  const now = Date.now()
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && hit.expiresAt > now) {
    hit.lastAccessedAt = nextAccess()
    if ((hit.freshUntil ?? hit.expiresAt) <= now && !inflight.has(key)) {
      loadAndCache(key, freshMs, staleMs, fn).catch(() => { /* stale entry stays valid until staleMs */ })
    }
    return hit.value
  }
  if (hit) store.delete(key)

  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending

  return loadAndCache(key, freshMs, staleMs, fn)
}
