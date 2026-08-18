import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({})) } }))

import webpush from 'web-push'
import {
  initNotifications, loadNotifications, createWebPushChannel, upsertTelegramChannel,
  channelsFor, getChannel, hasNotification, clearInbox,
} from '../src/notifications/notificationStore.ts'
import { deliverNotification, deliveryCounters, resetDeliveryStateForTests, webPushConfigured } from '../src/notifications/delivery.ts'
import { renderNotification, text, account } from '../src/notifications/render.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'p'.repeat(20), auth: 'a'.repeat(20) }
const SS58 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'

const rendered = () => renderNotification({
  title: [text('Safety action')],
  body: [[text('by'), account({ accountId: '0x' + 'cd'.repeat(32), address: SS58, emoji: '🐍', identity: { display: 'A & B', verified: true } })]],
  path: '/security',
})

const notification = (id: string) => ({
  notificationId: id, accountId: OWNER, ruleId: 'rule-1', kind: 'safety', rendered: rendered(), blockHeight: 9_000_001,
})

const sendMock = webpush.sendNotification as unknown as ReturnType<typeof vi.fn>
let client: FakeClient
let fetchMock: ReturnType<typeof vi.fn>
const originalFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const okResponse = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response
const statusResponse = (status: number) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response

beforeEach(async () => {
  client = fakeClient()
  initNotifications(client)
  await loadNotifications()
  resetDeliveryStateForTests()
  sendMock.mockReset()
  sendMock.mockResolvedValue({})
  fetchMock = vi.fn(async () => okResponse())
  globalThis.fetch = fetchMock as unknown as typeof fetch
  setEnv('TELEGRAM_BOT_TOKEN', 'test-token')
  setEnv('VAPID_PUBLIC_KEY', 'pub')
  setEnv('VAPID_PRIVATE_KEY', 'priv')
  setEnv('VAPID_SUBJECT', 'mailto:ops@example.test')
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
})

describe('deliverNotification', () => {
  it('writes the inbox row even when the account has no channel at all', async () => {
    expect(await deliverNotification(notification('n1'), [])).toBe('delivered')
    const [row] = insertedRows(client, 'user_notification_inbox')
    expect(row).toMatchObject({
      notification_id: 'n1', account_id: OWNER, rule_id: 'rule-1', kind: 'safety',
      title: 'Safety action', block_height: 9_000_001, read: 0, deleted: 0,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // The inbox is rendered by the SPA router, which prefixes a leading '/' to
  // whatever it is handed — an absolute URL there resolves to nothing. The
  // absolute form belongs to the surfaces that leave the site.
  it('stores the site-relative path in the inbox row and the absolute url on the wire', async () => {
    const channel = await upsertTelegramChannel(OWNER, { chatId: '4242', username: 'maf' })
    const push = await createWebPushChannel(OWNER, SUB)
    await deliverNotification(notification('p1'), [channel, push])
    expect(insertedRows(client, 'user_notification_inbox')[0]).toMatchObject({ url: '/security' })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const telegram = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(telegram.text).toContain('href="https://')
    expect(telegram.text).toContain('/security"><b>')
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(sendMock.mock.calls[0][1])).url).toMatch(/^https:\/\/.+\/security$/)
  })

  // Remembering the id before the write would make the retry on the next tick
  // read as a duplicate, losing the notification for good.
  it('does not remember a notification whose inbox write failed', async () => {
    const broken = fakeClient()
    broken.insert = (async () => { throw new Error('inbox is read-only') }) as unknown as typeof broken.insert
    initNotifications(broken)
    await loadNotifications()
    await expect(deliverNotification(notification('f1'), [])).rejects.toThrow()
    expect(hasNotification('f1')).toBe(false)

    // The same notification lands once the write works again.
    initNotifications(client)
    await loadNotifications()
    expect(await deliverNotification(notification('f1'), [])).toBe('delivered')
    expect(insertedRows(client, 'user_notification_inbox')).toHaveLength(1)
  })

  it('writes the inbox row before any send is dispatched', async () => {
    const channel = await upsertTelegramChannel(OWNER, { chatId: '4242', username: 'maf' })
    await deliverNotification(notification('n2'), [channel])
    expect(insertedRows(client, 'user_notification_inbox')).toHaveLength(1)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('suppresses a repeat of the same notification id', async () => {
    expect(await deliverNotification(notification('n3'), [])).toBe('delivered')
    expect(await deliverNotification(notification('n3'), [])).toBe('duplicate')
    expect(insertedRows(client, 'user_notification_inbox')).toHaveLength(1)
    expect(deliveryCounters().duplicates).toBe(1)
  })

  // The whole point of seeding the recent-id set from the inbox: a restart or
  // a ClickHouse replay must not re-deliver what already went out.
  it('stays suppressed across a reload', async () => {
    await deliverNotification(notification('n4'), [])
    const replayed = fakeClient({ user_notification_inbox: insertedRows(client, 'user_notification_inbox') })
    initNotifications(replayed)
    await loadNotifications()
    expect(hasNotification('n4')).toBe(true)
    expect(await deliverNotification(notification('n4'), [])).toBe('duplicate')
    expect(insertedRows(replayed, 'user_notification_inbox')).toHaveLength(0)
  })

  // Clearing the inbox empties the HISTORY, and must never re-open the door for
  // what already went out: the dedup seed at boot reads soft-deleted rows too,
  // so a restart after a clear still recognises every id it delivered.
  it('stays suppressed after the inbox was cleared and the api restarted', async () => {
    expect(await deliverNotification(notification('n5'), [])).toBe('delivered')

    const clearing = fakeClient({ user_notification_inbox: insertedRows(client, 'user_notification_inbox') })
    initNotifications(clearing)
    await loadNotifications()
    expect(await clearInbox(OWNER)).toBe(1)
    const tombstones = insertedRows(clearing, 'user_notification_inbox')
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]).toMatchObject({ notification_id: 'n5', deleted: 1 })

    // The restart: the inbox holds only the soft-deleted row now.
    const restarted = fakeClient({ user_notification_inbox: tombstones })
    initNotifications(restarted)
    await loadNotifications()
    expect(hasNotification('n5')).toBe(true)
    expect(await deliverNotification(notification('n5'), [])).toBe('duplicate')
    expect(insertedRows(restarted, 'user_notification_inbox')).toHaveLength(0)
  })
})

describe('telegram send', () => {
  it('posts the rendered HTML with previews disabled and never logs the chat id', async () => {
    const channel = await upsertTelegramChannel(OWNER, { chatId: '4242', username: 'maf' })
    await deliverNotification(notification('t1'), [channel])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ chat_id: '4242', parse_mode: 'HTML', disable_web_page_preview: true })
    expect(body.text).toContain('A &amp; B ✓')
    expect(body.text).not.toContain('A & B')
  })

  it('marks the channel unverified when the bot is blocked (403)', async () => {
    fetchMock.mockResolvedValue(statusResponse(403))
    const channel = await upsertTelegramChannel(OWNER, { chatId: '4242', username: 'maf' })
    await deliverNotification(notification('t2'), [channel])
    await vi.waitFor(() => expect(getChannel(channel.channelId)?.verified).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries at most twice on a transport failure, with a gap between attempts', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const channel = await upsertTelegramChannel(OWNER, { chatId: '4242', username: 'maf' })
    const startedAt = Date.now()
    await deliverNotification(notification('t3'), [channel])
    await vi.waitFor(() => expect(deliveryCounters().telegramFailed).toBe(1), { timeout: 5_000 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // Retrying in the same millisecond only asks a rate limiter twice.
    expect(Date.now() - startedAt).toBeGreaterThan(200)
  })

  // 429 is the one status that says how long to wait; anything past the cap is
  // dropped rather than parked on, because the evaluator keeps ticking.
  it('honours retry_after on a 429 and gives up when it exceeds the cap', async () => {
    const channel = await upsertTelegramChannel(OWNER, { chatId: '4242', username: 'maf' })
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ parameters: { retry_after: 1 } }) } as unknown as Response)
    fetchMock.mockResolvedValue(okResponse())
    const startedAt = Date.now()
    await deliverNotification(notification('t5'), [channel])
    await vi.waitFor(() => expect(deliveryCounters().telegramSent).toBe(1), { timeout: 5_000 })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000)

    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ parameters: { retry_after: 600 } }) } as unknown as Response)
    await deliverNotification(notification('t6'), [channel])
    await vi.waitFor(() => expect(deliveryCounters().telegramFailed).toBe(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a permanent 4xx', async () => {
    fetchMock.mockResolvedValue(statusResponse(400))
    const channel = await upsertTelegramChannel(OWNER, { chatId: '4242', username: 'maf' })
    await deliverNotification(notification('t4'), [channel])
    await vi.waitFor(() => expect(deliveryCounters().telegramFailed).toBe(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('web push send', () => {
  it('sends the JSON payload the service worker expects', async () => {
    const channel = await createWebPushChannel(OWNER, SUB, 'Firefox')
    await deliverNotification({ ...notification('w1'), tag: 'safety' }, [channel])
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1))
    const [subscription, payload] = sendMock.mock.calls[0]
    expect(subscription).toEqual({ endpoint: SUB.endpoint, keys: { p256dh: SUB.p256dh, auth: SUB.auth } })
    expect(JSON.parse(String(payload))).toMatchObject({ title: 'Safety action', tag: 'safety' })
  })

  it('soft-deletes the channel when the push service reports it gone', async () => {
    const channel = await createWebPushChannel(OWNER, SUB)
    sendMock.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }))
    await deliverNotification(notification('w2'), [channel])
    await vi.waitFor(() => expect(channelsFor(OWNER)).toHaveLength(0))
  })

  it('is a no-op with no VAPID keys configured', async () => {
    const channel = await createWebPushChannel(OWNER, SUB)
    setEnv('VAPID_PUBLIC_KEY', undefined)
    setEnv('VAPID_PRIVATE_KEY', undefined)
    resetDeliveryStateForTests()
    expect(webPushConfigured()).toBe(false)
    await deliverNotification(notification('w3'), [channel])
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(sendMock).not.toHaveBeenCalled()
    // The inbox row still lands — an unsendable channel never loses a record.
    expect(insertedRows(client, 'user_notification_inbox')).toHaveLength(1)
  })
})

describe('per-account hourly cap', () => {
  it('records overflow in the inbox and announces the cap exactly once', async () => {
    const channel = await upsertTelegramChannel(OWNER, { chatId: '4242', username: 'maf' })
    for (let i = 0; i < 30; i++) expect(await deliverNotification(notification(`c${i}`), [channel])).toBe('delivered')
    expect(await deliverNotification(notification('c30'), [channel])).toBe('rate-limited')
    expect(await deliverNotification(notification('c31'), [channel])).toBe('rate-limited')
    // Every one of the 32 is still in the inbox.
    expect(insertedRows(client, 'user_notification_inbox')).toHaveLength(32)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(31))
    const notices = fetchMock.mock.calls.filter(c => String((c[1] as RequestInit).body).includes('rate limited'))
    expect(notices).toHaveLength(1)
    expect(deliveryCounters().rateLimited).toBe(2)
  })
})
