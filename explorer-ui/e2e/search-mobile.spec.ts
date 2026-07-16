import { expect, test } from './fixtures/test'

// The topbar search dropdown must span nearly the full phone width without
// extending past either viewport edge.
test.use({ viewport: { width: 390, height: 844 } })

test('mobile topbar search results span the screen and are not cut off', async ({ page }) => {
  await page.goto('/activity')
  const input = page.locator('.topbar-search input')
  await input.click()
  await input.fill('dot')

  const results = page.locator('.search-results')
  await expect(results).toBeVisible()
  const box = (await results.boundingBox())!
  expect(box.x, 'no left cutoff').toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, 'no right cutoff').toBeLessThanOrEqual(390)
  expect(box.width, 'use (nearly) the whole screen width').toBeGreaterThan(340)

  // The dropdown stays immediately below the sticky top bar and on screen.
  const bar = (await page.locator('.topbar').boundingBox())!
  expect(box.y).toBeGreaterThan(bar.y + bar.height - 2)
  expect(box.y, 'dropdown must open right under the bar').toBeLessThan(bar.y + bar.height + 24)
})
