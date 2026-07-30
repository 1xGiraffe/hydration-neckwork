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

// Referenda are searchable by index ("263") and by title substring, and — since
// Democracy and OpenGov both index from 0 — the fixture pins one index to two
// different referenda so the dropdown and its links must keep them apart.
test('mobile search finds a referendum by index or title and links to the right pallet', async ({ page }) => {
  await page.goto('/activity')
  const input = page.locator('.topbar-search input')
  const results = page.locator('.search-results')

  await input.click()
  await input.fill('263')
  await expect(results).toContainText('Treasury spend for Bifrost integration')
  await expect(results).toContainText('Treasury Council election')
  const box = (await results.boundingBox())!
  expect(box.x, 'no left cutoff').toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, 'no right cutoff').toBeLessThanOrEqual(390)

  await input.fill('treasury spend')
  await expect(results).toContainText('Treasury spend for Bifrost integration')
  await expect(results).not.toContainText('Treasury Council election')

  await page.locator('.sr-item', { hasText: 'Treasury spend for Bifrost integration' }).click()
  await expect(page).toHaveURL(/\/referendum\/opengov\/263$/)
})
