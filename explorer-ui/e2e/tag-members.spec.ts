import { expect, test } from './fixtures/test'

// A tag is a slice of the accounts directory, so its member list is the same
// table /accounts renders. It used to be a bare column of address pills: a
// reader who followed a tag out of the directory lost the value, holdings,
// lending and activity they had just been reading.

const DIRECTORY_COLUMNS = ['Account', 'Value', 'Holdings', '1Y', 'Lent', 'Borrowed', 'Health', 'Liquidation $', 'Trading $', 'Revenue', 'Activity']

test('a system tag lists its members as directory rows', async ({ page }) => {
  await page.goto('/tag/kraken')
  const table = page.locator('table.accounts-tbl')
  await expect(table).toBeVisible()

  // The headers render uppercased by CSS; compare what they SAY.
  const headers = (await table.locator('thead th').allInnerTexts()).map(t => t.trim().toLowerCase())
  expect(headers).toEqual(DIRECTORY_COLUMNS.map(c => c.toLowerCase()))
  const first = table.locator('tbody tr').first()
  await expect(first.locator('td[data-label="Value"]')).toContainText('$')
  await expect(first.locator('td[data-label="Holdings"] .icon-stack')).toBeVisible()
})

test('a member row behaves like a directory row', async ({ page }) => {
  await page.goto('/tag/kraken')
  const first = page.locator('table.accounts-tbl tbody tr').first()
  await expect(first).toHaveClass(/clickable/)
  await first.locator('td[data-label="Value"]').click()
  await expect(page).toHaveURL(/\/account\//)
})

// A tag page is one tag: grouping its members under that tag again would
// collapse the whole list into the single row the reader arrived from.
test('members are listed one by one, never folded back into the tag', async ({ page }) => {
  await page.goto('/tag/kraken')
  const rows = page.locator('table.accounts-tbl tbody tr')
  await expect(rows.first()).toBeVisible()     // count the loaded table, not the skeleton
  expect(await rows.count()).toBeGreaterThan(1)
  // Each row names an account, not the tag itself.
  await expect(rows.first().locator('td[data-label="Account"] .addr-pill')).toBeVisible()
})
