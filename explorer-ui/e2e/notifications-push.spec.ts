import type { BrowserContext, Page, Worker as ServiceWorkerHandle } from '@playwright/test'
import { expect, seedSession, test } from './fixtures/test'

// Web Push, as far as a browser in CI can actually go.
//
// Two different things are worth proving, and they need opposite setups:
//  1. The APP's subscribe path — permission, worker, subscription, POST. A real
//     `PushManager.subscribe` needs a live push service (FCM et al.), which no
//     headless browser here can reach, so exactly one call is replaced and
//     everything around it stays real.
//  2. The WORKER itself — that `/sw.js` is served, parses, activates at the
//     right scope, and that the notification it builds genuinely displays in
//     this browser profile. That one runs with no stubs at all.

// The suite's default headless browser is `chrome-headless-shell`, which ships
// no notification platform at all: `Notification.permission` reads "denied"
// there however the permission is granted, and `showNotification` throws. The
// full Chromium build in modern headless mode has one, so these — and only
// these — run on it. Same binary set `playwright install chromium` already
// fetches; nothing else in the suite is affected.
test.use({ channel: 'chromium' })

const FAKE_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/e2e-fake-subscription-id'
const FAKE_KEYS = { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', auth: 'e2e-auth-secret-16b' }

// Chromium scopes the notification permission per ORIGIN, and a context that
// has not navigated yet has none — so the grant is taken from the page's own
// URL rather than restating the config's baseURL here.
async function allowNotifications(context: BrowserContext, page: Page): Promise<string> {
  const origin = new URL(page.url()).origin
  await context.grantPermissions(['notifications'], { origin })
  return origin
}

// Replaces ONLY the round trip to the push service. Registration, `ready`,
// `getSubscription`, the permission check, the VAPID key decoding and the POST
// all run as shipped.
async function stubPushService(page: Page): Promise<void> {
  await page.addInitScript(([endpoint, keys]) => {
    PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
      return {
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: options?.applicationServerKey ?? null },
        getKey: () => null,
        toJSON: () => ({ endpoint, expirationTime: null, keys }),
        unsubscribe: async () => true,
      } as unknown as PushSubscription
    }
  }, [FAKE_ENDPOINT, FAKE_KEYS] as [string, { p256dh: string; auth: string }])
}

test('enabling push registers this browser as a channel and hands the API the subscription', async ({ page, context, userMock }) => {
  await seedSession(page, userMock)
  await stubPushService(page)

  // Channels are their own tab; the plain URL is the inbox.
  await page.goto('/notifications?tab=channels')
  const origin = await allowNotifications(context, page)
  await expect(page.locator('.notif-note', { hasText: 'No browser registered yet' })).toBeVisible()
  await page.getByRole('button', { name: 'Enable push' }).click()

  // Exactly the shape the API stores — endpoint plus the two keys, nothing else.
  await expect.poll(() => userMock.state.notifications.webPushSubscriptions)
    .toEqual([{ endpoint: FAKE_ENDPOINT, keys: FAKE_KEYS }])

  // The channel comes back described by its endpoint HOST, and the browser
  // labelled itself from its own user agent.
  const row = page.locator('.notif-panel .notif-row')
  await expect(row).toHaveCount(1)
  await expect(row.locator('.notif-row-title')).toContainText('Chrome')
  await expect(row.locator('.notif-row-meta')).toHaveText('fcm.googleapis.com')
  // Never the endpoint or its keys: those are credentials.
  await expect(row).not.toContainText('e2e-fake-subscription-id')
  await expect(row).not.toContainText(FAKE_KEYS.auth)

  // A registered browser turns the action into "add another".
  await expect(page.getByRole('button', { name: 'Add this browser' })).toBeVisible()

  // And the real service worker was registered on the way through — by the
  // app's own path, not by this test.
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/sw.js'))?.scope ?? null)
  expect(scope).toBe(`${origin}/`)
})

test('removing the push channel drops it server-side', async ({ page, context, userMock }) => {
  await seedSession(page, userMock)
  await stubPushService(page)

  await page.goto('/notifications?tab=channels')
  await allowNotifications(context, page)
  await page.getByRole('button', { name: 'Enable push' }).click()
  await expect(page.locator('.notif-panel .notif-row')).toHaveCount(1)

  // Removing asks first — this browser would have to be granted permission and
  // re-subscribed to get it back — and names the channel it is dropping.
  await page.locator('.notif-panel .notif-row').getByRole('button', { name: 'Remove' }).click()
  const confirm = page.locator('.confirm-dialog')
  await expect(confirm.locator('.dialog-head h2')).toHaveText('Remove channel')
  await expect(confirm).toContainText('Alerts stop arriving on that browser')
  await confirm.getByRole('button', { name: 'Remove' }).click()

  await expect.poll(() => userMock.state.notifications.channels).toEqual([])
  await expect(page.locator('.notif-panel .notif-row')).toHaveCount(0)
})

// No stubs at all below this line.
test('the shipped service worker registers at the root scope and its notifications display', async ({ page, context }) => {
  await page.goto('/')
  const origin = await allowNotifications(context, page)

  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    return registration.scope
  })
  // A push-only worker claims the whole origin — a narrower scope would leave
  // notification clicks unable to find an open tab.
  expect(scope).toBe(`${origin}/`)
  // `ready` resolves as soon as there IS an active worker, which is a tick
  // before its own `activate` (skipWaiting + clients.claim) has settled.
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state ?? null)).toBe('activated')

  // The worker's own output path: what the `push` handler builds is a
  // showNotification call, and it has to produce a notification this browser
  // actually holds.
  const shown = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    await registration.showNotification('Large trade: 4.87M HDX → 106k USDT', {
      body: 'Swapped on Omnipool for $106k.',
      data: { url: '/notifications' },
      tag: 'rule-whale',
    })
    const list = await registration.getNotifications()
    return list.map(n => ({ title: n.title, body: n.body, tag: n.tag, url: (n.data as { url?: string } | null)?.url }))
  })
  expect(shown).toEqual([{
    title: 'Large trade: 4.87M HDX → 106k USDT',
    body: 'Swapped on Omnipool for $106k.',
    tag: 'rule-whale',
    url: '/notifications',
  }])

  // The tag is what keeps a repeated alert from stacking: a second show with
  // the same tag REPLACES the first rather than adding to it.
  const afterRepeat = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    await registration.showNotification('Large trade: 5.10M HDX → 111k USDT', { body: 'again', tag: 'rule-whale' })
    return (await registration.getNotifications()).map(n => n.title)
  })
  expect(afterRepeat).toEqual(['Large trade: 5.10M HDX → 111k USDT'])
})

// Dispatches a real PushEvent, carrying a real payload, into the running
// worker's own global scope — so the shipped `push` listener parses it and
// builds the notification itself. Only the transport is synthetic; the handler
// is not stubbed, wrapped or re-implemented.
async function deliverPush(worker: ServiceWorkerHandle, payload: string): Promise<void> {
  await worker.evaluate((data: string) => {
    // PushEvent lives in the service-worker lib, not the DOM one this file is
    // typechecked against.
    const scope = self as unknown as { dispatchEvent: (event: Event) => boolean }
    const PushEventCtor = (globalThis as unknown as { PushEvent: new (type: string, init: { data: string }) => Event }).PushEvent
    scope.dispatchEvent(new PushEventCtor('push', { data }))
  }, payload)
}

async function shownNotifications(page: Page): Promise<{ title: string; body: string; tag: string; url?: string }[]> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return (await registration.getNotifications())
      .map(n => ({ title: n.title, body: n.body, tag: n.tag, url: (n.data as { url?: string } | null)?.url }))
  })
}

test('a pushed alert runs through the worker and becomes a notification', async ({ page, context }) => {
  await page.goto('/')
  await allowNotifications(context, page)

  const appeared = context.waitForEvent('serviceworker')
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
  })
  const worker = await appeared

  // The API's delivery payload, verbatim.
  await deliverPush(worker, JSON.stringify({
    title: 'HDX rose above $0.03',
    body: 'Now $0.0304, up 4.28% on the day.',
    url: '/asset/0',
    tag: 'rule-price',
  }))
  await expect.poll(() => shownNotifications(page)).toEqual([{
    title: 'HDX rose above $0.03',
    body: 'Now $0.0304, up 4.28% on the day.',
    tag: 'rule-price',
    // The click target travels on the notification's own data, which is what
    // `notificationclick` reopens the app at.
    url: '/asset/0',
  }])

  // A push service can deliver an empty or non-JSON body, and some browsers
  // send a data-less keepalive. Throwing there would show nothing at all —
  // several browsers then punish the registration — so the worker falls back
  // to its own title and the notifications route.
  await deliverPush(worker, 'not json at all')
  await expect.poll(() => shownNotifications(page)).toContainEqual({
    title: 'Hydration Explorer',
    body: 'not json at all',
    tag: '',
    url: '/notifications',
  })
})
