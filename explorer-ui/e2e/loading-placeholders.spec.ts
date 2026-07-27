import { expect, test } from './fixtures/test'
import type { Page } from '@playwright/test'

// A loading placeholder has to occupy the height of the thing that replaces it,
// or the page jumps under the reader when data lands. Two shapes on /blocks used
// to get this wrong: the chart placeholder was 168px against a 309px card, and on
// a phone — where every table row becomes a stacked card of one labelled line per
// column — the table placeholder collapsed to a single ~60px bar against a ~203px
// card. Both are measured here against the real thing in the same page load.

// Hold the API long enough to observe the placeholders, then let the fixture
// answer. The matcher is anchored at the origin root for the same reason as the
// fixture's: a loose `**/api/**` also catches Vite's `/src/api/*` modules.
const holdApi = (page: Page, ms: number) =>
  page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    await new Promise(resolve => setTimeout(resolve, ms))
    await route.fallback()
  })

const HOLD_MS = 2500

for (const motion of ['no-preference', 'reduce'] as const) {
  test.describe(`phone card placeholder (prefers-reduced-motion: ${motion})`, () => {
    test.use({ viewport: { width: 390, height: 844 }, reducedMotion: motion })

    test('a blocks skeleton row is the size of the card it becomes', async ({ page }) => {
      await holdApi(page, HOLD_MS)
      await page.goto('/blocks')

      const skeleton = page.locator('tbody tr.sk-tr').first()
      await expect(skeleton).toBeVisible()
      // One line per column of the loaded card, as the card itself draws.
      await expect(skeleton.locator('td:not(.col-hide-mobile)')).toHaveCount(6)
      const placeholder = (await skeleton.boundingBox())!.height
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        'no sideways scroll while loading').toBe(0)

      const row = page.locator('tbody tr.clickable').first()
      await expect(row).toBeVisible()
      const loaded = (await row.boundingBox())!.height

      expect(loaded, 'a phone row is a stacked card, not a table line').toBeGreaterThan(150)
      expect(Math.abs(placeholder - loaded), `placeholder ${placeholder} vs card ${loaded}`).toBeLessThan(12)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        'no sideways scroll once loaded').toBe(0)
    })
  })
}

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]] as const) {
  test.describe(`block-time chart placeholder (${name})`, () => {
    test.use({ viewport })

    test('reserves the chart card height so the table below holds still', async ({ page }) => {
      await holdApi(page, HOLD_MS)
      await page.goto('/blocks')

      // Layout position, not the painted one: page content rises into place on
      // mount with a transform, which moves no layout and shifts nothing.
      const panelTop = () => page.evaluate(() => (document.querySelector('.panel') as HTMLElement).offsetTop)

      await expect(page.locator('.chart-skeleton')).toBeVisible()
      const loading = await panelTop()

      await expect(page.locator('.pf-card')).toBeVisible()
      // The card's headline is the only GeistMono text on the page, so it is
      // still measuring in the fallback face the instant it appears.
      await page.evaluate(() => document.fonts.ready)
      const loaded = await panelTop()

      expect(Math.abs(loaded - loading), `table panel moved ${loaded - loading}px`).toBeLessThan(2)
    })
  })
}
