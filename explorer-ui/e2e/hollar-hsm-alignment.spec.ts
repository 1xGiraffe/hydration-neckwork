import { expect, test } from './fixtures/test'

// Keep each HSM holding amount and its USD value on the same line.
test.use({ viewport: { width: 1280, height: 900 } })

test('HSM holdings amount and USD value share one line', async ({ page }) => {
  await page.goto('/hollar')
  const cells = page.locator('td[data-label="HSM holdings"]')
  await expect(cells.first()).toBeVisible()
  const n = await cells.count()
  expect(n).toBeGreaterThan(0)
  for (let i = 0; i < n; i++) {
    const cell = cells.nth(i)
    const amount = await cell.locator('.trade-leg').last().boundingBox()
    const usd = await cell.locator('span.muted').last().boundingBox()
    if (!amount || !usd) continue
    const amountMid = amount.y + amount.height / 2
    const usdMid = usd.y + usd.height / 2
    expect(Math.abs(usdMid - amountMid), `row ${i}: USD tag wrapped below the amount`).toBeLessThan(4)
  }
})
