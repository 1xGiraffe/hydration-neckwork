import { expect, test } from './fixtures/test'

// On phones the brand hides to make room for the topbar search — but the start
// page has no topbar search (it uses the hero search), so the logo belongs there.

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('start page shows the brand, sub pages hide it', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.topbar .brand')).toBeVisible()

    await page.goto('/activity')
    await expect(page.locator('.topbar .brand')).toBeHidden()
    await expect(page.locator('.topbar-search input')).toBeVisible()
  })
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('brand stays visible everywhere', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.topbar .brand')).toBeVisible()
    await page.goto('/activity')
    await expect(page.locator('.topbar .brand')).toBeVisible()
  })
})
