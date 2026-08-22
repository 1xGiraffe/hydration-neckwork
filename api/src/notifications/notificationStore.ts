import { randomUUID } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { UserDataError } from '../services/userProfileService.ts'
import { isNotificationKind, parseRuleParams, type NotificationKind } from './notificationRules.ts'
import { ruleTargetError } from './ruleTargets.ts'

// Notification subscriptions, their channels, and the evaluator's key/value
// state. Same shape as userListService: the api process is the single writer,
// these maps ARE the model, and ClickHouse is only their durability — every
// mutation updates memory first, then persists a ReplacingMergeTree row
// (soft-delete by inserting `deleted = 1`).
//
// The inbox is the one exception: it is queried on demand (small,
// account-filtered, FINAL) rather than held in memory, because nothing on the
// hot path reads it. What IS held is the set of notification ids seen in the
// last 7 days, so a restart or a ClickHouse replay cannot re-deliver a
// notification that already went out.

export interface WebPushConfig { endpoint: string; p256dh: string; auth: string }
export interface TelegramConfig { chatId: string; username: string }
export type ChannelKind = 'webpush' | 'telegram'

export interface NotificationChannel {
  channelId: string
  accountId: string
  kind: ChannelKind
  config: WebPushConfig | TelegramConfig
  label: string
  verified: boolean
}

export interface NotificationRule {
  ruleId: string
  accountId: string
  kind: NotificationKind
  name: string
  params: unknown
  /** Empty = deliver on every channel the account has. */
  channels: string[]
  muted: boolean
  cooldownS: number
}

export interface InboxRow {
  notificationId: string
  accountId: string
  ruleId: string
  kind: string
  title: string
  body: string
  url: string
  blockHeight: number
  read: boolean
  createdAt: string
}

export const NOTIFICATION_LIMITS = {
  rulesPerAccount: 100,
  // A browser registers one push channel per profile and Telegram one per
  // chat, so this only bounds a runaway client; the routes' rate limit bounds
  // the rate.
  channelsPerAccount: 20,
  nameLen: 48,
  labelLen: 64,
  cooldownS: 86_400,
} as const

// How far back the dedup set is seeded, and how long an entry is kept. Long
// enough that a restart cannot re-fire anything a live rule could still match,
// short enough that the set does not grow for the life of the process.
const RECENT_ID_DAYS = 7
const RECENT_ID_TTL_MS = RECENT_ID_DAYS * 86_400_000
const RECENT_ID_PRUNE_MS = 3_600_000

let client: ClickHouseClient
const channels = new Map<string, NotificationChannel>()
const channelsByAccount = new Map<string, Set<string>>()
const telegramChannelByChat = new Map<string, string>()
const rules = new Map<string, NotificationRule>()
const rulesByAccount = new Map<string, Set<string>>()
const rulesByKind = new Map<NotificationKind, Set<string>>()
const state = new Map<string, string>()
// notification id → when it was seen, so entries can age out instead of
// accumulating for the process's lifetime.
const recentNotificationIds = new Map<string, number>()
let lastPruneMs = 0

export function initNotifications(c: ClickHouseClient): void {
  client = c
  channels.clear(); channelsByAccount.clear(); telegramChannelByChat.clear()
  rules.clear(); rulesByAccount.clear(); rulesByKind.clear()
  state.clear(); recentNotificationIds.clear()
  lastPruneMs = 0
}

const TABLES = {
  channels: 'price_data.user_notification_channels',
  rules: 'price_data.user_notification_rules',
  inbox: 'price_data.user_notification_inbox',
  state: 'price_data.user_notification_state',
} as const

function parseConfig(kind: ChannelKind, raw: string): WebPushConfig | TelegramConfig | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw || '{}') } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (kind === 'webpush') {
    const { endpoint, p256dh, auth } = o
    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string' || !endpoint) return null
    return { endpoint, p256dh, auth }
  }
  const { chatId, username } = o
  if (typeof chatId !== 'string' || !chatId) return null
  return { chatId, username: typeof username === 'string' ? username : '' }
}

function indexChannel(c: NotificationChannel): void {
  channels.set(c.channelId, c)
  if (!channelsByAccount.has(c.accountId)) channelsByAccount.set(c.accountId, new Set())
  channelsByAccount.get(c.accountId)!.add(c.channelId)
  if (c.kind === 'telegram') telegramChannelByChat.set((c.config as TelegramConfig).chatId, c.channelId)
}
function unindexChannel(c: NotificationChannel): void {
  channels.delete(c.channelId)
  channelsByAccount.get(c.accountId)?.delete(c.channelId)
  if (c.kind === 'telegram') telegramChannelByChat.delete((c.config as TelegramConfig).chatId)
}
function indexRule(r: NotificationRule): void {
  rules.set(r.ruleId, r)
  if (!rulesByAccount.has(r.accountId)) rulesByAccount.set(r.accountId, new Set())
  rulesByAccount.get(r.accountId)!.add(r.ruleId)
  if (!rulesByKind.has(r.kind)) rulesByKind.set(r.kind, new Set())
  rulesByKind.get(r.kind)!.add(r.ruleId)
}
function unindexRule(r: NotificationRule): void {
  rules.delete(r.ruleId)
  rulesByAccount.get(r.accountId)?.delete(r.ruleId)
  rulesByKind.get(r.kind)?.delete(r.ruleId)
}

export async function loadNotifications(): Promise<void> {
  channels.clear(); channelsByAccount.clear(); telegramChannelByChat.clear()
  rules.clear(); rulesByAccount.clear(); rulesByKind.clear()
  state.clear(); recentNotificationIds.clear()
  lastPruneMs = Date.now()

  const channelRes = await client.query({
    query: `SELECT channel_id, account_id, kind, config, label, verified FROM ${TABLES.channels} FINAL WHERE deleted = 0`,
    format: 'JSONEachRow',
  })
  const ruleRes = await client.query({
    query: `SELECT rule_id, account_id, kind, name, params, channels, muted, cooldown_s FROM ${TABLES.rules} FINAL WHERE deleted = 0`,
    format: 'JSONEachRow',
  })
  const stateRes = await client.query({
    query: `SELECT key, value FROM ${TABLES.state} FINAL WHERE deleted = 0`,
    format: 'JSONEachRow',
  })
  // Deliberately NOT filtered by `deleted`: this seed is the dedup memory, not a
  // reading list. A cleared inbox soft-deletes its rows, and a restart that
  // seeded only the surviving ones would let every cleared notification be
  // delivered again — clearing history would silently re-deliver it. Emptying
  // the inbox must forget what was SHOWN, never what was SENT.
  const recentRes = await client.query({
    query: `SELECT notification_id, created_at FROM ${TABLES.inbox} FINAL WHERE created_at > now() - INTERVAL ${RECENT_ID_DAYS} DAY`,
    format: 'JSONEachRow',
  })

  for (const r of await channelRes.json<{ channel_id: string; account_id: string; kind: string; config: string; label?: string; verified?: number }>()) {
    if (r.kind !== 'webpush' && r.kind !== 'telegram') continue
    const config = parseConfig(r.kind, r.config ?? '')
    if (!config) continue
    indexChannel({
      channelId: r.channel_id, accountId: r.account_id, kind: r.kind, config,
      label: r.label ?? '', verified: Number(r.verified) === 1,
    })
  }
  for (const r of await ruleRes.json<{ rule_id: string; account_id: string; kind: string; name?: string; params?: string; channels?: string[]; muted?: number; cooldown_s?: number }>()) {
    // A row naming a kind this build no longer has is SKIPPED, never fatal: a
    // kind can be retired (the Wormhole alerts folded into `safety`) while rows
    // written by the previous build are still in the table, and a loader that
    // threw would take every other subscription down with it. The row itself is
    // left alone — its owner still sees the rule, and a later build could
    // reintroduce the kind. Only the id is logged; params are private.
    if (!isNotificationKind(r.kind)) {
      console.warn(`[notifications] rule ${r.rule_id} names unknown kind '${r.kind}'; skipped`)
      continue
    }
    let params: unknown
    try { params = JSON.parse(r.params || '{}') } catch { continue }
    // A row whose params no longer satisfy their kind's schema is dropped
    // rather than handed to the evaluator: a rule that cannot be described
    // cannot be matched safely either.
    const parsed = parseRuleParams(r.kind, params)
    if (!parsed.ok) continue
    indexRule({
      ruleId: r.rule_id, accountId: r.account_id, kind: r.kind, name: r.name ?? '',
      params: parsed.params, channels: r.channels ?? [],
      muted: Number(r.muted) === 1, cooldownS: Number(r.cooldown_s) || 0,
    })
  }
  for (const r of await stateRes.json<{ key: string; value: string }>()) state.set(r.key, r.value ?? '')
  for (const r of await recentRes.json<{ notification_id: string; created_at?: string }>()) {
    recentNotificationIds.set(r.notification_id, seenAtMs(r.created_at))
  }
}

// A ClickHouse DateTime is UTC without a zone marker; a row whose timestamp
// cannot be read is treated as seen now, which only makes it live a little
// longer than it should.
function seenAtMs(createdAt: string | undefined): number {
  const ms = createdAt ? Date.parse(`${createdAt.replace(' ', 'T')}Z`) : Number.NaN
  return Number.isFinite(ms) ? ms : Date.now()
}

/* ============ channels ============ */

async function persistChannel(c: NotificationChannel, deleted = 0): Promise<void> {
  await client.insert({
    table: TABLES.channels,
    values: [{
      channel_id: c.channelId, account_id: c.accountId, kind: c.kind,
      config: JSON.stringify(c.config), label: c.label, verified: c.verified ? 1 : 0, deleted,
    }],
    format: 'JSONEachRow',
  })
}

export function channelsFor(accountId: string): NotificationChannel[] {
  return [...(channelsByAccount.get(accountId) ?? [])].map(id => channels.get(id)!).filter(Boolean)
}
export function getChannel(channelId: string): NotificationChannel | null {
  return channels.get(channelId) ?? null
}
export function telegramChannelForChat(chatId: string): NotificationChannel | null {
  const id = telegramChannelByChat.get(chatId)
  return id ? channels.get(id) ?? null : null
}

function checkLabel(label: string): string {
  const v = label.trim()
  if (v.length > NOTIFICATION_LIMITS.labelLen) throw new UserDataError(422, `A channel label is limited to ${NOTIFICATION_LIMITS.labelLen} characters`)
  return v
}

// A re-registered browser (same endpoint) updates its existing channel instead
// of accumulating duplicates — push subscriptions are renewed silently by the
// browser, and the endpoint is their identity.
export async function createWebPushChannel(accountId: string, config: WebPushConfig, label = ''): Promise<NotificationChannel> {
  const existing = channelsFor(accountId).find(c => c.kind === 'webpush' && (c.config as WebPushConfig).endpoint === config.endpoint)
  const channel: NotificationChannel = existing
    ? { ...existing, config, label: checkLabel(label) || existing.label, verified: true }
    : { channelId: randomUUID(), accountId, kind: 'webpush', config, label: checkLabel(label), verified: true }
  if (!existing && (channelsByAccount.get(accountId)?.size ?? 0) >= NOTIFICATION_LIMITS.channelsPerAccount) {
    throw new UserDataError(422, `Limited to ${NOTIFICATION_LIMITS.channelsPerAccount} notification channels`)
  }
  indexChannel(channel)
  await persistChannel(channel)
  return channel
}

// One channel per chat: a chat that re-links moves to whichever account
// claimed the newest link code.
export async function upsertTelegramChannel(accountId: string, config: TelegramConfig, label = ''): Promise<NotificationChannel> {
  const existing = telegramChannelForChat(config.chatId)
  if (existing && existing.accountId !== accountId) {
    unindexChannel(existing)
    await persistChannel(existing, 1)
  }
  const keep = existing && existing.accountId === accountId ? existing : null
  if (!keep && (channelsByAccount.get(accountId)?.size ?? 0) >= NOTIFICATION_LIMITS.channelsPerAccount) {
    throw new UserDataError(422, `Limited to ${NOTIFICATION_LIMITS.channelsPerAccount} notification channels`)
  }
  const channel: NotificationChannel = {
    channelId: keep?.channelId ?? randomUUID(), accountId, kind: 'telegram', config,
    label: checkLabel(label) || keep?.label || (config.username ? `@${config.username}` : 'Telegram'),
    verified: true,
  }
  indexChannel(channel)
  await persistChannel(channel)
  return channel
}

export async function setChannelVerified(channelId: string, verified: boolean): Promise<void> {
  const c = channels.get(channelId)
  if (!c || c.verified === verified) return
  const next = { ...c, verified }
  indexChannel(next)
  await persistChannel(next)
}

// A channel or rule that belongs to somebody else answers exactly like one that
// does not exist. A distinguishable 403 would turn these ids into an existence
// oracle for other accounts' channels, and the ids are opaque UUIDs the owner
// never publishes.
export async function deleteChannel(accountId: string, channelId: string): Promise<void> {
  const c = channels.get(channelId)
  if (!c || c.accountId !== accountId) throw new UserDataError(404, 'Channel not found')
  await removeChannel(c)
}

// Ownerless removal, for a push service that has told us the subscription is
// gone (404/410). Never reachable from a request path.
export async function removeChannelById(channelId: string): Promise<void> {
  const c = channels.get(channelId)
  if (c) await removeChannel(c)
}

async function removeChannel(c: NotificationChannel): Promise<void> {
  unindexChannel(c)
  await persistChannel(c, 1)
  // A rule that named only this channel would otherwise silently fall back to
  // "all channels"; drop the reference so its channel list keeps meaning what
  // the owner chose.
  for (const rule of rulesFor(c.accountId)) {
    if (!rule.channels.includes(c.channelId)) continue
    const next = { ...rule, channels: rule.channels.filter(id => id !== c.channelId) }
    indexRule(next)
    await persistRule(next)
  }
}

/* ============ rules ============ */

// A rule's params in a canonical, comparable form: object keys sorted at every
// depth and `undefined` values dropped, so two requests that differ only in key
// order — or in spelling an optional the schema defaults anyway — serialize
// identically. This is also the form the `params` column stores, which is what
// makes the duplicate check below a string comparison rather than a deep walk.
export function canonicalParams(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalParams).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalParams(v)}`).join(',')}}`
}

async function persistRule(r: NotificationRule, deleted = 0): Promise<void> {
  await client.insert({
    table: TABLES.rules,
    values: [{
      rule_id: r.ruleId, account_id: r.accountId, kind: r.kind, name: r.name,
      params: canonicalParams(r.params), channels: r.channels,
      muted: r.muted ? 1 : 0, cooldown_s: r.cooldownS, deleted,
    }],
    format: 'JSONEachRow',
  })
}

export function rulesFor(accountId: string): NotificationRule[] {
  return [...(rulesByAccount.get(accountId) ?? [])].map(id => rules.get(id)!).filter(Boolean)
}
export function allRules(): NotificationRule[] { return [...rules.values()] }
// The evaluator's entry point: every unmuted rule of one kind, so a window
// query runs once per kind rather than once per rule.
export function activeRulesByKind(kind: NotificationKind): NotificationRule[] {
  return [...(rulesByKind.get(kind) ?? [])].map(id => rules.get(id)!).filter(r => r && !r.muted)
}
export function activeRuleKinds(): NotificationKind[] {
  return [...rulesByKind.entries()].filter(([, ids]) => [...ids].some(id => rules.get(id)?.muted === false)).map(([kind]) => kind)
}

function checkName(name: string): string {
  const v = name.trim()
  if (v.length > NOTIFICATION_LIMITS.nameLen) throw new UserDataError(422, `An alert name is limited to ${NOTIFICATION_LIMITS.nameLen} characters`)
  return v
}
function checkCooldown(cooldownS: number): number {
  if (!Number.isFinite(cooldownS) || cooldownS < 0 || cooldownS > NOTIFICATION_LIMITS.cooldownS) {
    throw new UserDataError(422, `A cooldown must be between 0 and ${NOTIFICATION_LIMITS.cooldownS} seconds`)
  }
  return Math.floor(cooldownS)
}
function checkChannels(accountId: string, ids: string[]): string[] {
  const own = channelsByAccount.get(accountId) ?? new Set<string>()
  const unknown = ids.filter(id => !own.has(id))
  if (unknown.length) throw new UserDataError(404, 'Unknown channel')
  return [...new Set(ids)]
}

/**
 * The account's existing rule with the same kind and the same canonical params,
 * if it has one. Subscribing is idempotent by nature — the same "notify me
 * about this" affordance is pressed from several surfaces, and a second press
 * must not silently produce a second alert that then delivers everything twice.
 * A MUTED equivalent counts: it is the same subscription, deliberately quiet,
 * and re-creating it must neither duplicate nor unmute it.
 */
export function findEquivalentRule(accountId: string, kind: NotificationKind, params: unknown): NotificationRule | null {
  const parsed = parseRuleParams(kind, params)
  if (!parsed.ok) return null
  return equivalentRule(accountId, kind, canonicalParams(parsed.params))
}

function equivalentRule(accountId: string, kind: NotificationKind, key: string): NotificationRule | null {
  for (const rule of rulesFor(accountId)) {
    if (rule.kind === kind && canonicalParams(rule.params) === key) return rule
  }
  return null
}

export async function createRule(accountId: string, input: {
  kind: NotificationKind; params: unknown; name?: string; channels?: string[]; cooldownS?: number
}): Promise<NotificationRule> {
  const parsed = parseRuleParams(input.kind, input.params)
  if (!parsed.ok) throw new UserDataError(422, parsed.error)
  const targetError = ruleTargetError(accountId, input.kind, parsed.params)
  if (targetError) throw new UserDataError(422, targetError)
  // Before the cap, not after: an account at its limit re-pressing a bell it
  // already owns gets its own rule back rather than a "limited to 100 alerts".
  const existing = equivalentRule(accountId, input.kind, canonicalParams(parsed.params))
  if (existing) return existing
  if ((rulesByAccount.get(accountId)?.size ?? 0) >= NOTIFICATION_LIMITS.rulesPerAccount) {
    throw new UserDataError(422, `Limited to ${NOTIFICATION_LIMITS.rulesPerAccount} alerts`)
  }
  const rule: NotificationRule = {
    ruleId: randomUUID(), accountId, kind: input.kind, name: checkName(input.name ?? ''),
    params: parsed.params, channels: checkChannels(accountId, input.channels ?? []),
    muted: false, cooldownS: checkCooldown(input.cooldownS ?? 0),
  }
  indexRule(rule)
  await persistRule(rule)
  return rule
}

export async function updateRule(accountId: string, ruleId: string, patch: {
  muted?: boolean; name?: string; params?: unknown; channels?: string[]; cooldownS?: number
}): Promise<NotificationRule> {
  const rule = rules.get(ruleId)
  if (!rule || rule.accountId !== accountId) throw new UserDataError(404, 'Alert not found')
  const next: NotificationRule = { ...rule }
  if (patch.muted !== undefined) next.muted = patch.muted
  if (patch.name !== undefined) next.name = checkName(patch.name)
  if (patch.cooldownS !== undefined) next.cooldownS = checkCooldown(patch.cooldownS)
  if (patch.channels !== undefined) next.channels = checkChannels(accountId, patch.channels)
  if (patch.params !== undefined) {
    const parsed = parseRuleParams(rule.kind, patch.params)
    if (!parsed.ok) throw new UserDataError(422, parsed.error)
    const targetError = ruleTargetError(accountId, rule.kind, parsed.params)
    if (targetError) throw new UserDataError(422, targetError)
    next.params = parsed.params
  }
  indexRule(next)
  await persistRule(next)
  return next
}

export async function deleteRule(accountId: string, ruleId: string): Promise<void> {
  const rule = rules.get(ruleId)
  if (!rule || rule.accountId !== accountId) throw new UserDataError(404, 'Alert not found')
  unindexRule(rule)
  await persistRule(rule, 1)
  // The threshold lanes keep an armed flag per rule; without this the state
  // table keeps a row for every alert ever deleted.
  await deleteNotificationState(armStateKey(ruleId))
}

/* ============ inbox ============ */

// `created_at` is written explicitly on every insert: ReplacingMergeTree keeps
// the whole newest row, so relying on the column DEFAULT would reset a
// notification's timestamp the moment it is marked read.
const chDateTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

export type InboxInsert = Omit<InboxRow, 'read' | 'createdAt'> & { read?: boolean; createdAtMs?: number }

// One insert for a whole batch. An evaluator tick can match thousands of rows
// on a busy pallet, and one round trip per row would put the loop's runtime at
// the mercy of the match count.
export async function insertInboxRows(rows: readonly InboxInsert[]): Promise<void> {
  if (!rows.length) return
  await client.insert({
    table: TABLES.inbox,
    values: rows.map(row => ({
      notification_id: row.notificationId, account_id: row.accountId, rule_id: row.ruleId, kind: row.kind,
      title: row.title, body: row.body, url: row.url, block_height: row.blockHeight,
      read: row.read ? 1 : 0, deleted: 0, created_at: chDateTime(row.createdAtMs ?? Date.now()),
    })),
    format: 'JSONEachRow',
  })
}

interface InboxDbRow {
  notification_id: string; account_id: string; rule_id: string; kind: string
  title: string; body: string; url: string; block_height: number; read: number; created_at: string
}
const toInboxRow = (r: InboxDbRow): InboxRow => ({
  notificationId: r.notification_id, accountId: r.account_id, ruleId: r.rule_id, kind: r.kind,
  title: r.title, body: r.body ?? '', url: r.url ?? '', blockHeight: Number(r.block_height) || 0,
  read: Number(r.read) === 1, createdAt: r.created_at,
})

export async function queryInbox(accountId: string, limit: number, offset: number): Promise<{ rows: InboxRow[]; total: number; unread: number }> {
  const res = await client.query({
    query: `SELECT notification_id, account_id, rule_id, kind, title, body, url, block_height, read, created_at
            FROM ${TABLES.inbox} FINAL
            WHERE deleted = 0 AND account_id = {account:String}
            ORDER BY created_at DESC, notification_id
            LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
    query_params: { account: accountId, limit, offset },
    format: 'JSONEachRow',
  })
  const rows = (await res.json<InboxDbRow>()).map(toInboxRow)
  const totals = await client.query({
    query: `SELECT count() AS total, countIf(read = 0) AS unread
            FROM ${TABLES.inbox} FINAL
            WHERE deleted = 0 AND account_id = {account:String}`,
    query_params: { account: accountId },
    format: 'JSONEachRow',
  })
  const [t] = await totals.json<{ total: number | string; unread: number | string }>()
  return { rows, total: Number(t?.total ?? 0), unread: Number(t?.unread ?? 0) }
}

export async function unreadCount(accountId: string): Promise<number> {
  const res = await client.query({
    query: `SELECT count() AS unread FROM ${TABLES.inbox} FINAL WHERE deleted = 0 AND read = 0 AND account_id = {account:String}`,
    query_params: { account: accountId },
    format: 'JSONEachRow',
  })
  const [r] = await res.json<{ unread: number | string }>()
  return Number(r?.unread ?? 0)
}

// Marking read re-inserts the WHOLE row with read = 1: ReplacingMergeTree
// replaces by notification_id and keeps the newest row entire, so a partial
// row would blank the title/body it replaces.
export async function markInboxRead(accountId: string, ids?: string[]): Promise<number> {
  const selected = ids?.length ? [...new Set(ids)] : null
  const res = await client.query({
    query: `SELECT notification_id, account_id, rule_id, kind, title, body, url, block_height, read, created_at
            FROM ${TABLES.inbox} FINAL
            WHERE deleted = 0 AND read = 0 AND account_id = {account:String}
            ${selected ? 'AND notification_id IN {ids:Array(String)}' : ''}`,
    query_params: selected ? { account: accountId, ids: selected } : { account: accountId },
    format: 'JSONEachRow',
  })
  // The account filter is re-applied locally so a stubbed or over-broad source
  // can never flip another account's rows.
  const rows = (await res.json<InboxDbRow>())
    .filter(r => r.account_id === accountId && Number(r.read) !== 1)
    .filter(r => !selected || selected.includes(r.notification_id))
  if (!rows.length) return 0
  await client.insert({
    table: TABLES.inbox,
    values: rows.map(r => ({
      notification_id: r.notification_id, account_id: r.account_id, rule_id: r.rule_id, kind: r.kind,
      title: r.title, body: r.body ?? '', url: r.url ?? '', block_height: Number(r.block_height) || 0,
      read: 1, deleted: 0, created_at: r.created_at,
    })),
    format: 'JSONEachRow',
  })
  return rows.length
}

// Emptying the whole inbox: one read of the account's rows, one insert of
// `deleted = 1` replacements. Soft-delete by re-inserting the row (the store's
// idiom everywhere else) rather than DELETE, and in ONE batch whatever the row
// count — an inbox is capped only by the 180-day TTL, so a per-row round trip
// would put the request's runtime at the mercy of how long somebody has been
// subscribed.
//
// The rows stay in the table with `deleted = 1`, which is also what keeps the
// dedup seed at boot honest (see loadNotifications): clearing forgets what was
// shown, never what was sent, so nothing is re-delivered afterwards.
export async function clearInbox(accountId: string): Promise<number> {
  const res = await client.query({
    query: `SELECT notification_id, account_id, rule_id, kind, title, body, url, block_height, read, created_at
            FROM ${TABLES.inbox} FINAL
            WHERE deleted = 0 AND account_id = {account:String}`,
    query_params: { account: accountId },
    format: 'JSONEachRow',
  })
  // Re-applied locally, like markInboxRead: a stubbed or over-broad source can
  // never clear another account's inbox.
  const rows = (await res.json<InboxDbRow>()).filter(r => r.account_id === accountId)
  if (!rows.length) return 0
  await client.insert({
    table: TABLES.inbox,
    values: rows.map(r => ({
      notification_id: r.notification_id, account_id: r.account_id, rule_id: r.rule_id, kind: r.kind,
      title: r.title, body: r.body ?? '', url: r.url ?? '', block_height: Number(r.block_height) || 0,
      read: Number(r.read) === 1 ? 1 : 0, deleted: 1, created_at: r.created_at,
    })),
    format: 'JSONEachRow',
  })
  return rows.length
}

/* ============ evaluator key/value state ============ */

// The threshold lanes' per-rule armed flag. Defined here rather than in the
// evaluator because deleting a rule has to delete its state row too, and the
// key must exist in exactly one place for those two to agree.
export const armStateKey = (ruleId: string): string => `arm:${ruleId}`

export function getNotificationState(key: string): string | null { return state.get(key) ?? null }

export async function setNotificationState(key: string, value: string): Promise<void> {
  state.set(key, value)
  await client.insert({ table: TABLES.state, values: [{ key, value, deleted: 0 }], format: 'JSONEachRow' })
}

export async function deleteNotificationState(key: string): Promise<void> {
  if (!state.delete(key)) return
  await client.insert({ table: TABLES.state, values: [{ key, value: '', deleted: 1 }], format: 'JSONEachRow' })
}

/* ============ dedup ============ */

// Deterministic notification ids make a re-evaluation idempotent; this set is
// what makes it idempotent ACROSS a restart, seeded from the inbox at load.
//
// Entries age out after the same seven days the seed query reads: nothing older
// can still be re-matched (the window clamp is 600 blocks), so keeping it would
// only grow the set for as long as the process lives. The one identity that can
// outlive the window is a safety `queued:<digest>` for a transfer the origin
// limiter holds longer than the TTL; its lane emits a digest once per process,
// so the cost of the aged-out entry is a single repeat after a restart.
export function hasNotification(notificationId: string): boolean { return recentNotificationIds.has(notificationId) }

export function rememberNotification(notificationId: string, seenAtMs = Date.now()): void {
  recentNotificationIds.set(notificationId, seenAtMs)
  if (seenAtMs - lastPruneMs < RECENT_ID_PRUNE_MS) return
  lastPruneMs = seenAtMs
  const cutoff = seenAtMs - RECENT_ID_TTL_MS
  for (const [id, at] of recentNotificationIds) if (at < cutoff) recentNotificationIds.delete(id)
}
