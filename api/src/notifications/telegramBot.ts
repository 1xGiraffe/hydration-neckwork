import { randomBytes } from 'node:crypto'
import { telegramBotToken } from './delivery.ts'
import { escapeHtml, explorerUrl } from './render.ts'
import { upsertTelegramChannel, telegramChannelForChat, removeChannelById } from './notificationStore.ts'

// The Telegram side of channel setup: a logged-in account mints a short-lived
// link code, opens `https://t.me/<bot>?start=<code>`, and the bot's long-poll
// loop turns the resulting `/start <code>` into a verified channel for that
// account. Codes live in memory only (deviceLinkService is the model): a lost
// code just means pressing Link again, so an api restart mid-handoff is a
// retry, not a failure mode.

const LINK_TTL_MS = 10 * 60_000
// One account only ever needs one live code — pressing Link again while the last
// one is still valid is the only way to hold several. The per-account cap is what
// actually bounds the pool; the global one is a backstop, and on its own it let
// a single account fill it and lock everybody else out of linking.
const MAX_PENDING_LINKS = 1000
const MAX_PENDING_LINKS_PER_ACCOUNT = 5
// The bot the deep link points at until getMe reports otherwise (it only
// answers when a token is configured, and the link must render either way).
const DEFAULT_BOT_USERNAME = 'hydration_explorer_bot'

interface PendingLink { accountId: string; expiresAtMs: number; claimed: boolean }
const linksByCode = new Map<string, PendingLink>()
let botUsername = DEFAULT_BOT_USERNAME

export function telegramBotUsername(): string { return botUsername }
export function resetTelegramLinksForTests(): void { linksByCode.clear(); botUsername = DEFAULT_BOT_USERNAME }

function sweepLinks(): void {
  const now = Date.now()
  for (const [code, link] of linksByCode) if (link.expiresAtMs < now) linksByCode.delete(code)
}

// The raw code is the credential the deep link carries, so unlike a session
// token it must be readable back to build the URL the user taps — it is
// single-use, expires in ten minutes, and only ever travels to the account
// that minted it.
export function createTelegramLink(accountId: string): { code: string; url: string; expiresAt: string } | null {
  sweepLinks()
  if (linksByCode.size >= MAX_PENDING_LINKS) return null
  let mine = 0
  for (const link of linksByCode.values()) if (link.accountId === accountId && !link.claimed) mine++
  if (mine >= MAX_PENDING_LINKS_PER_ACCOUNT) return null
  const code = randomBytes(12).toString('hex')
  const expiresAtMs = Date.now() + LINK_TTL_MS
  linksByCode.set(code, { accountId, expiresAtMs, claimed: false })
  return { code, url: `https://t.me/${botUsername}?start=${code}`, expiresAt: new Date(expiresAtMs).toISOString() }
}

// Only the minting account may observe a code's progress; unknown and expired
// collapse to 'expired' because after the sweep they are the same thing.
export function telegramLinkStatus(code: string, accountId: string): 'pending' | 'claimed' | 'expired' {
  const link = linksByCode.get(code)
  if (!link || link.accountId !== accountId || (!link.claimed && link.expiresAtMs < Date.now())) return 'expired'
  return link.claimed ? 'claimed' : 'pending'
}

function claimLink(code: string): string | null {
  const link = linksByCode.get(code)
  if (!link || link.claimed || link.expiresAtMs < Date.now()) return null
  link.claimed = true
  return link.accountId
}

/* ============ update handling ============ */

interface TelegramUpdate {
  update_id: number
  message?: {
    chat?: { id?: number | string; username?: string }
    from?: { username?: string }
    text?: string
  }
}

// Exported for tests: the pure-ish half of the loop, with the network reduced
// to the single reply it sends.
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message
  const chatId = message?.chat?.id
  const textValue = message?.text?.trim()
  if (chatId === undefined || chatId === null || !textValue) return
  const chat = String(chatId)
  const username = message?.chat?.username ?? message?.from?.username ?? ''

  if (textValue === '/stop' || textValue.startsWith('/stop ')) {
    const existing = telegramChannelForChat(chat)
    if (existing) await removeChannelById(existing.channelId)
    await sendChatMessage(chat, existing
      ? 'Unlinked. This chat will not receive Hydration Explorer alerts any more.'
      : 'This chat is not linked to a Hydration Explorer account.')
    return
  }

  if (!textValue.startsWith('/start')) return
  const code = textValue.slice('/start'.length).trim().split(/\s+/)[0] ?? ''
  if (!code) {
    await sendChatMessage(chat, `Open <a href="${escapeHtml(explorerUrl('/notifications'))}">Hydration Explorer alerts</a> and press Link to connect this chat.`)
    return
  }
  const accountId = claimLink(code)
  if (!accountId) {
    await sendChatMessage(chat, 'That link code has expired or was already used. Press Link again in the explorer.')
    return
  }
  await upsertTelegramChannel(accountId, { chatId: chat, username })
  await sendChatMessage(chat, `Linked. This chat will now receive your Hydration Explorer alerts. Send /stop to unlink, or manage them at <a href="${escapeHtml(explorerUrl('/notifications'))}">the explorer</a>.`)
}

async function sendChatMessage(chatId: string, html: string): Promise<void> {
  const token = telegramBotToken()
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch { /* a lost confirmation is not worth a retry; the channel already exists */ }
}

/* ============ long-poll loop ============ */

const POLL_TIMEOUT_S = 30
const MAX_BACKOFF_MS = 60_000
let running = false
let inFlight: AbortController | null = null
let offset = 0
let backoffMs = 1000

// Started from server.ts after listen, only when a token is configured. The
// loop never throws: a failing poll backs off and tries again, because the
// alternative is an unattended process dying on a transient Telegram outage.
export function startTelegramBot(): void {
  if (running || !telegramBotToken()) return
  running = true
  backoffMs = 1000
  void refreshBotUsername()
  void pollLoop()
}

export function stopTelegramBot(): void {
  running = false
  inFlight?.abort()
  inFlight = null
}

async function refreshBotUsername(): Promise<void> {
  const token = telegramBotToken()
  if (!token) return
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return
    const body = await res.json() as { result?: { username?: string } }
    if (body.result?.username) botUsername = body.result.username
  } catch { /* keep the default username */ }
}

async function pollLoop(): Promise<void> {
  while (running) {
    const token = telegramBotToken()
    if (!token) { running = false; return }
    const controller = new AbortController()
    inFlight = controller
    const timer = setTimeout(() => controller.abort(), (POLL_TIMEOUT_S + 5) * 1000)
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeout: POLL_TIMEOUT_S, offset, allowed_updates: ['message'] }),
        signal: controller.signal,
      })
      if (!res.ok) { await backoff(); continue }
      const body = await res.json() as { result?: TelegramUpdate[] }
      const updates = body.result ?? []
      backoffMs = 1000
      for (const update of updates) {
        // Acknowledge before handling: a poison update must not be replayed
        // forever, and every handler path is best-effort by design.
        offset = Math.max(offset, update.update_id + 1)
        try { await handleTelegramUpdate(update) } catch { /* one bad update never stops the loop */ }
      }
    } catch {
      if (running) await backoff()
    } finally {
      clearTimeout(timer)
      inFlight = null
    }
  }
}

async function backoff(): Promise<void> {
  const wait = backoffMs
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  await new Promise<void>(resolve => { const t = setTimeout(resolve, wait); t.unref?.() })
}
