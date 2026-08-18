import type { Page } from '@playwright/test'
import { E2E_ADDRESS, E2E_TOKEN, expect, seedSession, test } from './fixtures/test'
import { PENDING_NOTIFICATION_KEY } from '../src/pendingNotification'

// The subscribe affordance is meant to be met where the reader already is —
// on an asset, an account, the safety timeline, a set of filters, a
// referendum — carrying that surface's own context into the rule. These prove
// each button exists where it should, that the rule it POSTs is the one the
// page was showing, and that meeting one while logged OUT still ends with the
// alert created.

const FOX = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
// HDX's own fixture price, and the value floor the asset page's trade and
// transfer alerts open on.
const HDX_PRICE = 0.02184
const ASSET_MIN_USD = 10_000
// A quick-adjust step is always measured against the LIVE price, so the value the
// chip fills in — and the one that must be POSTed — is exactly this expression.
const stepped = (price: number, pct: number) => price * (1 + pct / 100)

type RuleBody = { kind: string; params: Record<string, unknown>; name?: string }

// Watch what the app actually sends, then let the stateful user mock answer it.
async function captureCreatedRules(page: Page): Promise<RuleBody[]> {
  const posted: RuleBody[] = []
  await page.route(/\/api\/user\/notifications\/rules$/, async route => {
    if (route.request().method() === 'POST') posted.push(route.request().postDataJSON() as RuleBody)
    await route.fallback()
  })
  return posted
}

async function installReferendum(page: Page): Promise<void> {
  await page.route(/\/api\/explorer\/referendum\//, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      pallet: 'opengov', index: 263, title: 'Treasury spend for Bifrost integration',
      subsquareUrl: 'https://hydration.subsquare.io/referenda/263',
      track: 0, proposalHash: '0x' + '4c'.repeat(32),
      proposalCall: { pallet: 'Treasury', callName: 'spend', args: {}, encoded: '0x1a00', byteLength: 12, decodeError: null },
      status: 'deciding', submittedAt: null, concludedAt: null,
      asset: { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: 2034 },
      onChainTally: null,
      directTally: { ayes: '0', nays: '0', rawAyes: '0', rawNays: '0', support: '0', ayeVoters: 0, nayVoters: 0, splitVoters: 0, voters: 0 },
      indirectTally: null, voters: [], votesShown: 0, votesTotal: 0,
    }),
  }))
}

test('the asset page opens a price alert prefilled with the price it is showing, adjustable by percentage', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const posted = await captureCreatedRules(page)

  await page.goto('/asset/0')
  const actions = page.locator('.notify-actions')
  // Three buttons, one per alert this page can prefill.
  await expect(actions.getByRole('button')).toHaveCount(3)
  const priceAlert = actions.getByRole('button', { name: 'Price alert' })
  await expect(priceAlert).toHaveAttribute('title', 'Alert me when HDX crosses a price — now $0.0218')

  // Clicking OPENS the dialog rather than creating anything: a second price alert
  // at another level is a legitimate thing to want, so the level is asked for.
  await priceAlert.click()
  const dialog = page.locator('.dialog')
  await expect(dialog.locator('.dialog-head h2')).toHaveText('Price alert · HDX')
  expect(posted).toEqual([])

  // The token is settled, not offered — a chip where the combo would be — and the
  // price field opens on the live price, exact rather than rounded.
  await expect(dialog.locator('.alert-locked-token')).toHaveText('HDX · #0')
  await expect(dialog.locator('#alert-kind')).toHaveCount(0)
  await expect(dialog.locator('#alert-price')).toHaveValue(String(HDX_PRICE))
  await expect(dialog.locator('#alert-direction')).toHaveValue('above')

  // −5% is 5% off the LIVE price, and the sign decides the direction.
  await dialog.getByRole('button', { name: '−5%' }).click()
  await expect(dialog.locator('#alert-price')).toHaveValue(String(stepped(HDX_PRICE, -5)))
  await expect(dialog.locator('#alert-direction')).toHaveValue('below')
  // A second step is measured from the live price too, never compounded on the
  // field — so tapping −10% after −5% lands on 90% of the price, not on 85.5%.
  await dialog.getByRole('button', { name: '−10%' }).click()
  await expect(dialog.locator('#alert-price')).toHaveValue(String(stepped(HDX_PRICE, -10)))
  await dialog.getByRole('button', { name: '−5%' }).click()

  await dialog.getByRole('button', { name: 'Save alert' }).click()
  await expect.poll(() => posted).toEqual([{
    kind: 'price',
    params: { assetId: 0, direction: 'below', price: stepped(HDX_PRICE, -5) },
    name: 'HDX price',
  }])
  await expect.poll(() => userMock.state.notifications.rules.map(r => r.kind)).toEqual(['price'])
  await expect(dialog).toHaveCount(0)

  // What the surface shows back is a COUNT of the alerts already watching this
  // token — any threshold — linking to where they are managed.
  const count = actions.locator('.notify-count')
  await expect(count).toHaveText('1')
  await expect(count).toHaveAttribute('href', '/notifications?tab=alerts')
  await expect(count).toHaveAttribute('title', '1 price alert on HDX — manage')

  // A second alert at another level is allowed, and the count says two.
  await priceAlert.click()
  await dialog.getByRole('button', { name: '+10%' }).click()
  await dialog.getByRole('button', { name: 'Save alert' }).click()
  await expect.poll(() => posted).toHaveLength(2)
  expect(posted[1]).toEqual({
    kind: 'price',
    params: { assetId: 0, direction: 'above', price: stepped(HDX_PRICE, 10) },
    name: 'HDX price',
  })
  await expect(count).toHaveText('2')

  // The count is read from the rules the viewer HAS, never from having clicked,
  // so it survives a reload.
  await page.reload()
  await expect(page.locator('.notify-actions .notify-count')).toHaveText('2')
})

test('the asset page opens trade and transfer alerts on a $10k floor, editable', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const posted = await captureCreatedRules(page)

  await page.goto('/asset/5')
  const actions = page.locator('.notify-actions')
  const dialog = page.locator('.dialog')

  const trade = actions.getByRole('button', { name: 'Trade alert' })
  await expect(trade).toHaveAttribute('title', 'Alert me on DOT trades over $10k')
  await trade.click()
  await expect(dialog.locator('.dialog-head h2')).toHaveText('Trade alert · DOT')
  await expect(dialog.locator('.alert-locked-token')).toHaveText('DOT · #5')
  // Prefilled with the shared floor — and it is one of the preset chips, so the
  // prefill reads as pressed rather than as a value the chips disagree with.
  await expect(dialog.locator('#alert-min-trade')).toHaveValue(String(ASSET_MIN_USD))
  await expect(dialog.getByRole('button', { name: '$10k' })).toHaveAttribute('aria-pressed', 'true')
  // …and it is editable, by chip or by typing.
  await dialog.getByRole('button', { name: '$100k' }).click()
  await expect(dialog.locator('#alert-min-trade')).toHaveValue('100000')
  await dialog.locator('#alert-min-trade').fill('50000')
  await dialog.getByRole('button', { name: 'Save alert' }).click()

  await expect.poll(() => posted).toEqual([{
    kind: 'large-trade',
    params: { assetId: 5, minUsd: 50_000 },
    name: 'Large DOT trades',
  }])

  // The transfer alert is the same shape on the other feed, saved as it opened.
  const transfer = actions.getByRole('button', { name: 'Transfer alert' })
  await expect(transfer).toHaveAttribute('title', 'Alert me on DOT transfers over $10k')
  await transfer.click()
  await expect(dialog.locator('.dialog-head h2')).toHaveText('Transfer alert · DOT')
  await expect(dialog.locator('#alert-min-transfer')).toHaveValue(String(ASSET_MIN_USD))
  await dialog.getByRole('button', { name: 'Save alert' }).click()

  await expect.poll(() => posted).toHaveLength(2)
  expect(posted[1]).toEqual({
    kind: 'large-transfer',
    params: { assetId: 5, minUsd: ASSET_MIN_USD },
    name: 'Large DOT transfers',
  })
  await expect(actions.locator('.notify-count')).toHaveCount(2)

  // Saving the very same transfer alert again is harmless: the create is
  // idempotent, so the dialog says the existing one was kept instead of
  // reporting an error or quietly making a duplicate.
  await transfer.click()
  await dialog.getByRole('button', { name: 'Save alert' }).click()
  await expect(dialog.locator('.dialog-note')).toContainText('already alerting on exactly this')
  await expect(dialog.locator('.dialog-error')).toHaveCount(0)
  await expect.poll(() => userMock.state.notifications.rules).toHaveLength(2)
})

// Three pills do not fit one phone line, so the row has to wrap instead of
// pushing the page sideways.
test('the three alert buttons wrap without overflowing a 390px viewport', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/asset/0')
  await expect(page.locator('.notify-actions').getByRole('button')).toHaveCount(3)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  // Every button is inside the viewport, on whichever line it landed.
  for (const box of await page.locator('.notify-actions .notify-btn').all()) {
    const rect = await box.boundingBox()
    expect(rect!.x).toBeGreaterThanOrEqual(0)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(390)
  }
})

test('the account page subscribes to that address\'s activity', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const posted = await captureCreatedRules(page)

  await page.goto(`/account/${FOX}`)
  const notify = page.locator('.ext-link-row').getByRole('button', { name: 'Get notified' })
  await expect(notify).toHaveAttribute('title', "Alert me on this account's activity")
  await notify.click()

  await expect.poll(() => posted.length).toBe(1)
  expect(posted[0].kind).toBe('account-activity')
  // The page's own canonical address for the account it is showing — never the
  // raw public-key hex, and never a second address it happened to render —
  // carried as an address target.
  const target = posted[0].params.target as { kind: string; address: string }
  expect(target.kind).toBe('address')
  expect(target.address).toMatch(/^([1-9A-HJ-NP-Za-km-z]{46,50}|0x[0-9a-fA-F]{40})$/)
  expect(posted[0].name).toMatch(/^Activity of /)
})

test('the security page subscribes to safety actions from beside the timeline', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const posted = await captureCreatedRules(page)

  await page.goto('/security')
  const row = page.locator('.sec-title-row', { hasText: 'Latest safety action' })
  const notify = row.getByRole('button', { name: 'Get notified' })
  await expect(notify).toHaveAttribute('title', 'Alert me on every circuit breaker, pause, freeze and lockdown')
  await notify.click()

  await expect.poll(() => posted).toEqual([{ kind: 'safety', params: {}, name: 'Safety actions' }])
})

test('a referendum page subscribes to the chain-wide referenda feed', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  await installReferendum(page)
  const posted = await captureCreatedRules(page)

  await page.goto('/referendum/opengov/263')
  await page.locator('.ext-link-row').getByRole('button', { name: 'Watch referenda' }).click()

  // Not a per-item subscription: by the time you can read this one it has
  // already moved, so the rule watches every phase of every referendum.
  await expect.poll(() => posted).toEqual([{ kind: 'referendum', params: {}, name: 'New referenda' }])
})

test('the activity filters offer a Notify button only once they express a real alert', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const posted = await captureCreatedRules(page)

  // No filters: there is nothing to subscribe to.
  await page.goto('/activity')
  await expect(page.locator('.filter-extra')).toBeVisible()
  await expect(page.locator('.filter-extra').getByRole('button', { name: 'Notify' })).toHaveCount(0)

  // A token alone is not enough either — a floorless rule would fire on every
  // trade of that token.
  await page.goto('/activity?token=0')
  await expect(page.locator('.filter-extra')).toBeVisible()
  await expect(page.locator('.filter-extra').getByRole('button', { name: 'Notify' })).toHaveCount(0)

  // A minimum below the registry's own floor is refused for the same reason.
  await page.goto('/activity?token=0&min=10')
  await expect(page.locator('.filter-extra')).toBeVisible()
  await expect(page.locator('.filter-extra').getByRole('button', { name: 'Notify' })).toHaveCount(0)

  // Token + a real floor: expressible as a large-trade rule, so the button
  // appears and carries exactly those two filters.
  await page.goto('/activity?token=0&min=25000')
  const notify = page.locator('.filter-extra').getByRole('button', { name: 'Notify' })
  await expect(notify).toBeVisible()
  await notify.click()

  await expect.poll(() => posted).toEqual([{
    kind: 'large-trade',
    params: { assetId: 0, minUsd: 25_000 },
    name: 'Trades over $25k on asset 0',
  }])

  // The same two filters on the transfer tab are a large-transfer rule — the
  // category the reader is looking at decides the kind, never a silent default.
  await page.goto('/activity?tab=transfer&token=0&min=25000')
  const notifyTransfers = page.locator('.filter-extra').getByRole('button', { name: 'Notify' })
  await expect(notifyTransfers).toHaveAttribute('title', 'Alert me on transfers matching these filters')
  await notifyTransfers.click()

  await expect.poll(() => posted).toHaveLength(2)
  expect(posted[1]).toEqual({
    kind: 'large-transfer',
    params: { assetId: 0, minUsd: 25_000 },
    name: 'Transfers over $25k of asset 0',
  })

  // A tab with no trigger kind behind it hides the button rather than
  // subscribing the reader to something else.
  await page.goto('/activity?tab=liquidity&token=0&min=25000')
  await expect(page.locator('.filter-extra')).toBeVisible()
  await expect(page.locator('.filter-extra').getByRole('button', { name: 'Notify' })).toHaveCount(0)
})

// The whole point of the logged-out affordance: the context that made the alert
// worth wanting is exactly what a "log in first" dead end would lose.
test('logged out, a surface button parks the alert, logs in, creates it and lands on the page holding it', async ({ page, userMock, injectedWallet }) => {
  void injectedWallet // the wallet stub; the mocked auth surface is asserted on below
  const posted = await captureCreatedRules(page)

  await page.goto('/asset/0')
  // The same buttons, opening the same dialog — a logged-out visitor is never
  // told to come back later, and gets to choose the level before logging in.
  const priceAlert = page.locator('.notify-actions').getByRole('button', { name: 'Price alert' })
  await expect(priceAlert).toHaveAttribute('title', 'Alert me when HDX crosses a price — now $0.0218')
  await priceAlert.click()
  const dialog = page.locator('.dialog')
  await expect(dialog.locator('.dialog-head h2')).toHaveText('Price alert · HDX')
  // The button says what the click will do, so "Save" is never a silent login.
  const save = dialog.getByRole('button', { name: 'Log in to save this alert' })
  await expect(save).toBeVisible()
  await save.click()

  // What is parked is the rule the dialog BUILT — the prefill it opened on, since
  // nothing was adjusted — and the login dialog (the shared one the topbar owns,
  // not a second instance) takes the place of the alert dialog.
  await expect.poll(() => page.evaluate(key => window.localStorage.getItem(key), PENDING_NOTIFICATION_KEY))
    .toBe(JSON.stringify({ kind: 'price', params: { assetId: 0, direction: 'above', price: HDX_PRICE }, name: 'HDX price' }))
  await expect(page.locator('.dialog-head h2')).toHaveText('Log in with your wallet')
  expect(posted).toEqual([])

  await page.locator('.wallet-tile', { hasText: 'Nova Wallet' }).click()

  // The handoff claims the parked intent, creates it, and takes the reader to
  // the tab holding the alert it just made — the inbox would be empty until it
  // fires, which reads as a failure.
  await expect(page).toHaveURL(/\/notifications\?tab=alerts$/)
  await expect.poll(() => posted).toEqual([{
    kind: 'price',
    params: { assetId: 0, direction: 'above', price: HDX_PRICE },
    name: 'HDX price',
  }])
  await expect.poll(() => userMock.state.notifications.rules.map(r => r.kind)).toEqual(['price'])
  // The notifications page is a lazily imported chunk, reached here by a
  // client-side navigation rather than a load — wait for the section itself
  // before reading a row out of it.
  await expect(page.locator('.sec-title-row', { hasText: 'Alerts' })).toBeVisible({ timeout: 20_000 })
  const row = page.locator('.sec-title-row + .panel tbody tr', { hasText: 'HDX price' })
  await expect(row.locator('.badge.notif-kind')).toHaveText('Price alert')

  // Single-shot: the entry is gone, so a reload cannot POST it a second time.
  expect(await page.evaluate(key => window.localStorage.getItem(key), PENDING_NOTIFICATION_KEY)).toBeNull()
  const stored = await page.evaluate(() => window.localStorage.getItem('explorer-session'))
  expect((JSON.parse(stored ?? '{}') as { token?: string }).token).toBe(E2E_TOKEN)

  await page.reload()
  await expect(page.locator('.sec-title-row + .panel tbody tr')).toHaveCount(1)
  expect(posted).toHaveLength(1)
})

// Regression for the exact race that made the test above fail under parallel
// load. Logging in starts the topbar's FIRST overview fetch and the handoff's
// create at the same instant, and react-query dedupes a refetch onto an
// in-flight first fetch (there is no previous data to revert to, so
// `cancelRefetch` does nothing) — so the invalidate the handoff fires was
// swallowed, the query settled on the pre-create response, and the page the
// reader was just sent to said "No alerts yet" for the next 30 seconds.
// Holding that first response until after the handoff has navigated makes the
// window certain instead of load-dependent.
test('the handoff refreshes the page it lands on even when the first overview fetch is still in flight', async ({ page, userMock, injectedWallet }) => {
  void injectedWallet
  let releaseOverview = () => {}
  const held = new Promise<void>(resolve => { releaseOverview = resolve })
  let seen = 0
  await page.route(/\/api\/user\/notifications\/overview(?:\?.*)?$/, async route => {
    if (seen++ > 0) { await route.fallback(); return }
    // Snapshot the answer BEFORE the create lands, then deliver it after — a
    // response that genuinely predates the new rule, which is what the racing
    // fetch really carries. (Falling back late would re-read the mock's state
    // and answer with the rule already in it, proving nothing.)
    const stale = JSON.stringify({
      channels: [], rules: [], unread: 0,
      vapidPublicKey: userMock.state.notifications.vapidPublicKey,
      telegramBot: userMock.state.notifications.telegramBot,
    })
    await held
    await route.fulfill({ status: 200, contentType: 'application/json', body: stale })
  })

  await page.goto('/asset/0')
  await page.locator('.notify-actions').getByRole('button', { name: 'Price alert' }).click()
  await page.locator('.dialog').getByRole('button', { name: 'Log in to save this alert' }).click()
  await expect(page.locator('.dialog-head h2')).toHaveText('Log in with your wallet')
  await page.locator('.wallet-tile', { hasText: 'Nova Wallet' }).click()

  // The handoff has created the rule and navigated — with the first overview
  // response still unanswered.
  await expect(page).toHaveURL(/\/notifications\?tab=alerts$/)
  await expect.poll(() => userMock.state.notifications.rules.map(r => r.kind)).toEqual(['price'])
  releaseOverview()

  // That stale first response must not be the one the page settles on.
  const row = page.locator('.sec-title-row + .panel tbody tr', { hasText: 'HDX price' })
  await expect(row.locator('.badge.notif-kind')).toHaveText('Price alert', { timeout: 15_000 })
})

/* ── the account-activity target picker ─────────────────────────────────── */

// Watching an account is the most-asked-for alert and the one whose parameter
// nobody can type from memory. The picker is the global search bar's typeahead,
// narrowed to the two things a target can be — an account or a tag.

async function openTargetPicker(page: Page): Promise<void> {
  await page.goto('/notifications?tab=alerts')
  await page.getByRole('button', { name: '+ New alert' }).click()
  await page.locator('.dialog #alert-kind').selectOption('account-activity')
  await expect(page.locator('#alert-target')).toBeVisible()
}

test('the target picker finds an account by its identity and writes an address target', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const posted = await captureCreatedRules(page)

  await openTargetPicker(page)
  await page.locator('#alert-target').fill('StakerNode')
  const row = page.locator('.acct-picker-row', { hasText: 'StakerNode' })
  await expect(row).toBeVisible()
  // The row is an account pill: identity, then the shortened address — never
  // the raw public key the search matched on.
  await expect(row.locator('.acct-picker-addr')).toContainText('…')
  await row.click()

  // Picked, it becomes a chip and the query box empties.
  await expect(page.locator('.acct-picker-box .acct-chip')).toContainText('StakerNode')
  await expect(page.locator('#alert-target')).toHaveValue('')

  await page.locator('.dialog').getByRole('button', { name: 'Create alert' }).click()
  await expect.poll(() => posted).toEqual([{
    kind: 'account-activity',
    params: { target: { kind: 'address', address: FOX } },
  }])
})

test('the target picker offers a tag, and the rule follows the tag rather than its members', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const posted = await captureCreatedRules(page)

  await openTargetPicker(page)
  await page.locator('#alert-target').fill('kraken')
  const tagRow = page.locator('.acct-picker-row', { hasText: 'Kraken' })
  await expect(tagRow).toBeVisible()
  await tagRow.click()

  await page.locator('.dialog').getByRole('button', { name: 'Create alert' }).click()
  await expect.poll(() => posted).toEqual([{
    kind: 'account-activity',
    params: { target: { kind: 'tag', tagId: 'kraken' } },
  }])

  // …and the stored rule carries the tag's own display fields, so the list
  // draws the tag instead of an opaque id.
  const rule = page.locator('.sec-title-row + .panel tbody tr', { hasText: 'Kraken' })
  await expect(rule.locator('.addr-pill')).toHaveAttribute('href', '/tag/kraken')
})

// One focus, one click: an empty box already offers the account you logged in
// with, because watching yourself needs no search at all.
test('the target picker suggests the logged-in account on an empty box', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const posted = await captureCreatedRules(page)

  await openTargetPicker(page)
  await page.locator('#alert-target').click()
  const self = page.locator('.acct-picker-row', { hasText: 'My account' })
  await expect(self).toHaveCount(1)
  await expect(self).toContainText('E2E User')
  await self.click()

  await page.locator('.dialog').getByRole('button', { name: 'Create alert' }).click()
  await expect.poll(() => posted).toEqual([{
    kind: 'account-activity',
    params: { target: { kind: 'address', address: E2E_ADDRESS } },
  }])
})

// A tag page is where somebody decides a whole group is worth watching, so the
// bell belongs there — with the same placement the account page uses.
test('a tag page subscribes to everything anyone in the tag does', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  const posted = await captureCreatedRules(page)

  await page.goto('/tag/kraken')
  const notify = page.locator('.ext-link-row').getByRole('button', { name: 'Get notified' })
  await expect(notify).toHaveAttribute('title', 'Alert me on activity by anyone tagged Kraken')
  await notify.click()

  await expect.poll(() => posted).toEqual([{
    kind: 'account-activity',
    params: { target: { kind: 'tag', tagId: 'kraken' } },
    name: 'Activity of Kraken',
  }])
  // Subscribed state is read back off the rule, on the page that made it.
  await expect(page.locator('.ext-link-row').getByRole('button', { name: 'Alerting ✓' })).toBeVisible()
  await expect.poll(() => userMock.state.notifications.rules[0]?.targetLabel).toBe('Kraken')
})
