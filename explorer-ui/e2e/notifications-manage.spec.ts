import { E2E_ADDRESS, E2E_TELEGRAM_BOT, E2E_TELEGRAM_LINK_CODE, E2E_TELEGRAM_USERNAME, claimTelegramLink, expect, seedInboxRow, seedSession, test } from './fixtures/test'
import type { UserMockState } from './fixtures/test'
import { MOCK_NOTIFICATION_CHANNELS, MOCK_NOTIFICATION_RULES } from '../tests/fixtures/mockApi'

// The management surface: three tabs over one page — the inbox you land on, the
// alerts that fill it, and the channels that carry them — and what happens when
// the reader adds, mutes, deletes or links one. The user mock is stateful, so
// every mutation here is proven by BOTH halves of the round trip: the request
// body the app sent, and the row that came back on the next refetch.

// The shared fixtures are module-level objects the mock hands out by reference,
// and PATCH mutates a rule in place — so a mute in one test would otherwise
// bleed into every later one in the same worker.
function seedNotifications(userMock: { state: UserMockState }): void {
  userMock.state.notifications.channels = structuredClone(MOCK_NOTIFICATION_CHANNELS)
  userMock.state.notifications.rules = structuredClone(MOCK_NOTIFICATION_RULES)
}

const RULE_COUNT = MOCK_NOTIFICATION_RULES.length

const tab = (page: import('@playwright/test').Page, name: string) => page.locator('.detail-tabs button', { hasText: name })
// The shared confirm — the only dialog these flows open besides "New alert".
const confirm = (page: import('@playwright/test').Page) => page.locator('.confirm-dialog')

test('the bell badge carries the unread count, and seeing the inbox clears it', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedInboxRow(userMock.state, { id: 'notif-a', title: 'Large trade: 4.87M HDX → 106k USDT' })
  seedInboxRow(userMock.state, { id: 'notif-b', kind: 'price', kindLabel: 'Price alert', title: 'HDX rose above $0.03', body: 'Now $0.0304.' })

  await page.goto('/')
  const badge = page.locator('.topbar-bell .invite-badge')
  await expect(badge).toHaveText('2')
  await expect(page.locator('.topbar-bell')).toHaveAttribute('title', '2 unread notifications')

  // The bell leads to the plain URL, and the plain URL IS the inbox.
  await page.locator('.topbar-bell').click()
  await expect(page).toHaveURL(/\/notifications$/)
  await expect(tab(page, 'Inbox')).toHaveClass(/active/)

  // Both rows are on the page, newest first…
  const inboxRows = page.locator('.wrap > .panel').last().locator('tbody tr')
  await expect(inboxRows).toHaveCount(2)
  await expect(inboxRows.first()).toContainText('HDX rose above $0.03')

  // …and seeing them IS reading them: the server-side flag flips and the badge
  // the topbar was showing goes with it.
  await expect.poll(() => userMock.state.notifications.inbox.every(r => r.read)).toBe(true)
  await expect(badge).toHaveCount(0)
})

// Reading is something the reader DID, not something the URL says: landing on
// another tab must leave the badge exactly as it found it.
test('landing on the alerts tab does not clear the badge; the inbox tab does', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedNotifications(userMock)
  seedInboxRow(userMock.state, { id: 'notif-a' })

  await page.goto('/notifications?tab=alerts')
  await expect(tab(page, 'Alerts')).toHaveClass(/active/)
  await expect(page.locator('.sec-title-row + .panel tbody tr')).toHaveCount(RULE_COUNT)
  // The inbox tab still wears its unread pill, and nothing was marked read.
  await expect(tab(page, 'Inbox').locator('.invite-badge')).toHaveText('1')
  await expect(page.locator('.topbar-bell .invite-badge')).toHaveText('1')
  // Give a stray mark-read every chance to fire before asserting it did not.
  await page.waitForTimeout(500)
  expect(userMock.state.notifications.inbox.every(r => !r.read)).toBe(true)

  await tab(page, 'Inbox').click()
  await expect(page).toHaveURL(/\/notifications$/)
  await expect.poll(() => userMock.state.notifications.inbox.every(r => r.read)).toBe(true)
  await expect(page.locator('.topbar-bell .invite-badge')).toHaveCount(0)
})

test('the tabs are deep-linkable query state, and each one owns its section', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedNotifications(userMock)

  await page.goto('/notifications')
  await expect(page.locator('.sec-title', { hasText: 'Inbox' })).toBeVisible()
  await expect(page.locator('.notif-panel')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '+ New alert' })).toHaveCount(0)

  await tab(page, 'Alerts').click()
  await expect(page).toHaveURL(/\/notifications\?tab=alerts$/)
  await expect(page.getByRole('button', { name: '+ New alert' })).toBeVisible()
  await expect(page.locator('.notif-panel')).toHaveCount(0)
  // The rule count rides the tab.
  await expect(tab(page, 'Alerts').locator('.cnt')).toHaveText(String(RULE_COUNT))

  await tab(page, 'Channels').click()
  await expect(page).toHaveURL(/\/notifications\?tab=channels$/)
  await expect(page.locator('.notif-panel .notif-row')).toHaveCount(2)

  // A rule's channel routing is a way to the tab that owns it.
  await tab(page, 'Alerts').click()
  await page.locator('.sec-title-row + .panel tbody tr', { hasText: 'HDX price above $0.03' }).locator('.notif-chip').click()
  await expect(page).toHaveURL(/\/notifications\?tab=channels$/)

  // Back steps through the tabs the reader actually visited.
  await page.goBack()
  await expect(page).toHaveURL(/\/notifications\?tab=alerts$/)
})

// Alerts with no channel still land in the inbox, so nothing is broken and
// nothing complains — which is exactly why the tab that fixes it says so.
test('the channels tab is marked when rules exist with nowhere to deliver', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.notifications.rules = structuredClone(MOCK_NOTIFICATION_RULES)

  await page.goto('/notifications?tab=alerts')
  const channels = tab(page, 'Channels')
  await expect(channels.locator('.tab-dot')).toHaveCount(1)
  await expect(channels).toHaveAttribute('title', 'No channel linked — alerts only land in your inbox')

  // Link one, and the mark goes with it.
  await channels.click()
  await page.getByRole('button', { name: 'Link Telegram' }).click()
  await expect(page.locator('.notif-link-panel')).toBeVisible()
  claimTelegramLink(userMock.state)
  await expect(page.locator('.notif-panel .notif-row', { hasText: `@${E2E_TELEGRAM_USERNAME}` })).toBeVisible({ timeout: 20_000 })
  await expect(tab(page, 'Channels').locator('.tab-dot')).toHaveCount(0)
})

test('channels list the registered browser by its endpoint host and Telegram by its @username', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedNotifications(userMock)

  await page.goto('/notifications?tab=channels')
  const rows = page.locator('.notif-panel .notif-row')
  await expect(rows).toHaveCount(2)

  const push = rows.filter({ hasText: 'Chrome on macOS' })
  // A channel's real config is a credential: the host is all the API ships,
  // and all the page can therefore show.
  await expect(push.locator('.notif-row-meta')).toHaveText('fcm.googleapis.com')
  await expect(push).not.toContainText('/fcm/send')
  await expect(push.getByRole('button', { name: 'Remove' })).toBeVisible()

  const telegram = rows.filter({ hasText: '@hydrationwatcher' })
  await expect(telegram.locator('.notif-row-meta')).toHaveText('Telegram')
  await expect(telegram.getByRole('button', { name: 'Unlink' })).toBeVisible()

  // With a browser already registered, the push action offers a SECOND one
  // rather than repeating the first-run copy.
  await expect(page.getByRole('button', { name: 'Add this browser' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Link Telegram' })).toHaveCount(0)
})

test('the rules list renders each kind, its summary, its channel routing and its mute state', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedNotifications(userMock)

  await page.goto('/notifications?tab=alerts')
  const rules = page.locator('.sec-title-row + .panel tbody tr')
  await expect(rules).toHaveCount(RULE_COUNT)

  // A named rule leads with its name and keeps the server's summary underneath.
  const whale = rules.filter({ hasText: 'Large HDX trades' })
  await expect(whale.locator('.badge.notif-kind')).toHaveText('Large trade')
  await expect(whale.locator('.notif-row-meta')).toHaveText('trades over $10k on HDX')
  await expect(whale.locator('td[data-label="Channels"]')).toHaveText('All channels')
  await expect(whale.locator('td[data-label="Frequency"]')).toHaveText('every match')

  // An unnamed one reads as its summary, and a rule pinned to one channel
  // names that channel the same way the channels list does.
  const price = rules.filter({ hasText: 'HDX price above $0.03' })
  await expect(price.locator('.badge.notif-kind')).toHaveText('Price alert')
  await expect(price.locator('.notif-chip')).toHaveText('@hydrationwatcher')
  await expect(price.locator('td[data-label="Frequency"]')).toHaveText('1h')

  const muted = rules.filter({ hasText: 'Owl watch' })
  await expect(muted).toHaveClass(/notif-rule-muted/)
  await expect(muted.locator('.badge.pending')).toHaveText('muted')
  await expect(muted.getByRole('button', { name: 'Unmute' })).toBeVisible()
  await expect(muted.locator('td[data-label="Frequency"]')).toHaveText('5m')

  // A tag target renders as the tag itself — its icon, its colour, how many
  // accounts wear it — and leads to the tag, not to one of its members.
  const tagged = rules.filter({ hasText: 'Kraken' })
  const pill = tagged.locator('.addr-pill')
  await expect(pill).toHaveAttribute('href', '/tag/kraken')
  await expect(pill.locator('.tag')).toHaveText('Kraken')
  await expect(pill.locator('.tag-member-suffix')).toHaveText('·2')
})

test('creates an account-activity alert from the New alert dialog', async ({ page, userMock }) => {
  await seedSession(page, userMock)

  let posted: unknown = null
  await page.route(/\/api\/user\/notifications\/rules$/, async route => {
    if (route.request().method() === 'POST') posted = route.request().postDataJSON()
    await route.fallback()
  })

  await page.goto('/notifications?tab=alerts')
  await expect(page.locator('.sec-title-row + .panel tbody')).toContainText('No alerts yet')

  await page.getByRole('button', { name: '+ New alert' }).click()
  const dialog = page.locator('.dialog')
  await expect(dialog.locator('.dialog-head h2')).toHaveText('New alert')
  // The form says the invariant out loud, on the surface where a rule is born.
  await expect(dialog.locator('.dialog-hint')).toContainText('never fire for backfilled history')

  await dialog.locator('#alert-kind').selectOption('account-activity')
  // An address the search has never seen is still a target: typed straight
  // into the picker and submitted, no row to pick.
  await expect(dialog.locator('#alert-target')).toBeVisible()
  await dialog.locator('#alert-target').fill(E2E_ADDRESS)
  await dialog.locator('#alert-type').selectOption('transfer')
  await dialog.locator('#alert-min-activity').fill('50000')
  await dialog.locator('#alert-name').fill('Treasury watch')
  await dialog.locator('#alert-cooldown').selectOption('300')
  await dialog.getByRole('button', { name: 'Create alert' }).click()

  // Exactly the body the rule registry describes — the target union, and
  // optional fields present only because they were filled in.
  await expect.poll(() => posted).toEqual({
    kind: 'account-activity',
    params: { target: { kind: 'address', address: E2E_ADDRESS }, type: 'transfer', minUsd: 50_000 },
    name: 'Treasury watch',
    cooldownS: 300,
  })

  // …and the mutation's own invalidate → refetch cycle shows the stored rule,
  // not an optimistic echo of the form.
  await expect(page.locator('.dialog')).toHaveCount(0)
  const row = page.locator('.sec-title-row + .panel tbody tr', { hasText: 'Treasury watch' })
  await expect(row.locator('.badge.notif-kind')).toHaveText('Account activity')
  await expect(row.locator('td[data-label="Frequency"]')).toHaveText('5m')
  await expect.poll(() => userMock.state.notifications.rules.map(r => r.kind)).toEqual(['account-activity'])
})

// The one kind whose form is a token picker rather than free text — the same
// Combo the activity filters use, so a wrong option here would be a wrong
// filter everywhere.
test('creates a price alert by picking a token in the combo', async ({ page, userMock }) => {
  await seedSession(page, userMock)

  await page.goto('/notifications?tab=alerts')
  await page.getByRole('button', { name: '+ New alert' }).click()
  const dialog = page.locator('.dialog')
  await dialog.locator('#alert-kind').selectOption('price')

  await dialog.locator('.combo-input').click()
  await dialog.locator('.combo-opt', { hasText: 'HDX' }).first().click()
  await expect(dialog.locator('.combo-input')).toHaveValue('HDX')

  await dialog.locator('#alert-direction').selectOption('below')
  await dialog.locator('#alert-price').fill('0.015')
  await dialog.getByRole('button', { name: 'Create alert' }).click()

  await expect(page.locator('.dialog')).toHaveCount(0)
  await expect.poll(() => userMock.state.notifications.rules.map(r => r.params))
    .toEqual([{ assetId: 0, direction: 'below', price: 0.015 }])
  await expect(page.locator('.sec-title-row + .panel tbody tr .badge.notif-kind')).toHaveText('Price alert')
})

// The matcher kinds' two fields are pickers over the indexed name catalogue:
// nobody knows a pallet.Event name by heart, and a name that never matches is
// worth nothing. Both still take a typed value, which the second half proves.
test('creates an event alert by picking a pallet and then an event inside it', async ({ page, userMock }) => {
  await seedSession(page, userMock)

  await page.goto('/notifications?tab=alerts')
  await page.getByRole('button', { name: '+ New alert' }).click()
  const dialog = page.locator('.dialog')
  await dialog.locator('#alert-kind').selectOption('event')

  // The pallet list is the catalogue's own first segments.
  await dialog.locator('#alert-section').click()
  await dialog.locator('#alert-section').fill('Refer')
  await dialog.locator('.combo-opt', { hasText: 'Referenda' }).first().click()
  await expect(dialog.locator('#alert-section')).toHaveValue('Referenda')

  // …and the event list is only what lives inside THAT pallet.
  await dialog.locator('#alert-method').click()
  const events = dialog.locator('.combo-pop .combo-opt-sym')
  await expect(events.filter({ hasText: 'Submitted' })).toHaveCount(1)
  await expect(events.filter({ hasText: 'Transfer' })).toHaveCount(0)
  await dialog.locator('.combo-opt', { hasText: 'DecisionStarted' }).first().click()
  await expect(dialog.locator('#alert-method')).toHaveValue('DecisionStarted')

  await dialog.getByRole('button', { name: 'Create alert' }).click()
  await expect(page.locator('.dialog')).toHaveCount(0)
  await expect.poll(() => userMock.state.notifications.rules.map(r => r.params))
    .toEqual([{ section: 'Referenda', method: 'DecisionStarted' }])
})

test('takes a pallet and call the catalogue has never heard of', async ({ page, userMock }) => {
  await seedSession(page, userMock)

  await page.goto('/notifications?tab=alerts')
  await page.getByRole('button', { name: '+ New alert' }).click()
  const dialog = page.locator('.dialog')
  await dialog.locator('#alert-kind').selectOption('extrinsic')

  // A pallet only a newer runtime has: the dropdown offers to use exactly what
  // was typed, and the alert is made from it.
  await dialog.locator('#alert-section').fill('BrandNewPallet')
  await expect(dialog.locator('.combo-opt', { hasText: 'Use “BrandNewPallet”' })).toBeVisible()
  await dialog.locator('.combo-opt', { hasText: 'Use “BrandNewPallet”' }).click()
  await expect(dialog.locator('#alert-section')).toHaveValue('BrandNewPallet')
  // Nothing is indexed under it, so the call field has nothing to offer — and
  // still takes a typed name, committed by leaving the field.
  await dialog.locator('#alert-method').fill('do_something')
  await dialog.locator('#alert-success').selectOption('no')

  await dialog.getByRole('button', { name: 'Create alert' }).click()
  await expect(page.locator('.dialog')).toHaveCount(0)
  await expect.poll(() => userMock.state.notifications.rules.map(r => r.params))
    .toEqual([{ section: 'BrandNewPallet', method: 'do_something', success: false }])
})

test('a bad parameter is refused before a round trip, and the dialog stays open to fix it', async ({ page, userMock }) => {
  await seedSession(page, userMock)

  await page.goto('/notifications?tab=alerts')
  await page.getByRole('button', { name: '+ New alert' }).click()
  const dialog = page.locator('.dialog')
  await dialog.locator('#alert-kind').selectOption('account-activity')
  await dialog.locator('#alert-target').fill('not-an-address')
  await dialog.getByRole('button', { name: 'Create alert' }).click()

  await expect(dialog.locator('.dialog-error')).toContainText('Pick an account or tag to watch')
  expect(userMock.state.notifications.rules).toHaveLength(0)

  // Correcting it submits the same form, no reopen needed.
  await dialog.locator('#alert-target').fill(E2E_ADDRESS)
  await dialog.getByRole('button', { name: 'Create alert' }).click()
  await expect(page.locator('.dialog')).toHaveCount(0)
  await expect.poll(() => userMock.state.notifications.rules).toHaveLength(1)
})

test('mutes a rule and deletes another', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedNotifications(userMock)

  await page.goto('/notifications?tab=alerts')
  const rules = page.locator('.sec-title-row + .panel tbody tr')
  const whale = rules.filter({ hasText: 'Large HDX trades' })

  await whale.getByRole('button', { name: 'Mute' }).click()
  await expect.poll(() => userMock.state.notifications.rules.find(r => r.id === 'rule-whale')?.muted).toBe(true)
  await expect(whale).toHaveClass(/notif-rule-muted/)
  await expect(whale.locator('.badge.pending')).toHaveText('muted')
  const unmute = whale.getByRole('button', { name: 'Unmute' })
  await expect(unmute).toHaveAttribute('aria-pressed', 'true')

  // Muting is a toggle, not a one-way door.
  await unmute.click()
  await expect.poll(() => userMock.state.notifications.rules.find(r => r.id === 'rule-whale')?.muted).toBe(false)
  await expect(whale).not.toHaveClass(/notif-rule-muted/)

  // Deleting is the one action here nothing can undo, so it asks first — and
  // names the rule it is about to stop.
  const owl = rules.filter({ hasText: 'Owl watch' })
  await owl.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm(page).locator('.dialog-head h2')).toHaveText('Delete alert')
  await expect(confirm(page)).toContainText('Delete "Owl watch"? It stops alerting immediately.')

  // Cancelling keeps it. (Waited out, so a stray DELETE has every chance to
  // fire before this asserts it did not.)
  await confirm(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm(page)).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(userMock.state.notifications.rules.map(r => r.id)).toContain('rule-owl-activity')
  await expect(rules).toHaveCount(RULE_COUNT)

  await owl.getByRole('button', { name: 'Delete' }).click()
  await confirm(page).getByRole('button', { name: 'Delete' }).click()
  await expect.poll(() => userMock.state.notifications.rules.map(r => r.id)).toEqual(['rule-whale', 'rule-price', 'rule-tag-activity'])
  await expect(confirm(page)).toHaveCount(0)
  await expect(rules).toHaveCount(RULE_COUNT - 1)
  await expect(tab(page, 'Alerts').locator('.cnt')).toHaveText(String(RULE_COUNT - 1))
})

// The quick-add row exists because referenda and safety actions are chain-wide
// feeds with no page you are "on" when you want to subscribe to them.
test('the quick-add row creates a chain-wide alert in one click, and reads as subscribed after a reload', async ({ page, userMock }) => {
  await seedSession(page, userMock)

  await page.goto('/notifications?tab=alerts')
  const quickAdd = page.locator('.notif-quick-add')
  await quickAdd.getByRole('button', { name: 'Watch referenda' }).click()

  await expect.poll(() => userMock.state.notifications.rules.map(r => ({ kind: r.kind, name: r.name })))
    .toEqual([{ kind: 'referendum', name: 'New referenda' }])
  const alerting = quickAdd.getByRole('button', { name: 'Watching referenda ✓' })
  await expect(alerting).toBeVisible()
  await expect(alerting).toHaveAttribute('aria-pressed', 'true')

  // The state is read from the rules the viewer HAS, so it survives a reload
  // (and would read the same on another device).
  await page.reload()
  await expect(page.locator('.notif-quick-add').getByRole('button', { name: 'Watching referenda ✓' })).toBeVisible()
  await expect(page.locator('.notif-quick-add').getByRole('button', { name: 'Watch safety actions' })).toBeVisible()

  // …and it is a toggle: clicking it removes the rule it stands for — through
  // the same confirm the rules table uses, since switching an alert off IS
  // deleting it.
  await page.locator('.notif-quick-add').getByRole('button', { name: 'Watching referenda ✓' }).click()
  await expect(confirm(page)).toContainText('Delete "New referenda"? It stops alerting immediately.')
  await confirm(page).getByRole('button', { name: 'Delete' }).click()
  await expect.poll(() => userMock.state.notifications.rules).toHaveLength(0)
  await expect(page.locator('.notif-quick-add').getByRole('button', { name: 'Watch referenda' })).toBeVisible()
})

// The same toggle, cancelled: an "Alerting ✓" button is one click away from
// deleting a rule on every page in the app, so backing out has to be free.
test('cancelling the toggle-off keeps the alert', async ({ page, userMock }) => {
  await seedSession(page, userMock)

  await page.goto('/notifications?tab=alerts')
  await page.locator('.notif-quick-add').getByRole('button', { name: 'Watch safety actions' }).click()
  const alerting = page.locator('.notif-quick-add').getByRole('button', { name: 'Watching safety actions ✓' })
  await expect(alerting).toBeVisible()

  await alerting.click()
  await expect(confirm(page)).toContainText('Delete "Safety actions"?')
  await confirm(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm(page)).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(userMock.state.notifications.rules.map(r => r.kind)).toEqual(['safety'])
  await expect(page.locator('.notif-quick-add').getByRole('button', { name: 'Watching safety actions ✓' })).toBeVisible()
})

// Two clicks inside one tick — before any re-render can disable the button —
// are two POSTs of the same subscription. The server's create is idempotent,
// so what comes back the second time is the rule that already exists.
test('a double click on a subscribe button creates exactly one rule', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const posted: unknown[] = []
  await page.route(/\/api\/user\/notifications\/rules$/, async route => {
    if (route.request().method() === 'POST') posted.push(route.request().postDataJSON())
    await route.fallback()
  })

  await page.goto('/notifications?tab=alerts')
  await expect(page.locator('.notif-quick-add').getByRole('button', { name: 'Watch safety actions' })).toBeVisible()
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.notif-quick-add button')]
      .find(b => b.textContent?.includes('Watch safety actions')) as HTMLButtonElement
    button.click()
    button.click()
  })

  await expect.poll(() => posted.length).toBe(2)
  await expect.poll(() => userMock.state.notifications.rules.map(r => r.kind)).toEqual(['safety'])
  await expect(page.locator('.sec-title-row + .panel tbody tr')).toHaveCount(1)
})

test('linking Telegram shows a deep link and a code, then flips to the linked account when the bot claims it', async ({ page, userMock }) => {
  await seedSession(page, userMock)

  await page.goto('/notifications?tab=channels')
  await page.getByRole('button', { name: 'Link Telegram' }).click()

  const panel = page.locator('.notif-link-panel')
  await expect(panel.getByRole('link', { name: 'Open Telegram' }))
    .toHaveAttribute('href', `https://t.me/${E2E_TELEGRAM_BOT}?start=${E2E_TELEGRAM_LINK_CODE}`)
  // The code itself is shown too, for a desktop browser handing it to a phone.
  await expect(panel.locator('.notif-link-code .mono')).toHaveText(`/start ${E2E_TELEGRAM_LINK_CODE}`)
  await expect(panel).toContainText('keep it to yourself')
  await expect.poll(() => userMock.state.notifications.telegramLinks[E2E_TELEGRAM_LINK_CODE]).toBe('pending')

  // Someone taps /start in the bot.
  claimTelegramLink(userMock.state)

  // The panel polls, so this is the page's own 3s cycle plus the refetch it
  // triggers — no waiting written into the test.
  const linked = page.locator('.notif-panel .notif-row', { hasText: `@${E2E_TELEGRAM_USERNAME}` })
  await expect(linked).toBeVisible({ timeout: 20_000 })
  await expect(linked.locator('.notif-row-meta')).toHaveText('Telegram')
  await expect(page.locator('.notif-link-panel')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Link Telegram' })).toHaveCount(0)
})

// Unlinking a chat cannot be undone from here — the chat has to /start the bot
// again — so it asks, naming the account it is about to detach.
test('unlinking Telegram asks first, and names the chat', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedNotifications(userMock)

  await page.goto('/notifications?tab=channels')
  const telegram = page.locator('.notif-panel .notif-row', { hasText: '@hydrationwatcher' })
  await telegram.getByRole('button', { name: 'Unlink' }).click()
  await expect(confirm(page).locator('.dialog-head h2')).toHaveText('Unlink Telegram')
  await expect(confirm(page)).toContainText('Unlink "@hydrationwatcher"? Alerts stop arriving in that chat.')

  await confirm(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm(page)).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(userMock.state.notifications.channels.map(c => c.kind)).toEqual(['webpush', 'telegram'])

  await telegram.getByRole('button', { name: 'Unlink' }).click()
  await confirm(page).getByRole('button', { name: 'Unlink' }).click()
  await expect.poll(() => userMock.state.notifications.channels.map(c => c.kind)).toEqual(['webpush'])
  await expect(page.locator('.notif-panel .notif-row', { hasText: '@hydrationwatcher' })).toHaveCount(0)
  // Mute is still one click — it is reversible, so it never asks.
  await expect(page.locator('.notif-panel .notif-row', { hasText: 'Chrome on macOS' })).toBeVisible()
})

// Emptying the history is not unsubscribing: the rules keep firing, which is
// exactly what the confirm has to say before it happens.
test('clearing the inbox asks first, then empties it and clears the badge', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  seedNotifications(userMock)
  seedInboxRow(userMock.state, { id: 'notif-a', title: 'Large trade: 4.87M HDX → 106k USDT' })
  seedInboxRow(userMock.state, { id: 'notif-b', kind: 'price', kindLabel: 'Price alert', title: 'HDX rose above $0.03' })

  await page.goto('/notifications')
  const inboxRows = page.locator('.wrap > .panel').last().locator('tbody tr')
  await expect(inboxRows).toHaveCount(2)

  const clear = page.getByRole('button', { name: 'Clear inbox' })
  await clear.click()
  await expect(confirm(page).locator('.dialog-head h2')).toHaveText('Clear inbox')
  await expect(confirm(page)).toContainText('Clear all 2 notifications? Alerts keep firing; this only empties the history.')

  // Cancelling keeps the history.
  await confirm(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm(page)).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(userMock.state.notifications.inbox).toHaveLength(2)

  await clear.click()
  await confirm(page).getByRole('button', { name: 'Clear inbox' }).click()
  await expect.poll(() => userMock.state.notifications.inbox).toHaveLength(0)
  // The empty state comes back, the button goes with the rows, and the topbar's
  // badge is gone — while every rule is still there.
  await expect(page.locator('.wrap > .panel').last().locator('tbody')).toContainText('Nothing yet')
  await expect(page.getByRole('button', { name: 'Clear inbox' })).toHaveCount(0)
  await expect(page.locator('.topbar-bell .invite-badge')).toHaveCount(0)
  await expect(tab(page, 'Alerts').locator('.cnt')).toHaveText(String(RULE_COUNT))
})

// A deployment with neither channel configured must say so rather than offering
// buttons that can only fail.
test('a deployment with no push or bot configured says so instead of offering the buttons', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.notifications.vapidPublicKey = ''
  userMock.state.notifications.telegramBot = ''

  await page.goto('/notifications?tab=channels')
  await expect(page.locator('.notif-note', { hasText: 'Web Push is not configured on this deployment.' })).toBeVisible()
  await expect(page.locator('.notif-note', { hasText: 'Telegram is not configured on this deployment.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enable push' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Link Telegram' })).toHaveCount(0)
})

test.describe('mobile — 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the rules table stacks into cards, nothing overflows, and the bell rides beside the burger', async ({ page, userMock }) => {
    await seedSession(page, userMock)
    seedNotifications(userMock)
    seedInboxRow(userMock.state)

    // The bell is the only route to notifications — no drawer or menu row —
    // so it stays visible at this width, badge included, left of the burger.
    await page.goto('/')
    const bell = page.locator('.topbar-bell')
    await expect(bell).toBeVisible()
    await expect(bell.locator('.invite-badge')).toHaveText('1')
    const bellBox = (await bell.boundingBox())!
    const burgerBox = (await page.locator('.nav-burger').boundingBox())!
    expect(bellBox.x, 'bell sits left of the burger').toBeLessThan(burgerBox.x)
    await page.locator('.drawer-scrim').waitFor({ state: 'detached' }).catch(() => {})
    await page.locator('.nav-burger').click()
    await expect(page.locator('.drawer').getByRole('link', { name: /^Notifications/ })).toHaveCount(0)
    await page.locator('.drawer-head .theme-toggle').click()
    await bell.click()
    await expect(page).toHaveURL(/\/notifications$/)

    // The tab bar is reachable and switching is a query-only navigation.
    await tab(page, 'Alerts').click()
    await expect(page).toHaveURL(/\/notifications\?tab=alerts$/)
    const rules = page.locator('.sec-title-row + .panel tbody tr')
    await expect(rules).toHaveCount(RULE_COUNT)

    // Each cell becomes its own block with its column name in front of it —
    // nothing hidden behind a sideways scroll.
    const row = rules.filter({ hasText: 'Large HDX trades' })
    const alert = (await row.locator('td[data-label="Alert"]').boundingBox())!
    const channels = (await row.locator('td[data-label="Channels"]').boundingBox())!
    expect(await row.locator('td[data-label="Channels"]').evaluate(el => getComputedStyle(el).display)).toBe('block')
    expect(channels.y, 'Channels sits below Alert, not beside it').toBeGreaterThan(alert.y)
    expect(channels.x, 'both cells span the same full width').toBe(alert.x)
    expect(Math.round(channels.width)).toBe(Math.round(alert.width))
    // …with the column names carried per cell (data-label) rather than by a
    // head row, which is hidden at this width.
    await expect(page.locator('.sec-title-row + .panel thead')).toBeHidden()

    const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)
    expect(overflow, 'no horizontal overflow at 390px').toBeLessThanOrEqual(0)
  })
})
