import { createHash } from 'node:crypto'
import type { ClickHouseClient } from '../../db/client.ts'
import { dataConfig } from '../config.ts'

// Token authentication, per-user rate limiting and usage metering for the Data
// API (concept § 3). This service is the whole data-plane half of the control
// plane: it READS user_api_tokens/user_api_limits (through short in-process
// caches — no boot-time load, so a token minted in the explorer works within
// seconds and a revoked one dies within TTL_POS_MS) and WRITES user_api_usage
// plus the hourly last_used_at refresh. Token CRUD lives in the explorer api.

const TOKEN_RE = /^hdd_[0-9a-f]{64}$/
const TTL_POS_MS = 30_000       // a live token is re-verified at most this often
const TTL_NEG_MS = 10_000       // an unknown hash is re-checked at most this often
const TOKEN_CACHE_MAX = 10_000  // LRU bound so credential stuffing cannot grow the map
const LAST_USED_PERSIST_MS = 3_600_000
const USAGE_FLUSH_MS = 60_000
const IP_WINDOW_MS = 60_000
const IP_MAX_UNAUTHENTICATED = 60

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const chDateTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

interface TokenCacheEntry {
  accountId: string | null    // null = negative entry (unknown or revoked)
  expiresAtMs: number
  lastUsedPersistedMs: number
}

interface LimitsCacheEntry { perMinute: number; perDay: number; expiresAtMs: number }

interface WindowCounters { minuteStart: number; minuteCount: number; dayStart: number; dayCount: number }

interface UsageCounter { requests: number; rejected: number; seeded: boolean }

let client: ClickHouseClient
const tokenCache = new Map<string, TokenCacheEntry>()
const tokenLookupInflight = new Map<string, Promise<string | null>>()
const limitsCache = new Map<string, LimitsCacheEntry>()
const limitsInflight = new Map<string, Promise<{ perMinute: number; perDay: number }>>()
const windows = new Map<string, WindowCounters>()
const usage = new Map<string, UsageCounter>() // key `${accountId}|${hourStartSec}`
const ipWindows = new Map<string, { windowStart: number; count: number }>()
let flushTimer: ReturnType<typeof setInterval> | null = null

export function initDataAuth(c: ClickHouseClient): void {
  client = c
}

export function startUsageFlush(): void {
  if (flushTimer) return
  flushTimer = setInterval(() => {
    void flushUsage().catch(err => console.error('[data-api] usage flush failed:', err))
  }, USAGE_FLUSH_MS)
  flushTimer.unref()
}

export function stopUsageFlush(): void {
  if (!flushTimer) return
  clearInterval(flushTimer)
  flushTimer = null
}

export function resetDataAuthForTests(): void {
  tokenCache.clear()
  tokenLookupInflight.clear()
  limitsCache.clear()
  limitsInflight.clear()
  windows.clear()
  usage.clear()
  ipWindows.clear()
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

export function isTokenShaped(raw: string): boolean {
  return TOKEN_RE.test(raw)
}

// Bearer token → owner accountId, or null. Positive hits are cached TTL_POS_MS,
// misses TTL_NEG_MS; concurrent misses for one hash share a single FINAL point
// read (primary-key lookup on user_api_tokens, sub-ms).
export async function resolveToken(rawToken: string): Promise<string | null> {
  if (!isTokenShaped(rawToken)) return null
  const hash = sha256(rawToken)
  const now = Date.now()
  const hit = tokenCache.get(hash)
  if (hit && hit.expiresAtMs > now) {
    if (hit.accountId) touchLastUsed(hash, hit, now)
    return hit.accountId
  }

  const pending = tokenLookupInflight.get(hash)
  if (pending) return pending
  const lookup = (async () => {
    try {
      const res = await client.query({
        query: `
          SELECT account_id
          FROM price_data.user_api_tokens FINAL
          WHERE token_hash = {hash:String} AND deleted = 0
        `,
        query_params: { hash },
        format: 'JSONEachRow',
      })
      const [row] = await res.json<{ account_id: string }>()
      const accountId = row?.account_id ?? null
      const resolvedAt = Date.now()
      pruneTokenCache()
      const entry: TokenCacheEntry = {
        accountId,
        expiresAtMs: resolvedAt + (accountId ? TTL_POS_MS : TTL_NEG_MS),
        // A fresh positive entry persists last_used_at immediately (then at
        // most hourly): "last used" tracking should not miss a token used once.
        lastUsedPersistedMs: 0,
      }
      tokenCache.set(hash, entry)
      if (accountId) touchLastUsed(hash, entry, resolvedAt)
      return accountId
    } finally {
      tokenLookupInflight.delete(hash)
    }
  })()
  tokenLookupInflight.set(hash, lookup)
  return lookup
}

function pruneTokenCache(): void {
  if (tokenCache.size < TOKEN_CACHE_MAX) return
  const now = Date.now()
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAtMs <= now) tokenCache.delete(key)
  }
  // Maps iterate in insertion order, so evicting from the front is oldest-first.
  for (const key of tokenCache.keys()) {
    if (tokenCache.size < TOKEN_CACHE_MAX) break
    tokenCache.delete(key)
  }
}

// Throttled last_used_at refresh, at most hourly per token. The write is an
// INSERT…SELECT that re-reads the CURRENT row (FINAL) and only when it is
// still live, so it can never resurrect a revoked token or clobber a renamed
// label with cached values; the raced window against a concurrent revoke is
// the statement itself, not the 30 s token cache. Fire-and-forget: a lost
// refresh costs display freshness only.
function touchLastUsed(hash: string, entry: TokenCacheEntry, now: number): void {
  if (now - entry.lastUsedPersistedMs < LAST_USED_PERSIST_MS) return
  entry.lastUsedPersistedMs = now
  void client.command({
    query: `
      INSERT INTO price_data.user_api_tokens (token_hash, account_id, label, token_prefix, created_at, last_used_at, deleted, updated_at)
      SELECT token_hash, account_id, label, token_prefix, created_at, toDateTime({now:UInt32}) AS last_used_at, deleted, now64(3)
      FROM price_data.user_api_tokens FINAL
      WHERE token_hash = {hash:String} AND deleted = 0
    `,
    query_params: { hash, now: Math.floor(now / 1000) },
  }).catch(() => { /* freshness only */ })
}

// ---------------------------------------------------------------------------
// Per-user limits and fixed-window rate limiting
// ---------------------------------------------------------------------------

export interface ResolvedLimits { perMinute: number; perDay: number }

export async function limitsFor(accountId: string): Promise<ResolvedLimits> {
  const now = Date.now()
  const hit = limitsCache.get(accountId)
  if (hit && hit.expiresAtMs > now) return { perMinute: hit.perMinute, perDay: hit.perDay }
  const pending = limitsInflight.get(accountId)
  if (pending) return pending
  const lookup = (async () => {
    try {
      const res = await client.query({
        query: `
          SELECT per_minute, per_day
          FROM price_data.user_api_limits FINAL
          WHERE account_id = {account:String} AND deleted = 0
        `,
        query_params: { account: accountId },
        format: 'JSONEachRow',
      })
      const [row] = await res.json<{ per_minute: number; per_day: number }>()
      const resolved = {
        perMinute: Number(row?.per_minute ?? 0) || dataConfig.defaultPerMinute,
        perDay: Number(row?.per_day ?? 0) || dataConfig.defaultPerDay,
      }
      limitsCache.set(accountId, { ...resolved, expiresAtMs: Date.now() + TTL_POS_MS })
      return resolved
    } finally {
      limitsInflight.delete(accountId)
    }
  })()
  limitsInflight.set(accountId, lookup)
  return lookup
}

export interface RateDecision {
  allowed: boolean
  limits: ResolvedLimits
  usedMinute: number
  usedDay: number
  remainingMinute: number
  remainingDay: number
  retryAfterSeconds: number
  admin: boolean
}

// Fixed windows: per-minute, and per-UTC-day. All tokens of one account share
// the account's budget (the map is keyed by account, not token). Admin
// accounts are exempt from ENFORCEMENT but still counted, so their usage shows
// up on the admin page like anyone else's.
export async function checkRateLimit(accountId: string): Promise<RateDecision> {
  const limits = await limitsFor(accountId)
  const nowSec = Math.floor(Date.now() / 1000)
  const minuteStart = nowSec - (nowSec % 60)
  const dayStart = nowSec - (nowSec % 86_400)
  let counters = windows.get(accountId)
  if (!counters) {
    counters = { minuteStart, minuteCount: 0, dayStart, dayCount: 0 }
    windows.set(accountId, counters)
  }
  if (counters.minuteStart !== minuteStart) { counters.minuteStart = minuteStart; counters.minuteCount = 0 }
  if (counters.dayStart !== dayStart) { counters.dayStart = dayStart; counters.dayCount = 0 }

  const admin = dataConfig.adminAccountIds.has(accountId)
  const overMinute = counters.minuteCount >= limits.perMinute
  const overDay = counters.dayCount >= limits.perDay
  const allowed = admin || (!overMinute && !overDay)
  if (allowed) {
    counters.minuteCount += 1
    counters.dayCount += 1
  }
  const retryAfterSeconds = overDay && !overMinute
    ? dayStart + 86_400 - nowSec
    : minuteStart + 60 - nowSec
  return {
    allowed,
    limits,
    usedMinute: counters.minuteCount,
    usedDay: counters.dayCount,
    remainingMinute: Math.max(0, limits.perMinute - counters.minuteCount),
    remainingDay: Math.max(0, limits.perDay - counters.dayCount),
    retryAfterSeconds: Math.max(1, retryAfterSeconds),
    admin,
  }
}

// ---------------------------------------------------------------------------
// Per-IP brake for unauthenticated requests: 60/min per address, checked
// BEFORE any DB work beyond the (negative-cached) token lookup, so a
// credential-stuffing loop cannot monopolize the process.
// ---------------------------------------------------------------------------

export function unauthenticatedIpAllowed(ip: string): boolean {
  const now = Date.now()
  let window = ipWindows.get(ip)
  if (!window || now - window.windowStart >= IP_WINDOW_MS) {
    window = { windowStart: now, count: 0 }
    ipWindows.set(ip, window)
  }
  window.count += 1
  if (ipWindows.size > 50_000) {
    for (const [key, value] of ipWindows) {
      if (now - value.windowStart >= IP_WINDOW_MS) ipWindows.delete(key)
    }
  }
  return window.count <= IP_MAX_UNAUTHENTICATED
}

// ---------------------------------------------------------------------------
// Usage metering: in-memory running totals per (account, UTC hour), flushed
// every 60 s by REPLACING the (account, hour) row with the running total.
// After a restart the first flush touching an hour SEEDS the in-memory total
// from the stored row, so a replace never shrinks a stored count and a
// restart loses at most one flush interval.
// ---------------------------------------------------------------------------

export function recordUsage(accountId: string, rejected: boolean): void {
  const nowSec = Math.floor(Date.now() / 1000)
  const hourStart = nowSec - (nowSec % 3600)
  const key = `${accountId}|${hourStart}`
  let counter = usage.get(key)
  if (!counter) {
    counter = { requests: 0, rejected: 0, seeded: false }
    usage.set(key, counter)
  }
  counter.requests += 1
  if (rejected) counter.rejected += 1
}

export async function flushUsage(): Promise<void> {
  if (usage.size === 0) return
  const entries = [...usage.entries()]
  const unseeded = entries.filter(([, counter]) => !counter.seeded)
  if (unseeded.length > 0) {
    // Two parallel flat arrays zipped server-side: ClickHouse's HTTP parameter
    // parser cannot read an Array(Tuple(…)) literal from the JSON the client
    // sends (measured live: "expected '(' before …"), while arrayZip over two
    // flat arrays binds cleanly.
    const accounts: string[] = []
    const hours: number[] = []
    for (const [key] of unseeded) {
      const [accountId, hourStart] = splitUsageKey(key)
      accounts.push(accountId)
      hours.push(hourStart)
    }
    const res = await client.query({
      query: `
        SELECT account_id, toUnixTimestamp(hour_start) AS hour_epoch, requests, rejected
        FROM price_data.user_api_usage FINAL
        WHERE (account_id, toUnixTimestamp(hour_start)) IN arrayZip({accounts:Array(String)}, {hours:Array(UInt32)})
      `,
      query_params: { accounts, hours },
      format: 'JSONEachRow',
    })
    const stored = new Map<string, { requests: number; rejected: number }>()
    for (const row of await res.json<{ account_id: string; hour_epoch: number; requests: string; rejected: string }>()) {
      stored.set(`${row.account_id}|${row.hour_epoch}`, { requests: Number(row.requests), rejected: Number(row.rejected) })
    }
    for (const [key, counter] of unseeded) {
      const prior = stored.get(key)
      if (prior) {
        counter.requests += prior.requests
        counter.rejected += prior.rejected
      }
      counter.seeded = true
    }
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const currentHour = nowSec - (nowSec % 3600)
  await client.insert({
    table: 'price_data.user_api_usage',
    values: entries.map(([key, counter]) => {
      const [accountId, hourStart] = splitUsageKey(key)
      return {
        account_id: accountId,
        hour_start: chDateTime(hourStart * 1000),
        requests: counter.requests,
        rejected: counter.rejected,
      }
    }),
    format: 'JSONEachRow',
  })
  // A closed hour has been written with its final total; only the live hour
  // keeps accumulating in memory.
  for (const [key] of entries) {
    const [, hourStart] = splitUsageKey(key)
    if (hourStart < currentHour) usage.delete(key)
  }
}

function splitUsageKey(key: string): [string, number] {
  const at = key.lastIndexOf('|')
  return [key.slice(0, at), Number(key.slice(at + 1))]
}
