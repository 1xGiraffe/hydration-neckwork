import { expect, test } from './fixtures/test'

// The accounts list sorts via clickable column headers, but mobile hides the
// thead (rows become stacked cards) — a phone needs its own sort control.

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('accounts list offers a sort control that drives the server sort', async ({ page }) => {
    await page.goto('/accounts')
    const select = page.locator('.mobile-sort select')
    await expect(select).toBeVisible()

    const firstBefore = await page.locator('.tbl tbody tr').first().textContent()
    await select.selectOption('identity')
    await expect(page).toHaveURL(/sort=identity/)
    await expect(page.locator('.tbl tbody tr').first()).not.toHaveText(firstBefore ?? '')
  })
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('sort control stays hidden where the sortable headers exist', async ({ page }) => {
    await page.goto('/accounts')
    await expect(page.locator('.tbl thead')).toBeVisible()
    await expect(page.locator('.mobile-sort select')).toBeHidden()
  })
})
