import { createHash, randomBytes } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { UserDataError } from './userProfileService.ts'

// Control plane for the Data API's tokens (concept: ~/.g/hydraken-api-concept.md
// § 3): minting, listing and revoking live HERE, on the explorer api, where the
// wallet session already is; the api-data process only ever READS
// user_api_tokens/user_api_limits and meters into user_api_usage. Unlike the
// session/list services this keeps no in-memory mirror — every operation is a
// FINAL point read or a ReplacingMergeTree upsert on tables that api-data
// writes too (its throttled last_used_at refresh), so the table itself stays
// the single source of truth and the two processes cannot disagree.

const TOKEN_BYTES = 32
const TOKEN_PREFIX_LEN = 12
export const MAX_ACTIVE_TOKENS = 10
export const MAX_LABEL_LEN = 100

// The same env contract as api/src/data/config.ts, parsed independently: the
// two processes must agree on the defaults an account WITHOUT an override runs
// under, and both read DATA_API_DEFAULT_* from the compose file.
function parseCount(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim() || '')
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

let client: ClickHouseClient
let adminAccounts: Set<string> = new Set()
let defaults = { perMinute: 30, perDay: 20_000 }

export function initUserApiTokenService(c: ClickHouseClient): void {
  client = c
  adminAccounts = new Set(
    (process.env.ADMIN_ACCOUNT_IDS ?? '')
      .split(',')
      .map(entry => entry.trim().toLowerCase())
      .filter(entry => /^0x[0-9a-f]{64}$/.test(entry)),
  )
  defaults = {
    perMinute: parseCount(process.env.DATA_API_DEFAULT_PER_MINUTE, 30),
    perDay: parseCount(process.env.DATA_API_DEFAULT_PER_DAY, 20_000),
  }
}

export function isApiAdmin(accountId: string): boolean {
  return adminAccounts.has(accountId.toLowerCase())
}

export function apiLimitDefaults(): { perMinute: number; perDay: number } {
  return { ...defaults }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const chDateTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const EPOCH = '1970-01-01 00:00:00'

export interface ApiTokenInfo {
  id: string          // the token hash — irreversible, safe to hand back to its owner
  label: string
  tokenPrefix: string
  createdAt: string
  lastUsedAt: string | null
}

interface TokenRow {
  token_hash: string
  account_id: string
  label: string
  token_prefix: string
  created_at: string
  last_used_at: string
}

function tokenInfo(row: TokenRow): ApiTokenInfo {
  return {
    id: row.token_hash,
    label: row.label,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at === EPOCH ? null : row.last_used_at,
  }
}

async function activeTokenRows(accountId: string): Promise<TokenRow[]> {
  const res = await client.query({
    query: `
      SELECT token_hash, account_id, label, token_prefix, toString(created_at) AS created_at, toString(last_used_at) AS last_used_at
      FROM price_data.user_api_tokens FINAL
      WHERE account_id = {account:String} AND deleted = 0
      ORDER BY created_at DESC, token_hash`,
    query_params: { account: accountId },
    format: 'JSONEachRow',
  })
  return res.json<TokenRow>()
}

export async function listApiTokens(accountId: string): Promise<ApiTokenInfo[]> {
  return (await activeTokenRows(accountId)).map(tokenInfo)
}

export interface CreatedApiToken extends ApiTokenInfo {
  // The raw secret — returned exactly once, from this function to the create
  // response, and never persisted or logged anywhere.
  token: string
}

export async function createApiToken(accountId: string, label: string): Promise<CreatedApiToken> {
  const trimmed = label.trim()
  if (trimmed.length > MAX_LABEL_LEN) throw new UserDataError(422, `Label must be at most ${MAX_LABEL_LEN} characters`)
  const existing = await activeTokenRows(accountId)
  if (existing.length >= MAX_ACTIVE_TOKENS) {
    throw new UserDataError(422, `At most ${MAX_ACTIVE_TOKENS} active tokens per account — revoke one first`)
  }
  const token = `hdd_${randomBytes(TOKEN_BYTES).toString('hex')}`
  const now = Date.now()
  const row = {
    token_hash: sha256(token),
    account_id: accountId,
    label: trimmed,
    token_prefix: token.slice(0, TOKEN_PREFIX_LEN),
    created_at: chDateTime(now),
    last_used_at: EPOCH,
    deleted: 0,
  }
  await client.insert({ table: 'price_data.user_api_tokens', values: [row], format: 'JSONEachRow' })
  return { token, id: row.token_hash, label: row.label, tokenPrefix: row.token_prefix, createdAt: row.created_at, lastUsedAt: null }
}

// Owner-scoped unless `asAdmin`; an unknown hash and someone else's token both
// 404 so the endpoint leaks nothing about other accounts' tokens.
export async function revokeApiToken(callerAccountId: string, tokenHash: string, asAdmin = false): Promise<void> {
  const res = await client.query({
    query: `
      SELECT token_hash, account_id, label, token_prefix, toString(created_at) AS created_at, toString(last_used_at) AS last_used_at
      FROM price_data.user_api_tokens FINAL
      WHERE token_hash = {hash:String} AND deleted = 0`,
    query_params: { hash: tokenHash },
    format: 'JSONEachRow',
  })
  const [row] = await res.json<TokenRow>()
  if (!row || (!asAdmin && row.account_id !== callerAccountId)) throw new UserDataError(404, 'Unknown token')
  await client.insert({
    table: 'price_data.user_api_tokens',
    values: [{
      token_hash: row.token_hash, account_id: row.account_id, label: row.label,
      token_prefix: row.token_prefix, created_at: row.created_at, last_used_at: row.last_used_at, deleted: 1,
    }],
    format: 'JSONEachRow',
  })
}

// ---------------------------------------------------------------------------
// Admin: the API-users overview and per-account limit overrides.
// ---------------------------------------------------------------------------

export interface ApiUserOverview {
  accountId: string
  tokenCount: number
  labels: string[]
  lastUsedAt: string | null
  limits: { perMinute: number; perDay: number; override: boolean; note: string }
  usage: {
    requests24h: number
    rejected24h: number
    requests7d: number
    requests30d: number
    lastActiveHour: string | null
  }
}

export async function adminApiUsers(): Promise<ApiUserOverview[]> {
  const [tokensRes, limitsRes, usageRes] = await Promise.all([
    client.query({
      query: `
        SELECT account_id, toUInt32(count()) AS tokens, groupArray(label) AS labels, toString(max(last_used_at)) AS last_used
        FROM price_data.user_api_tokens FINAL
        WHERE deleted = 0
        GROUP BY account_id`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT account_id, per_minute, per_day, note
        FROM price_data.user_api_limits FINAL
        WHERE deleted = 0`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT account_id,
               toString(sumIf(requests, hour_start >= now() - INTERVAL 24 HOUR)) AS r24,
               toString(sumIf(rejected, hour_start >= now() - INTERVAL 24 HOUR)) AS j24,
               toString(sumIf(requests, hour_start >= now() - INTERVAL 7 DAY)) AS r7,
               toString(sumIf(requests, hour_start >= now() - INTERVAL 30 DAY)) AS r30,
               toString(max(hour_start)) AS last_hour
        FROM price_data.user_api_usage FINAL
        GROUP BY account_id`,
      format: 'JSONEachRow',
    }),
  ])
  const limits = new Map<string, { per_minute: number; per_day: number; note: string }>()
  for (const row of await limitsRes.json<{ account_id: string; per_minute: number; per_day: number; note: string }>()) {
    limits.set(row.account_id, row)
  }
  const usage = new Map<string, { r24: string; j24: string; r7: string; r30: string; last_hour: string }>()
  for (const row of await usageRes.json<{ account_id: string; r24: string; j24: string; r7: string; r30: string; last_hour: string }>()) {
    usage.set(row.account_id, row)
  }
  const out: ApiUserOverview[] = []
  for (const row of await tokensRes.json<{ account_id: string; tokens: number; labels: string[]; last_used: string }>()) {
    const override = limits.get(row.account_id)
    const used = usage.get(row.account_id)
    out.push({
      accountId: row.account_id,
      tokenCount: Number(row.tokens),
      labels: (row.labels ?? []).filter(label => label !== ''),
      lastUsedAt: row.last_used === EPOCH ? null : row.last_used,
      limits: {
        perMinute: override ? Number(override.per_minute) : defaults.perMinute,
        perDay: override ? Number(override.per_day) : defaults.perDay,
        override: override != null,
        note: override?.note ?? '',
      },
      usage: {
        requests24h: Number(used?.r24 ?? 0),
        rejected24h: Number(used?.j24 ?? 0),
        requests7d: Number(used?.r7 ?? 0),
        requests30d: Number(used?.r30 ?? 0),
        lastActiveHour: used?.last_hour && used.last_hour !== EPOCH ? used.last_hour : null,
      },
    })
  }
  return out.sort((a, b) => b.usage.requests24h - a.usage.requests24h || b.usage.requests30d - a.usage.requests30d || a.accountId.localeCompare(b.accountId))
}

const MAX_PER_MINUTE = 100_000
const MAX_PER_DAY = 100_000_000

export async function adminSetLimits(adminAccountId: string, accountId: string, perMinute: number, perDay: number, note: string): Promise<void> {
  if (!Number.isSafeInteger(perMinute) || perMinute < 1 || perMinute > MAX_PER_MINUTE) throw new UserDataError(422, `perMinute must be 1…${MAX_PER_MINUTE}`)
  if (!Number.isSafeInteger(perDay) || perDay < 1 || perDay > MAX_PER_DAY) throw new UserDataError(422, `perDay must be 1…${MAX_PER_DAY}`)
  if (note.length > 400) throw new UserDataError(422, 'Note must be at most 400 characters')
  await client.insert({
    table: 'price_data.user_api_limits',
    values: [{ account_id: accountId, per_minute: perMinute, per_day: perDay, note, updated_by: adminAccountId, deleted: 0 }],
    format: 'JSONEachRow',
  })
}

export async function adminClearLimits(adminAccountId: string, accountId: string): Promise<void> {
  await client.insert({
    table: 'price_data.user_api_limits',
    values: [{ account_id: accountId, per_minute: 0, per_day: 0, note: '', updated_by: adminAccountId, deleted: 1 }],
    format: 'JSONEachRow',
  })
}
