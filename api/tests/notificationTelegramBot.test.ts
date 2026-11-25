import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createTelegramLink, telegramLinkStatus, handleTelegramUpdate, telegramBotUsername, resetTelegramLinksForTests,
} from '../src/notifications/telegramBot.ts'
import { initNotifications, loadNotifications, channelsFor, telegramChannelForChat } from '../src/notifications/notificationStore.ts'
import { fakeClient, type FakeClient } from './helpers/userFakes.ts'
import { accountRef } from '../src/services/explorerService.ts'
import { shortAddress } from '../src/notifications/render.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const OTHER = '0x' + 'bb'.repeat(32)

let client: FakeClient
let fetchMock: ReturnType<typeof vi.fn>
const originalFetch = globalThis.fetch
let savedToken: string | undefined

const update = (id: number, chatId: number | string, text: string, username = 'alice') => ({
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

const lastText = () => JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)).text as string
const shortOf = (accountId: string) => shortAddress(accountRef(accountId).address)

describe('telegram link codes', () => {
  it('mints a deep link the user can tap, polled by a separate link id', () => {
    const link = createTelegramLink(OWNER)!
    expect(link.url).toBe(`https://t.me/${telegramBotUsername()}?start=${link.code}`)
    expect(link.linkId).not.toContain(link.code)
    expect(telegramLinkStatus(link.linkId, OWNER)).toBe('pending')
    // Only the minting account may observe it; anyone else sees 'expired'.
    expect(telegramLinkStatus(link.linkId, OTHER)).toBe('expired')
    // The code is not a poll handle.
    expect(telegramLinkStatus(link.code, OWNER)).toBe('expired')
    expect(telegramLinkStatus('nosuchlink', OWNER)).toBe('expired')
  })

  it('names the account and links the chat only after /confirm, exactly once', async () => {
    const link = createTelegramLink(OWNER)!
    await handleTelegramUpdate(update(1, 4242, `/start ${link.code}`))
    // Nothing is linked yet: the bot asks, naming the account by its short address.
    expect(channelsFor(OWNER)).toHaveLength(0)
    expect(telegramLinkStatus(link.linkId, OWNER)).toBe('pending')
    expect(lastText()).toContain(shortOf(OWNER))
    expect(lastText()).toContain('/confirm')

    await handleTelegramUpdate(update(2, 4242, '/confirm'))
    expect(telegramLinkStatus(link.linkId, OWNER)).toBe('claimed')
    const [channel] = channelsFor(OWNER)
    expect(channel).toMatchObject({ kind: 'telegram', verified: true })
    expect(channel.config).toEqual({ chatId: '4242', username: 'alice' })
    const body = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body))
    expect(body).toMatchObject({ chat_id: '4242', parse_mode: 'HTML' })
    expect(body.text).toContain('Linked')
    expect(body.text).toContain(shortOf(OWNER))

    // Single-use: a replayed code (shoulder-surfed, screenshotted) is refused.
    await handleTelegramUpdate(update(3, 5555, `/start ${link.code}`))
    expect(telegramChannelForChat('5555')).toBeNull()
    expect(lastText()).toContain('expired or was already used')
    // And a second /confirm has nothing left to confirm.
    await handleTelegramUpdate(update(4, 4242, '/confirm'))
    expect(lastText()).toContain('nothing to confirm')
  })

  it('only the chat that opened the code can confirm it', async () => {
    const link = createTelegramLink(OWNER)!
    await handleTelegramUpdate(update(1, 4242, `/start ${link.code}`))
    await handleTelegramUpdate(update(2, 5555, '/confirm'))
    expect(lastText()).toContain('nothing to confirm')
    expect(channelsFor(OWNER)).toHaveLength(0)
  })

  it('never moves a chat linked to another account; the chat must /stop first', async () => {
    const mine = createTelegramLink(OWNER)!
    await handleTelegramUpdate(update(1, 4242, `/start ${mine.code}`))
    await handleTelegramUpdate(update(2, 4242, '/confirm'))
    expect(telegramChannelForChat('4242')?.accountId).toBe(OWNER)

    // A code minted by another account, tapped in the already-linked chat.
    const theirs = createTelegramLink(OTHER)!
    await handleTelegramUpdate(update(3, 4242, `/start ${theirs.code}`))
    expect(lastText()).toContain('/stop')
    expect(lastText()).toContain(shortOf(OWNER))
    await handleTelegramUpdate(update(4, 4242, '/confirm'))
    expect(telegramChannelForChat('4242')?.accountId).toBe(OWNER)
    expect(channelsFor(OTHER)).toHaveLength(0)
    expect(telegramLinkStatus(theirs.linkId, OTHER)).toBe('pending')

    // After /stop the chat may be linked again, still with a confirmation.
    await handleTelegramUpdate(update(5, 4242, '/stop'))
    await handleTelegramUpdate(update(6, 4242, `/start ${theirs.code}`))
    expect(lastText()).toContain(shortOf(OTHER))
    await handleTelegramUpdate(update(7, 4242, '/confirm'))
    expect(telegramChannelForChat('4242')?.accountId).toBe(OTHER)
  })

  it('re-links a chat to the account it already belongs to without asking', async () => {
    const first = createTelegramLink(OWNER)!
    await handleTelegramUpdate(update(1, 4242, `/start ${first.code}`))
    await handleTelegramUpdate(update(2, 4242, '/confirm'))
    const second = createTelegramLink(OWNER)!
    await handleTelegramUpdate(update(3, 4242, `/start ${second.code}`, 'alice_new'))
    expect(telegramLinkStatus(second.linkId, OWNER)).toBe('claimed')
    expect(channelsFor(OWNER)).toHaveLength(1)
    expect(channelsFor(OWNER)[0].config).toEqual({ chatId: '4242', username: 'alice_new' })
  })

  it('answers a bare /start with instructions rather than creating anything', async () => {
    await handleTelegramUpdate(update(1, 4242, '/start'))
    expect(channelsFor(OWNER)).toHaveLength(0)
    expect(lastText()).toContain('press Link')
  })

  it('unlinks the chat on /stop', async () => {
    const link = createTelegramLink(OWNER)!
    await handleTelegramUpdate(update(1, 4242, `/start ${link.code}`))
    await handleTelegramUpdate(update(2, 4242, '/confirm'))
    await handleTelegramUpdate(update(3, 4242, '/stop'))
    expect(channelsFor(OWNER)).toHaveLength(0)
    expect(telegramChannelForChat('4242')).toBeNull()
    expect(lastText()).toContain('Unlinked')
  })

  it('ignores updates that carry no chat or no text', async () => {
    await handleTelegramUpdate({ update_id: 1, message: { text: '/start x' } })
    await handleTelegramUpdate({ update_id: 2, message: { chat: { id: 1 } } })
    await handleTelegramUpdate({ update_id: 3, message: { chat: { id: 1 }, text: 'hello' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
