import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createTelegramLink, telegramLinkStatus, handleTelegramUpdate, telegramBotUsername, resetTelegramLinksForTests,
} from '../src/notifications/telegramBot.ts'
import { initNotifications, loadNotifications, channelsFor, telegramChannelForChat } from '../src/notifications/notificationStore.ts'
import { fakeClient, type FakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const OTHER = '0x' + 'bb'.repeat(32)

let client: FakeClient
let fetchMock: ReturnType<typeof vi.fn>
const originalFetch = globalThis.fetch
let savedToken: string | undefined

const update = (id: number, chatId: number | string, text: string, username = 'maf') => ({
  update_id: id, message: { chat: { id: chatId, username }, text },
})

beforeEach(async () => {
  client = fakeClient()
  initNotifications(client)
  await loadNotifications()
  resetTelegramLinksForTests()
  savedToken = process.env.TELEGRAM_BOT_TOKEN
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response)
  globalThis.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
  else process.env.TELEGRAM_BOT_TOKEN = savedToken
})

describe('telegram link codes', () => {
  it('mints a deep link the user can tap, pending until claimed', () => {
    const link = createTelegramLink(OWNER)!
    expect(link.url).toBe(`https://t.me/${telegramBotUsername()}?start=${link.code}`)
    expect(telegramLinkStatus(link.code, OWNER)).toBe('pending')
    // Only the minting account may observe it; anyone else sees 'expired'.
    expect(telegramLinkStatus(link.code, OTHER)).toBe('expired')
    expect(telegramLinkStatus('nosuchcode', OWNER)).toBe('expired')
  })

  it('claims a code exactly once, creating a verified channel for the chat', async () => {
    const link = createTelegramLink(OWNER)!
    await handleTelegramUpdate(update(1, 4242, `/start ${link.code}`))
    expect(telegramLinkStatus(link.code, OWNER)).toBe('claimed')
    const [channel] = channelsFor(OWNER)
    expect(channel).toMatchObject({ kind: 'telegram', verified: true })
    expect(channel.config).toEqual({ chatId: '4242', username: 'maf' })
    // A welcome message goes back to the chat.
    const body = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body))
    expect(body).toMatchObject({ chat_id: '4242', parse_mode: 'HTML' })
    expect(body.text).toContain('Linked')

    // Single-use: a replayed code (shoulder-surfed, screenshotted) is refused.
    await handleTelegramUpdate(update(2, 5555, `/start ${link.code}`))
    expect(telegramChannelForChat('5555')).toBeNull()
    expect(JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)).text).toContain('expired or was already used')
  })

  it('answers a bare /start with instructions rather than creating anything', async () => {
    await handleTelegramUpdate(update(1, 4242, '/start'))
    expect(channelsFor(OWNER)).toHaveLength(0)
    expect(JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)).text).toContain('press Link')
  })

  it('unlinks the chat on /stop', async () => {
    const link = createTelegramLink(OWNER)!
    await handleTelegramUpdate(update(1, 4242, `/start ${link.code}`))
    await handleTelegramUpdate(update(2, 4242, '/stop'))
    expect(channelsFor(OWNER)).toHaveLength(0)
    expect(telegramChannelForChat('4242')).toBeNull()
    expect(JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)).text).toContain('Unlinked')
  })

  it('ignores updates that carry no chat or no text', async () => {
    await handleTelegramUpdate({ update_id: 1, message: { text: '/start x' } })
    await handleTelegramUpdate({ update_id: 2, message: { chat: { id: 1 } } })
    await handleTelegramUpdate({ update_id: 3, message: { chat: { id: 1 }, text: 'hello' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
