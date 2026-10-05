import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'

// The directory's twelve columns fit the page container from a 1200px window up:
// a column pushed off the right edge of a panel with no visible scrollbar reads
// as missing, not as scrollable (it was the Activity column, at 1,336px in a
// 1,230px panel). User Revenue is the first metric after the row's value.
const HEADERS = ['account', 'value', 'u. revenue', 'holdings', '12m', 'supplied', 'borrowed', 'health', 'p. revenue', 'liq. $', 'trading $', 'activity']

for (const width of [1200, 1280, 1440, 1920]) {
  test(`the accounts table fits without horizontal scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/accounts')
    const table = page.locator('table.accounts-tbl')
    await expect(table.locator('tbody tr td[data-label="Value"]').first()).toBeVisible()
    const fit = await page.evaluate(() => {
      const t = document.querySelector('table.accounts-tbl') as HTMLElement
      const panel = t.closest('.panel') as HTMLElement
      return { scroll: panel.scrollWidth, client: panel.clientWidth, doc: document.documentElement.scrollWidth, vw: window.innerWidth }
    })
    expect(fit.scroll).toBeLessThanOrEqual(fit.client)
    expect(fit.doc).toBeLessThanOrEqual(fit.vw)
    const headers = (await table.locator('thead th').allInnerTexts()).map(t => t.replace('▼', '').trim().toLowerCase())
    expect(headers).toEqual(HEADERS)
  })
}

// The mock's rows carry one of each User Revenue shape. Ranked positive > zero >
// negative > not a user > unpublished, as the server does: Kraken (48.2k),
// Binance (31.5k), a user's zero, the net loss, then the Treasury — a protocol
// account User Revenue does not describe ranks after every user, however large
// its value (980k) — and the unpublished row last.
const UR_ORDER = [/48\.2k/, /31\.5k/, /^\$0$/, /120/, /^—$/, /^—$/]

async function userRevenueCells(page: Page): Promise<string[]> {
  return (await page.locator('table.accounts-tbl tbody tr td[data-label="User Revenue"]').allInnerTexts()).map(t => t.trim())
}

test('sorting by User Revenue asks for sort=user-revenue and ranks the rows by it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/accounts')
  await expect(page.locator('table.accounts-tbl tbody tr td[data-label="Value"]').first()).toBeVisible()
  const sorted = page.waitForRequest(r => /\/api\/explorer\/accounts\?/.test(r.url()) && new URL(r.url()).searchParams.get('sort') === 'user-revenue')
  await page.locator('table.accounts-tbl thead').getByRole('button', { name: 'U. Revenue' }).click()
  await sorted
  await expect(page).toHaveURL(/[?&]sort=user-revenue/)
  await expect.poll(async () => (await userRevenueCells(page)).length).toBe(UR_ORDER.length)
  const cells = await userRevenueCells(page)
  UR_ORDER.forEach((re, i) => expect(cells[i]).toMatch(re))
})

// At phone width the table becomes cards: nothing may push the page sideways,
// every card stays inside the viewport, User Revenue leads a user's facts while a
// protocol row (its zero is no user's zero) drops the line, and the sort select
// reaches the same User Revenue ranking.
test('the accounts directory fits a 390px phone as cards', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/accounts')
  const rows = page.locator('table.accounts-tbl tbody tr')
  await expect(rows.locator('td[data-label="Value"]').first()).toBeVisible()
  const fit = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('table.accounts-tbl tbody tr')].map(tr => tr.getBoundingClientRect())
    return { doc: document.documentElement.scrollWidth, vw: window.innerWidth, overflow: cards.filter(r => r.left < 0 || r.right > window.innerWidth + 0.5).length }
  })
  expect(fit.doc).toBeLessThanOrEqual(fit.vw)
  expect(fit.overflow).toBe(0)

  const kraken = rows.filter({ hasText: 'Kraken' }).first()
  await expect(kraken.locator('td[data-label="User Revenue"]')).toBeVisible()
  await expect(kraken.locator('td[data-label="User Revenue"]')).toContainText('48.2k')
  const treasuryUr = rows.locator('td[data-label="User Revenue"].cell-empty').first()
  await expect(treasuryUr).toBeHidden()

  const sorted = page.waitForRequest(r => /\/api\/explorer\/accounts\?/.test(r.url()) && new URL(r.url()).searchParams.get('sort') === 'user-revenue')
  await page.locator('#accounts-sort').selectOption('user-revenue')
  await sorted
  await expect(page).toHaveURL(/[?&]sort=user-revenue/)
  await expect(rows.first()).toContainText('Kraken')
})
