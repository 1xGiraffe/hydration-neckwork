import { expect, test } from './fixtures/test'

// Logged out, /notifications is the conversion surface every "Get notified"
// button on every other page leads to — so it has to say what alerts are FOR
// (the personas), and its one call to action has to open the real login dialog
// rather than a dead end. The topbar bell is the other half of the same story:
// it renders for a visitor with no session too, badge-free, because a bell that
// only appears after login is a feature nobody discovers.

test('the logged-out page sells the feature and its CTA opens the connect dialog', async ({ page }) => {
  await page.goto('/notifications')

  const hero = page.locator('.notif-hero')
  await expect(hero).toContainText('Get told the moment it happens.')
  // The three channels, named as badges rather than buried in the prose.
  await expect(hero.locator('.notif-channel-badge')).toHaveText(['Browser push', 'Installed app', 'Telegram'])

  // One card per persona — a trigger taxonomy would describe the machinery,
  // not the reason anyone would want it.
  const personas = page.locator('.notif-persona')
  await expect(personas).toHaveCount(6)
  await expect(personas.first()).toContainText('Treasury watcher')
  await expect(page.locator('.notif-personas')).toContainText('Warn me before I get liquidated')

  // The invariant that makes the feature trustworthy is stated on the page.
  await expect(page.locator('.notif-foot-note')).toContainText('never wake you up')

  // Nothing the logged-out visitor could manage is offered — and no tabs
  // either: none of the three has anything to show without a session.
  await expect(page.locator('.detail-tabs')).toHaveCount(0)
  await expect(page.locator('.sec-title', { hasText: 'Channels' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '+ New alert' })).toHaveCount(0)

  await expect(page.locator('.dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Log in to set up alerts' }).click()
  await expect(page.locator('.dialog-head h2')).toHaveText('Log in with your wallet')
})

test('the topbar bell renders without a session — no badge — and leads to the teaser', async ({ page }) => {
  await page.goto('/')

  const bell = page.locator('.topbar-bell')
  await expect(bell).toBeVisible()
  await expect(bell).toHaveAttribute('title', 'Notifications')
  // No session means no count to show; an empty pill would read as "zero
  // unread", which is a different (and wrong) statement.
  await expect(bell.locator('.invite-badge')).toHaveCount(0)

  await bell.click()
  await expect(page).toHaveURL(/\/notifications$/)
  await expect(page.locator('.notif-hero')).toBeVisible()
})
