import { expect, test } from './fixtures/test'

// Keep pool cards readable and balanced on wide desktop layouts.
test.use({ viewport: { width: 1440, height: 900 } })

test('desktop liquidity pool grid has 4 entries per row', async ({ page }) => {
  await page.goto('/hollar')
  const cards = page.locator('.pool-cards .hdx-card')
  await expect(cards.first()).toBeVisible()

  const rows = new Map<number, number>()
  for (const box of await cards.evaluateAll(els => els.map(e => e.getBoundingClientRect().y))) {
    rows.set(box, (rows.get(box) ?? 0) + 1)
  }
  const counts = [...rows.values()]
  expect(Math.max(...counts)).toBeLessThanOrEqual(4)
  expect(counts[0], 'first row should be full').toBe(4)
})
