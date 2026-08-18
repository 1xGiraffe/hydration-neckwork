import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({})) } }))

import Fastify from 'fastify'
import { notificationRoutes } from '../src/routes/notifications.ts'
import { initUserAuthService, issueSession, resetUserAuthForTests } from '../src/services/userAuthService.ts'
import { initNotifications, loadNotifications, channelsFor, rulesFor } from '../src/notifications/notificationStore.ts'
import { resetTelegramLinksForTests, telegramLinkStatus } from '../src/notifications/telegramBot.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { initTagService, loadTags } from '../src/services/tagService.ts'
import { fakeClient, type FakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const SS58 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
const SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'p'.repeat(24), auth: 'a'.repeat(24) },
}

let client: FakeClient
let token: string
const originalFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}
function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function build() {
  const f = Fastify()
  await f.register(notificationRoutes)
  return f
}
const auth = () => ({ authorization: `Bearer ${token}` })

beforeEach(async () => {
  client = fakeClient()
  initNotifications(client)
  await loadNotifications()
  resetUserAuthForTests()
  resetTelegramLinksForTests()
  resetDeliveryStateForTests()
  await initUserAuthService(fakeClient())
  token = await issueSession(OWNER)
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response) as unknown as typeof fetch
  setEnv('VAPID_PUBLIC_KEY', 'test-public-key')
  setEnv('VAPID_PRIVATE_KEY', 'test-private-key')
  setEnv('TELEGRAM_BOT_TOKEN', 'test-token')
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
})

describe('auth', () => {
  it('answers 401 on every route without a bearer token', async () => {
    const f = await build()
    const calls: [string, string][] = [
      ['GET', '/user/notifications/overview'],
      ['POST', '/user/notifications/channels/webpush'],
      ['POST', '/user/notifications/channels/telegram/link'],
      ['GET', '/user/notifications/channels/telegram/link/abcdef12'],
      ['DELETE', '/user/notifications/channels/x'],
      ['POST', '/user/notifications/channels/x/test'],
      ['POST', '/user/notifications/rules'],
      ['PATCH', '/user/notifications/rules/x'],
      ['DELETE', '/user/notifications/rules/x'],
      ['GET', '/user/notifications/inbox'],
      ['POST', '/user/notifications/inbox/read'],
      ['POST', '/user/notifications/inbox/clear'],
    ]
    for (const [method, url] of calls) {
      const res = await f.inject({ method: method as 'GET', url, payload: method === 'GET' || method === 'DELETE' ? undefined : {} })
      expect(res.statusCode, url).toBe(401)
      expect(res.headers['cache-control'], url).toBe('no-store')
    }
  })
})

describe('overview', () => {
  it('reports channels, rules, unread and the deployment\'s channel configuration', async () => {
    const f = await build()
    const res = await f.inject({ method: 'GET', url: '/user/notifications/overview', headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).toEqual({ channels: [], rules: [], unread: 0, vapidPublicKey: 'test-public-key', telegramBot: 'hydration_explorer_bot' })
  })

  it('reports both channels as unconfigured when their env is absent', async () => {
    setEnv('VAPID_PUBLIC_KEY', undefined)
    setEnv('TELEGRAM_BOT_TOKEN', undefined)
    const f = await build()
    const body = (await f.inject({ method: 'GET', url: '/user/notifications/overview', headers: auth() })).json()
    expect(body.vapidPublicKey).toBe('')
    expect(body.telegramBot).toBe('')
  })
})

describe('channels', () => {
  it('registers a web push subscription and answers with the host only, never the endpoint or keys', async () => {
    const f = await build()
    const res = await f.inject({
      method: 'POST', url: '/user/notifications/channels/webpush', headers: auth(),
      payload: { subscription: SUBSCRIPTION, label: 'Firefox on Linux' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ kind: 'webpush', label: 'Firefox on Linux', verified: true, endpointHost: 'fcm.googleapis.com' })
    expect(JSON.stringify(body)).not.toContain(SUBSCRIPTION.keys.auth)
    expect(JSON.stringify(body)).not.toContain('/fcm/send/abc123')
    expect(channelsFor(OWNER)).toHaveLength(1)
  })

  it('refuses a push registration when the deployment has no VAPID keys', async () => {
    setEnv('VAPID_PUBLIC_KEY', undefined)
    setEnv('VAPID_PRIVATE_KEY', undefined)
    const f = await build()
    const res = await f.inject({ method: 'POST', url: '/user/notifications/channels/webpush', headers: auth(), payload: { subscription: SUBSCRIPTION } })
    expect(res.statusCode).toBe(503)
  })

  it('rejects a malformed subscription', async () => {
    const f = await build()
    const res = await f.inject({ method: 'POST', url: '/user/notifications/channels/webpush', headers: auth(), payload: { subscription: { endpoint: 'nope' } } })
    expect(res.statusCode).toBe(400)
  })

  it('mints a telegram link code and reports its status', async () => {
    const f = await build()
    const link = (await f.inject({ method: 'POST', url: '/user/notifications/channels/telegram/link', headers: auth() })).json()
    expect(link.url).toContain(`?start=${link.code}`)
    expect(telegramLinkStatus(link.code, OWNER)).toBe('pending')
    const status = await f.inject({ method: 'GET', url: `/user/notifications/channels/telegram/link/${link.code}`, headers: auth() })
    expect(status.json()).toEqual({ status: 'pending' })
  })

  // The pool used to be global, so one account could fill it and lock everybody
  // else out of linking a chat.
  it('caps pending link codes per account rather than globally', async () => {
    const f = await build()
    const mint = () => f.inject({ method: 'POST', url: '/user/notifications/channels/telegram/link', headers: auth(), remoteAddress: '10.0.0.9' })
    for (let i = 0; i < 5; i++) expect((await mint()).statusCode).toBe(200)
    expect((await mint()).statusCode).toBe(503)
    // Another account is unaffected.
    const otherToken = await issueSession('0x' + 'bb'.repeat(32))
    const other = await f.inject({
      method: 'POST', url: '/user/notifications/channels/telegram/link',
      headers: { authorization: `Bearer ${otherToken}` }, remoteAddress: '10.0.0.10',
    })
    expect(other.statusCode).toBe(200)
  })

  it('refuses link creation when no bot token is configured', async () => {
    setEnv('TELEGRAM_BOT_TOKEN', undefined)
    const f = await build()
    const res = await f.inject({ method: 'POST', url: '/user/notifications/channels/telegram/link', headers: auth() })
    expect(res.statusCode).toBe(503)
  })

  it('sends a real rendered test message on a channel it owns, and 404s on one it does not', async () => {
    const f = await build()
    const channel = (await f.inject({
      method: 'POST', url: '/user/notifications/channels/webpush', headers: auth(), payload: { subscription: SUBSCRIPTION },
    })).json()
    const ok = await f.inject({ method: 'POST', url: `/user/notifications/channels/${channel.id}/test`, headers: auth() })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true })
    const missing = await f.inject({ method: 'POST', url: '/user/notifications/channels/does-not-exist/test', headers: auth() })
    expect(missing.statusCode).toBe(404)
  })

  it('deletes a channel', async () => {
    const f = await build()
    const channel = (await f.inject({
      method: 'POST', url: '/user/notifications/channels/webpush', headers: auth(), payload: { subscription: SUBSCRIPTION },
    })).json()
    const res = await f.inject({ method: 'DELETE', url: `/user/notifications/channels/${channel.id}`, headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(channelsFor(OWNER)).toHaveLength(0)
  })

  it('rate-limits link creation well below the plugin-wide budget', async () => {
    const f = await build()
    let limited = false
    for (let i = 0; i < 12; i++) {
      const res = await f.inject({ method: 'POST', url: '/user/notifications/channels/telegram/link', headers: auth(), remoteAddress: '10.0.0.7' })
      if (res.statusCode === 429) limited = true
    }
    expect(limited).toBe(true)
  })
})

describe('rules', () => {
  it('creates a rule with its human summary and normalized params', async () => {
    const f = await build()
    const res = await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'account-activity', params: { address: SS58, type: 'trade', minUsd: 5000 }, name: 'watch' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      kind: 'account-activity', kindLabel: 'Account activity', name: 'watch',
      summary: 'trade activity over $5k by 15Da…BDRLZ', channels: [], muted: false, cooldownS: 0,
      // The pre-target spelling is normalized into the address target before it
      // is stored, so both spellings answer with the current one.
      params: { target: { kind: 'address', address: SS58 }, type: 'trade', minUsd: 5000 },
    })
    expect(rulesFor(OWNER)).toHaveLength(1)
  })

  it('rejects an unknown kind with 400 and bad params with 422', async () => {
    const f = await build()
    const badKind = await f.inject({ method: 'POST', url: '/user/notifications/rules', headers: auth(), payload: { kind: 'nope', params: {} } })
    expect(badKind.statusCode).toBe(400)
    const badParams = await f.inject({ method: 'POST', url: '/user/notifications/rules', headers: auth(), payload: { kind: 'large-trade', params: { minUsd: 1 } } })
    expect(badParams.statusCode).toBe(422)
  })

  it('patches only the keys it was sent, and deletes', async () => {
    const f = await build()
    const rule = (await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'large-trade', params: { minUsd: 10_000 }, name: 'whales' },
    })).json()
    const patched = await f.inject({ method: 'PATCH', url: `/user/notifications/rules/${rule.id}`, headers: auth(), payload: { muted: true } })
    expect(patched.json()).toMatchObject({ muted: true, name: 'whales', params: { minUsd: 10_000 } })
    const gone = await f.inject({ method: 'DELETE', url: `/user/notifications/rules/${rule.id}`, headers: auth() })
    expect(gone.statusCode).toBe(200)
    expect(rulesFor(OWNER)).toHaveLength(0)
    const missing = await f.inject({ method: 'PATCH', url: `/user/notifications/rules/${rule.id}`, headers: auth(), payload: { muted: false } })
    expect(missing.statusCode).toBe(404)
  })

  // Somebody else's alert answers exactly like one that does not exist.
  it('answers 404, not 403, for another account\'s alert', async () => {
    const f = await build()
    const rule = (await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'safety', params: {} },
    })).json()
    const intruder = { authorization: `Bearer ${await issueSession('0x' + 'cc'.repeat(32))}` }
    expect((await f.inject({ method: 'PATCH', url: `/user/notifications/rules/${rule.id}`, headers: intruder, payload: { muted: true } })).statusCode).toBe(404)
    expect((await f.inject({ method: 'DELETE', url: `/user/notifications/rules/${rule.id}`, headers: intruder })).statusCode).toBe(404)
  })

  // Subscribing is idempotent: the same affordance lives on several surfaces,
  // and pressing it twice must return the rule the account already has.
  it('returns the existing rule with existing:true instead of creating a duplicate', async () => {
    const f = await build()
    const create = () => f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'price', params: { assetId: 5, direction: 'below', price: 0.005 } },
    })
    const first = (await create()).json()
    expect(first.existing).toBeUndefined()
    const again = (await create()).json()
    expect(again.id).toBe(first.id)
    expect(again.existing).toBe(true)
    // Key order and an omitted optional the schema defaults are the same rule.
    const reordered = await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'account-activity', params: { type: 'trade', address: SS58 } },
    })
    const targeted = await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'account-activity', params: { target: { kind: 'address', address: SS58 }, type: 'trade' } },
    })
    expect(targeted.json()).toMatchObject({ id: reordered.json().id, existing: true })
    expect(rulesFor(OWNER)).toHaveLength(2)
  })

  // A tag rule's params carry ids; the rules list needs a name, a count and the
  // tag's own presentation, resolved server-side under the owner's visibility.
  it('resolves a tag target\'s presentation onto the rule', async () => {
    initTagService(fakeClient({
      'price_data.account_tags': [
        { label_id: 'kraken', label_name: 'Kraken', color: '#5b53d3', note: '', icon: '🐙', account_id: '0x' + '11'.repeat(32) },
        { label_id: 'kraken', label_name: 'Kraken', color: '#5b53d3', note: '', icon: '🐙', account_id: '0x' + '22'.repeat(32) },
      ],
    }))
    await loadTags()
    const f = await build()
    const res = await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'kraken' } } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      summary: 'Any activity by tag "Kraken"',
      params: { target: { kind: 'tag', tagId: 'kraken' } },
      targetLabel: 'Kraken', targetMemberCount: 2, targetIcon: '🐙', targetColor: '#5b53d3',
    })
    // An address rule carries no target block at all.
    const address = await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'account-activity', params: { address: SS58 } },
    })
    expect(address.json().targetLabel).toBeUndefined()
    // A tag that does not exist is a 422, not a rule that can never match.
    const bogus = await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'nope' } } },
    })
    expect(bogus.statusCode).toBe(422)
  })

  // A track written by name normalizes to the id the chain reports.
  it('accepts a referendum track by name or by id and stores the id', async () => {
    const f = await build()
    const byName = await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'referendum', params: { track: 'Whitelisted Caller' } },
    })
    expect(byName.json()).toMatchObject({ params: { track: '1' }, summary: 'referenda — any phase on whitelisted_caller' })
    const byId = await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'referendum', params: { track: '1' } },
    })
    expect(byId.json()).toMatchObject({ params: { track: '1' } })
    const bogus = await f.inject({
      method: 'POST', url: '/user/notifications/rules', headers: auth(),
      payload: { kind: 'referendum', params: { track: 'treasury' } },
    })
    expect(bogus.statusCode).toBe(422)
  })
})

describe('inbox', () => {
  it('pages rows and marks them read', async () => {
    const rows = [{
      notification_id: 'n1', account_id: OWNER, rule_id: 'r1', kind: 'safety', title: 'Safety action',
      body: 'b', url: '/security', block_height: 5, read: 0, created_at: '2026-08-18 10:00:00',
    }]
    initNotifications(fakeClient({ user_notification_inbox: rows }))
    await loadNotifications()
    const f = await build()
    const page = await f.inject({ method: 'GET', url: '/user/notifications/inbox?limit=10', headers: auth() })
    expect(page.statusCode).toBe(200)
    // The row's link is site-relative: the SPA renders it with <Link to={url}>.
    expect(page.json().rows[0]).toMatchObject({ id: 'n1', ruleId: 'r1', kind: 'safety', kindLabel: 'Safety action', title: 'Safety action', url: '/security', read: false })
    const read = await f.inject({ method: 'POST', url: '/user/notifications/inbox/read', headers: auth(), payload: { ids: ['n1'] } })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({ ok: true, marked: 1 })
  })

  it('rejects an out-of-range page', async () => {
    const f = await build()
    const res = await f.inject({ method: 'GET', url: '/user/notifications/inbox?limit=5000', headers: auth() })
    expect(res.statusCode).toBe(400)
  })

  // Clearing empties the HISTORY. The rules keep firing — that is the whole
  // distinction the confirm copy makes — so the count that comes back is of rows
  // removed, and the unread count is zero by construction.
  it('clears the whole inbox in one write and reports how many rows went', async () => {
    const inboxRow = (id: string, read = 0, account = OWNER) => ({
      notification_id: id, account_id: account, rule_id: 'r1', kind: 'safety', title: `t-${id}`,
      body: 'b', url: '/security', block_height: 5, read, deleted: 0, created_at: '2026-08-18 10:00:00',
    })
    const client = fakeClient({ user_notification_inbox: [inboxRow('n1'), inboxRow('n2', 1)] })
    initNotifications(client)
    await loadNotifications()
    const f = await build()

    const res = await f.inject({ method: 'POST', url: '/user/notifications/inbox/clear', headers: auth(), payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).toEqual({ ok: true, cleared: 2, unread: 0 })
    // One insert, both rows, all of them tombstones.
    expect(client.inserts).toHaveLength(1)
    expect(client.inserts[0].values.map(v => [v.notification_id, v.deleted])).toEqual([['n1', 1], ['n2', 1]])
    // The rules are untouched: clearing history is not unsubscribing.
    expect(client.inserts.some(i => i.table.endsWith('user_notification_rules'))).toBe(false)
  })

  it('clears only the caller\'s own rows', async () => {
    const client = fakeClient({
      user_notification_inbox: [{
        notification_id: 'theirs', account_id: '0x' + 'cc'.repeat(32), rule_id: 'r1', kind: 'safety',
        title: 't', body: '', url: '', block_height: 0, read: 0, deleted: 0, created_at: '2026-08-18 10:00:00',
      }],
    })
    initNotifications(client)
    await loadNotifications()
    const f = await build()
    const res = await f.inject({ method: 'POST', url: '/user/notifications/inbox/clear', headers: auth(), payload: {} })
    expect(res.json()).toEqual({ ok: true, cleared: 0, unread: 0 })
    expect(client.inserts).toHaveLength(0)
  })
})
