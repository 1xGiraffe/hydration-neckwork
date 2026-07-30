import { expect, test } from './fixtures/test'

// On phones the day bar charts cap at the most recent 30 bars — the full
// window (~45-90 days) makes each bar a ~3px sliver that can't be tapped.
// The fixture serves 45 days, so mobile must show exactly 30, desktop all 45.

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('activity day chart shows the last 30 bars, each wide enough to tap', async ({ page }) => {
    await page.goto('/activity')
    const bars = page.locator('.day-bar')
    await expect(bars).toHaveCount(30)

    const width = (await bars.last().boundingBox())!.width
    expect(width, 'bars must be finger-selectable').toBeGreaterThan(6)

    // Tapping a bar still filters by that day (the bar carries the date).
    await bars.last().click()
    await expect(page.locator('.sec-title .t-d, .sec-title span span')).toContainText(/\d{4}-\d{2}-\d{2}/)
  })
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('activity day chart keeps the full window', async ({ page }) => {
    await page.goto('/activity')
    await expect(page.locator('.day-bar')).toHaveCount(45)
  })
})
