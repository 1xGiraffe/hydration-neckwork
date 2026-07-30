import { expect, test } from './fixtures/test'

// The asset page's feed is called Activities and offers the same filters as
// the global activities feed (minus the token combo — the asset is pinned),
// served by the SAME /explorer/activity endpoint with ?asset=<id>.
test('asset page shows an Activities tab with activity-style filters', async ({ page }) => {
  const activityRequests: string[] = []
  page.on('request', req => {
    const url = req.url()
    if (url.includes('/api/explorer/activity')) activityRequests.push(url)
  })

  await page.goto('/asset/5')
  const activitiesTab = page.getByRole('button', { name: 'Activities' })
  await expect(activitiesTab).toBeVisible()
  await expect(page.locator('.tbl').first()).toBeVisible()

  // rows load from the unified endpoint with the asset pinned
  await expect.poll(() => activityRequests.some(u => /\/explorer\/activity\?asset=5/.test(u))).toBe(true)

  // the filter zone exposes dates + $-min (no token combo — the asset is fixed)
  await page.getByRole('button', { name: /Filters/ }).click()
  await expect(page.locator('.filters input[type="date"]')).toHaveCount(2)
  await expect(page.getByPlaceholder('$ from')).toBeVisible()
  await expect(page.getByPlaceholder('All tokens')).toHaveCount(0)

  // the $-min filter deep-links and reaches the API
  await page.getByPlaceholder('$ from').fill('100')
  await expect(page).toHaveURL(/min=100/)
  await expect.poll(() => activityRequests.some(u => u.includes('asset=5') && u.includes('min=100'))).toBe(true)
})
