import webpush from 'web-push'
import {
  hasNotification, rememberNotification, insertInboxRows, removeChannelById, setChannelVerified,
  type InboxInsert, type NotificationChannel, type TelegramConfig, type WebPushConfig,
} from './notificationStore.ts'
import { renderNotification, type RenderedNotification } from './render.ts'

// Outbound delivery. Two rules govern everything here:
//
//  1. The inbox row lands FIRST and is the durable record — a notification is
//     "delivered" once it is in the inbox, whether or not any channel is
//     configured or any send succeeds. Sends are fire-and-forget afterwards, so
//     nothing an external service does can delay the evaluator or a request.
//  2. Nothing identifying is ever logged. Push endpoints, push keys, Telegram
//     chat ids, the bot token and rule params are private user data; failures
//     are counted, not described.

const TELEGRAM_TIMEOUT_MS = 10_000
const TELEGRAM_MAX_ATTEMPTS = 3          // the initial send plus ≤2 retries
// Wait between Telegram attempts. A retry in the same millisecond only asks a
// rate limiter the same question twice; a 429's own `retry_after` wins over this
// but is capped, because the evaluator is not going to sit out a minute.
const TELEGRAM_RETRY_MS = 250
const TELEGRAM_MAX_WAIT_MS = 5_000
// Per-account outbound ceiling. Overflow still reaches the inbox; only the
// push/Telegram messages stop, plus one notice when the ceiling trips.
const HOURLY_SEND_CAP = 30
const HOUR_MS = 3_600_000

const counters = { inbox: 0, webpushSent: 0, webpushFailed: 0, telegramSent: 0, telegramFailed: 0, duplicates: 0, rateLimited: 0 }
export function deliveryCounters(): Readonly<typeof counters> { return { ...counters } }

interface SendWindow { times: number[]; suppressed: number; noticeSent: boolean }
const sendWindows = new Map<string, SendWindow>()

export function resetDeliveryStateForTests(): void {
  sendWindows.clear()
  for (const k of Object.keys(counters) as (keyof typeof counters)[]) counters[k] = 0
  vapidConfigured = false
}

/* ============ env ============ */

const env = (name: string) => process.env[name]?.trim() || ''
export function vapidPublicKey(): string { return env('VAPID_PUBLIC_KEY') }
export function webPushConfigured(): boolean { return !!(env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY')) }
export function telegramBotToken(): string { return env('TELEGRAM_BOT_TOKEN') }
export function telegramConfigured(): boolean { return !!telegramBotToken() }

let vapidConfigured = false
function ensureVapid(): boolean {
  if (!webPushConfigured()) return false
  if (vapidConfigured) return true
  webpush.setVapidDetails(env('VAPID_SUBJECT') || 'mailto:notifications@localhost', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'))
  vapidConfigured = true
  return true
}

/* ============ notification ============ */

export interface DeliverableNotification {
  /** Deterministic: sha256(ruleId + ':' + eventIdentity). */
  notificationId: string
  accountId: string
  ruleId: string
  kind: string
  rendered: RenderedNotification
  /**
   * What the channels actually receive, when it differs from the inbox row.
   * The evaluator coalesces several matches of one rule in one tick into a
   * single digest message while every match still keeps its own inbox entry,
   * so the leading match carries the digest here and its own detail in
   * `rendered`.
   */
  outbound?: RenderedNotification
  blockHeight?: number
  /** Push notification grouping tag; defaults to the rule id. */
  tag?: string
}

export type DeliveryOutcome = 'delivered' | 'duplicate' | 'rate-limited'

/** Inbox rows for one batch, with the ids to remember once the write lands. */
export interface PreparedNotifications { rows: InboxInsert[]; ids: string[] }

// Duplicate-filtered inbox rows for a whole tick. Both the persisted
// ReplacingMergeTree key and this in-memory set collapse a repeat, so filtering
// here is what keeps a replayed window from re-sending rather than re-writing.
//
// A row stores the notification's site-relative PATH: the inbox is rendered by
// the SPA router, which resolves an absolute URL to nothing. The absolute URL is
// for the surfaces that leave the site (push payloads, Telegram).
export function prepareNotifications(items: readonly DeliverableNotification[]): PreparedNotifications {
  const rows: InboxInsert[] = []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const n of items) {
    if (seen.has(n.notificationId) || hasNotification(n.notificationId)) { counters.duplicates++; continue }
    seen.add(n.notificationId)
    ids.push(n.notificationId)
    rows.push({
      notificationId: n.notificationId, accountId: n.accountId, ruleId: n.ruleId, kind: n.kind,
      title: n.rendered.title, body: n.rendered.body, url: n.rendered.path, blockHeight: n.blockHeight ?? 0,
    })
  }
  return { rows, ids }
}

// One insert for the batch, and the dedup set updated only AFTER it lands:
// remembering first would drop a notification for good every time the write
// failed, because the retry on the next tick would read as a duplicate.
export async function commitNotifications(prepared: PreparedNotifications): Promise<void> {
  if (!prepared.rows.length) return
  await insertInboxRows(prepared.rows)
  const now = Date.now()
  for (const id of prepared.ids) rememberNotification(id, now)
  counters.inbox += prepared.rows.length
}

// The outbound half: at most one message per rule per tick, subject to the
// account's rolling-hour budget. Sends are dispatched, not awaited.
export function sendOutbound(accountId: string, message: RenderedNotification, tag: string, channels: NotificationChannel[]): DeliveryOutcome {
  if (!channels.length) return 'delivered'
  if (!takeSendBudget(accountId)) {
    counters.rateLimited++
    const suppressed = claimRateLimitNotice(accountId)
    if (suppressed > 0) {
      const notice = renderNotification({
        title: 'Alerts rate limited',
        body: [`${suppressed} alert${suppressed === 1 ? '' : 's'} suppressed this hour — every one is still in your inbox.`],
        path: '/notifications',
      })
      for (const channel of channels) void sendToChannel(channel, notice, 'rate-limit').catch(() => {})
    }
    return 'rate-limited'
  }
  for (const channel of channels) void sendToChannel(channel, message, tag).catch(() => {})
  return 'delivered'
}

// Single-notification delivery: prepare, write, send. The evaluator batches its
// tick through the three steps directly; this is the shape everything else
// (a test message, a one-off) wants.
export async function deliverNotification(n: DeliverableNotification, channels: NotificationChannel[]): Promise<DeliveryOutcome> {
  const prepared = prepareNotifications([n])
  if (!prepared.rows.length) return 'duplicate'
  await commitNotifications(prepared)
  return sendOutbound(n.accountId, n.outbound ?? n.rendered, n.tag ?? n.ruleId, channels)
}

// Rolling-hour budget. The first refusal in a window emits one notice, so the
// account learns that the rest of the hour is inbox-only instead of silently
// missing messages. The notice is sent outside the budget — it exists to explain
// that the budget is gone.
function takeSendBudget(accountId: string): boolean {
  const now = Date.now()
  const w = sendWindows.get(accountId) ?? { times: [], suppressed: 0, noticeSent: false }
  sendWindows.set(accountId, w)
  w.times = w.times.filter(t => now - t < HOUR_MS)
  if (w.times.length === 0) { w.suppressed = 0; w.noticeSent = false }
  if (w.times.length < HOURLY_SEND_CAP) { w.times.push(now); return true }
  w.suppressed++
  return false
}

// Whether a rate-limit notice is still owed for this account, and claiming it.
export function claimRateLimitNotice(accountId: string): number {
  const w = sendWindows.get(accountId)
  if (!w || w.noticeSent || w.suppressed === 0) return 0
  w.noticeSent = true
  return w.suppressed
}

export async function sendToChannel(channel: NotificationChannel, rendered: RenderedNotification, tag: string): Promise<void> {
  if (channel.kind === 'webpush') return sendWebPush(channel, rendered, tag)
  return sendTelegram(channel, rendered)
}

/* ============ web push ============ */

async function sendWebPush(channel: NotificationChannel, rendered: RenderedNotification, tag: string): Promise<void> {
  if (!ensureVapid()) return
  const cfg = channel.config as WebPushConfig
  const payload = JSON.stringify({ title: rendered.title, body: rendered.body, url: rendered.url, tag })
  try {
    await webpush.sendNotification(
      { endpoint: cfg.endpoint, keys: { p256dh: cfg.p256dh, auth: cfg.auth } },
      payload,
      { TTL: 3600 },
    )
    counters.webpushSent++
  } catch (err) {
    counters.webpushFailed++
    const status = (err as { statusCode?: number })?.statusCode
    // 404/410 is the push service saying this subscription is permanently
    // gone — the browser dropped it or the user cleared site data.
    if (status === 404 || status === 410) await removeChannelById(channel.channelId).catch(() => {})
  }
}

/* ============ telegram ============ */

async function sendTelegram(channel: NotificationChannel, rendered: RenderedNotification): Promise<void> {
  const token = telegramBotToken()
  if (!token) return
  const cfg = channel.config as TelegramConfig
  const body = JSON.stringify({
    chat_id: cfg.chatId,
    text: rendered.telegramHtml,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
  for (let attempt = 0; attempt < TELEGRAM_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(TELEGRAM_RETRY_MS)
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      })
      if (res.ok) { counters.telegramSent++; return }
      // 403 = the user blocked the bot or left the chat. Keep the channel so
      // the account can see it needs re-linking, but stop treating it as live.
      if (res.status === 403) {
        counters.telegramFailed++
        await setChannelVerified(channel.channelId, false).catch(() => {})
        return
      }
      // 429 says exactly how long to wait; anything longer than the cap is
      // treated as "not this message" rather than parked on.
      if (res.status === 429) {
        const wait = await retryAfterMs(res)
        if (wait > TELEGRAM_MAX_WAIT_MS) { counters.telegramFailed++; return }
        await sleep(wait)
        continue
      }
      // 4xx other than 429 is a permanent rejection of this message.
      if (res.status >= 400 && res.status < 500) { counters.telegramFailed++; return }
    } catch { /* timeout or transport error — retry within the attempt budget */ }
  }
  counters.telegramFailed++
}

const sleep = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); t.unref?.() })

// Telegram puts the wait in `parameters.retry_after` (seconds). An unreadable
// body falls back to the fixed gap the next attempt would take anyway.
async function retryAfterMs(res: Response): Promise<number> {
  try {
    const body = await res.json() as { parameters?: { retry_after?: number } }
    const seconds = Number(body?.parameters?.retry_after)
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000)
  } catch { /* no body, or not JSON */ }
  return TELEGRAM_RETRY_MS
}
