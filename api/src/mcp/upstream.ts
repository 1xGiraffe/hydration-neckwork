// The only way out of this process. Every tool reads the explorer api through
// this client: one place to enforce the path allow-list, the concurrency bound,
// the timeout budget and the response cache.

// The explorer api's public read surface, by prefix. `/user/` is the private
// half of that api — notification channels, lists, API tokens, sessions, the
// `user_*` tables — and it is unreachable from here BY CONSTRUCTION rather than
// by convention: isAllowedUpstreamPath refuses the path before a socket opens,
// so no tool, present or future, can address private user data even by mistake.
// api/tests/mcp/upstreamPaths.test.ts pins both halves of that rule.
export const ALLOWED_UPSTREAM_PREFIXES: readonly string[] = ['/explorer/', '/candles', '/assets', '/market-stats', '/health']

// Percent-encoding can hide a traversal or the private prefix behind another
// layer of escapes, so the guard checks every form the path can decode to, not
// only its first. Three rounds is past anything a real explorer path needs (a
// tag name is encoded once), and a later round that throws means the text has
// stopped being an escape sequence rather than that it hides one — a literal
// `%` in a tag name decodes once and then fails, and must still be reachable.
function decodedForms(pathname: string): string[] | null {
  const forms = [pathname]
  for (let round = 0; round < 3; round += 1) {
    let next: string
    try {
      next = decodeURIComponent(forms[forms.length - 1])
    } catch {
      // A malformed escape in the path as WRITTEN is refused rather than
      // guessed at; one that appears only after a decode is plain text.
      if (round === 0) return null
      break
    }
    if (next === forms[forms.length - 1]) break
    forms.push(next)
  }
  return forms
}

export function isAllowedUpstreamPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false
  // A path must be origin-relative. `http://…` and a bare `explorer/x` both fail
  // here; `//host/x` is a protocol-relative URL, which fetch would resolve
  // against another origin entirely.
  if (!path.startsWith('/') || path.startsWith('//')) return false
  if (path.includes('\\')) return false
  const pathname = path.split(/[?#]/, 1)[0]
  const forms = decodedForms(pathname)
  if (!forms) return false
  for (const form of forms) {
    if (form.includes('\\')) return false
    if (form.includes('//') || form.split('/').includes('..') || form.split('/').includes('.')) return false
    if (form.toLowerCase().includes('/user/') || form.toLowerCase().endsWith('/user')) return false
  }
  // The prefix is judged on the path as the upstream will read it: decoded
  // once, which is what an HTTP server does to a request target.
  const decoded = forms[1] ?? forms[0]
  return ALLOWED_UPSTREAM_PREFIXES.some(prefix => (
    prefix.endsWith('/')
      ? decoded.startsWith(prefix)
      : decoded === prefix || decoded.startsWith(`${prefix}/`)
  ))
}

// Which lane a call runs in. `cheap` is the reserved lane: a read that answers
// in milliseconds off the explorer's warm caches and must not queue behind the
// heavy ones, because an agent asking "is the chain live?" gets no value from
// an answer that arrives a minute late. Everything else is `standard` and
// shares the larger, sheddable pool.
export type UpstreamCost = 'cheap' | 'standard'

// The reserved lane is opt-in by path and deliberately short: a route earns a
// place only once it is known to answer off a warm in-process cache. An unknown
// route is `standard`, so a new heavy call can never take a cheap slot by
// default. A tool overrides per call with `cost` where it knows better.
//
// The lane is a claim about speed, not a privilege: a cheap call still counts
// against the total bound, so a route listed here that stopped being fast would
// crowd out the standard lane instead of the other way round. That is the
// reason the list stays short and is checked against measurement.
const CHEAP_UPSTREAM_PATHS: readonly string[] = ['/health', '/explorer/stats', '/explorer/counts', '/explorer/blocks']

export function upstreamCostOf(path: string): UpstreamCost {
  const pathname = path.split(/[?#]/, 1)[0]
  return CHEAP_UPSTREAM_PATHS.includes(pathname) ? 'cheap' : 'standard'
}

export interface UpstreamGetOptions {
  // Per-call override of the response cache TTL; 0 disables caching for the call.
  ttlMs?: number
  timeoutMs?: number
  // Which concurrency lane the call runs in. Defaults to the path's own
  // classification (upstreamCostOf); pass 'cheap' only for a read that is
  // genuinely milliseconds warm, since the reserved lane is what keeps a
  // status read answerable while heavy work is in flight.
  cost?: UpstreamCost
}

export interface UpstreamClient {
  get<T = unknown>(
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
    opts?: UpstreamGetOptions,
  ): Promise<T>
}

// Just enough of a fastify logger to record what must not reach the client.
export interface UpstreamLogger {
  warn(details: Record<string, unknown>, message: string): void
}

const consoleLogger: UpstreamLogger = {
  warn: (details, message) => { console.warn(message, details) },
}

// A non-2xx answer, a non-JSON body, or a transport failure. `status: 0` is the
// network/timeout case — there was no HTTP answer at all.
export class UpstreamError extends Error {
  readonly status: number
  readonly body: unknown
  readonly path: string
  // The upstream's own machine-readable refusal code when it sent one
  // (fastify serializes a thrown error's `code` into the body), so a mapper can
  // tell "narrow your query" from "the service is down" without matching prose.
  readonly upstreamCode?: string
  // Copied off the explorer's describeLookupMiss body when it is present, so a
  // tool can tell "the block is not indexed yet, retry" (blockIndexed false)
  // from "the block is there and holds no such row" (blockIndexed true).
  readonly blockIndexed?: boolean
  readonly headBound?: number

  constructor(message: string, status: number, body: unknown, path: string) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.body = body
    this.path = path
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>
      if (typeof record.code === 'string') this.upstreamCode = record.code
      if (typeof record.blockIndexed === 'boolean') this.blockIndexed = record.blockIndexed
      if (typeof record.headBound === 'number') this.headBound = record.headBound
    }
  }

  get notFound(): boolean {
    return this.status === 404
  }
}

/**
 * The call never reached the explorer api: this process is already running its
 * bound of upstream work and shed the request instead of queuing it behind a
 * minute of someone else's.
 *
 * It is a distinct type because the advice differs from every other failure —
 * the upstream is healthy, the caller is early, and a retry in a few seconds is
 * the right move.
 */
export class UpstreamBusyError extends UpstreamError {
  readonly waitedMs: number

  constructor(message: string, path: string, waitedMs: number) {
    super(message, 0, null, path)
    this.name = 'UpstreamBusyError'
    this.waitedMs = waitedMs
  }
}

/**
 * The path guard refused before a socket opened.
 *
 * The message is deliberately generic and carries neither the path nor the
 * allow-list: an anonymous caller that can probe the guard with arbitrary input
 * must not learn the internal route map from the refusal, and "there is a
 * `/user/` surface" is exactly what it would otherwise confirm. The detail goes
 * to the server log at the refusal site.
 */
export class UpstreamPathRefused extends Error {
  readonly path: string

  constructor(path: string) {
    super('the identifier does not address a readable Hydration explorer resource')
    this.name = 'UpstreamPathRefused'
    this.path = path
  }
}

export interface CreateUpstreamClientOptions {
  // Origin of the explorer api, without a trailing slash.
  baseUrl: string
  timeoutMs?: number
  maxConcurrency?: number
  // How long a call may wait for a permit before it is shed as busy. Separate
  // from timeoutMs on purpose: the fetch budget is sized for a cold explorer
  // read, and a caller must not spend it standing in a queue.
  queueTimeoutMs?: number
  // How many calls may wait at once. Past this the client sheds immediately,
  // so a burst cannot grow an unbounded array of pending promises.
  maxQueueDepth?: number
  // Permits reserved for the cheap lane, taken out of maxConcurrency.
  cheapLaneSlots?: number
  defaultTtlMs?: number
  maxCacheEntries?: number
  // A second bound on the same cache, in bytes of raw upstream response. The
  // count alone is not a memory bound: the dashboards and the pool index are
  // 70-280 KB each, so a few hundred entries of them is hundreds of megabytes.
  maxCacheBytes?: number
  userAgent?: string
  logger?: UpstreamLogger
  // Injectable for tests; the process always uses the global fetch.
  fetchImpl?: typeof fetch
}

// One upstream answer, with the size of the body it was decoded from. The size
// is carried rather than measured later because the raw text is only in hand
// inside fetchOnce, and re-serializing a 280 KB dashboard to weigh it would
// cost about as much as parsing it did.
interface Fetched {
  value: unknown
  bytes: number
}

interface CacheEntry {
  expiresAt: number
  value: unknown
  bytes: number
}

// A request other callers may join while it is still open, with the wall-clock
// time by which it has promised to settle.
interface InFlightRequest {
  promise: Promise<Fetched>
  deadline: number
}

// Bounded so a process that runs for weeks cannot grow a cache entry per
// distinct URL an agent ever asked for.
const DEFAULT_MAX_CACHE_ENTRIES = 500
// And bounded in bytes, because the entries are not the same size. An agent
// paging the global feed, or walking the six dashboards over a few ranges,
// reaches hundreds of distinct URLs of 70-280 KB each inside one TTL; a
// count-only bound would let that park several hundred megabytes of parsed
// JSON in a process that has no container memory limit.
const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024
const DEFAULT_QUEUE_TIMEOUT_MS = 5_000
const DEFAULT_MAX_QUEUE_DEPTH = 64
const DEFAULT_CHEAP_LANE_SLOTS = 2

// A path that carries its own `?` or `#` — a path parameter a call site handed
// on unencoded — must not be allowed to change the request that call site
// wrote. Concatenated naively, a fragment swallows the whole query string
// (`/explorer/tag/treasury#x` + `{summary: 1}` goes out as
// `/explorer/tag/treasury`, dropping the `summary=1` that is the difference
// between a 56 KB read and a 1.5 MB one on the shared explorer api) and a
// second `?` buries the caller's query inside the first one's value. Split the
// path once, merge the two halves and drop the fragment — which no HTTP request
// target carries anyway — so the request is the one the caller meant and the
// cache key is canonical.
function splitPath(path: string): { pathname: string; inlineQuery: string } {
  const withoutFragment = path.split('#', 1)[0]
  const at = withoutFragment.indexOf('?')
  return at < 0
    ? { pathname: withoutFragment, inlineQuery: '' }
    : { pathname: withoutFragment.slice(0, at), inlineQuery: withoutFragment.slice(at + 1) }
}

function buildQuery(inlineQuery: string, query: Record<string, string | number | boolean | null | undefined> | undefined): string {
  const params = new URLSearchParams(inlineQuery)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue
    const text = String(value)
    // An empty value means "unfiltered" upstream, and sending it would only
    // fragment the cache key.
    if (text === '') continue
    // `set`, not `append`: the explicit argument wins over anything the path
    // brought with it.
    params.set(key, text)
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

// Fastify serializes a thrown error as `{statusCode, code, error, message}`,
// where `error` is only the status text ("Service Unavailable") and `message`
// carries what the caller can act on. A hand-written route sends `{error: "…"}`
// with the sentence in `error`. Read both shapes, most specific first.
function upstreamMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.trim()) return record.message
    if (typeof record.error === 'string' && record.error.trim()) return record.error
  }
  return `upstream responded ${status}`
}

export function createUpstreamClient(opts: CreateUpstreamClientOptions): UpstreamClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const timeoutMs = opts.timeoutMs ?? 60_000
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 6)
  const queueTimeoutMs = Math.max(1, opts.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS)
  const maxQueueDepth = Math.max(1, opts.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH)
  // At least one permit stays available to the standard lane, however the two
  // knobs are configured.
  const cheapLaneSlots = Math.min(Math.max(0, opts.cheapLaneSlots ?? DEFAULT_CHEAP_LANE_SLOTS), maxConcurrency - 1)
  const standardLimit = maxConcurrency - cheapLaneSlots
  const defaultTtlMs = opts.defaultTtlMs ?? 10_000
  const maxCacheEntries = Math.max(1, opts.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES)
  const maxCacheBytes = Math.max(1, opts.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES)
  const userAgent = opts.userAgent ?? 'hydration-mcp'
  const logger = opts.logger ?? consoleLogger
  const doFetch = opts.fetchImpl ?? fetch

  const cache = new Map<string, CacheEntry>()
  let cachedBytes = 0
  // Single-flight: concurrent identical URLs share one upstream request. An
  // agent that fans out over the same account from several tools costs the
  // explorer one read, not four.
  const inFlight = new Map<string, InFlightRequest>()

  // The explorer api is unthrottled and has no per-caller isolation, so an
  // agent burst would otherwise contend directly with the live UI for the same
  // event loop and ClickHouse budget. Three properties hold together here:
  //
  // - **Two lanes.** `cheapLaneSlots` of the permits are reachable only by the
  //   cheap lane, so a "is the chain live?" read answers in milliseconds while
  //   the standard lane is saturated. Without it, six 50-second calls make
  //   every other caller wait for one of them — measured at 57.6s on the live
  //   deployment for a read that costs 2ms idle.
  // - **A bounded wait.** A queued call waits at most `queueTimeoutMs` (never
  //   longer than its own fetch budget) and is then shed as busy. The fetch
  //   timeout is not an answer-time bound on its own, because the queue wait
  //   comes before it; this is what bounds the total. A caller that joins an
  //   identical request already in flight is held to its own budget too
  //   (withDeadline), so the de-duplication cannot smuggle someone else's
  //   minute past it.
  // - **A bounded queue.** Past `maxQueueDepth` waiting calls the client sheds
  //   immediately rather than growing an unbounded array under a burst.
  //
  // Shedding is deliberately preferred to widening: a measured burst of 30
  // concurrent reads moved the live Explorer's own activity p50 from 338ms to
  // 2,278ms, so letting more agent work through is worse than refusing it.
  let active = 0
  let activeStandard = 0

  interface Waiter {
    lane: UpstreamCost
    admit: () => void
    timer: ReturnType<typeof setTimeout>
  }
  const waiters: Waiter[] = []

  function canAdmit(lane: UpstreamCost): boolean {
    if (active >= maxConcurrency) return false
    return lane === 'cheap' || activeStandard < standardLimit
  }

  function take(lane: UpstreamCost): void {
    active += 1
    if (lane === 'standard') activeStandard += 1
  }

  function busy(path: string, waitedMs: number, reason: 'queue full' | 'queue wait'): UpstreamBusyError {
    return new UpstreamBusyError(
      reason === 'queue full'
        ? `upstream request shed: ${waiters.length} calls are already waiting for one of this server's ${maxConcurrency} upstream slots`
        : `upstream request shed after waiting ${waitedMs}ms for one of this server's ${maxConcurrency} upstream slots`,
      path,
      waitedMs,
    )
  }

  async function acquire(lane: UpstreamCost, path: string, waitMs: number): Promise<void> {
    if (canAdmit(lane)) {
      take(lane)
      return
    }
    if (waiters.length >= maxQueueDepth) throw busy(path, 0, 'queue full')
    const queuedAt = Date.now()
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        lane,
        admit: resolve,
        timer: setTimeout(() => {
          const at = waiters.indexOf(waiter)
          if (at >= 0) waiters.splice(at, 1)
          reject(busy(path, Date.now() - queuedAt, 'queue wait'))
        }, waitMs),
      }
      waiters.push(waiter)
    })
  }

  function release(lane: UpstreamCost): void {
    active -= 1
    if (lane === 'standard') activeStandard -= 1
    // FIFO, except that a freed permit skips a waiter it cannot serve: with the
    // standard lane full, a freed slot goes to the next cheap waiter rather
    // than stalling behind a standard one it could not admit anyway. One permit
    // was freed, so at most one waiter can start.
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i]
      if (!canAdmit(waiter.lane)) continue
      waiters.splice(i, 1)
      clearTimeout(waiter.timer)
      take(waiter.lane)
      waiter.admit()
      return
    }
  }

  function evict(url: string): void {
    const entry = cache.get(url)
    if (!entry) return
    cache.delete(url)
    cachedBytes -= entry.bytes
  }

  function readCache(url: string): CacheEntry | undefined {
    const entry = cache.get(url)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      evict(url)
      return undefined
    }
    return entry
  }

  function writeCache(url: string, fetched: Fetched, ttlMs: number): void {
    if (ttlMs <= 0) return
    // Delete first so a refreshed entry moves to the back of the insertion
    // order; without it a hot URL keeps the age of its first write and is
    // evicted ahead of colder ones.
    evict(url)
    cache.set(url, { expiresAt: Date.now() + ttlMs, value: fetched.value, bytes: fetched.bytes })
    cachedBytes += fetched.bytes
    // Map iterates in insertion order, so the first key is the oldest write.
    // Bounded on both axes: an answer that is on its own larger than the byte
    // budget is written and then dropped again on the same pass, which is the
    // right outcome — one answer is never worth the whole cache.
    while (cache.size > 0 && (cache.size > maxCacheEntries || cachedBytes > maxCacheBytes)) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      evict(oldest.value)
    }
  }

  // Bounds the time a caller spends awaiting a request it did not start. The
  // single-flight join is free for the explorer but must not be free of the
  // caller's own deadline: without this, a read with a 400ms budget that joins
  // a 60s one waits the full minute, which is exactly the answer-time bound the
  // queue deadline exists to provide. The leader is left running for whoever
  // else is still waiting on it.
  function withDeadline(promise: Promise<Fetched>, budgetMs: number, path: string): Promise<Fetched> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new UpstreamError(`upstream request timed out after ${budgetMs}ms`, 0, null, path)),
        budgetMs,
      )
    })
    return Promise.race([promise, expiry]).finally(() => { if (timer) clearTimeout(timer) })
  }

  async function fetchOnce(path: string, url: string, budgetMs: number, lane: UpstreamCost): Promise<Fetched> {
    // The wait for a permit never eats the fetch budget, and never exceeds it
    // either: a caller that asked for a 400ms answer is shed at 400ms rather
    // than standing in a queue for seconds it said it did not have.
    await acquire(lane, path, Math.min(queueTimeoutMs, budgetMs))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budgetMs)
    try {
      let res: Response
      try {
        res = await doFetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': userAgent },
        })
      } catch (err) {
        const reason = controller.signal.aborted
          ? `upstream request timed out after ${budgetMs}ms`
          : `upstream request failed: ${err instanceof Error ? err.message : String(err)}`
        throw new UpstreamError(reason, 0, null, path)
      }

      const text = await res.text()
      let body: unknown = null
      if (text.length > 0) {
        try {
          body = JSON.parse(text)
        } catch {
          if (res.ok) throw new UpstreamError('upstream returned a non-JSON body', res.status, text.slice(0, 500), path)
          body = text.slice(0, 500)
        }
      }
      if (!res.ok) throw new UpstreamError(upstreamMessage(body, res.status), res.status, body, path)
      return { value: body, bytes: text.length }
    } finally {
      clearTimeout(timer)
      release(lane)
    }
  }

  return {
    async get<T = unknown>(
      path: string,
      query?: Record<string, string | number | boolean | null | undefined>,
      getOpts?: UpstreamGetOptions,
    ): Promise<T> {
      if (!isAllowedUpstreamPath(path)) {
        // The client sees only that the identifier was not addressable; the log
        // keeps what was actually asked for, which is the half an operator
        // needs and an anonymous caller must not be handed.
        logger.warn({ path }, '[mcp] refused an upstream path outside the allow-list')
        throw new UpstreamPathRefused(path)
      }
      const { pathname, inlineQuery } = splitPath(path)
      const url = `${baseUrl}${pathname}${buildQuery(inlineQuery, query)}`
      const ttlMs = getOpts?.ttlMs ?? defaultTtlMs
      const budgetMs = getOpts?.timeoutMs ?? timeoutMs
      const lane = getOpts?.cost ?? upstreamCostOf(path)

      const cached = readCache(url)
      if (cached) return cached.value as T

      const pending = inFlight.get(url)
      if (pending) {
        // Join the request already in flight — unless this caller's budget runs
        // out before that request has promised to settle, in which case it
        // waits only its own share and reports the timeout itself.
        return Date.now() + budgetMs >= pending.deadline
          ? (await pending.promise).value as T
          : (await withDeadline(pending.promise, budgetMs, path)).value as T
      }

      const request = fetchOnce(path, url, budgetMs, lane)
        // Only a successful response is cached; an error must be asked again,
        // because the failure is usually the state that is about to change.
        .then(fetched => {
          writeCache(url, fetched, ttlMs)
          return fetched
        })
        .finally(() => {
          inFlight.delete(url)
        })
      // The permit wait comes before the fetch budget, so the worst case a
      // joiner may be asked to wait out is the sum of the two.
      inFlight.set(url, { promise: request, deadline: Date.now() + Math.min(queueTimeoutMs, budgetMs) + budgetMs })
      return (await request).value as T
    },
  }
}
