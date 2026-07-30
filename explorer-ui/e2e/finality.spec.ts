import { expect, test } from './fixtures/test'

test('detail finality follows the indexed finalized height', async ({ page }) => {
  await page.goto('/block/12848613')
  await expect(page.locator('.detail-card').first().locator('.badge.pending')).toHaveText('Pending')

  await page.goto('/block/12848610')
  await expect(page.locator('.detail-card').first().locator('.badge.finalized')).toHaveText('Finalized')

  await page.goto('/extrinsic/12848613-4')
  await expect(page.locator('.detail-card').first().locator('.badge.pending')).toHaveText('Pending')
})
