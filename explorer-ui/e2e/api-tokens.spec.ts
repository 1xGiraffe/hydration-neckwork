import { E2E_ADDRESS, E2E_API_LIMIT_DEFAULTS, expect, seedSession, test } from './fixtures/test'
import type { UserMockState } from './fixtures/test'

// The Data-API token surface: minting (with the one-time secret reveal),
// revoking, the logged-out teaser, and the admin roster. The user mock is
// stateful, so every flow is proven by both halves of the round trip.

function seedApiUser(state: UserMockState, overrides: Partial<UserMockState['apiUsers'][number]> = {}): void {
  state.apiUsers.push({
    account: { accountId: E2E_ADDRESS, address: E2E_ADDRESS, emoji: '🧪', tag: null, identity: null, profile: { name: 'E2E User', avatarVersion: 0 } },
    tokenCount: 2,
    labels: ['trading bot', 'tax export'],
    lastUsedAt: '2026-08-28 11:30:00',
    limits: { ...E2E_API_LIMIT_DEFAULTS, override: false, note: '' },
    usage: { requests24h: 4870, rejected24h: 12, requests7d: 40200, requests30d: 112000, lastActiveHour: '2026-08-28 11:00:00' },
    ...overrides,
  })
}

test('minting shows the secret exactly once; the list keeps only the prefix', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  await page.goto('/api-tokens')

  await page.getByRole('button', { name: '+ Create token' }).click()
  await page.getByPlaceholder('Label (optional)').fill('trading bot')
  await page.getByRole('button', { name: 'Create token' }).click()

  // The reveal step: full hdd_ secret, the store-it-now warning, a copy button.
  const reveal = page.locator('.token-reveal-value')
  await expect(reveal).toBeVisible()
  const raw = (await reveal.textContent()) ?? ''
  expect(raw).toMatch(/^hdd_[0-9a-f]{64}$/)
  await expect(page.locator('.dialog')).toContainText("You won't see this token again")

  await page.getByRole('button', { name: 'Done — I stored it' }).click()

  // The list row carries the label and the PREFIX — the secret is gone from
  // the page for good.
  const row = page.locator('.panel tbody tr').first()
  await expect(row).toContainText('trading bot')
  await expect(row).toContainText(`${raw.slice(0, 12)}…`)
  await expect(page.locator('body')).not.toContainText(raw)

  // Reopening the dialog starts clean rather than re-showing the old secret.
  await page.getByRole('button', { name: '+ Create token' }).click()
  await expect(page.locator('.token-reveal-value')).toHaveCount(0)
})

test('revoking goes through the confirm and removes the row server-side', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.apiTokens.push({ id: 'a'.repeat(64), label: 'old bot', tokenPrefix: 'hdd_00010001', createdAt: '2026-08-01 00:00:00', lastUsedAt: '2026-08-27 09:00:00' })

  await page.goto('/api-tokens')
  await expect(page.locator('.panel tbody tr')).toHaveCount(1)
  await page.getByRole('button', { name: 'Revoke' }).click()

  const confirm = page.locator('.confirm-dialog')
  await expect(confirm).toContainText('old bot')
  await confirm.getByRole('button', { name: 'Revoke' }).click()

  await expect(page.locator('.panel tbody tr td').first()).toContainText('No tokens yet')
  expect(userMock.state.apiTokens).toHaveLength(0)
})

test('logged out, the page is a sign-in teaser', async ({ page }) => {
  await page.goto('/api-tokens')
  await expect(page.getByRole('button', { name: 'Log in to manage your API tokens' })).toBeVisible()
  await expect(page.locator('.panel')).toHaveCount(0)
})

test('the admin page lists API users for an admin session', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  userMock.state.apiAdmin = true
  seedApiUser(userMock.state, { limits: { perMinute: 120, perDay: 500000, override: true, note: 'quant desk' } })

  await page.goto('/admin/api')
  const row = page.locator('.panel tbody tr').first()
  await expect(row).toContainText('E2E User')
  await expect(row).toContainText('trading bot')
  // Compact usage numbers plus the rejected aside, and the override badge.
  await expect(row).toContainText('4.9k')
  await expect(row).toContainText('(12 rejected)')
  await expect(row.locator('.badge.pending')).toContainText('override')
  await expect(row).toContainText('120/min')

  // The menu shows the admin entry for this session.
  await page.locator('.account-btn').click()
  await expect(page.locator('.account-menu')).toContainText('API admin')
})

test('a non-admin session gets the not-available state, and no menu entry', async ({ page, userMock }) => {
  await seedSession(page, userMock)
  await page.goto('/admin/api')
  await expect(page.locator('.detail-card')).toContainText('not available for this account')
  await expect(page.locator('.panel')).toHaveCount(0)

  await page.locator('.account-btn').click()
  await expect(page.locator('.account-menu')).toContainText('API tokens')
  await expect(page.locator('.account-menu')).not.toContainText('API admin')
})
