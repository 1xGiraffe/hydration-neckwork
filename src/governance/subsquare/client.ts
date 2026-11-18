import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The polite Subsquare client. Subsquare's public API answers one request in ~0.5–1 s
// and slows EVERY request to ~6 s under three concurrent ones (measured 2026-11-07),
// so this keeps exactly one request in flight and starts at most `rps` per second,
// identifies itself with a generic User-Agent, backs off exponentially on 429/5xx
// (honouring Retry-After) and opens a circuit breaker after `breakerThreshold`
// consecutive failures, which aborts the cycle — the next cycle starts afresh.

export const USER_AGENT = 'hydration-neckwork-governance-sync'

/** No honest answer comes near this (a 100-item list page with full texts is a few MiB). */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** A response body as text, or null once it passes `maxBytes` (the stream is cancelled there, not read to its end). */
export async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return null }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * Every string in a parsed answer (keys included) made well-formed UTF-16: a lone
 * surrogate becomes U+FFFD. ClickHouse refuses a lone surrogate's JSON escape, and
 * one in a batch would fail the whole insert.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
/** String.prototype.toWellFormed (ES2024), spelled out for the compile target. */
export const toWellFormed = (s: string): string => s.replace(LONE_SURROGATE, '\uFFFD')

export function wellFormed(v: unknown): unknown {
  if (typeof v === 'string') return toWellFormed(v)
  if (Array.isArray(v)) return v.map(wellFormed)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, x] of Object.entries(v)) out[toWellFormed(k)] = wellFormed(x)
    return Object.setPrototypeOf(out, Object.prototype)
  }
  return v
}

export class CircuitOpenError extends Error {
  constructor(message: string) { super(message); this.name = 'CircuitOpenError' }
}

export interface FetchResult { status: number; body: unknown }

export interface ClientOptions {
  baseUrl: string
  rps?: number
  timeoutMs?: number
  maxRetries?: number
  breakerThreshold?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Response cache directory: 'write' records every 200/404, 'read' answers from it before the network. */
  cache?: { dir: string; mode: 'read' | 'write' | 'read-write' }
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Seconds (or an HTTP date) from a Retry-After header → ms, capped. */
export function retryAfterMs(header: string | null, now: number, capMs = 120_000): number | null {
  if (!header) return null
  const s = Number(header)
  if (Number.isFinite(s) && s >= 0) return Math.min(capMs, s * 1000)
  const t = Date.parse(header)
  return Number.isFinite(t) ? Math.min(capMs, Math.max(0, t - now)) : null
}

/** Exponential backoff: 2 s, 4 s, 8 s … capped at 60 s. */
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** attempt)
}

export class SubsquareClient {
  readonly baseUrl: string
  readonly minIntervalMs: number
  requests = 0
  cacheHits = 0
  failuresInRow = 0
  private lastStart = 0
  private chain: Promise<unknown> = Promise.resolve()
  private readonly opts: Required<Omit<ClientOptions, 'cache' | 'baseUrl' | 'rps'>> & Pick<ClientOptions, 'cache'>

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    const rps = options.rps && options.rps > 0 ? Math.min(options.rps, 1) : 1
    this.minIntervalMs = Math.ceil(1000 / rps)
    this.opts = {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 4,
      breakerThreshold: options.breakerThreshold ?? 5,
      fetchImpl: options.fetchImpl ?? fetch,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
      cache: options.cache,
    }
  }

  /** GET `path` (with its query string). Resolves 200 and 404 (and other 4xx) answers; throws on exhausted retries or an open breaker. */
  get(path: string): Promise<FetchResult> {
    // One request in flight: every call queues behind the previous one.
    const run = this.chain.then(() => this.getNow(path))
    this.chain = run.catch(() => undefined)
    return run
  }

  /**
   * Runs any other request to a Subsquare-owned host (an image on its static host or
   * IPFS gateway) in the same queue and pace as the API calls: one in flight, at most
   * SUBSQUARE_RPS, counted in `requests`.
   */
  throttle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - this.opts.now()
      if (wait > 0) await this.opts.sleep(wait)
      this.lastStart = this.opts.now()
      this.requests++
      return fn()
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  private cachePath(path: string): string | null {
    if (!this.opts.cache) return null
    return join(this.opts.cache.dir, createHash('sha1').update(path).digest('hex') + '.json')
  }

  private async getNow(path: string): Promise<FetchResult> {
    const file = this.cachePath(path)
    if (file && this.opts.cache!.mode !== 'write') {
      try {
        const cached = wellFormed(JSON.parse(await readFile(file, 'utf8'))) as FetchResult
        this.cacheHits++
        return cached
      } catch { /* miss */ }
    }
    if (this.failuresInRow >= this.opts.breakerThreshold) throw new CircuitOpenError(`circuit open after ${this.failuresInRow} consecutive failures`)
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastStart + this.minIntervalMs - this.opts.now()
      if (wait > 0) await this.opts.sleep(wait)
      this.lastStart = this.opts.now()
      this.requests++
      let status = 0
      let retryAfter: number | null = null
      let body: unknown = null
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs)
      try {
        const res = await this.opts.fetchImpl(this.baseUrl + path, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: controller.signal,
          redirect: 'error',
        })
        status = res.status
        retryAfter = retryAfterMs(res.headers.get('retry-after'), this.opts.now())
        const text = await readCapped(res, MAX_RESPONSE_BYTES)
        if (text == null) { status = -2; body = null } // larger than any honest answer: a failure, retried then given up
        else { try { body = text ? wellFormed(JSON.parse(text)) : null } catch { body = null; if (status === 200) status = -1 } }
      } catch {
        status = 0
      } finally {
        clearTimeout(timer)
      }
      if (status >= 200 && status < 500 && status !== 429) {
        this.failuresInRow = 0
        const result = { status, body }
        if (file && this.opts.cache!.mode !== 'read' && (status === 200 || status === 404)) {
          await mkdir(this.opts.cache!.dir, { recursive: true })
          await writeFile(file, JSON.stringify(result))
        }
        return result
      }
      this.failuresInRow++
      if (this.failuresInRow >= this.opts.breakerThreshold) throw new CircuitOpenError(`circuit open after ${this.failuresInRow} consecutive failures (last status ${status})`)
      if (attempt >= this.opts.maxRetries) throw new Error(`GET ${path.split('?')[0]} failed after ${attempt + 1} attempts (status ${status})`)
      await this.opts.sleep(retryAfter ?? backoffMs(attempt))
    }
  }
}
